// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUSALS } from './run-tool.js';

/** Error classes that never reach `runTool`, each with why. */
const ELSEWHERE: Record<string, string> = {
  IvantiApiError: 'has its own branch in runTool',
  ConfigError: 'startup, before any tool runs',
  ListenError: 'startup, before any tool runs',
  EmptyCsdlError: 'caught in the catalog, which reports it as an unreadable graph',
  TenantRefusedError: 'startup probe, before any tool runs',
  AttachmentLinkUnconfirmedError: 'caught in upload_attachment, which answers it',
  RoleNotAppliedError: 'caught in switch_role, which answers it',
  HubError: 'licensing runs beside the tools, never inside one; the licence check answers instead',
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

describe('the refusal table', () => {
  const declared = new Map<string, string>();
  for (const file of sources(join(__dirname, '../..'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/export class (\w+Error)\s+extends\s+(\w+)/g)) {
      declared.set(m[1] as string, m[2] as string);
    }
  }
  const rows = new Set(REFUSALS.map((r) => r.refusal.name));
  const covered = (name: string): boolean => {
    for (let n: string | undefined = name; n !== undefined; n = declared.get(n)) {
      if (rows.has(n) || n in ELSEWHERE) return true;
    }
    return false;
  };

  it('finds the error classes in the source', () => {
    expect(declared.size).toBeGreaterThan(15);
  });

  // An unwired class is logged as `tool failed` with a stack and counted as a fault of this
  // server when it is the caller's mistake.
  it.each([...declared.keys()])('%s is a row, a subclass of one, or handled elsewhere', (name) => {
    expect(covered(name)).toBe(true);
  });

  it('names nothing in the allowlist that no longer exists', () => {
    for (const name of Object.keys(ELSEWHERE)) expect(declared.has(name)).toBe(true);
  });
});
