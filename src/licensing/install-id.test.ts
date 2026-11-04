// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ensureInstallId } from './install-id.js';

describe('ensureInstallId', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'install-id-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('generates a UUID once and keeps it', () => {
    const dir = freshDir();
    const first = ensureInstallId(dir);

    expect(z.uuid().safeParse(first).success).toBe(true);
    expect(ensureInstallId(dir)).toBe(first);
    expect(readFileSync(join(dir, 'install-id'), 'utf8').trim()).toBe(first);
  });

  it('creates the config folder when it is not there yet', () => {
    const dir = join(freshDir(), 'ivanti-mcp');

    expect(ensureInstallId(dir)).toBe(ensureInstallId(dir));
  });

  it('refuses to replace a file that is not a UUID, since that would move the seat', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'install-id'), 'not-an-id\n');

    expect(() => ensureInstallId(dir)).toThrow(/does not hold a UUID/);
    expect(readFileSync(join(dir, 'install-id'), 'utf8')).toBe('not-an-id\n');
  });
});
