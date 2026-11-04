// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { auditFields } from '../auth/identity.js';
import type { Logger } from '../logger.js';
import { noteOutcome, type CallUsage } from '../usage/call-usage.js';
import type { ManifestFingerprint } from './manifest-fingerprint.js';
import { errorResult } from './shared/result.js';
import type { CallContext, ToolDefinition } from './tool-definition.js';
import { auditTargets, createCallLog, targetArguments } from './call/call-log.js';
import { createConversation } from './call/conversation.js';
import { createIdentityGate, requiresIdentity } from './call/identity-gate.js';
import { createLicenceGate, type LicenceCheck } from './call/licence-gate.js';
import { createRateLimiter } from './call/rate-limit.js';
import { createSessionKeeper } from './call/session-keeper.js';

// Tool selection and mode narrowing live in `select-tools.ts` and `audience.ts`; re-exported so the
// one place that builds the list and the one that registers it stay importable together.
export { selectTools, type ToolContext } from './select-tools.js';

/**
 * Registers already-built definitions onto one server, bound to one call context.
 *
 * Takes the tools rather than building them, so every session shares one set of definitions:
 * `registerTool` stores the **config** by reference, so the zod schemas exist once however many
 * sessions are open. Only the small closure that carries the context is per session, which is
 * what makes identity a per-conversation fact rather than a global.
 *
 * Every call is audited here, and gated here, because this is the one place they all pass
 * through. Argument values are never logged — they carry ticket text and personal data — so the
 * record is what was called, by which session, on whose behalf, and how that was established; a
 * write adds which record it was aimed at, by id alone (`auditTargets`).
 */
export interface RegisteredTools {
  /** The names registered, in the order they were given. */
  names: string[];
  /**
   * Ends the conversation: the pin is thrown away and the next call starts with nobody.
   *
   * Handed out rather than exposed on the pin, because a tool holds a `SessionPin` and must never
   * be able to end the conversation it is bound by — that would be a way out of the pin, which is
   * the one thing the pin exists to prevent. Only the caller that built the connection gets this.
   */
  endConversation: () => Promise<void>;
  /**
   * Whether this conversation may be answered at all — false until `act_as` has pinned somebody.
   *
   * Published so that anything else registered on the same server asks the same question rather
   * than re-deriving it: "is there an identity" and "does this deployment require one" are two
   * conditions, and a second copy of them is a second thing to get wrong.
   */
  mayAnswer: () => boolean;
}

/**
 * How a conversation ends, and why a stdio process has to be told.
 *
 * Over HTTP a conversation *is* a session: the store sweeps it once it goes quiet and the whole
 * server — pin included — is thrown away with it. A stdio process has no such thing. It is one
 * connection for the life of the process, so a client that keeps the server running across
 * conversations, which is the ordinary shape, carried the first person's pin into every
 * conversation that followed: the person outlived the conversation that named them.
 *
 * Two signals end one, and neither is within the model's reach — a tool that could end a
 * conversation could shed the pin, which is the one thing the pin exists to prevent:
 *
 * - **Silence.** No tool call for `idleMs` — `MCP_IDENTITY_IDLE_TTL_SECONDS`. Its own setting,
 *   not the session sweep's: how long a person's records stay reachable to whoever is at the
 *   keyboard is not the same question as how long a dead HTTP session may hold memory.
 * - **A fresh `initialize`.** The client saying so itself, which is exact but arrives only from
 *   clients that re-initialize rather than reconnect. Silence is the one that always arrives.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  context: CallContext,
  logger: Logger,
  /** Omitted means a conversation never goes stale on its own — the shape every test wants. */
  idleMs?: number,
  /** Stamped on every usage line, so the report can compare one version of the text with another. */
  manifest?: ManifestFingerprint,
  /** `MCP_MAX_CALLS_PER_MINUTE`; omitted, nothing is limited — the shape every test wants. */
  maxCallsPerMinute?: number,
  /** The licence check (design §9f); omitted, every call is licensed — the shape every test wants. */
  licence?: LicenceCheck,
): RegisteredTools {
  const conversation = createConversation(context, logger, requiresIdentity(tools), idleMs);
  const limiter = createRateLimiter(maxCallsPerMinute);
  const gate = createIdentityGate(tools, conversation, logger);
  const licensed = createLicenceGate(licence, logger);
  const keepSession = createSessionKeeper(conversation, logger);
  const callLog = createCallLog(server, conversation, logger, manifest);

  const answer = async (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    { usage, began }: { usage: CallUsage; began: { conversation?: number } },
    /** The arguments naming what a write touches — see `auditTargets`. */
    targets: readonly string[],
  ): Promise<CallToolResult> => {
    const at = Date.now();

    // First, before the gate: a model in a loop, or a client replaying one, is stopped here rather
    // than at the tenant — `act_as` included, since naming people over and over is the loop too.
    const limited = limiter.admit(at);
    if (limited !== undefined) {
      logger.warn('tool call rate limited', {
        tool: tool.name,
        ...conversation.session(),
        limit: limiter.limit,
      });
      noteOutcome('RateLimited');
      return errorResult(
        `This conversation has made ${String(limiter.limit)} calls in the last minute, the ` +
          `most it may. Wait ${String(limited.retryAfterSeconds)} s, then try again.`,
      );
    }

    conversation.touch(at);

    // Read after any expiry above, so a call that ends the previous conversation belongs to the
    // new one rather than being refused by its own arrival.
    const startedIn = conversation.id();
    began.conversation = startedIn;
    // The conversation's context as it stands now. A retry must run in the conversation the call
    // was made in, not whichever one has started since.
    const call = conversation.bound();

    logger.info('tool called', {
      tool: tool.name,
      ...conversation.session(),
      ...auditFields(conversation.pin().identity()),
      ...auditTargets(targets, args),
    });

    // The licence first: unlicensed, nothing reaches Ivanti on anyone's behalf (see `licence-gate.ts`).
    const unlicensed = licensed.admit(tool);
    if (unlicensed !== undefined) return unlicensed;

    // The gate, here, at the one place every call passes through (see `identity-gate.ts`).
    const pending = gate.admit(tool);
    if (pending !== undefined) {
      const refused = await pending;
      if (refused !== undefined) return refused;
    }

    const result = await keepSession(tool, args, call, usage, startedIn);

    // Ended underneath us. The result was computed for a conversation that is over, and for
    // `act_as` it was computed against a pin nothing reads any more — so it is refused rather
    // than reported, which is the difference between "call me again" and a silent lie.
    if (conversation.id() !== startedIn) {
      logger.info('result discarded; the conversation ended first', {
        tool: tool.name,
        ...conversation.session(),
      });
      noteOutcome('discarded');
      return errorResult(
        // "Retry" is only safe to say about a read. A write that got as far as Ivanti happened,
        // whatever became of its result, and retrying it blind would do it twice.
        tool.config.annotations.readOnlyHint === true
          ? 'This conversation ended while that call was running, so its result was discarded. ' +
              'Call `act_as` again to say who you are helping, then retry.'
          : 'This conversation ended while that call was running, so its result was discarded — ' +
              'but it changes records, and the change may already have been made. Call `act_as` ' +
              'again to say who you are helping, then check the record before trying it again.',
      );
    }

    return result;
  };

  for (const tool of tools) {
    const targets = targetArguments(tool);
    server.registerTool(
      tool.name,
      tool.config,
      (args: Record<string, unknown>, extra?: { requestId?: RequestId }) =>
        callLog.around(tool, args, extra, (record) => answer(tool, args, record, targets)),
    );
  }

  return {
    names: tools.map((tool) => tool.name),
    endConversation: () => conversation.end('reinitialized'),
    mayAnswer: conversation.mayAnswer,
  };
}
