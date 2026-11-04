// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { RefusalCode } from './hub-client.js';
import type { LicenceClaims } from './token.js';
import { endOfDay, GRACE_MS } from './token.js';

/**
 * - `open` — the Hub confirmed the licence on the last call.
 * - `grace` — the Hub cannot be reached, and the last licence it confirmed is under 30 days old.
 * - `closed` — refused, ended, never confirmed, or the grace period ran out. Tools are refused.
 */
export type LicenceStatus = 'open' | 'grace' | 'closed';

export interface LicenceView {
  readonly status: LicenceStatus;
  /** Why it is not open, in words an operator acts on. Absent while open. */
  readonly reason?: string;
  /** The refusal the Hub gave, when that is why it is closed. */
  readonly code?: RefusalCode;
  readonly validUntil?: string;
  /** When the Hub last confirmed the licence (ms), by the token's signed issue time. */
  readonly confirmedAt?: number;
  /** While in grace: when it runs out (ms). */
  readonly graceEndsAt?: number;
}

export interface LicenceState {
  view(now?: number): LicenceView;
  isAdmitted(now?: number): boolean;
  /** A verified token, fresh from the Hub. */
  confirmed(claims: LicenceClaims): void;
  /** A verified token from the store, at startup with the Hub unreachable. */
  restored(claims: LicenceClaims): void;
  /** No answer that says anything about the licence. Keeps whatever grace there is. */
  unreachable(reason: string): void;
  /** The Hub said no: closed until a later call succeeds, whatever grace there was. */
  refused(code: RefusalCode, reason: string): void;
}

const REASONS: Record<RefusalCode, string> = {
  invalid_request: 'the Synergy Hub rejected the request as malformed (invalid_request); this is a server bug — report it',
  usage_invalid: 'the Synergy Hub rejected the usage report (usage_invalid); this is a server bug — report it',
  license_suspended: 'the licence is suspended in the Synergy Hub; it works again as soon as it is reinstated',
  unknown_key: 'the Synergy Hub does not recognise the licence key; check LICENSE_KEY',
  revoked: 'the licence key has been revoked in the Synergy Hub',
  no_active_entitlement: 'the licence has no active entitlement for this product in the Synergy Hub — it may have ended',
  no_seat: 'every seat of this licence is in use; free one in the Synergy Hub or add seats',
  fingerprint_reject: 'the Synergy Hub superseded this installation; it will activate again',
};

export function reasonFor(code: RefusalCode): string {
  return REASONS[code];
}

export function createLicenceState(clock: () => number = Date.now): LicenceState {
  let claims: LicenceClaims | undefined;
  /** Set while the last answer was not a confirmation. */
  let trouble: { kind: 'unreachable' | 'refused'; reason: string; code?: RefusalCode } | undefined = {
    kind: 'unreachable',
    reason: 'the licence has not been confirmed with the Synergy Hub yet',
  };

  const view = (now = clock()): LicenceView => {
    const confirmed =
      claims === undefined
        ? {}
        : { validUntil: claims.validUntil, confirmedAt: claims.issuedAt * 1000 };
    if (claims !== undefined) {
      const ends = endOfDay(claims.validUntil);
      if (ends !== undefined && now >= ends) {
        return { status: 'closed', reason: `the licence ended on ${claims.validUntil}`, ...confirmed };
      }
    }
    if (trouble === undefined) return { status: 'open', ...confirmed };
    if (trouble.kind === 'refused') {
      return { status: 'closed', reason: trouble.reason, ...(trouble.code === undefined ? {} : { code: trouble.code }), ...confirmed };
    }
    if (claims === undefined) return { status: 'closed', reason: trouble.reason };
    const graceEndsAt = claims.issuedAt * 1000 + GRACE_MS;
    if (now < graceEndsAt) return { status: 'grace', reason: trouble.reason, graceEndsAt, ...confirmed };
    return {
      status: 'closed',
      reason: `the Synergy Hub has not confirmed the licence for 30 days (${trouble.reason})`,
      ...confirmed,
    };
  };

  const state: LicenceState = {
    view,
    isAdmitted: (now) => view(now).status !== 'closed',
    confirmed(next) {
      claims = next;
      trouble = undefined;
    },
    restored(next) {
      claims = next;
      trouble = { kind: 'unreachable', reason: 'running on the stored licence; the Synergy Hub has not answered since the restart' };
    },
    unreachable(reason) {
      // A refusal is not softened by a later network error: the Hub's last word on the licence was
      // no, and nothing since has said otherwise.
      if (trouble?.kind === 'refused') return;
      trouble = { kind: 'unreachable', reason };
    },
    refused(code, reason) {
      // Any grace ends with a refusal: the token it rested on vouched for a licence the Hub has
      // since refused.
      claims = undefined;
      trouble = { kind: 'refused', reason, code };
    },
  };
  return state;
}
