// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { JSONWebKeySet } from 'jose';
import type { Fingerprint } from './fingerprint.js';

/** Built in, and never empty: no setting turns licensing off (design §9f). */
export const DEFAULT_HUB_URL = 'https://hub.itsmcloud.lt';

/** The product key the Hub's catalogue holds for this server; the token's `aud` must carry it. */
export const PRODUCT_KEY = 'ivanti-mcp-standalone';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The Hub's refusal codes, from its contract (`docs/contracts/license-process.json`). The code is
 * the ProblemDetails `title`; the status alone cannot tell them apart — 403 carries five.
 */
export const REFUSAL_CODES = [
  'invalid_request',
  'usage_invalid',
  'license_suspended',
  'unknown_key',
  'revoked',
  'no_active_entitlement',
  'no_seat',
  'fingerprint_reject',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * Every way a call to the Hub can fail, sorted by what the caller does about it:
 *
 * - `refused` — the Hub answered and said no. The licence check closes.
 * - `unreachable` — no answer that means anything: a network error, a timeout, a 5xx (the Hub's
 *   own `no_signing_key` included), or a 200 that is not the contract's shape. The grace period
 *   applies, because none of these says anything about the licence.
 * - `rate_limited` — 429. Wait for the window; nothing changes.
 */
export class HubError extends Error {
  constructor(
    readonly kind: 'refused' | 'unreachable' | 'rate_limited',
    message: string,
    readonly code?: RefusalCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export interface SignedToken {
  /** A compact JWS, ES256; checked by `verifyLicenceToken` before anything trusts it. */
  readonly token: string;
  readonly kid: string;
  readonly expiresAt: string;
}

export interface Activation {
  readonly activationId: string;
  readonly token: SignedToken;
}

export interface HubClient {
  activate(fingerprint: Fingerprint, nonce: string): Promise<Activation>;
  heartbeat(activationId: string, fingerprint: Fingerprint, nonce: string): Promise<SignedToken>;
  /** The Hub's public signing keys. Not secret, and fetched without the licence key. */
  publicKeys(): Promise<JSONWebKeySet>;
}

export interface HubClientOptions {
  readonly baseUrl?: string | undefined;
  readonly licenceKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createHubClient(options: HubClientOptions): HubClient {
  const base = (options.baseUrl ?? DEFAULT_HUB_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  // The key travels in one header and nowhere else. Anything the Hub says back is scrubbed of it
  // before it can reach an error message, and from there a log line.
  const scrub = (text: string): string => text.split(options.licenceKey).join('[licence key]');

  async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; keyed: boolean }): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.keyed ? { 'x-license-key': options.licenceKey } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new HubError('unreachable', `Could not reach the Synergy Hub at ${base}: ${scrub(reason)}`);
    }

    const text = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new HubError('rate_limited', 'The Synergy Hub is rate-limiting this licence key.', undefined, 429);
    }
    if (!response.ok) {
      const code = refusalCode(text);
      if (response.status < 500 && code !== undefined) {
        throw new HubError('refused', `The Synergy Hub refused the licence: ${code}.`, code, response.status);
      }
      throw new HubError(
        'unreachable',
        `The Synergy Hub answered ${String(response.status)}${code === undefined ? '' : ` (${code})`} at ${path}.`,
        undefined,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HubError('unreachable', `The Synergy Hub answered ${path} with something that is not JSON.`);
    }
  }

  const hub: HubClient = {
    async activate(fingerprint, nonce) {
      const body = await call('/api/v1/activation/activate', {
        method: 'POST',
        keyed: true,
        body: fingerprintBody(fingerprint, nonce),
      });
      if (!isRecord(body) || typeof body.activationId !== 'string' || !isSignedToken(body.token)) {
        throw new HubError('unreachable', 'The Synergy Hub answered activate in an unexpected shape.');
      }
      return { activationId: body.activationId, token: body.token };
    },

    async heartbeat(activationId, fingerprint, nonce) {
      const body = await call('/api/v1/activation/heartbeat', {
        method: 'POST',
        keyed: true,
        body: { activationId, ...fingerprintBody(fingerprint, nonce) },
      });
      if (!isSignedToken(body)) {
        throw new HubError('unreachable', 'The Synergy Hub answered heartbeat in an unexpected shape.');
      }
      return body;
    },

    async publicKeys() {
      const body = await call('/.well-known/jwks.json', { method: 'GET', keyed: false });
      if (!isRecord(body) || !Array.isArray(body.keys)) {
        throw new HubError('unreachable', 'The Synergy Hub answered its key set in an unexpected shape.');
      }
      return body as unknown as JSONWebKeySet;
    },
  };
  return hub;
}

function fingerprintBody(fingerprint: Fingerprint, nonce: string): Record<string, string> {
  return {
    machineGuid: fingerprint.machineGuid,
    biosUuid: fingerprint.biosUuid,
    installGuid: fingerprint.installGuid,
    nonce,
  };
}

/** The ProblemDetails `title`, when it is one of the contract's codes. */
function refusalCode(text: string): RefusalCode | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || typeof parsed.title !== 'string') return undefined;
    const title = parsed.title;
    return (REFUSAL_CODES as readonly string[]).includes(title) ? (title as RefusalCode) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignedToken(value: unknown): value is SignedToken {
  return isRecord(value) && typeof value.token === 'string' && typeof value.kid === 'string' && typeof value.expiresAt === 'string';
}
