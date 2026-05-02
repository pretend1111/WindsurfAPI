import { createHash } from 'crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// Extract a per-user / per-session signal from the request body so two
// different end users sharing one API key get different conversation pool
// scopes. v2.0.25 HIGH-3: chat & responses now look at body.user /
// conversation / previous_response_id / metadata.{conversation_id,session_id}.
//
// metadata.user_id is INTENTIONALLY NOT inspected here — handlers/messages.js
// has a specialized parser for it (Claude Code's JSON-encoded
// {device_id, session_id, account_uuid} shape) and appends its own
// `:user:<digest>` to keep the two extraction paths from double-stamping
// the same callerKey.
//
// The returned subkey is appended to the API-key callerKey so reuse stays
// pinned to (apiKey, user/session). Returns '' when no usable signal.
export function extractBodyCallerSubKey(body) {
  if (!body || typeof body !== 'object') return '';
  // Bug D fix: pick the FIRST available signal in priority order rather
  // than hashing the join of every present field. Concatenating made the
  // subkey unstable across turns whenever an OpenAI / Responses client
  // optionally included conversation_id or previous_response_id — same
  // user, different bucket, zero cascade reuse. Priority order keeps the
  // most stable identity (explicit user id) ahead of per-turn ids.
  const candidates = [
    typeof body.user === 'string' ? body.user : '',
    typeof body?.metadata?.conversation_id === 'string' ? body.metadata.conversation_id : '',
    typeof body.conversation === 'string' ? body.conversation : '',
    typeof body?.metadata?.session_id === 'string' ? body.metadata.session_id : '',
    typeof body.previous_response_id === 'string' ? body.previous_response_id : '',
  ];
  for (const c of candidates) {
    if (c) return sha256Hex(`v2|${c}`).slice(0, 16);
  }
  return '';
}

// IP + UA fallback used when an apiKey-mode caller has no explicit body
// user signal. Without this, every Claude Code / claudecode CLI on a
// self-hosted single-user setup hits "shared API key, no per-user scope"
// and cascade reuse stays disabled — exactly the symptom reported in
// #93 follow-up by zhangzhang-bit (claude-opus-4-6-thinking, msgs growing
// 33→97 across turns, reuse=false on every Cascade started).
//
// Two physical clients sharing one apiKey will land on different IP/UA
// hashes and stay isolated; same client across turns lands on the same
// hash and lets the cascade pool reuse the upstream session.
function ipUaFingerprint(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  if (!ip && !ua) return '';
  return sha256Hex(`${ip}\0${ua}`).slice(0, 16);
}

export function callerKeyFromRequest(req, apiKey = '', body = null) {
  const bodySubKey = body ? extractBodyCallerSubKey(body) : '';
  if (apiKey) {
    const base = `api:${sha256Hex(apiKey).slice(0, 32)}`;
    if (bodySubKey) return `${base}:user:${bodySubKey}`;
    const ipua = ipUaFingerprint(req);
    return ipua ? `${base}:client:${ipua}` : base;
  }
  const sessionId = req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id'] || '';
  if (sessionId) {
    const base = `session:${sha256Hex(sessionId).slice(0, 32)}`;
    return bodySubKey ? `${base}:user:${bodySubKey}` : base;
  }
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  const base = `client:${sha256Hex(`${ip}\0${ua}`).slice(0, 32)}`;
  return bodySubKey ? `${base}:user:${bodySubKey}` : base;
}

// Returns true if we have any per-user signal beyond the bare API key.
// chat.js consults this to decide whether to allow conversation reuse for a
// shared API key with no user dimension — pre-v2.0.25 we did, which let two
// concurrent end users on the same proxy key share each other's cascade
// state. Now defaults to off; set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to
// restore the legacy permissive behavior.
export function hasCallerScope(callerKey, req, body) {
  if (typeof callerKey === 'string') {
    if (callerKey.includes(':user:')) return true;
    // Match :client: anywhere — apiKey-mode now appends `:client:<ip+ua>`
    // as a fallback subkey when there's no body user signal, so the
    // scope check has to look past the prefix.
    if (callerKey.includes(':client:')) return true;
    if (callerKey.startsWith('session:') || callerKey.startsWith('client:')) return true;
  }
  if (body && extractBodyCallerSubKey(body)) return true;
  if (req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id']) return true;
  return false;
}
