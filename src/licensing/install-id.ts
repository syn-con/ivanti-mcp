// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = 'install-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Under stdio, the install ID this machine's user keeps in their config folder: read when it is
 * there, generated and written once when it is not (design §9f). Over HTTP it is configuration
 * instead, because a container loses whatever it writes and would take a new seat on every start.
 *
 * A file that is there but is not a UUID is an error rather than replaced: replacing it would
 * silently move this installation to a new seat.
 */
export function ensureInstallId(dir: string): string {
  const path = join(dir, FILE_NAME);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== undefined) {
    if (!UUID.test(existing)) {
      throw new Error(`${path} does not hold a UUID. Remove it to generate a new install ID, which takes a new licence seat.`);
    }
    return existing.toLowerCase();
  }
  const created = randomUUID();
  mkdirSync(dir, { recursive: true });
  // `wx`: two processes starting together must not each write their own and disagree.
  try {
    writeFileSync(path, `${created}\n`, { flag: 'wx', mode: 0o600 });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return ensureInstallId(dir);
    throw error;
  }
}
