// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { JSONWebKeySet } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Fingerprint } from './fingerprint.js';
import { nonceFor } from './fingerprint.js';
import { PRODUCT_KEY } from './hub-client.js';

/**
 * Test-only: a stand-in for the Hub's signing key, generated per test run. Never a real key — the
 * Hub's private keys never leave it, and its public ones are fetched, not committed.
 */
export interface FakeHubKeys {
  readonly keys: JSONWebKeySet;
  sign(claims: TokenOverrides): Promise<string>;
}

export interface TokenOverrides {
  readonly fingerprint: Fingerprint;
  /** Unix seconds. */
  readonly iat: number;
  readonly aud?: string | string[];
  readonly validUntil?: string;
  readonly nonce?: string | null;
  readonly exp?: number;
}

export async function fakeHubKeys(kid = 'test-key-1'): Promise<FakeHubKeys> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'ES256' };
  return {
    keys: { keys: [jwk] },
    sign: (claims) =>
      new SignJWT({
        sub: 'SD-1001',
        licenseType: 'Subscription',
        entitlements: ['IVANTI-MCP'],
        features: [],
        validFrom: '2026-01-01',
        validUntil: claims.validUntil ?? '2099-12-31',
        nonce: claims.nonce === undefined ? nonceFor(claims.fingerprint) : claims.nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuer('https://hub.itsmcloud.lt')
        .setAudience(claims.aud ?? PRODUCT_KEY)
        .setIssuedAt(claims.iat)
        .setExpirationTime(claims.exp ?? claims.iat + 300)
        .sign(privateKey),
  };
}
