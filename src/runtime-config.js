/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by a
 * small JSON file next to the project root so it survives redeploys.
 *
 * Currently hosts the "experimental" feature flags. Keep this tiny: anything
 * that needs a restart should stay in config.js / .env.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from './fs-atomic.js';
import { resolve } from 'path';
import { config, log } from './config.js';

const FILE = resolve(config.dataDir, 'runtime-config.json');

const DEFAULTS = {
  experimental: {
    // Reuse Cascade cascade_id across multi-turn requests when the history
    // fingerprint matches. Big latency win for long conversations but relies
    // on Windsurf keeping the cascade alive — off by default.
    cascadeConversationReuse: true,
    // Pre-flight rate limit check via server.codeium.com before sending a
    // chat request. Reduces wasted attempts when the account has no message
    // capacity. Adds one network round-trip per attempt so off by default.
    preflightRateLimit: false,
    // Caller-aware account scheduler. When ON, getApiKey adds extra terms
    // to the account-selection score: stick same caller (callerKey) to
    // accounts they recently used so Anthropic prompt-cache prefixes survive
    // even when the conversation-pool fingerprint missed; demote accounts
    // that are approaching their RPM cap (so the next request doesn't
    // tip them over) and accounts that just reported upstream errors
    // (self-cooldown until they recover). When OFF (default) the original
    // inflight + RPM-headroom + LRU scoring is used unchanged.
    callerAffinityScheduler: false,
  },
  scheduler: {
    // TTL for stick-to-same-account memory of a callerKey. 5 min matches
    // Anthropic's prompt-cache TTL — past that the cache is gone anyway,
    // so spreading across the pool is fine.
    callerAffinityTtlMs: 5 * 60 * 1000,
    // RPM-utilization threshold above which an account is demoted to
    // discourage piling onto a near-full account.
    rpmWarningThreshold: 0.85,
    // Once an account hits this many consecutive upstream errors, hold it
    // in cooldown (see errorCooldownMs) before considering it again.
    consecutiveErrorThreshold: 3,
    errorCooldownMs: 5 * 60 * 1000,
    // Long-window load-balance signal — penalize accounts that took too
    // many requests over the last hour relative to the pool mean.
    loadBalanceWindowMs: 60 * 60 * 1000,
    // Score weights. All terms are normalized to [0,1] before weighting.
    // Larger means stronger pull / push.
    weights: {
      inflight: 1.0,        // pull: prefer fewer in-flight requests
      rpmHeadroom: 0.7,     // pull: prefer larger remaining RPM ratio
      callerAffinity: 0.6,  // pull: same callerKey recently → strong stick
      warmCascade: 0.5,     // pull: account has live cascade for this caller
      approachLimit: 0.8,   // push: discount accounts close to RPM cap
      recentError: 1.0,     // push: discount accounts with recent upstream errors
      loadImbalance: 0.3,   // push: long-term over-served accounts
    },
  },
  // System-level prompt templates injected into Cascade proto fields.
  // Editable from Dashboard so users can tune without code changes.
  systemPrompts: {
    toolReinforcement: 'The functions listed above are available and callable. When the user\'s request can be answered by calling a function, emit a <tool_call> block as described. Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
    communicationWithTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation). Use the functions above when relevant.',
    communicationNoTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. Answer directly. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation).',
  },
};

const SYSTEM_PROMPT_KEYS = new Set(Object.keys(DEFAULTS.systemPrompts));

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    // Skip prototype-polluting keys — the JSON loaded here is user-writable
    // via the dashboard, and a crafted key would otherwise corrupt every
    // object in the process.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    _state = deepMerge(DEFAULTS, raw);
  } catch (e) {
    log.warn(`runtime-config: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeJsonAtomic(FILE, _state);
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  // Coerce to booleans — the dashboard ships JSON but we never want truthy
  // strings sneaking in as "true".
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

/**
 * Read the active scheduler config (defaults merged with whatever the dashboard
 * has persisted). Returns a deep copy so callers can't accidentally mutate
 * the live state by reference.
 */
export function getSchedulerConfig() {
  const dflt = DEFAULTS.scheduler;
  const cur = _state.scheduler || {};
  return {
    callerAffinityTtlMs: Number.isFinite(cur.callerAffinityTtlMs) && cur.callerAffinityTtlMs > 0
      ? cur.callerAffinityTtlMs : dflt.callerAffinityTtlMs,
    rpmWarningThreshold: Number.isFinite(cur.rpmWarningThreshold)
      ? Math.min(1, Math.max(0, cur.rpmWarningThreshold)) : dflt.rpmWarningThreshold,
    consecutiveErrorThreshold: Number.isFinite(cur.consecutiveErrorThreshold) && cur.consecutiveErrorThreshold > 0
      ? cur.consecutiveErrorThreshold : dflt.consecutiveErrorThreshold,
    errorCooldownMs: Number.isFinite(cur.errorCooldownMs) && cur.errorCooldownMs >= 0
      ? cur.errorCooldownMs : dflt.errorCooldownMs,
    loadBalanceWindowMs: Number.isFinite(cur.loadBalanceWindowMs) && cur.loadBalanceWindowMs > 0
      ? cur.loadBalanceWindowMs : dflt.loadBalanceWindowMs,
    weights: { ...dflt.weights, ...(cur.weights || {}) },
  };
}

export function getSystemPrompts() {
  const out = { ...DEFAULTS.systemPrompts };
  for (const key of SYSTEM_PROMPT_KEYS) {
    if (typeof _state.systemPrompts?.[key] === 'string') {
      out[key] = _state.systemPrompts[key];
    }
  }
  return out;
}

export function setSystemPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getSystemPrompts();
  const current = _state.systemPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (!SYSTEM_PROMPT_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.systemPrompts = current;
  persist();
  return getSystemPrompts();
}

export function resetSystemPrompt(key) {
  if (key) {
    if (_state.systemPrompts && SYSTEM_PROMPT_KEYS.has(key)) delete _state.systemPrompts[key];
  } else {
    _state.systemPrompts = {};
  }
  persist();
  return getSystemPrompts();
}

