// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { fingerprintFor } from './fingerprint.js';
import type { HubError } from './hub-client.js';
import { createHubClient, DEFAULT_HUB_URL, REFUSAL_CODES } from './hub-client.js';

const KEY = 'lic_secret_value_1234';
const FINGERPRINT = fingerprintFor({ installId: '3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03' });
const TOKEN = { token: 'a.b.c', kid: 'k1', expiresAt: '2026-11-04T10:05:00Z' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, title: string) =>
  json(status, { type: 'about:blank', title, status, detail: 'words', traceId: 't' });

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fetch that answers with `answer` and records what was sent. */
function recordingFetch(answer: () => Response | Promise<Response>): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    sent.push({
      url: url instanceof Request ? url.url : url.toString(),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return answer();
  };
  return { fetchImpl, sent };
}

function client(answer: () => Response | Promise<Response>): { hub: ReturnType<typeof createHubClient>; sent: Sent[] } {
  const { fetchImpl, sent } = recordingFetch(answer);
  return { hub: createHubClient({ licenceKey: KEY, fetchImpl }), sent };
}

async function failure(promise: Promise<unknown>): Promise<HubError> {
  try {
    await promise;
  } catch (error) {
    return error as HubError;
  }
  throw new Error('expected a failure');
}

describe('createHubClient', () => {
  it('activates with the key in its header and the fingerprint in the body', async () => {
    const { hub, sent } = client(() => json(200, { activationId: 'act-1', token: TOKEN }));

    const activation = await hub.activate(FINGERPRINT, 'n.1');

    expect(activation).toEqual({ activationId: 'act-1', token: TOKEN });
    const [request] = sent;
    expect(request?.url).toBe(`${DEFAULT_HUB_URL}/api/v1/activation/activate`);
    expect(request?.method).toBe('POST');
    expect(request?.headers['x-license-key']).toBe(KEY);
    // The key travels in the header only: never in the URL, never in the body.
    expect(request?.url).not.toContain(KEY);
    expect(request?.body).not.toContain(KEY);
    expect(JSON.parse(request?.body ?? '')).toEqual({
      machineGuid: FINGERPRINT.machineGuid,
      biosUuid: FINGERPRINT.biosUuid,
      installGuid: FINGERPRINT.installGuid,
      nonce: 'n.1',
    });
  });

  it('heartbeats with the activation and the same fingerprint', async () => {
    const { hub, sent } = client(() => json(200, TOKEN));

    expect(await hub.heartbeat('act-1', FINGERPRINT, 'n.2')).toEqual(TOKEN);
    const [request] = sent;
    expect(request?.url).toBe(`${DEFAULT_HUB_URL}/api/v1/activation/heartbeat`);
    expect(JSON.parse(request?.body ?? '')).toMatchObject({ activationId: 'act-1', installGuid: FINGERPRINT.installGuid });
  });

  it('fetches the public keys without the licence key', async () => {
    const { hub, sent } = client(() => json(200, { keys: [] }));

    expect(await hub.publicKeys()).toEqual({ keys: [] });
    const [request] = sent;
    expect(request?.url).toBe(`${DEFAULT_HUB_URL}/.well-known/jwks.json`);
    expect(request?.headers).not.toHaveProperty('x-license-key');
  });

  it.each(REFUSAL_CODES)('reads %s from the ProblemDetails title as a refusal', async (code) => {
    const status = code === 'no_seat' ? 409 : code === 'invalid_request' || code === 'usage_invalid' ? 400 : 403;
    const { hub } = client(() => problem(status, code));

    const error = await failure(hub.heartbeat('act-1', FINGERPRINT, 'n'));

    expect(error.kind).toBe('refused');
    expect(error.code).toBe(code);
  });

  it('treats a 5xx, the Hub\'s own no_signing_key included, as unreachable', async () => {
    const { hub } = client(() => problem(500, 'no_signing_key'));

    expect((await failure(hub.activate(FINGERPRINT, 'n'))).kind).toBe('unreachable');
  });

  it('treats a 4xx it does not recognise as unreachable rather than a refusal', async () => {
    const { hub } = client(() => new Response('<html>404</html>', { status: 404 }));

    expect((await failure(hub.activate(FINGERPRINT, 'n'))).kind).toBe('unreachable');
  });

  it('reports a 429 as rate limited', async () => {
    const { hub } = client(() => new Response('', { status: 429 }));

    expect((await failure(hub.heartbeat('act-1', FINGERPRINT, 'n'))).kind).toBe('rate_limited');
  });

  it('treats a 200 of the wrong shape as unreachable', async () => {
    const { hub } = client(() => json(200, { hello: 'world' }));

    expect((await failure(hub.activate(FINGERPRINT, 'n'))).kind).toBe('unreachable');
  });

  it('keeps the licence key out of a network error', async () => {
    const hub = createHubClient({
      licenceKey: KEY,
      fetchImpl: () => Promise.reject(new Error(`connect failed for ${KEY}`)),
    });

    const error = await failure(hub.activate(FINGERPRINT, 'n'));

    expect(error.kind).toBe('unreachable');
    expect(error.message).not.toContain(KEY);
  });

  it('uses an overriding Hub address, without a trailing slash', async () => {
    const { fetchImpl, sent } = recordingFetch(() => json(200, { keys: [] }));
    const hub = createHubClient({ licenceKey: KEY, baseUrl: 'http://localhost:8080/', fetchImpl });

    await hub.publicKeys();

    expect(sent[0]?.url).toBe('http://localhost:8080/.well-known/jwks.json');
  });
});
