// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KubernetesAccess, KubernetesAnswer, KubernetesSend, StoredLicence } from './state-store.js';
import { createFileStore, createSecretStore } from './state-store.js';

const LICENCE: StoredLicence = { token: 'a.b.c', keys: { keys: [] }, savedAt: 1_700_000_000_000 };

describe('createFileStore', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'licence-store-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a licence across a new store on the same folder, as a restart would', async () => {
    const dir = freshDir();
    await createFileStore(dir).save(LICENCE);

    expect(await createFileStore(dir).load()).toEqual(LICENCE);
  });

  it('leaves no temporary file behind', async () => {
    const dir = freshDir();
    await createFileStore(dir).save(LICENCE);

    expect(readdirSync(dir)).toEqual(['licence-state.json']);
  });

  it('creates the folder it is given', async () => {
    const dir = join(freshDir(), 'nested', 'state');
    await createFileStore(dir).save(LICENCE);

    expect(await createFileStore(dir).load()).toEqual(LICENCE);
  });

  it('reads nothing from an empty folder or a damaged file', async () => {
    const dir = freshDir();
    expect(await createFileStore(dir).load()).toBeUndefined();

    writeFileSync(join(dir, 'licence-state.json'), '{ not json');
    expect(await createFileStore(dir).load()).toBeUndefined();
  });

  it('forgets the licence when cleared', async () => {
    const dir = freshDir();
    const store = createFileStore(dir);
    await store.save(LICENCE);
    await store.clear();

    expect(await store.load()).toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

const ACCESS: KubernetesAccess = { host: 'kubernetes.default', port: 443, namespace: 'mcp', token: () => 'sa-token', ca: 'CA' };

/** A fake API server holding one Secret, with optimistic concurrency like the real one. */
function fakeApiServer(options: { conflictsFirst?: number; missing?: boolean } = {}) {
  let secret: Record<string, unknown> = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'licence-state', namespace: 'mcp', resourceVersion: '1' },
    data: { other: 'kept' },
  };
  let conflicts = options.conflictsFirst ?? 0;
  const calls: { method: string; path: string }[] = [];
  const send: KubernetesSend = (method, path, body): Promise<KubernetesAnswer> => {
    calls.push({ method, path });
    if (options.missing === true) return Promise.resolve({ status: 404, body: '{}' });
    if (method === 'GET') return Promise.resolve({ status: 200, body: JSON.stringify(secret) });
    if (conflicts > 0) {
      conflicts -= 1;
      return Promise.resolve({ status: 409, body: '{}' });
    }
    secret = JSON.parse(body ?? '{}') as Record<string, unknown>;
    return Promise.resolve({ status: 200, body: JSON.stringify(secret) });
  };
  return { send, calls, secret: () => secret };
}

describe('createSecretStore', () => {
  it('writes the licence into its own key and keeps the rest of the Secret', async () => {
    const api = fakeApiServer();
    const store = createSecretStore('licence-state', ACCESS, { send: api.send });

    await store.save(LICENCE);

    expect(await store.load()).toEqual(LICENCE);
    expect((api.secret().data as Record<string, string>).other).toBe('kept');
    expect(api.calls[0]?.path).toBe('/api/v1/namespaces/mcp/secrets/licence-state');
  });

  it('retries once when another writer got there first', async () => {
    const api = fakeApiServer({ conflictsFirst: 1 });
    const store = createSecretStore('licence-state', ACCESS, { send: api.send });

    await store.save(LICENCE);

    expect(await store.load()).toEqual(LICENCE);
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });

  it('gives up after a second conflict rather than looping', async () => {
    const api = fakeApiServer({ conflictsFirst: 5 });

    await expect(createSecretStore('licence-state', ACCESS, { send: api.send }).save(LICENCE)).rejects.toThrow(/kept conflicting/);
  });

  it('removes only its own key when cleared', async () => {
    const api = fakeApiServer();
    const store = createSecretStore('licence-state', ACCESS, { send: api.send });
    await store.save(LICENCE);

    await store.clear();

    expect(await store.load()).toBeUndefined();
    expect(api.secret().data).toEqual({ other: 'kept' });
  });

  it('reads nothing when the Secret cannot be read, and says so when writing', async () => {
    const store = createSecretStore('licence-state', ACCESS, { send: fakeApiServer({ missing: true }).send });

    expect(await store.load()).toBeUndefined();
    await expect(store.save(LICENCE)).rejects.toThrow(/answered 404/);
  });
});
