// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { fingerprintFor, nonceFor } from './fingerprint.js';
import { startLicensing, TIMINGS } from './heartbeat.js';
import type { Activation, HubClient, RefusalCode, SignedToken } from './hub-client.js';
import { HubError } from './hub-client.js';
import type { FakeHubKeys } from './hub-keys.fixture.js';
import { fakeHubKeys } from './hub-keys.fixture.js';
import { createLicenceState } from './licence-state.js';
import type { LicenceStore, StoredLicence } from './state-store.js';

const FINGERPRINT = fingerprintFor({ installId: '3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03' });
const START = Date.UTC(2026, 10, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

type Answer = 'ok' | HubError;

/** A Hub that signs with test keys and answers each call as told. */
function fakeHub(keys: FakeHubKeys) {
  let signer = keys;
  const answers: { activate: Answer; heartbeat: Answer; publicKeys: Answer } = { activate: 'ok', heartbeat: 'ok', publicKeys: 'ok' };
  const calls: string[] = [];
  const tokenFor = async (nonce: string): Promise<SignedToken> => ({
    token: await signer.sign({ fingerprint: FINGERPRINT, iat: Math.floor(Date.now() / 1000), nonce }),
    kid: 'test-key-1',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const answer = (name: keyof typeof answers): void => {
    calls.push(name);
    const set = answers[name];
    if (set !== 'ok') throw set;
  };
  const hub: HubClient = {
    async activate(_fingerprint, nonce): Promise<Activation> {
      answer('activate');
      return { activationId: 'act-1', token: await tokenFor(nonce) };
    },
    async heartbeat(_id, _fingerprint, nonce): Promise<SignedToken> {
      answer('heartbeat');
      return tokenFor(nonce);
    },
    publicKeys() {
      answer('publicKeys');
      return Promise.resolve(signer.keys);
    },
  };
  return {
    hub,
    calls,
    answer: (name: keyof typeof answers, value: Answer) => {
      answers[name] = value;
    },
    rotate: (next: FakeHubKeys) => {
      signer = next;
    },
  };
}

function memoryStore(initial?: StoredLicence) {
  let held = initial;
  const store: LicenceStore & { saves: number } = {
    describe: 'memory',
    saves: 0,
    load: () => Promise.resolve(held),
    save(licence) {
      store.saves += 1;
      held = licence;
      return Promise.resolve();
    },
    clear() {
      held = undefined;
      return Promise.resolve();
    },
  };
  return { store, held: () => held };
}

const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
/**
 * Moves the clock on in steps, letting each attempt finish between them: an attempt signs and
 * verifies with real crypto, which settles outside the fake clock.
 */
async function advance(licensing: { whenIdle(): Promise<void> }, ms: number, step = 10_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await licensing.whenIdle();
  }
}

const unreachable = (): HubError => new HubError('unreachable', 'Could not reach the Synergy Hub: ECONNREFUSED');
const refusal = (code: RefusalCode): HubError => new HubError('refused', `refused: ${code}`, code, 403);

describe('startLicensing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(options: { stored?: StoredLicence } = {}) {
    const keys = await fakeHubKeys();
    const hub = fakeHub(keys);
    const { store, held } = memoryStore(options.stored);
    const state = createLicenceState();
    const licensing = startLicensing({ hub: hub.hub, fingerprint: FINGERPRINT, state, store, logger: silent });
    return { keys, hub, store, held, state, licensing };
  }

  it('activates at start, then heartbeats every 4 minutes on the same activation', async () => {
    const { hub, state, licensing, store } = await start();
    await licensing.firstAttempt;

    expect(state.view().status).toBe('open');
    expect(hub.calls).toEqual(['activate', 'publicKeys']);
    expect(store.saves).toBe(1);

    await advance(licensing, TIMINGS.heartbeatMs);
    expect(hub.calls.at(-1)).toBe('heartbeat');
    expect(state.view().status).toBe('open');
    // Not rewritten every heartbeat: a Secret write every 4 minutes buys nothing.
    expect(store.saves).toBe(1);
    licensing.stop();
  });

  it('rewrites the stored licence once an hour while all is well', async () => {
    const { licensing, store } = await start();
    await licensing.firstAttempt;

    await advance(licensing, TIMINGS.saveEveryMs + TIMINGS.heartbeatMs);

    expect(store.saves).toBe(2);
    licensing.stop();
  });

  it('starts closed when the Hub cannot be reached and nothing is stored, and backs off', async () => {
    const keys = await fakeHubKeys();
    const hub = fakeHub(keys);
    hub.answer('activate', unreachable());
    const state = createLicenceState();
    const licensing = startLicensing({ hub: hub.hub, fingerprint: FINGERPRINT, state, store: memoryStore().store, logger: silent });
    await licensing.firstAttempt;

    expect(state.view()).toMatchObject({ status: 'closed', reason: expect.stringContaining('ECONNREFUSED') as string });

    const before = hub.calls.filter((c) => c === 'activate').length;
    await advance(licensing, TIMINGS.firstRetryMs);
    expect(hub.calls.filter((c) => c === 'activate').length).toBe(before + 1);

    hub.answer('activate', 'ok');
    await advance(licensing, 2 * TIMINGS.firstRetryMs);
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('reopens from the stored licence after a restart while the Hub is away', async () => {
    const keys = await fakeHubKeys();
    const issued = Math.floor((START - 2 * DAY) / 1000);
    const stored: StoredLicence = {
      token: await keys.sign({ fingerprint: FINGERPRINT, iat: issued, nonce: nonceFor(FINGERPRINT) }),
      keys: keys.keys,
      savedAt: START - 2 * DAY,
    };
    const hub = fakeHub(keys);
    hub.answer('activate', unreachable());
    hub.answer('publicKeys', unreachable());
    const state = createLicenceState();
    const licensing = startLicensing({ hub: hub.hub, fingerprint: FINGERPRINT, state, store: memoryStore(stored).store, logger: silent });
    await licensing.firstAttempt;

    expect(state.view()).toMatchObject({ status: 'grace', graceEndsAt: issued * 1000 + 30 * DAY });

    hub.answer('activate', 'ok');
    hub.answer('publicKeys', 'ok');
    await advance(licensing, TIMINGS.firstRetryMs);
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('does not reopen from a stored licence issued to another installation', async () => {
    const keys = await fakeHubKeys();
    const other = fingerprintFor({ installId: '00000000-0000-4000-8000-000000000009' });
    const stored: StoredLicence = {
      token: await keys.sign({ fingerprint: other, iat: Math.floor(START / 1000) - 60, nonce: nonceFor(other) }),
      keys: keys.keys,
      savedAt: START,
    };
    const hub = fakeHub(keys);
    hub.answer('activate', unreachable());
    const state = createLicenceState();
    const licensing = startLicensing({ hub: hub.hub, fingerprint: FINGERPRINT, state, store: memoryStore(stored).store, logger: silent });
    await licensing.firstAttempt;

    expect(state.view().status).toBe('closed');
    licensing.stop();
  });

  it('closes on a refusal, clears the stored licence, and asks again only after an hour', async () => {
    const { hub, state, licensing, held } = await start();
    await licensing.firstAttempt;
    expect(held()).toBeDefined();

    hub.answer('heartbeat', refusal('no_seat'));
    await advance(licensing, TIMINGS.heartbeatMs);

    expect(state.view()).toMatchObject({ status: 'closed', code: 'no_seat' });
    expect(held()).toBeUndefined();

    const calls = hub.calls.length;
    await advance(licensing, TIMINGS.refusedRetryMs - 1000);
    expect(hub.calls.length).toBe(calls);
    hub.answer('heartbeat', 'ok');
    await advance(licensing, 1000);
    // The seat was lost, so it activates afresh rather than heartbeating a dead activation.
    expect(hub.calls.slice(calls)).toContain('activate');
    expect(hub.calls.slice(calls)).not.toContain('heartbeat');
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('activates again at once when a heartbeat answers revoked, as an admin deactivation does', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.answer('heartbeat', refusal('revoked'));
    await advance(licensing, TIMINGS.heartbeatMs);

    expect(hub.calls.slice(-2)).toEqual(['heartbeat', 'activate']);
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('closes when activating again is refused too, as for a revoked key', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.answer('heartbeat', refusal('revoked'));
    hub.answer('activate', refusal('revoked'));
    await advance(licensing, TIMINGS.heartbeatMs);

    expect(state.view()).toMatchObject({ status: 'closed', code: 'revoked' });
    licensing.stop();
  });

  it('keeps heartbeating a suspended licence on its normal schedule, and reopens when reinstated', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.answer('heartbeat', refusal('license_suspended'));
    await advance(licensing, TIMINGS.heartbeatMs);
    expect(state.view()).toMatchObject({ status: 'closed', code: 'license_suspended' });

    hub.answer('heartbeat', 'ok');
    await advance(licensing, TIMINGS.heartbeatMs);
    expect(hub.calls.at(-1)).toBe('heartbeat');
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('runs on grace while the Hub is away, and closes after 30 days', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.answer('heartbeat', unreachable());
    await advance(licensing, TIMINGS.heartbeatMs);
    expect(state.view().status).toBe('grace');

    vi.setSystemTime(START + 31 * DAY);
    expect(state.view().status).toBe('closed');
    licensing.stop();
  });

  it('waits out a rate limit without changing the licence', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.answer('heartbeat', new HubError('rate_limited', 'slow down', undefined, 429));
    await advance(licensing, TIMINGS.heartbeatMs);
    expect(state.view().status).toBe('open');

    const calls = hub.calls.length;
    await advance(licensing, TIMINGS.rateLimitedMs);
    expect(hub.calls.length).toBe(calls + 1);
    licensing.stop();
  });

  it('fetches the public keys again when the Hub signs with a new one', async () => {
    const { hub, state, licensing } = await start();
    await licensing.firstAttempt;

    hub.rotate(await fakeHubKeys('test-key-2'));
    await advance(licensing, TIMINGS.heartbeatMs);

    expect(hub.calls.slice(-2)).toEqual(['heartbeat', 'publicKeys']);
    expect(state.view().status).toBe('open');
    licensing.stop();
  });

  it('asks nothing more once stopped', async () => {
    const { hub, licensing } = await start();
    await licensing.firstAttempt;
    licensing.stop();

    const calls = hub.calls.length;
    await advance(licensing, 10 * TIMINGS.heartbeatMs);
    expect(hub.calls.length).toBe(calls);
  });
});
