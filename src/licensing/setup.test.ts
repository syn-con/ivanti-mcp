// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import type { Logger } from '../logger.js';
import { setUpLicensing } from './setup.js';

const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('setUpLicensing: where the stdio install ID is kept', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'licence-setup-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // An unreachable Hub on loopback: nothing leaves the machine.
  const stdio = { STDIO_TRANSPORT_ON: true, HTTP_TRANSPORT_ON: false, LICENSE_INSTALL_ID: undefined, LICENSE_HUB_URL: 'http://127.0.0.1:9' };

  it('keeps it in LICENSE_STATE_DIR when set, so a container volume carries it from run to run', () => {
    const configDir = freshDir();
    const stateDir = freshDir();
    const { licensing } = setUpLicensing(configFixture({ ...stdio, LICENSE_STATE_DIR: stateDir }), { configDir, kubernetes: () => undefined }, silent);
    licensing.stop();

    expect(existsSync(join(stateDir, 'install-id'))).toBe(true);
    expect(existsSync(join(configDir, 'install-id'))).toBe(false);
  });

  it('keeps it in the config folder otherwise', () => {
    const configDir = freshDir();
    const { licensing } = setUpLicensing(configFixture(stdio), { configDir, kubernetes: () => undefined }, silent);
    licensing.stop();

    expect(existsSync(join(configDir, 'install-id'))).toBe(true);
  });
});
