// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { IdentityProvenance } from '../auth/identity.js';
import { readSdkVersion } from '../version.js';
import type { LicenceCheck } from './call/licence-gate.js';
import { jsonResult } from './shared/result.js';
import { defineTool, type ToolDefinition } from './tool-definition.js';

export interface VersionInfo {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  sdkVersion: string;
  /**
   * How this call's identity was established — `anonymous`, `asserted` or `verified`. The
   * provenance, never the person: this exists so an operator can see which path executed, and a
   * tool that reported *who* would be an identity oracle for anyone who can call it.
   */
  caller: IdentityProvenance;
  /**
   * The licence check (design §9f). The one tool that still answers unlicensed, so this is where a
   * model — and through it the user — learns why every other tool is refused.
   */
  licence?: {
    status: 'open' | 'grace' | 'closed';
    reason?: string;
    validUntil?: string;
    /** While in grace: when the server stops answering unless the Synergy Hub is reached first. */
    graceEndsAt?: string;
  };
}

export interface GetVersionDeps {
  serverName: string;
  serverVersion: string;
  /** Injected so the versions can be asserted in tests. */
  protocolVersion?: string;
  sdkVersion?: string;
  licence?: LicenceCheck;
}

export function buildVersionInfo(
  deps: GetVersionDeps,
  caller: IdentityProvenance = 'anonymous',
): VersionInfo {
  return {
    serverName: deps.serverName,
    serverVersion: deps.serverVersion,
    protocolVersion: deps.protocolVersion ?? LATEST_PROTOCOL_VERSION,
    sdkVersion: deps.sdkVersion ?? readSdkVersion(),
    caller,
    ...(deps.licence === undefined ? {} : { licence: licenceInfo(deps.licence) }),
  };
}

function licenceInfo(licence: LicenceCheck): NonNullable<VersionInfo['licence']> {
  const view = licence.view();
  return {
    status: view.status,
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    ...(view.validUntil === undefined ? {} : { validUntil: view.validUntil }),
    ...(view.graceEndsAt === undefined ? {} : { graceEndsAt: new Date(view.graceEndsAt).toISOString() }),
  };
}

export function createGetVersionTool(deps: GetVersionDeps): ToolDefinition {
  return defineTool({
    name: 'get_version',
    title: 'Get server version',
    description:
      'Returns the name and version of this MCP server, the MCP protocol version it ' +
      'implements, the SDK version it is built on, and how the caller was identified — ' +
      '`anonymous`, `asserted` or `verified`. Useful for confirming which build a client is ' +
      'talking to and which authentication path it came in on.',
    annotations: {
      title: 'Get server version',
      readOnlyHint: true,
      idempotentHint: true,
      // Answers from process-local state; it reaches nothing external.
      openWorldHint: false,
    },
    inputSchema: {},
    handler: (_args, context) => jsonResult(buildVersionInfo(deps, context.identity.provenance)),
  });
}
