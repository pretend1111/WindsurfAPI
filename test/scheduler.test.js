import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _scheduleScore,
  recordCallerAffinity,
  recordWarmCascade,
  clearWarmCascade,
  recordAccountError,
  recordAccountSuccess,
} from '../src/auth.js';
import { getSchedulerConfig, setExperimental } from '../src/runtime-config.js';

// _scheduleScore is the inner scoring function; it's exported only for
// these tests. Each test builds a synthetic account object (no shared pool
// state) so the assertions are independent of any other test file.

function makeAccount(overrides = {}) {
  return {
    id: overrides.id || 'a1',
    apiKey: overrides.apiKey || 'k1',
    email: overrides.email || 'a1@x',
    _inflight: 0,
    _consecutiveErrors: 0,
    _errorCooldownUntil: 0,
    _stickAffinity: new Map(),
    _warmCascades: new Map(),
    _reqsTimeline: [],
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    now: Date.now(),
    callerKey: 'caller-A',
    used: 5,
    limit: 60,
    poolMeanReqs: 100,
    sched: getSchedulerConfig(),
    ...overrides,
  };
}

describe('_scheduleScore — caller affinity stickiness', () => {
  it('gives a same-caller account a higher score than an idle stranger', () => {
    const stranger = makeAccount({ id: 'stranger' });
    const sticky   = makeAccount({ id: 'sticky' });
    sticky._stickAffinity.set('caller-A', Date.now() - 1000);

    const c = ctx();
    const sStranger = _scheduleScore(stranger, c);
    const sSticky   = _scheduleScore(sticky,   c);
    assert.ok(sSticky > sStranger,
      `expected sticky > stranger, got ${sSticky} vs ${sStranger}`);
  });

  it('decays affinity over the configured TTL', () => {
    const ttl = getSchedulerConfig().callerAffinityTtlMs;
    const fresh = makeAccount({ id: 'fresh' });
    const old   = makeAccount({ id: 'old' });
    fresh._stickAffinity.set('caller-A', Date.now() - 1000);          // 1s ago
    old._stickAffinity.set('caller-A',   Date.now() - (ttl - 10000));  // 10s before TTL

    const c = ctx();
    const sFresh = _scheduleScore(fresh, c);
    const sOld   = _scheduleScore(old,   c);
    assert.ok(sFresh > sOld,
      `fresh affinity should outscore stale, got ${sFresh} vs ${sOld}`);
  });

  it('ignores affinity for a different caller', () => {
    const a = makeAccount({ id: 'a' });
    const b = makeAccount({ id: 'b' });
    a._stickAffinity.set('caller-OTHER', Date.now());
    // a has affinity but for a different caller — should score the same as b
    const cA = ctx({ callerKey: 'caller-A' });
    const sA = _scheduleScore(a, cA);
    const sB = _scheduleScore(b, cA);
    assert.equal(sA, sB);
  });
});

describe('_scheduleScore — RPM approach-limit demotion', () => {
  it('demotes accounts above the rpmWarningThreshold', () => {
    const cool = makeAccount({ id: 'cool' });
    const hot  = makeAccount({ id: 'hot' });
    const sched = getSchedulerConfig();
    // hot uses 95% of its 60 RPM cap → above 0.85 threshold
    const c1 = ctx({ used: 6, limit: 60 });   // 10% used
    const c2 = ctx({ used: 57, limit: 60 });  // 95% used
    const sCool = _scheduleScore(cool, c1);
    const sHot  = _scheduleScore(hot,  c2);
    assert.ok(sCool > sHot,
      `cool (10% used) should outrank hot (95% used), got ${sCool} vs ${sHot}`);
  });
});

describe('_scheduleScore — error cooldown', () => {
  it('strongly demotes an account in active cooldown', () => {
    const healthy = makeAccount({ id: 'h' });
    const flaky   = makeAccount({ id: 'f',
      _consecutiveErrors: 5,
      _errorCooldownUntil: Date.now() + 60_000,
    });
    const c = ctx();
    const sH = _scheduleScore(healthy, c);
    const sF = _scheduleScore(flaky,   c);
    assert.ok(sH > sF,
      `healthy should outrank flaky in cooldown, got ${sH} vs ${sF}`);
  });

  it('partial demotion before cooldown trips, full after', () => {
    const partial = makeAccount({ id: 'partial', _consecutiveErrors: 1 });
    const full    = makeAccount({ id: 'full',
      _consecutiveErrors: 5,
      _errorCooldownUntil: Date.now() + 60_000,
    });
    const c = ctx();
    const sP = _scheduleScore(partial, c);
    const sF = _scheduleScore(full,    c);
    assert.ok(sP > sF, 'partial demotion should be milder than full cooldown');
  });
});

describe('_scheduleScore — warm cascade boost', () => {
  it('warm cascade beats no-history account at equal load', () => {
    const cold = makeAccount({ id: 'cold' });
    const warm = makeAccount({ id: 'warm' });
    warm._warmCascades.set('caller-A', Date.now() - 5000);

    const c = ctx();
    const sCold = _scheduleScore(cold, c);
    const sWarm = _scheduleScore(warm, c);
    assert.ok(sWarm > sCold,
      `warm cascade should outrank cold start, got ${sWarm} vs ${sCold}`);
  });
});

describe('recordAccountError / recordAccountSuccess', () => {
  // These maintain real account state; smoke-test that the counter moves
  // and that success resets it. The accounts module keeps its pool in
  // module-scope, so we validate behaviour by registering a synthetic
  // apiKey via the (intentionally simple) public surface — here we just
  // poke the helpers directly with invalid keys to confirm graceful no-op.
  it('is a no-op for unknown apiKey', () => {
    assert.doesNotThrow(() => recordAccountError('does-not-exist', 'rate_limit'));
    assert.doesNotThrow(() => recordAccountSuccess('does-not-exist'));
    assert.doesNotThrow(() => recordCallerAffinity('does-not-exist', 'caller'));
    assert.doesNotThrow(() => recordWarmCascade('does-not-exist', 'caller'));
    assert.doesNotThrow(() => clearWarmCascade('does-not-exist', 'caller'));
  });

  it('handles missing callerKey gracefully', () => {
    assert.doesNotThrow(() => recordCallerAffinity('any', ''));
    assert.doesNotThrow(() => recordWarmCascade('any', ''));
  });
});

describe('Bug A — post-cooldown lazy decay', () => {
  // Once the self-cooldown window has naturally elapsed, _ensureSchedulerState
  // should clear both the timestamp and the consecutive-error counter so the
  // account stops being score-penalized indefinitely. The decay is triggered
  // by any code path that calls _ensureSchedulerState — getApiKey's prune
  // pass, or any record* helper. Here we use recordAccountSuccess on a real
  // pool account because that's the most direct public surface that touches
  // _ensureSchedulerState.
  it('clears _consecutiveErrors when cooldown timestamp is in the past', async () => {
    const { addAccountByKey, recordAccountSuccess, removeAccount } =
      await import('../src/auth.js');
    const apiKey = 'sk-test-buga-' + Math.random().toString(36).slice(2);
    const acct = addAccountByKey(apiKey, 'buga-test');
    try {
      acct._consecutiveErrors = 5;
      acct._errorCooldownUntil = Date.now() - 1000;
      // recordAccountSuccess invokes _ensureSchedulerState which should
      // observe the past cooldown and zero everything.
      recordAccountSuccess(apiKey);
      assert.equal(acct._consecutiveErrors, 0,
        'expired cooldown should have decayed counter to 0');
      assert.equal(acct._errorCooldownUntil, 0,
        'expired cooldown timestamp should have been cleared');
    } finally {
      removeAccount(acct.id);
    }
  });

  it('leaves _consecutiveErrors alone while cooldown is still active', async () => {
    const { addAccountByKey, recordAccountError, removeAccount } =
      await import('../src/auth.js');
    const apiKey = 'sk-test-buga2-' + Math.random().toString(36).slice(2);
    const acct = addAccountByKey(apiKey, 'buga-active');
    try {
      acct._consecutiveErrors = 4;
      acct._errorCooldownUntil = Date.now() + 60_000;
      // Triggers _ensureSchedulerState via the record helper.
      recordAccountError(apiKey, 'rate_limit');
      // _consecutiveErrors should now be 5 (incremented), NOT reset to 0.
      assert.equal(acct._consecutiveErrors, 5,
        'active cooldown must NOT reset counter; record* should still increment');
      assert.ok(acct._errorCooldownUntil > Date.now(),
        'active cooldown timestamp preserved');
    } finally {
      removeAccount(acct.id);
    }
  });
});

describe('Bug F — getAccountAvailability surfaces self_cooldown', () => {
  // We need a real account in the pool to test getAccountAvailability since it
  // does accounts.find. The test reuses the public addAccountByKey + manual
  // state stamping path.
  it('returns reason=self_cooldown with correct retryAfterMs', async () => {
    const { addAccountByKey, getAccountAvailability, removeAccount } =
      await import('../src/auth.js');
    const test_apiKey = 'sk-test-bugf-' + Math.random().toString(36).slice(2);
    const acct = addAccountByKey(test_apiKey, 'bugf-test');
    try {
      acct.tier = 'pro';   // ensure RPM check passes
      acct._errorCooldownUntil = Date.now() + 30_000;   // 30s remaining
      acct._consecutiveErrors = 5;
      const avail = getAccountAvailability(test_apiKey, null);
      assert.equal(avail.available, false);
      assert.equal(avail.reason, 'self_cooldown');
      assert.ok(avail.retryAfterMs >= 25_000 && avail.retryAfterMs <= 31_000,
        `retryAfterMs should be ~30s, got ${avail.retryAfterMs}`);
    } finally {
      removeAccount(acct.id);
    }
  });

  it('does not flag self_cooldown when timestamp is in the past', async () => {
    const { addAccountByKey, getAccountAvailability, removeAccount } =
      await import('../src/auth.js');
    const test_apiKey = 'sk-test-bugf2-' + Math.random().toString(36).slice(2);
    const acct = addAccountByKey(test_apiKey, 'bugf-past');
    try {
      acct.tier = 'pro';
      acct._errorCooldownUntil = Date.now() - 1000;  // expired
      acct._consecutiveErrors = 5;
      const avail = getAccountAvailability(test_apiKey, null);
      // Either available=true (the lazy-decay path cleared the cooldown),
      // or available=false with a different reason — but never self_cooldown.
      assert.notEqual(avail.reason, 'self_cooldown');
    } finally {
      removeAccount(acct.id);
    }
  });
});

describe('Bug D — extractBodyCallerSubKey stable across optional fields', () => {
  it('returns the same subkey for {user} and {user, conversation_id}', async () => {
    const { extractBodyCallerSubKey } = await import('../src/caller-key.js');
    const a = extractBodyCallerSubKey({ user: 'alice' });
    const b = extractBodyCallerSubKey({ user: 'alice', metadata: { conversation_id: 'c1' } });
    assert.equal(a, b,
      'subkey should pin to body.user — adding/removing optional ids must not change it');
  });

  it('returns the same subkey when previous_response_id appears or disappears', async () => {
    const { extractBodyCallerSubKey } = await import('../src/caller-key.js');
    const a = extractBodyCallerSubKey({ user: 'bob', previous_response_id: 'r1' });
    const b = extractBodyCallerSubKey({ user: 'bob' });
    const c = extractBodyCallerSubKey({ user: 'bob', previous_response_id: 'r2' });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('different users produce different subkeys', async () => {
    const { extractBodyCallerSubKey } = await import('../src/caller-key.js');
    const alice = extractBodyCallerSubKey({ user: 'alice' });
    const bob   = extractBodyCallerSubKey({ user: 'bob' });
    assert.notEqual(alice, bob);
  });

  it('falls through to next signal when user is absent', async () => {
    const { extractBodyCallerSubKey } = await import('../src/caller-key.js');
    // user absent → falls through to metadata.conversation_id
    const a = extractBodyCallerSubKey({ metadata: { conversation_id: 'c1' } });
    // Same value via the same priority slot must produce the same hash —
    // that's the whole stability point.
    const b = extractBodyCallerSubKey({ metadata: { conversation_id: 'c1' } });
    assert.equal(a, b);
    // user present should pin on user, not the conversation_id below it.
    const withUser = extractBodyCallerSubKey({ user: 'alice', metadata: { conversation_id: 'c1' } });
    const onlyUser = extractBodyCallerSubKey({ user: 'alice' });
    assert.equal(withUser, onlyUser, 'user should win priority over conversation_id');
    assert.notEqual(withUser, a, 'user-pinned subkey should differ from conversation-pinned');
  });

  it('returns empty string when no signals present', async () => {
    const { extractBodyCallerSubKey } = await import('../src/caller-key.js');
    assert.equal(extractBodyCallerSubKey({}), '');
    assert.equal(extractBodyCallerSubKey(null), '');
    assert.equal(extractBodyCallerSubKey('not-an-object'), '');
  });
});

describe('runtime-config scheduler defaults', () => {
  it('returns sane defaults', () => {
    const s = getSchedulerConfig();
    assert.ok(s.callerAffinityTtlMs > 0);
    assert.ok(s.rpmWarningThreshold > 0 && s.rpmWarningThreshold < 1);
    assert.ok(s.consecutiveErrorThreshold > 0);
    assert.ok(s.errorCooldownMs > 0);
    assert.ok(s.weights.callerAffinity > 0);
    assert.ok(s.weights.recentError > 0);
  });
});

describe('callerAffinityScheduler experimental flag', () => {
  let prev;
  beforeEach(() => { prev = !!process.env.__SCHED_TEST_FLAG_PREV; });
  afterEach(() => {
    // Reset the flag to a known state regardless of what each test set.
    setExperimental({ callerAffinityScheduler: false });
  });

  it('toggling the flag is a pure setter, no side effects on score function', () => {
    setExperimental({ callerAffinityScheduler: true });
    setExperimental({ callerAffinityScheduler: false });
    // The pure score function still runs identically — toggling is just
    // about whether getApiKey *consults* it.
    const a1 = makeAccount();
    const a2 = makeAccount({ _consecutiveErrors: 5, _errorCooldownUntil: Date.now() + 60_000 });
    const c = ctx();
    assert.ok(_scheduleScore(a1, c) > _scheduleScore(a2, c));
  });
});
