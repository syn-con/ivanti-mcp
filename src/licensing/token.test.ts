// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { fingerprintFor } from './fingerprint.js';
import { fakeHubKeys } from './hub-keys.fixture.js';
import { GRACE_MS, TokenRejected, verifyLicenceToken } from './token.js';

const FINGERPRINT = fingerprintFor({ installId: '3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03' });
const OTHER = fingerprintFor({ installId: '00000000-0000-4000-8000-000000000009' });
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const IAT = Math.floor(NOW / 1000);
const DAY = 24 * 60 * 60 * 1000;

describe('verifyLicenceToken', () => {
  it('trusts a fresh token from the Hub and reads its end date', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT, validUntil: '2027-03-31' });

    const claims = await verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' });

    expect(claims).toEqual({ issuedAt: IAT, validUntil: '2027-03-31', customer: 'SD-1001' });
  });

  it('accepts an audience array that includes this product', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT, aud: ['another-product', 'ivanti-mcp-standalone'] });

    await expect(verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' })).resolves.toBeDefined();
  });

  it.each([
    ['signed by a key the Hub does not publish', 'other-key'],
    ['for another product', 'audience'],
    ['issued to another installation', 'nonce'],
    ['without a nonce', 'no-nonce'],
    ['for a licence that has ended', 'ended'],
  ] as const)('refuses a token %s', async (_label, kind) => {
    const hub = await fakeHubKeys();
    const stranger = await fakeHubKeys();
    const base = { fingerprint: FINGERPRINT, iat: IAT };
    const token =
      kind === 'other-key'
        ? await stranger.sign(base)
        : kind === 'audience'
          ? await hub.sign({ ...base, aud: 'some-other-product' })
          : kind === 'nonce'
            ? await hub.sign({ ...base, fingerprint: OTHER })
            : kind === 'no-nonce'
              ? await hub.sign({ ...base, nonce: null })
              : await hub.sign({ ...base, validUntil: '2026-11-03' });

    await expect(
      verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' }),
    ).rejects.toThrow(TokenRejected);
  });

  it('keeps a licence valid through the whole of its last day', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT, validUntil: '2026-11-04' });

    await expect(verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' })).resolves.toBeDefined();
  });

  it('refuses a fresh token past its 5-minute expiry', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT - 3600 });

    await expect(
      verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' }),
    ).rejects.toThrow(TokenRejected);
  });

  it('restores a stored token long past its expiry, within 30 days of issue', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT });

    const claims = await verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW + 29 * DAY, as: 'stored' });

    expect(claims.issuedAt).toBe(IAT);
  });

  it('refuses a stored token more than 30 days old', async () => {
    const hub = await fakeHubKeys();
    const token = await hub.sign({ fingerprint: FINGERPRINT, iat: IAT });

    await expect(
      verifyLicenceToken(token, { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW + GRACE_MS + 1000, as: 'stored' }),
    ).rejects.toThrow(/more than 30 days old/);
  });

  it('refuses a stored token whose payload was edited to look newer', async () => {
    const hub = await fakeHubKeys();
    const [header, , signature] = (await hub.sign({ fingerprint: FINGERPRINT, iat: IAT })).split('.');
    const forged = Buffer.from(JSON.stringify({ aud: 'ivanti-mcp-standalone', iat: IAT + 40 * 86_400, validUntil: '2099-12-31' })).toString('base64url');

    await expect(
      verifyLicenceToken(`${header ?? ''}.${forged}.${signature ?? ''}`, {
        keys: hub.keys,
        fingerprint: FINGERPRINT,
        now: NOW + 40 * DAY,
        as: 'stored',
      }),
    ).rejects.toThrow(TokenRejected);
  });

  it('refuses something that is not a JWT at all', async () => {
    const hub = await fakeHubKeys();

    await expect(
      verifyLicenceToken('not-a-token', { keys: hub.keys, fingerprint: FINGERPRINT, now: NOW, as: 'fresh' }),
    ).rejects.toThrow(/not a JWT/);
  });
});
