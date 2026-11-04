// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../logger.js';
import { noteOutcome } from '../../usage/call-usage.js';
import { errorResult } from '../shared/result.js';
import type { ToolDefinition } from '../tool-definition.js';

/**
 * The one tool the licence check lets through: it reports the licence. Where a tenant is configured
 * the identity gate still holds it until `act_as` — which is refused here — so every refusal below
 * carries the reason itself rather than pointing at `get_version`.
 */
export const UNLICENSED_ANSWERS = 'get_version';

/** What the gate reads: the licence state's view, structurally, so tools/ depends on no licensing code. */
export interface LicenceCheck {
  view(): {
    readonly status: 'open' | 'grace' | 'closed';
    readonly reason?: string;
    readonly validUntil?: string;
    readonly graceEndsAt?: number;
  };
}

export interface LicenceGate {
  /** `undefined` lets the call through; otherwise the refusal to return instead of running it. */
  admit(tool: ToolDefinition): CallToolResult | undefined;
}

/**
 * The licence check (design §9f): one place, in `registerTools`, beside the identity gate, never
 * tool by tool — a tool that forgot would not fail, it would answer.
 *
 * Grace admits: the Hub being unreachable says nothing about the licence. Only `closed` refuses,
 * and it refuses before the identity gate, so an unlicensed server never reaches Ivanti on anyone's
 * behalf — `act_as` included.
 */
export function createLicenceGate(licence: LicenceCheck | undefined, logger: Logger): LicenceGate {
  return {
    admit(tool: ToolDefinition): CallToolResult | undefined {
      if (licence === undefined || tool.name === UNLICENSED_ANSWERS) return undefined;
      const view = licence.view();
      if (view.status !== 'closed') return undefined;

      logger.warn('tool refused: not licensed', { tool: tool.name, reason: view.reason });
      noteOutcome('Unlicensed');
      return errorResult(
        `This server is not licensed, so it cannot run \`${tool.name}\`: ${view.reason ?? 'the licence is not valid'}. ` +
          'Its tools are refused until the licence is confirmed again, so retrying will not help until then. ' +
          'Tell the user, and that whoever runs this server can see why in its log.',
      );
    },
  };
}
