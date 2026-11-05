// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { JSONWebKeySet } from 'jose';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { Fingerprint } from './fingerprint.js';
import { isOwnNonce } from './fingerprint.js';
import { PRODUCT_KEY } from './hub-client.js';

/** How long the last verified licence carries the server without the Hub (design §9f). */
export const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** What this server reads out of a verified token. The `features` claim is not read (§9f). */
export interface LicenceClaims {
  /** Unix seconds, signed: the grace clock starts here, so editing a stored copy cannot move it. */
  readonly issuedAt: number;
  /** The licence's real end, a date; valid through the end of that day, UTC. */
  readonly validUntil: string;
  /** The customer's Service Desk id. */
  readonly customer: string;
}

export class TokenRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRejected';
  }
}

export interface VerifyOptions {
  readonly keys: JSONWebKeySet;
  readonly fingerprint: Fingerprint;
  readonly now: number;
  /**
   * `fresh`: just answered by the Hub, so its 5-minute `exp` must hold. `stored`: restored after a
   * restart, so `exp` has long passed and the 30 days from `iat` decide instead.
   */
  readonly as: 'fresh' | 'stored';
}

/**
 * Trust a licence token only once all of these hold: an ES256 signature from one of the Hub's
 * keys, `aud` naming this product, a nonce this installation sent, and a licence that has not
 * ended. Any one failing is a rejection, never a partial trust.
 */
export async function verifyLicenceToken(token: string, options: VerifyOptions): Promise<LicenceClaims> {
  let unverifiedIat: unknown;
  try {
    unverifiedIat = decodeJwt(token).iat;
  } catch {
    throw new TokenRejected('the licence token is not a JWT');
  }
  if (typeof unverifiedIat !== 'number') throw new TokenRejected('the licence token has no issue time');

  // A stored token is judged as of the moment it was issued, which is the only moment its
  // 5-minute `exp` was ever going to hold. The signature check below makes that `iat` trustworthy;
  // the grace window is then measured from it against the real clock.
  const asOf = options.as === 'fresh' ? options.now : unverifiedIat * 1000;

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, createLocalJWKSet(options.keys), {
      algorithms: ['ES256'],
      audience: PRODUCT_KEY,
      currentDate: new Date(asOf),
      clockTolerance: 60,
    }));
  } catch (error) {
    throw new TokenRejected(`the licence token did not verify: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isOwnNonce(options.fingerprint, payload.nonce)) {
    throw new TokenRejected('the licence token was issued to another installation');
  }

  const issuedAt = payload.iat;
  const validUntil = payload.validUntil;
  if (typeof issuedAt !== 'number' || typeof validUntil !== 'string') {
    throw new TokenRejected('the licence token lacks its issue time or its end date');
  }
  const ends = endOfDay(validUntil);
  if (ends === undefined) throw new TokenRejected(`the licence end date is not a date: ${validUntil}`);
  if (options.now >= ends) throw new TokenRejected(`the licence ended on ${validUntil}`);
  if (options.as === 'stored' && options.now - issuedAt * 1000 > GRACE_MS) {
    throw new TokenRejected('the stored licence is more than 30 days old');
  }

  return {
    issuedAt,
    validUntil,
    customer: typeof payload.sub === 'string' ? payload.sub : '',
  };
}

/** The first instant after `date` (yyyy-MM-dd, UTC), or `undefined` when it is not a date. */
export function endOfDay(date: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (match === null) return undefined;
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(start) ? undefined : start + 24 * 60 * 60 * 1000;
}
