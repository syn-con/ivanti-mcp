// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every Ivanti request goes through `exchange()` — the one place that times out, scrubs, logs and
 * turns every failure into an `IvantiApiError`. A bare `fetch` does none of that, and nothing
 * about it fails: it works, and leaks a credential into a log line or hangs on a dead socket.
 *
 * So no file outside `exchange.ts` may call `fetch` or a `fetchImpl`. The exceptions are the
 * OAuth discovery calls, which talk to the identity provider, and the licence client, which talks
 * to the Synergy Hub — neither ever reaches Ivanti.
 */
const NOT_IVANTI: Record<string, string> = {
  'auth/oauth/discover-metadata.ts': 'Fetches the identity provider discovery document.',
  'auth/oauth/create-verifier.ts': 'Fetches the identity provider JWKS.',
  'licensing/hub-client.ts': 'Talks to the Synergy Hub (activate, heartbeat, its public keys), never Ivanti.',
};

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string, prefix = ''): { name: string; body: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, `${prefix}${entry.name}/`);
    if (!entry.name.endsWith('.ts') || /\.(test|fixture)\.ts$/.test(entry.name)) return [];
    return [{ name: `${prefix}${entry.name}`, body: readFileSync(path, 'utf8') }];
  });
}

/** Comments name `fetch(` freely; only code counts. */
const stripComments = (body: string): string =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CALLS_FETCH = /(?<![.\w])(?:globalThis\.)?fetch\s*\(|\bfetchImpl\s*\(/;

describe('every Ivanti request goes through exchange()', () => {
  it('has no bare fetch outside exchange.ts and the declared non-Ivanti calls', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter(({ name }) => name !== 'ivanti/http/exchange.ts')
      .filter(({ body }) => CALLS_FETCH.test(stripComments(body)))
      .map(({ name }) => name)
      .filter((name) => !(name in NOT_IVANTI));

    expect(
      offenders,
      `These call fetch directly. Use exchange() so the request is timed out, scrubbed and logged:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the declared exceptions honest by requiring them to still call fetch', () => {
    const files = new Map(sourceFiles(SRC_DIR).map(({ name, body }) => [name, body]));
    const stale = Object.keys(NOT_IVANTI).filter(
      (name) => !CALLS_FETCH.test(stripComments(files.get(name) ?? '')),
    );

    expect(stale, `declared but no longer calling fetch:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
