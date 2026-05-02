/**
 * Cascade conversation reuse pool (experimental).
 *
 * Goal: when a multi-turn chat continues a previous exchange, reuse the same
 * Windsurf `cascade_id` instead of starting a fresh one. This lets the
 * Windsurf backend keep its own per-cascade context cached — we avoid
 * resending the full history on each turn and the server responds faster.
 *
 * The key is a "state digest" of the caller-visible trajectory up to (but
 * not including) the newest user/tool result turn. v2.0.25 upgraded the key
 * from a relaxed "user text only" projection to a server-state semantic key
 * that includes assistant text + tool_calls digest, normalized system,
 * stable media digests, and (when tool-emulating) the tool schema digest.
 * This trades some hit rate for correctness: when the client's prior
 * assistant / system / tool context drifts, we miss instead of silently
 * resuming a stale upstream cascade.
 *
 * Safety rails:
 *   - Entries are pinned to a specific (apiKey, lsPort) pair. We must reuse
 *     the same LS and the same account or the cascade_id is meaningless.
 *   - A checked-out entry is removed from the pool. Concurrent second request
 *     with the same fingerprint falls back to a fresh cascade.
 *   - TTL defaults to 30 min (override with CASCADE_POOL_TTL_MS); LRU eviction
 *     at 500 entries.
 */

import { createHash } from 'crypto';

function positiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const POOL_TTL_MS = positiveIntEnv('CASCADE_POOL_TTL_MS', 30 * 60 * 1000);
const POOL_MAX = 500;
const KEY_VERSION = 2;

const _pool = new Map();

const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0 };

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function shortDigest(s, n = 16) {
  return sha256(String(s ?? '')).slice(0, n);
}

// Client-injected meta tags whose bodies change every turn (cwd snapshot,
// todo state, current time, hook output, slash-command echo). If we hash
// these, the fingerprint drifts even when the real user text is unchanged
// and Cascade reuse silently falls back to fresh for every call
// (issue #24). Strip them before hashing.
const META_TAG_NAMES = new Set([
  'system-reminder',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
  'analysis',
  'summary',
  'example',
  // Claude Code wraps cwd / git status / platform / today's date in <env>.
  // The date rolls every 24h and cwd/git change when the user moves around,
  // which makes the fingerprint drift across turns even when the logical
  // conversation hasn't changed. Strip it here so multi-turn sessions match
  // their prior pool entries; the actual environment information still
  // reaches the model intact via the live system prompt — we only remove it
  // from the *fingerprint key*, not the request body.
  'env',
]);

function buildMetaTagRe() {
  const escaped = [...META_TAG_NAMES].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `<(${escaped.join('|')})[^>]*>[\\s\\S]*?</\\1>`,
    'g'
  );
}
let META_TAG_RE = buildMetaTagRe();

function stripMetaTags(s) {
  if (typeof s !== 'string' || !s) return s;
  const stripped = s.replace(META_TAG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Unknown tags are caller content. Never learn them into the global
  // stripping set or fingerprints stop being a pure function of the request.
  const remaining = stripped.match(/<([a-z][-a-z_]*)[^>]*>[\s\S]*?<\/\1>/g);
  if (remaining?.length) {
    const tagNames = remaining.map(m => m.match(/^<([a-z][-a-z_]*)/)?.[1]).filter(Boolean);
    const unknown = tagNames.filter(t => !META_TAG_NAMES.has(t));
    if (unknown.length) {
      console.error(`[META_TAG_AUDIT] Unknown XML tags in user message: ${[...new Set(unknown)].join(', ')}`);
    }
  }
  return stripped;
}

// Stable JSON: recursively sort object keys so {b:1,a:2} and {a:2,b:1}
// produce the same string. Without this, two equivalent inputs hash
// differently when client serialization order varies.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Project one content block into a typed canonical record. Returns
// { type, ...payload } where payload uses stable hashes for binary media.
// `unhashable=true` flags blocks we cannot stably digest — caller's
// canonicalise() turns this into a `null` fingerprint, disabling reuse for
// the request rather than silently colliding distinct media inputs.
function canonicalContentBlock(part) {
  if (typeof part?.text === 'string') return { type: 'text', text: stripMetaTags(part.text) };
  if (typeof part === 'string') return { type: 'text', text: stripMetaTags(part) };
  const type = String(part?.type || '').toLowerCase();
  // image_url block (OpenAI / Anthropic image_url style)
  if (type === 'image_url' || type === 'image' || type === 'input_image') {
    const url = part?.image_url?.url || part?.url || '';
    if (typeof url === 'string' && url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = comma > 0 ? url.slice(5, comma) : '';
      const data = comma > 0 ? url.slice(comma + 1) : url;
      return { type: 'image', meta, hash: shortDigest(data, 16) };
    }
    if (typeof url === 'string' && url) return { type: 'image', url };
    if (typeof part?.source === 'object') {
      const src = part.source;
      if (src.type === 'base64' && typeof src.data === 'string') {
        return { type: 'image', meta: src.media_type || '', hash: shortDigest(src.data, 16) };
      }
      if (src.type === 'url' && typeof src.url === 'string') {
        return { type: 'image', url: src.url };
      }
      if (typeof src.file_id === 'string') return { type: 'image', file_id: src.file_id };
    }
    return { type: 'image', unhashable: true };
  }
  // file / document block
  if (type === 'document' || type === 'file' || type === 'input_file') {
    const fileId = part?.file_id || part?.source?.file_id;
    if (typeof fileId === 'string') return { type: 'file', file_id: fileId };
    if (part?.source?.type === 'base64' && typeof part.source.data === 'string') {
      return { type: 'file', meta: part.source.media_type || '', hash: shortDigest(part.source.data, 16) };
    }
    if (typeof part?.source?.url === 'string') return { type: 'file', url: part.source.url };
    return { type: 'file', unhashable: true };
  }
  // Any other typed block — stable JSON of the whole part. Catches things
  // like { type: 'tool_use', ... } when they appear in mixed content arrays.
  return { type: type || 'unknown', json: stableStringify(part ?? '') };
}

function canonicaliseContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: stripMetaTags(content) }];
  if (!Array.isArray(content)) return [{ type: 'json', json: stableStringify(content ?? '') }];
  return content.map(canonicalContentBlock);
}

function hasUnhashableMedia(blocks) {
  return Array.isArray(blocks) && blocks.some(b => b?.unhashable === true);
}

// Project assistant tool_calls into a stable digest. Both OpenAI
// `tool_calls: [{id, function:{name, arguments}}]` and Anthropic
// `content: [{type:'tool_use', name, input}]` shapes need to map to the
// same canonical form so the same logical call digests identically.
function projectAssistantToolCalls(m) {
  const calls = [];
  if (Array.isArray(m?.tool_calls)) {
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name || tc?.name || '';
      const args = tc?.function?.arguments;
      let argsCanonical;
      if (typeof args === 'string') {
        try { argsCanonical = stableStringify(JSON.parse(args)); }
        catch { argsCanonical = args; }
      } else if (args !== undefined) {
        argsCanonical = stableStringify(args);
      } else if (tc?.input !== undefined) {
        argsCanonical = stableStringify(tc.input);
      } else {
        argsCanonical = '';
      }
      calls.push({ name, args: argsCanonical });
    }
  }
  if (Array.isArray(m?.content)) {
    for (const part of m.content) {
      if (part?.type === 'tool_use') {
        calls.push({ name: part.name || '', args: stableStringify(part.input ?? null) });
      }
    }
  }
  return calls;
}

function projectMessage(m) {
  const role = m?.role;
  if (role === 'system') {
    const blocks = canonicaliseContent(m.content);
    return { role: 'system', content: blocks };
  }
  if (role === 'user') {
    const blocks = canonicaliseContent(m.content);
    return { role: 'user', content: blocks };
  }
  if (role === 'tool') {
    return {
      role: 'tool_result',
      tool_call_id: typeof m?.tool_call_id === 'string' ? m.tool_call_id : '',
      content: canonicaliseContent(m.content),
    };
  }
  if (role === 'assistant') {
    // Project to a stable text + tool_calls digest. Drop reasoning / metadata
    // / id fields that drift across re-renders.
    const blocks = canonicaliseContent(m.content);
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => (b.text || '').replace(/\s+/g, ' ').trim())
      .join('\n')
      .trim();
    const toolCalls = projectAssistantToolCalls(m);
    return { role: 'assistant', text, tool_calls: toolCalls };
  }
  // Unknown role — preserve as-is so it's neither swallowed nor confused
  // with a known projection.
  return { role: String(role || 'unknown'), content: canonicaliseContent(m?.content) };
}

function systemDigest(messages) {
  // CASCADE_REUSE_HASH_SYSTEM=0 is an explicit opt-out for callers whose
  // system prompt drifts every turn (Claude Code with `cwd` snapshots etc.)
  // and who care more about hit rate than strict isolation. Default ON
  // since the audit found that "default exclude system" caused silent
  // cross-system reuse.
  if (process.env.CASCADE_REUSE_HASH_SYSTEM === '0') return '';
  const sys = messages.filter(m => m?.role === 'system');
  if (!sys.length) return '';
  return shortDigest(stableStringify(sys.map(projectMessage)), 32);
}

function toolContextDigest(opts = {}) {
  if (!opts.emulateTools) return '';
  const tools = Array.isArray(opts.tools) ? opts.tools.map(t => {
    const fn = t?.function || t;
    return {
      name: fn?.name || '',
      description: fn?.description || '',
      parameters: fn?.parameters ?? fn?.input_schema ?? null,
    };
  }) : [];
  return shortDigest(stableStringify({
    tools,
    tool_choice: opts.toolChoice ?? null,
    preambleTier: opts.preambleTier ?? null,
    toolPreambleHash: opts.toolPreamble ? shortDigest(opts.toolPreamble, 16) : '',
  }), 32);
}

// Build the array of stable turns up to (but not including) the newest user
// or tool turn. This is what fpBefore digests. It includes every assistant
// turn and every system/user/tool turn except the trailing user/tool turn.
function priorTurnsForBefore(messages) {
  if (!Array.isArray(messages)) return null;
  // Find newest user/tool turn — that's the "newest" we drop.
  let newestStable = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i]?.role;
    if (r === 'user' || r === 'tool') { newestStable = i; break; }
  }
  if (newestStable < 0) return null;
  // Need at least one prior turn to make reuse meaningful.
  if (newestStable === 0) return null;
  return messages.slice(0, newestStable);
}

function projectTurns(turns) {
  if (!Array.isArray(turns)) return null;
  const projected = [];
  for (const m of turns) {
    if (m?.role === 'system') continue; // system handled separately
    const p = projectMessage(m);
    if (Array.isArray(p.content) && hasUnhashableMedia(p.content)) return { unhashable: true };
    projected.push(p);
  }
  return { turns: projected };
}

function buildKeyPayload({ messages, modelKey, callerKey, opts, scope }) {
  const sys = systemDigest(messages);
  const tools = toolContextDigest(opts);
  const turnSlice = scope === 'after' ? messages : priorTurnsForBefore(messages);
  if (!turnSlice) return null;
  const projection = projectTurns(turnSlice);
  if (!projection) return null;
  if (projection.unhashable) return null;
  return stableStringify({
    v: KEY_VERSION,
    caller: String(callerKey || ''),
    model: String(modelKey || ''),
    route: opts?.route || 'chat',
    sys,
    tools,
    turns: projection.turns,
  });
}

/**
 * Fingerprint for "I'm about to send this newest user turn — find me a
 * cascade I can resume." Hashes everything before the newest user/tool
 * turn (including assistant text + tool_calls digest, system, tools).
 *
 * Signatures (backward-compatible):
 *   fingerprintBefore(messages)
 *   fingerprintBefore(messages, modelKey)
 *   fingerprintBefore(messages, modelKey, callerKey)
 *   fingerprintBefore(messages, modelKey, callerKey, opts)
 * where opts = { tools, toolChoice, toolPreamble, emulateTools,
 *                preambleTier, route }
 *
 * Returns null when reuse should be disabled (single-turn, unhashable
 * media in prior history, etc.).
 */
export function fingerprintBefore(messages, modelKey = '', callerKey = '', opts = {}) {
  const payload = buildKeyPayload({ messages, modelKey, callerKey, opts, scope: 'before' });
  if (!payload) return null;
  return sha256(payload);
}

/**
 * Fingerprint for "I just finished a turn — store the cascade under the
 * key the next request will look up." Same shape as fingerprintBefore but
 * over the FULL message list (the newest user turn is included so the
 * post-turn fingerprint represents server state right after that turn).
 */
export function fingerprintAfter(messages, modelKey = '', callerKey = '', opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return null;
  // For "after" we want the entire trajectory we've seen, including the
  // newest user/tool/assistant turn the caller just exchanged with us.
  const sys = systemDigest(messages);
  const tools = toolContextDigest(opts);
  const projection = projectTurns(messages.filter(m => m?.role !== 'system'));
  if (!projection || projection.unhashable) return null;
  return sha256(stableStringify({
    v: KEY_VERSION,
    caller: String(callerKey || ''),
    model: String(modelKey || ''),
    route: opts?.route || 'chat',
    sys,
    tools,
    turns: projection.turns,
  }));
}

function effectiveTtl(entry) {
  const hint = Number(entry?.ttlHintMs);
  return Number.isFinite(hint) && hint > 0 ? hint : POOL_TTL_MS;
}

function prune(now) {
  for (const [fp, e] of _pool) {
    if (now - e.lastAccess > effectiveTtl(e)) { _pool.delete(fp); stats.expired++; }
  }
  if (_pool.size <= POOL_MAX) return;
  const entries = [..._pool.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toDrop = entries.length - POOL_MAX;
  for (let i = 0; i < toDrop; i++) {
    _pool.delete(entries[i][0]);
    stats.evictions++;
  }
}

/**
 * Check out a conversation if we have a matching fingerprint AND the caller
 * is willing to use the same (apiKey, lsPort) we stored. Removes the entry
 * from the pool — caller is expected to call `checkin()` with a new
 * fingerprint on success (or just drop it on failure and a fresh cascade
 * will be created next turn).
 *
 * v2.0.25 added optional `expected` for atomic owner verification at the
 * pool boundary (MED-3). Pass `{ apiKey, lsPort, lsGeneration }` and a
 * mismatch returns null + counts a miss without leaking the entry.
 */
export function checkout(fingerprint, callerKey = '', expected = null) {
  if (!fingerprint) { stats.misses++; return null; }
  const entry = _pool.get(fingerprint);
  if (!entry) { stats.misses++; return null; }

  // Validate BEFORE removing from the pool. The previous order
  // (`delete` first, then check) had a subtle leak: when a caller's
  // request fingerprinted the same as someone else's (different
  // callerKey) we deleted the rightful owner's entry on the way to
  // returning null, so the legitimate caller lost their cascade
  // resume forever. Keep the entry in place on mismatch so the
  // owner's next turn still finds it.
  if (entry.callerKey && callerKey && entry.callerKey !== callerKey) {
    stats.misses++;
    return null;
  }
  if (Date.now() - entry.lastAccess > effectiveTtl(entry)) {
    _pool.delete(fingerprint);
    stats.expired++;
    stats.misses++;
    return null;
  }
  if (expected) {
    if (expected.apiKey && entry.apiKey && expected.apiKey !== entry.apiKey) { stats.misses++; return null; }
    if (expected.lsPort && entry.lsPort && expected.lsPort !== entry.lsPort) { stats.misses++; return null; }
    if (expected.lsGeneration != null && entry.lsGeneration != null && expected.lsGeneration !== entry.lsGeneration) {
      stats.misses++;
      return null;
    }
  }

  // Validated. Now remove and hand to the caller.
  _pool.delete(fingerprint);
  stats.hits++;
  return entry;
}

/**
 * Store (or restore) a conversation entry under a new fingerprint.
 *
 * `ttlHintMs` (optional) extends this entry's expiry past the pool's
 * default 30 min — used to honour Anthropic prompt-caching markers that
 * request a 1h ttl. Pass `undefined` (default) to keep the existing
 * entry-level hint when restoring across turns. Pass `0` (or negative)
 * to clear any inherited hint and fall back to the default TTL — used
 * when the next request explicitly does NOT carry a 1h marker so a stale
 * 1h window doesn't outlive its source request (MED-2).
 */
export function checkin(fingerprint, entry, callerKey = '', ttlHintMs) {
  if (!fingerprint || !entry) return;
  const now = Date.now();
  let resolvedHint;
  if (ttlHintMs === undefined) {
    resolvedHint = entry.ttlHintMs;
  } else if (ttlHintMs === null || !Number.isFinite(ttlHintMs) || ttlHintMs <= 0) {
    resolvedHint = undefined;
  } else {
    resolvedHint = ttlHintMs;
  }
  _pool.set(fingerprint, {
    cascadeId: entry.cascadeId,
    sessionId: entry.sessionId,
    lsPort: entry.lsPort,
    lsGeneration: entry.lsGeneration,
    apiKey: entry.apiKey,
    callerKey: callerKey || entry.callerKey || '',
    stepOffset: Number.isFinite(entry.stepOffset) ? entry.stepOffset : 0,
    generatorOffset: Number.isFinite(entry.generatorOffset) ? entry.generatorOffset : 0,
    historyCoverage: entry.historyCoverage || null,
    createdAt: entry.createdAt || now,
    lastAccess: now,
    ...(Number.isFinite(resolvedHint) && resolvedHint > 0 ? { ttlHintMs: resolvedHint } : {}),
  });
  stats.stores++;
  prune(now);
}

/**
 * Drop any entries that belong to a (apiKey, lsPort, lsGeneration) tuple
 * that just went away (account removed, LS restarted, LS replaced on the
 * same port). Keeps the pool honest.
 */
export function invalidateFor({ apiKey, lsPort, lsGeneration } = {}) {
  let dropped = 0;
  for (const [fp, e] of _pool) {
    if (apiKey && e.apiKey === apiKey) { _pool.delete(fp); dropped++; continue; }
    if (lsPort && e.lsPort === lsPort) {
      // When generation is supplied on both sides, only drop entries for the
      // SAME generation — lets a same-port LS replace the old one without
      // nuking healthy entries from the new one. When either side lacks a
      // generation tag, fall back to port-only matching for safety.
      if (lsGeneration == null || e.lsGeneration == null || e.lsGeneration === lsGeneration) {
        _pool.delete(fp);
        dropped++;
      }
    }
  }
  return dropped;
}

export function poolStats() {
  return {
    size: _pool.size,
    maxSize: POOL_MAX,
    ttlMs: POOL_TTL_MS,
    ...stats,
    hitRate: stats.hits + stats.misses > 0
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)
      : '0.0',
  };
}

export function poolClear() {
  const n = _pool.size;
  _pool.clear();
  return n;
}

// Background prune — without this, expired entries accumulate when there
// are no checkin() calls for a while (e.g. a quiet weekend). .unref() so
// this timer never holds the process open past real work.
setInterval(() => prune(Date.now()), 5 * 60 * 1000).unref();
