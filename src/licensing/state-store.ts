// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import type { JSONWebKeySet } from 'jose';

/**
 * The last licence the Hub confirmed, kept so a restart during a Hub outage reopens from it
 * (design §9f). Never the licence key: what is stored is a signed token, which proves nothing to
 * anyone but this installation and expires on its own, and the public keys that verified it.
 */
export interface StoredLicence {
  readonly token: string;
  readonly keys: JSONWebKeySet;
  /** When it was written (ms) — only to decide when to write again, never to judge the licence. */
  readonly savedAt: number;
}

export interface LicenceStore {
  /** Where it is kept, for a log line. */
  readonly describe: string;
  /** `undefined` when there is nothing, or nothing readable: a damaged store is an empty one. */
  load(): Promise<StoredLicence | undefined>;
  save(licence: StoredLicence): Promise<void>;
  clear(): Promise<void>;
}

const FILE_NAME = 'licence-state.json';
/** The key inside the Kubernetes Secret. */
const SECRET_KEY = 'licence-state';

function parse(text: string): StoredLicence | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { token, keys, savedAt } = value as Record<string, unknown>;
    if (typeof token !== 'string' || typeof savedAt !== 'number') return undefined;
    if (typeof keys !== 'object' || keys === null || !Array.isArray((keys as { keys?: unknown }).keys)) return undefined;
    return { token, keys: keys as JSONWebKeySet, savedAt };
  } catch {
    return undefined;
  }
}

/** Docker and stdio: a file in a folder the operator gave, written whole or not at all. */
export function createFileStore(dir: string): LicenceStore {
  const path = join(dir, FILE_NAME);
  return {
    describe: path,
    async load(): Promise<StoredLicence | undefined> {
      try {
        return parse(await readFile(path, 'utf8'));
      } catch {
        return undefined;
      }
    },
    async save(licence): Promise<void> {
      await mkdir(dir, { recursive: true });
      // Written beside it, then renamed over it: a process killed mid-write leaves the old copy or
      // the new one, never half of either.
      const temporary = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temporary, JSON.stringify(licence), { mode: 0o600 });
      await rename(temporary, path);
    },
    async clear(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

/** The pod's view of the Kubernetes API, read by `index.ts` from the service-account mount. */
export interface KubernetesAccess {
  readonly host: string;
  readonly port: number;
  readonly namespace: string;
  /** Read again on every call: the kubelet rotates a projected token in place. */
  readonly token: () => string;
  readonly ca: string;
}

export interface KubernetesAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * Under the chart: a Secret in the pod's own namespace, which survives restarts and moves to
 * another node, where a ReadWriteOnce volume would stall a rolling update. The chart creates it
 * and grants `get` and `update` on that one name and nothing else, so this never creates one.
 *
 * `node:https` rather than `fetch`: the API server's certificate is signed by the cluster's own
 * CA, and `fetch` takes no CA per request.
 */
export type KubernetesSend = (method: 'GET' | 'PUT', path: string, body?: string) => Promise<KubernetesAnswer>;

export function createSecretStore(
  name: string,
  access: KubernetesAccess,
  options: { timeoutMs?: number; send?: KubernetesSend } = {},
): LicenceStore {
  const path = `/api/v1/namespaces/${encodeURIComponent(access.namespace)}/secrets/${encodeURIComponent(name)}`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const overHttps: KubernetesSend = (method, target, body) =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: access.host,
          port: access.port,
          path: target,
          method,
          ca: access.ca,
          timeout: timeoutMs,
          headers: {
            authorization: `Bearer ${access.token()}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          response.on('error', reject);
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error(`no answer from the Kubernetes API within ${String(timeoutMs)} ms`)));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  const send = options.send ?? overHttps;
  const call = (method: 'GET' | 'PUT', body?: string): Promise<KubernetesAnswer> => send(method, path, body);

  const read = async (): Promise<Record<string, unknown>> => {
    const answer = await call('GET');
    if (answer.status !== 200) {
      throw new Error(`reading Secret ${access.namespace}/${name} answered ${String(answer.status)}`);
    }
    return JSON.parse(answer.body) as Record<string, unknown>;
  };

  /** A read-modify-write, retried once if another writer got there first (409). */
  const write = async (value: string | undefined): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const secret = await read();
      const data = { ...((secret.data as Record<string, string> | undefined) ?? {}) };
      if (value === undefined) delete data[SECRET_KEY];
      else data[SECRET_KEY] = Buffer.from(value, 'utf8').toString('base64');
      const answer = await call('PUT', JSON.stringify({ ...secret, data }));
      if (answer.status === 200) return;
      if (answer.status !== 409) {
        throw new Error(`updating Secret ${access.namespace}/${name} answered ${String(answer.status)}`);
      }
    }
    throw new Error(`updating Secret ${access.namespace}/${name} kept conflicting`);
  };

  return {
    describe: `Secret ${access.namespace}/${name}`,
    async load(): Promise<StoredLicence | undefined> {
      try {
        const encoded = ((await read()).data as Record<string, string> | undefined)?.[SECRET_KEY];
        return encoded === undefined ? undefined : parse(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch {
        return undefined;
      }
    },
    save: (licence) => write(JSON.stringify(licence)),
    clear: () => write(undefined),
  };
}

/** No store: offline restart is off, and the 30 days last only while the process runs. */
export const NO_STORE: LicenceStore = {
  describe: 'nowhere',
  load: () => Promise.resolve(undefined),
  save: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};
