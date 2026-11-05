// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ANONYMOUS, assertedIdentity } from '../auth/identity.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { buildVersionInfo, createGetVersionTool } from './get-version.js';

const deps = { serverName: 'ivanti-mcp', serverVersion: '0.1.0' };

describe('buildVersionInfo', () => {
  it('reports the injected server identity', () => {
    expect(buildVersionInfo(deps)).toMatchObject({
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
    });
  });

  it("defaults to the SDK's protocol version", () => {
    expect(buildVersionInfo(deps).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('reports the installed SDK version', () => {
    expect(buildVersionInfo(deps).sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('allows the protocol version to be overridden', () => {
    expect(buildVersionInfo({ ...deps, protocolVersion: '2025-06-18' }).protocolVersion).toBe(
      '2025-06-18',
    );
  });
});

describe('createGetVersionTool', () => {
  it('is annotated as a read-only, closed-world tool', () => {
    const { config } = createGetVersionTool(deps);

    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config.annotations.idempotentHint).toBe(true);
    expect(config.annotations.openWorldHint).toBe(false);
  });

  it('returns the version info as JSON text content', async () => {
    const result = await createGetVersionTool(deps).handler({});
    const [block] = result.content;

    expect(block?.type).toBe('text');
    expect(JSON.parse(block?.type === 'text' ? block.text : '')).toMatchObject({
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
  });

  it('reports how the caller was identified, and never who they are', async () => {
    const tool = createGetVersionTool(deps);

    const anonymous = await tool.handler({}, { identity: ANONYMOUS });
    const asserted = await tool.handler({}, { identity: assertedIdentity('jsmith') });

    const read = (result: { content: { type: string; text?: string }[] }): Record<string, string> =>
      JSON.parse(result.content[0]?.text ?? '{}') as Record<string, string>;

    expect(read(anonymous).caller).toBe('anonymous');
    expect(read(asserted).caller).toBe('asserted');
    // The provenance is the answer; the person is not this tool's business.
    expect(JSON.stringify(asserted)).not.toContain('jsmith');
  });
});

describe('the licence in get_version', () => {
  const base = { serverName: 'ivanti-mcp', serverVersion: '0.4.0', sdkVersion: '1.31.0' };

  it('says nothing about a licence when none is checked', () => {
    expect(buildVersionInfo(base)).not.toHaveProperty('licence');
  });

  it('reports an open licence and its end date', () => {
    const info = buildVersionInfo({ ...base, licence: { view: () => ({ status: 'open', validUntil: '2027-03-31' }) } });

    expect(info.licence).toEqual({ status: 'open', validUntil: '2027-03-31' });
  });

  it('reports why it is closed, or when its grace runs out', () => {
    const closed = buildVersionInfo({ ...base, licence: { view: () => ({ status: 'closed', reason: 'no seat' }) } });
    const grace = buildVersionInfo({
      ...base,
      licence: { view: () => ({ status: 'grace', reason: 'Hub unreachable', graceEndsAt: Date.UTC(2026, 11, 4) }) },
    });

    expect(closed.licence).toEqual({ status: 'closed', reason: 'no seat' });
    expect(grace.licence).toEqual({ status: 'grace', reason: 'Hub unreachable', graceEndsAt: '2026-12-04T00:00:00.000Z' });
  });
});
