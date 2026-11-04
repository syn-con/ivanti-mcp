// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { JSONWebKeySet } from 'jose';
import type { Logger } from '../logger.js';
import type { Fingerprint } from './fingerprint.js';
import { nonceFor } from './fingerprint.js';
import type { HubClient, RefusalCode } from './hub-client.js';
import { HubError } from './hub-client.js';
import type { LicenceState, LicenceStatus } from './licence-state.js';
import { reasonFor } from './licence-state.js';
import type { LicenceStore } from './state-store.js';
import { TokenRejected, verifyLicenceToken } from './token.js';

/** The cadence (design §9f, and SDAP's): every one fixed, not configuration. */
export const TIMINGS = {
  /** Under the token's 5-minute life, so a renewal always lands before it ends. */
  heartbeatMs: 4 * 60 * 1000,
  /** After a refusal that a person has to fix, such as a revoked key or no free seat. */
  refusedRetryMs: 60 * 60 * 1000,
  /** Backoff while the Hub cannot be reached: 30 s, doubling, never longer than a heartbeat. */
  firstRetryMs: 30 * 1000,
  maxRetryMs: 4 * 60 * 1000,
  /** The Hub's rate-limit window is a minute. */
  rateLimitedMs: 60 * 1000,
  /** How often the stored token is rewritten while all is well: a Secret is not rewritten every 4 minutes. */
  saveEveryMs: 60 * 60 * 1000,
  /** How long the Hub's public keys are reused before being fetched again. */
  keysMaxAgeMs: 60 * 60 * 1000,
} as const;

export type Timings = { readonly [K in keyof typeof TIMINGS]: number };

export interface LicensingOptions {
  readonly hub: HubClient;
  readonly fingerprint: Fingerprint;
  readonly state: LicenceState;
  readonly store: LicenceStore;
  readonly logger: Logger;
  readonly clock?: () => number;
  readonly timings?: Partial<Timings>;
}

export interface Licensing {
  /** Settles once the first attempt has finished, whatever its outcome. Never rejects. */
  readonly firstAttempt: Promise<void>;
  /** Settles once no attempt is in flight. A test waits on it, since the token check is real crypto. */
  whenIdle(): Promise<void>;
  stop(): void;
}

/**
 * The licence's life in this process: activate, then a heartbeat every 4 minutes, each answer
 * moving the licence state (design §9f, the table in *Runtime flow*). It never throws and never
 * blocks startup: an unreachable Hub is a state, not a failure of the server.
 */
export function startLicensing(options: LicensingOptions): Licensing {
  const { hub, fingerprint, state, store, logger } = options;
  const clock = options.clock ?? Date.now;
  const timings: Timings = { ...TIMINGS, ...options.timings };

  let activationId: string | undefined;
  let keys: { set: JSONWebKeySet; fetchedAt: number } | undefined;
  let lastSaved = 0;
  let failures = 0;
  let restoreTried = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const publicKeys = async (force: boolean): Promise<JSONWebKeySet> => {
    if (!force && keys !== undefined && clock() - keys.fetchedAt < timings.keysMaxAgeMs) return keys.set;
    const set = await hub.publicKeys();
    keys = { set, fetchedAt: clock() };
    return set;
  };

  /** Verify a token fresh from the Hub; on a signature miss, fetch the keys once more — they rotate. */
  const confirm = async (token: string, wasOpen: boolean): Promise<void> => {
    const cached = keys !== undefined && clock() - keys.fetchedAt < timings.keysMaxAgeMs;
    let set = await publicKeys(false);
    let claims;
    try {
      claims = await verifyLicenceToken(token, { keys: set, fingerprint, now: clock(), as: 'fresh' });
    } catch (error) {
      // Only cached keys are worth a second look: keys fetched a moment ago are the Hub's current set.
      if (!(error instanceof TokenRejected) || !cached) throw error;
      set = await publicKeys(true);
      claims = await verifyLicenceToken(token, { keys: set, fingerprint, now: clock(), as: 'fresh' });
    }
    state.confirmed(claims);
    if (!wasOpen || clock() - lastSaved >= timings.saveEveryMs) {
      try {
        await store.save({ token, keys: set, savedAt: clock() });
        lastSaved = clock();
      } catch (error) {
        logger.warn('licence: could not store the confirmed licence; a restart without the Hub will not reopen from it', {
          store: store.describe,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const activate = async (wasOpen: boolean): Promise<void> => {
    const activation = await hub.activate(fingerprint, nonceFor(fingerprint));
    activationId = activation.activationId;
    await confirm(activation.token.token, wasOpen);
  };

  const renew = async (wasOpen: boolean): Promise<void> => {
    if (activationId === undefined) {
      await activate(wasOpen);
      return;
    }
    try {
      const token = await hub.heartbeat(activationId, fingerprint, nonceFor(fingerprint));
      await confirm(token.token, wasOpen);
    } catch (error) {
      // Not always the key: an admin deactivating this installation in the Hub answers `revoked`
      // too, and so does a superseded activation (`fingerprint_reject`). Activating again takes a
      // seat if one is free, which the Hub intends; if the key is gone, activate says so.
      if (error instanceof HubError && (error.code === 'revoked' || error.code === 'fingerprint_reject')) {
        activationId = undefined;
        await activate(wasOpen);
        return;
      }
      throw error;
    }
  };

  /** At startup only, and only when the Hub gave no answer: the stored licence, if it still holds. */
  const restore = async (): Promise<void> => {
    restoreTried = true;
    const stored = await store.load();
    if (stored === undefined) return;
    try {
      const claims = await verifyLicenceToken(stored.token, { keys: stored.keys, fingerprint, now: clock(), as: 'stored' });
      state.restored(claims);
      keys = { set: stored.keys, fetchedAt: 0 };
      lastSaved = stored.savedAt;
      logger.info('licence: running on the stored licence until the Synergy Hub answers', {
        store: store.describe,
        validUntil: claims.validUntil,
      });
    } catch (error) {
      logger.warn('licence: the stored licence cannot be used', {
        store: store.describe,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const refused = async (code: RefusalCode): Promise<number> => {
    // A suspension clears by itself and the activation still stands, so it keeps its schedule and
    // its activation. Everything else needs a person, and a new activation once they have acted.
    if (code !== 'license_suspended') activationId = undefined;
    state.refused(code, reasonFor(code));
    try {
      await store.clear();
    } catch (error) {
      logger.warn('licence: could not clear the stored licence', {
        store: store.describe,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return code === 'license_suspended' ? timings.heartbeatMs : timings.refusedRetryMs;
  };

  /** One attempt; answers how long to wait before the next. */
  const attempt = async (): Promise<number> => {
    const wasOpen = state.view().status === 'open';
    try {
      await renew(wasOpen);
      failures = 0;
      return timings.heartbeatMs;
    } catch (error) {
      if (error instanceof HubError && error.kind === 'refused' && error.code !== undefined) {
        failures = 0;
        return refused(error.code);
      }
      if (error instanceof HubError && error.kind === 'rate_limited') return timings.rateLimitedMs;
      // Unreachable, a token that would not verify, or anything unforeseen: none of these says the
      // licence is gone, so whatever grace there is holds.
      state.unreachable(error instanceof Error ? error.message : String(error));
      if (!restoreTried && !state.isAdmitted()) await restore();
      failures += 1;
      return Math.min(timings.firstRetryMs * 2 ** (failures - 1), timings.maxRetryMs);
    }
  };

  let reported: LicenceStatus | undefined;
  const report = (): void => {
    const view = state.view();
    if (view.status === reported) return;
    reported = view.status;
    const fields = {
      ...(view.reason === undefined ? {} : { reason: view.reason }),
      ...(view.validUntil === undefined ? {} : { validUntil: view.validUntil }),
      ...(view.graceEndsAt === undefined ? {} : { graceEndsAt: new Date(view.graceEndsAt).toISOString() }),
    };
    if (view.status === 'open') logger.info('licence: confirmed by the Synergy Hub', fields);
    else if (view.status === 'grace') logger.warn('licence: the Synergy Hub cannot be reached; running on grace', fields);
    else logger.error('licence: not licensed — tools are refused until the Synergy Hub confirms it', fields);
  };

  let inFlight: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    inFlight = (async (): Promise<void> => {
      const delay = await attempt();
      report();
      if (stopped) return;
      timer = setTimeout(() => void run(), delay);
      // Never what keeps the process alive: stdio ends when its client goes, HTTP when it is stopped.
      timer.unref();
    })().catch((error: unknown) => {
      logger.error('licence: the licensing loop failed', { reason: error instanceof Error ? error.message : String(error) });
    });
    return inFlight;
  };

  const firstAttempt = run();

  return {
    firstAttempt,
    whenIdle: () => inFlight,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
