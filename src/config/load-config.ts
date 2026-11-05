// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from './env-schema.js';
import { envSchema } from './env-schema.js';
import type { EnvRecord, FileReader } from './read-secret-file.js';
import { readSecret } from './read-secret-file.js';
import { validateConfig } from './validate-config.js';

/** Settings that may also arrive via the `*_FILE` convention. */
const SECRET_KEYS = [
  'BEARER_TOKEN',
  'IVANTI_API_KEY',
  'IVANTI_CENTRAL_CONFIG_API_KEY',
  'METRICS_TOKEN',
  'LICENSE_KEY',
  // Not a secret, but the chart keeps it in one, so it arrives the same way.
  'LICENSE_INSTALL_ID',
] as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * An environment variable set to nothing is not set.
 *
 * `docker run -e AUTH_MODE=` is how an operator clears a value inherited from an `--env-file`,
 * and a `.env` line with nothing after the `=` means the same. Treating the empty string as a
 * value makes both of those a startup failure that reads like a typo in the schema.
 */
function withoutEmpty(env: EnvRecord): EnvRecord {
  const kept: EnvRecord = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Resolves file-backed secrets, parses the environment, then applies the cross-field
 * rules — in that order, because a rule such as "bearer mode needs a token" cannot be
 * judged until `BEARER_TOKEN_FILE` has been read.
 */
export function loadConfig(env: EnvRecord, readFile?: FileReader): Config {
  const resolved: EnvRecord = withoutEmpty(env);

  for (const key of SECRET_KEYS) {
    try {
      // `resolved`, not `env`: the secrets have to see the same "set to nothing is unset" rule as
      // every other setting. Reading the raw record made `BEARER_TOKEN=` alongside
      // `BEARER_TOKEN_FILE=/run/secrets/…` — the documented way to move from the inline form to
      // the file form — fail with "Both … are set; provide exactly one", when only one was. It
      // also let a whitespace-only `BEARER_TOKEN` start the server, which is the one direction
      // this bug failed open.
      // An unset secret stays absent: `validateConfig` reads the key set as "what the operator wrote",
      // and a key holding `undefined` would count as written.
      const secret = readSecret(resolved, key, readFile);
      if (secret === undefined) delete resolved[key];
      else resolved[key] = secret;
      delete resolved[`${key}_FILE`];
    } catch (error) {
      throw new ConfigError([error instanceof Error ? error.message : String(error)]);
    }
  }

  const parsed = envSchema.safeParse(resolved);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  // What was actually set, not defaulted: some rules refuse a setting the mode would ignore.
  const problems = validateConfig(parsed.data, new Set(Object.keys(resolved)));
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return parsed.data;
}
