// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ANONYMOUS, verifiedIdentity, type CallerIdentity } from '../../auth/identity.js';
import type { Logger } from '../../logger.js';
import type { AuthorizationResult } from './authorize-request.js';
import { describeRpc } from './describe-rpc.js';
import {
  BodyBudget,
  MAX_BODY_BYTES,
  MAX_INITIALIZE_BODY_BYTES,
  readJsonBody,
} from './read-body.js';
import { sendRpcError } from './respond.js';
import type {
  ClientDetails,
  ClosableSession,
  SessionManager,
  SessionSlot,
} from './session-manager.js';

/** Enough to tell two clients apart in a log line; the header is the caller's to make any length. */
const MAX_USER_AGENT_CHARS = 200;

/** The slice of a session this handler needs — narrow enough to fake in a test. */
export interface McpSession extends ClosableSession {
  /** Who this session acts for — fixed when it was created. */
  identity: CallerIdentity;
  transport: {
    sessionId?: string;
    handleRequest: (
      request: IncomingMessage,
      response: ServerResponse,
      body?: unknown,
    ) => Promise<void>;
  };
  connect: () => Promise<void>;
}

export interface McpHandlerDeps<S extends McpSession> {
  sessions: SessionManager<S>;
  logger: Logger;
  /**
   * Builds a session for this identity. It registers itself by committing `slot` from the
   * transport's `onsessioninitialized`, since the id does not exist before then.
   */
  createSession: (identity: CallerIdentity, slot: SessionSlot<S>) => S;
  /**
   * Which token claim names the person, for matching against Ivanti. Absent means the default
   * probe order — `email`, then `preferred_username`, then `upn`.
   */
  directoryClaim?: string;
  /** Bounds the request bytes buffered at once; one per handler unless a test shares it. */
  bodyBudget?: BodyBudget;
}

export type McpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  authorization: AuthorizationResult,
) => Promise<void>;

/**
 * Whether this request's credential belongs to the session it addresses.
 *
 * Only meaningful for verified identities: under `none` and `bearer` every caller is the same
 * anonymous one, so there is nothing to compare and refusing would break the shared-token
 * deployment that mode exists for.
 */
function sameSubject(sessionIdentity: CallerIdentity, authorization: AuthorizationResult): boolean {
  if (sessionIdentity.provenance !== 'verified') return true;
  return authorization.identity?.subject === sessionIdentity.subject;
}

/**
 * Dispatches one request on the MCP endpoint.
 *
 * Separate from `startHttp` because this is MCP protocol dispatch — which session, is this an
 * initialize, is the body well formed — while `startHttp` is HTTP plumbing. They change for
 * different reasons, and only this half is worth testing without a socket.
 */
export function createMcpHandler<S extends McpSession>(deps: McpHandlerDeps<S>): McpHandler {
  const { sessions, logger, directoryClaim } = deps;
  const bodyBudget = deps.bodyBudget ?? new BodyBudget();

  /** One place that knows the shape of a request log line. */
  const logExchange = (
    message: string,
    startedAt: number,
    subject: string | undefined,
    fields: Record<string, unknown>,
    durationKey: 'ms' | 'attachedMs' = 'ms',
  ): void => {
    logger.debug(message, { ...fields, subject, [durationKey]: Date.now() - startedAt });
  };

  const sessionIdOf = (request: IncomingMessage): string | undefined => {
    const header = request.headers['mcp-session-id'];
    return Array.isArray(header) ? header[0] : header;
  };

  /**
   * The socket's peer, never `X-Forwarded-For`: this server reads no forwarding header (design
   * §7), so behind a proxy this is the proxy — which is still the true answer to "who connected".
   */
  const clientOf = (request: IncomingMessage): ClientDetails => {
    const userAgent = request.headers['user-agent'];
    return {
      ...(request.socket.remoteAddress === undefined
        ? {}
        : { remoteAddress: request.socket.remoteAddress }),
      ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, MAX_USER_AGENT_CHARS) }),
    };
  };

  /** Answers a request on a live session, which is in use until the answer is finished. */
  const answerOn = async (
    sessionId: string,
    existing: S,
    request: IncomingMessage,
    response: ServerResponse,
    body?: unknown,
    /** A GET holds the dedicated SSE stream: the client is attached, nothing is running. */
    stream = false,
  ): Promise<void> => {
    const done = stream ? sessions.attach(sessionId) : sessions.busy(sessionId);
    try {
      await existing.transport.handleRequest(request, response, body);
    } finally {
      done();
    }
  };

  /**
   * A session belongs to the identity that opened it.
   *
   * Another verified subject presenting its own valid token is not entitled to this conversation,
   * to the records it has already been told about, or to ending it. One helper because all three
   * methods need the same answer — it lived inline in the POST branch, which is how GET and
   * DELETE came to skip it entirely.
   */
  const ownsSession = (
    existing: { identity: CallerIdentity },
    authorization: AuthorizationResult,
    sessionId: string,
  ): boolean => {
    if (sameSubject(existing.identity, authorization)) return true;
    logger.warn('session subject mismatch', { sessionId });
    return false;
  };

  return async (request, response, authorization): Promise<void> => {
    const subject = authorization.identity?.subject;
    const sessionId = sessionIdOf(request);

    // GET (SSE stream) and DELETE (end session) always address an existing session.
    if (request.method !== 'POST') {
      if (sessionId === undefined) {
        sendRpcError(response, 400, 'Mcp-Session-Id header is required');
        return;
      }
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        sendRpcError(response, 404, 'Unknown or expired session');
        return;
      }

      // The same gate as POST, and it has to be here too: this branch used to reach
      // `handleRequest` without it, so a holder of a valid token for a DIFFERENT subject could
      // send `DELETE /mcp` with somebody else's session id and `handleDeleteRequest` would close
      // their conversation and answer 200. A GET likewise attached to their dedicated SSE stream.
      if (!ownsSession(existing, authorization, sessionId)) {
        sendRpcError(response, 403, 'This session belongs to another identity');
        return;
      }

      // A GET holds the SSE stream open for the life of the connection, so its elapsed time is
      // how long the client stayed attached — not request latency.
      const isStream = request.method === 'GET';
      const startedAt = Date.now();
      if (isStream) logger.debug('mcp stream opened', { sessionId, subject });

      await answerOn(sessionId, existing, request, response, undefined, isStream);

      logExchange(
        isStream ? 'mcp stream closed' : 'mcp request',
        startedAt,
        subject,
        { httpMethod: request.method, sessionId },
        isStream ? 'attachedMs' : 'ms',
      );
      return;
    }

    // No session header means this can only be an `initialize`, which is small; the full limit is
    // for a call on a session that has already been admitted.
    const parsed = await readJsonBody(
      request,
      sessionId === undefined ? MAX_INITIALIZE_BODY_BYTES : MAX_BODY_BYTES,
      bodyBudget,
    );
    if (!parsed.ok) {
      if (parsed.status === 503) response.setHeader('Retry-After', String(parsed.retryAfterSeconds));
      sendRpcError(response, parsed.status, parsed.message);
      return;
    }

    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        sendRpcError(response, 404, 'Unknown or expired session');
        return;
      }
      if (!ownsSession(existing, authorization, sessionId)) {
        sendRpcError(response, 403, 'This session belongs to another identity');
        return;
      }
      const startedAt = Date.now();
      await answerOn(sessionId, existing, request, response, parsed.body);
      logExchange('mcp request', startedAt, subject, { ...describeRpc(parsed.body), sessionId });
      return;
    }

    if (!isInitializeRequest(parsed.body)) {
      sendRpcError(response, 400, 'Mcp-Session-Id header is required for non-initialize requests');
      return;
    }

    const admission = sessions.admit({
      ...(subject === undefined ? {} : { subject }),
      client: clientOf(request),
    });
    if (!admission.admitted) {
      // 503, not 429. RFC 9110: 503 is "a temporary overload ... which will likely be
      // alleviated after some delay" — which is exactly a global session cap. 429 means "the
      // user has sent too many requests" (RFC 6585), a per-client quota; here a client's very
      // first request can be refused through no fault of its own, and that client backing off
      // frees nothing. The per-subject limit never refuses — it closes the subject's own oldest
      // session instead — so there is no 429 to send.
      //
      // Reaching this means every session is in use or was used within the eviction floor, so
      // Retry-After is when the quietest of them could first be closed, not a fixed interval.
      response.setHeader('Retry-After', String(admission.retryAfterSeconds));
      sendRpcError(
        response,
        503,
        'Too many active sessions, and none has been idle long enough to close. Retry in ' +
          `${String(admission.retryAfterSeconds)} s.`,
      );
      return;
    }

    const { slot } = admission;
    const session = deps.createSession(
      authorization.identity === undefined
        ? ANONYMOUS
        : verifiedIdentity(authorization.identity, directoryClaim),
      slot,
    );
    const startedAt = Date.now();
    try {
      await session.connect();
      await session.transport.handleRequest(request, response, parsed.body);
    } finally {
      // An initialize that failed — refused by the SDK, or thrown — never registered, so the slot
      // it held goes back, and the session built for it is closed rather than left to the GC.
      if (slot.cancel()) void session.close();
    }

    logExchange('mcp request', startedAt, subject, {
      ...describeRpc(parsed.body),
      // `onsessioninitialized` has fired by now, so the id exists — logging "new" here would
      // leave the initialize line unjoinable to the RPCs that follow it.
      sessionId: session.transport.sessionId ?? 'unassigned',
    });
  };
}
