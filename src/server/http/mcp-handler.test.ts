// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS, verifiedIdentity } from '../../auth/identity.js';
import type { Logger } from '../../logger.js';
import type { AuthorizationResult } from './authorize-request.js';
import { createMcpHandler, type McpSession } from './mcp-handler.js';
import { BodyBudget } from './read-body.js';
import { EVICTION_FLOOR_MS, SessionManager } from './session-manager.js';

const silentLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const authorized: AuthorizationResult = {
  authorized: true,
  status: 200,
  identity: { subject: 'user-1', issuer: 'https://id.example', scopes: [], claims: {} },
};

interface FakeSession extends McpSession {
  handled: ReturnType<typeof vi.fn<() => void>>;
}

const fakeSession = (
  sessionId = 'generated-id',
  identity = ANONYMOUS,
): FakeSession => {
  const handled = vi.fn<() => void>();
  return {
    identity,
    close: vi.fn<() => void>(),
    connect: () => Promise.resolve(),
    handled,
    transport: {
      sessionId,
      handleRequest: () => {
        handled();
        return Promise.resolve();
      },
    },
  };
};

const request = (
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    method,
    headers,
    url: '/mcp',
    socket: { remoteAddress: '203.0.113.7' },
  }) as unknown as IncomingMessage;
};

interface FakeResponse extends ServerResponse {
  status?: number;
  payload?: string;
  headers: Record<string, string>;
}

const response = (): FakeResponse => {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(payload?: string) {
      res.payload = payload;
      return res;
    },
    headersSent: false,
  } as unknown as FakeResponse;
  return res;
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
};

const setup = (maxSessions = 10) => {
  const logger = silentLogger();
  const sessions = new SessionManager<FakeSession>({ maxSessions, idleTtlMs: 60_000, logger });
  const created: FakeSession[] = [];
  const handler = createMcpHandler<FakeSession>({
    sessions,
    logger,
    createSession: () => {
      const s = fakeSession(`session-${created.length}`);
      created.push(s);
      return s;
    },
  });
  return { handler, sessions, created };
};

describe('createMcpHandler', () => {
  it('opens a session for an initialize with no session header', async () => {
    const { handler, created } = setup();
    const res = response();

    await handler(request('POST', {}, INITIALIZE), res, authorized);

    expect(created).toHaveLength(1);
    expect(created[0]?.handled).toHaveBeenCalled();
  });

  it('refuses a non-initialize POST that carries no session', async () => {
    const { handler } = setup();
    const res = response();

    await handler(request('POST', {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), res, authorized);

    expect(res.status).toBe(400);
  });

  it('routes a POST with a known session to that session', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(
      request('POST', { 'mcp-session-id': 'abc' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      response(),
      authorized,
    );

    expect(existing.handled).toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    const { handler } = setup();
    const res = response();

    await handler(
      request('POST', { 'mcp-session-id': 'gone' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      res,
      authorized,
    );

    expect(res.status).toBe(404);
  });

  it('answers 503 once the session cap is reached, with a Retry-After', async () => {
    const { handler, sessions } = setup(1);
    sessions.register('taken', fakeSession('taken'));
    const res = response();

    await handler(request('POST', {}, INITIALIZE), res, authorized);

    // 503 rather than 429: the cap is global, so this client sent nothing wrong and its
    // backing off frees nothing. Retry-After is what makes it actionable — and it is when the
    // one session, used just now, could first be closed for a newcomer: the eviction floor.
    expect(res.status).toBe(503);
    expect(res.headers['Retry-After']).toBe(String(EVICTION_FLOOR_MS / 1000));
  });

  /**
   * `admit()` used to count registered sessions only, and a session registers when its
   * `initialize` has run. Two initializes arriving together were both admitted against the one
   * free slot; the second then failed to register mid-handshake and was answered 404 "Session not
   * found" — which reads as a bug, not as a full server.
   */
  it('holds the slot from admission, so a concurrent initialize is refused rather than half-opened', async () => {
    const logger = silentLogger();
    const sessions = new SessionManager<FakeSession>({ maxSessions: 1, idleTtlMs: 60_000, logger });
    let connected: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let admitted = 0;
    const handler = createMcpHandler<FakeSession>({
      sessions,
      logger,
      createSession: (_identity, slot) => {
        admitted += 1;
        const session = fakeSession('first');
        session.connect = () => slow;
        // What the real transport does from `onsessioninitialized`.
        session.transport.handleRequest = () => {
          slot.commit('first', session);
          return Promise.resolve();
        };
        return session;
      },
    });

    const first = handler(request('POST', {}, INITIALIZE), response(), authorized);
    // The first is admitted and parked in connect(), not yet registered.
    await vi.waitFor(() => {
      expect(admitted).toBe(1);
    });
    expect(sessions.size).toBe(0);
    const second = response();
    await handler(request('POST', {}, INITIALIZE), second, authorized);
    connected();
    await first;

    expect(second.status).toBe(503);
    expect(sessions.get('first')).toBeDefined();
  });

  it('gives the slot back, and closes the session, when an initialize never registers', async () => {
    const { handler, sessions, created } = setup(1);

    // The fake transport never fires `onsessioninitialized` — as when the SDK refuses the request.
    await handler(request('POST', {}, INITIALIZE), response(), authorized);

    expect(created[0]?.close).toHaveBeenCalled();
    expect(sessions.admit().admitted).toBe(true);
  });

  it('records who connected when a session opens', async () => {
    const info = vi.fn();
    const logger = { ...silentLogger(), info };
    const sessions = new SessionManager<FakeSession>({ maxSessions: 5, idleTtlMs: 60_000, logger });
    const handler = createMcpHandler<FakeSession>({
      sessions,
      logger,
      createSession: (_identity, slot) => {
        const session = fakeSession('s1');
        session.transport.handleRequest = () => {
          slot.commit('s1', session);
          return Promise.resolve();
        };
        return session;
      },
    });

    await handler(
      request('POST', { 'user-agent': 'claude-code/2.1' }, INITIALIZE),
      response(),
      authorized,
    );

    expect(info).toHaveBeenCalledWith(
      'session opened',
      expect.objectContaining({ remoteAddress: '203.0.113.7', userAgent: 'claude-code/2.1' }),
    );
  });

  /**
   * The SSE stream a client holds open for its whole life is a request in flight: a client with
   * one attached is alive, however long ago it last sent anything, and closing it to admit a
   * newcomer would only trade one person's conversation for another's.
   */
  it('never evicts a session while it is answering, however quiet it has been', async () => {
    let clock = 1_000_000;
    const logger = silentLogger();
    const sessions = new SessionManager<FakeSession>({
      maxSessions: 1,
      idleTtlMs: 3_600_000,
      logger,
      now: () => clock,
    });
    const attached = fakeSession('attached');
    let detach: () => void = () => undefined;
    attached.transport.handleRequest = () =>
      new Promise<void>((resolve) => {
        detach = resolve;
      });
    sessions.register('attached', attached);
    const handler = createMcpHandler<FakeSession>({
      sessions,
      logger,
      createSession: () => fakeSession('newcomer'),
    });

    const stream = handler(request('GET', { 'mcp-session-id': 'attached' }), response(), authorized);
    clock += 10 * EVICTION_FLOOR_MS;
    const refused = response();
    await handler(request('POST', {}, INITIALIZE), refused, authorized);

    expect(refused.status).toBe(503);
    expect(attached.close).not.toHaveBeenCalled();

    // Once the stream ends the session is quiet from THAT moment, not from when it opened.
    detach();
    await stream;
    clock += EVICTION_FLOOR_MS;
    await handler(request('POST', {}, INITIALIZE), response(), authorized);

    expect(attached.close).toHaveBeenCalled();
  });

  it('rejects a malformed body before touching a session', async () => {
    const { handler, created } = setup();
    const res = response();
    const bad = Object.assign(Readable.from([Buffer.from('{not json')]), {
      method: 'POST',
      headers: {},
      url: '/mcp',
      socket: { remoteAddress: '203.0.113.7' },
    }) as unknown as IncomingMessage;

    await handler(bad, res, authorized);

    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('requires a session header on GET', async () => {
    const { handler } = setup();
    const res = response();

    await handler(request('GET'), res, authorized);

    expect(res.status).toBe(400);
  });

  it('routes a GET to its session as a stream', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(request('GET', { 'mcp-session-id': 'abc' }), response(), authorized);

    expect(existing.handled).toHaveBeenCalled();
  });

  it('routes a DELETE to its session', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(request('DELETE', { 'mcp-session-id': 'abc' }), response(), authorized);

    expect(existing.handled).toHaveBeenCalled();
  });

  it('refuses a session that belongs to another verified identity', async () => {
    // A different subject with its own perfectly valid token is not entitled to this
    // conversation, or to the records it has already been told about.
    const owner = verifiedIdentity({
      subject: 'user-1',
      issuer: 'https://id.example',
      scopes: [],
      claims: {},
    });
    const logger = silentLogger();
    const sessions = new SessionManager<FakeSession>({ maxSessions: 10, idleTtlMs: 60_000, logger });
    const session = fakeSession('s1', owner);
    sessions.register('s1', session);
    const handler = createMcpHandler<FakeSession>({
      sessions,
      logger,
      createSession: () => session,
    });
    const res = response();

    await handler(
      request('POST', { 'mcp-session-id': 's1' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      res,
      {
        authorized: true,
        status: 200,
        identity: { subject: 'someone-else', issuer: 'https://id.example', scopes: [], claims: {} },
      },
    );

    expect(res.status).toBe(403);
    expect(res.payload).toContain('another identity');
    expect(session.handled).not.toHaveBeenCalled();
  });

  /**
   * The same rule, on the methods that used to skip it.
   *
   * `sameSubject` lived inline in the POST branch, so a holder of a valid token for a DIFFERENT
   * subject could send `DELETE /mcp` with somebody else's session id — `handleDeleteRequest`
   * closes the transport in a `finally` and answers 200, destroying their conversation — or `GET`
   * to attach to their dedicated SSE stream. Only the POST case was covered.
   */
  it.each(['GET', 'DELETE'])(
    'refuses a %s on a session that belongs to another verified identity',
    async (method) => {
      const owner = verifiedIdentity({
        subject: 'user-1',
        issuer: 'https://id.example',
        scopes: [],
        claims: {},
      });
      const logger = silentLogger();
      const sessions = new SessionManager<FakeSession>({
        maxSessions: 10,
        idleTtlMs: 60_000,
        logger,
      });
      const session = fakeSession('s1', owner);
      sessions.register('s1', session);
      const handler = createMcpHandler<FakeSession>({
        sessions,
        logger,
        createSession: () => session,
      });
      const res = response();

      await handler(request(method, { 'mcp-session-id': 's1' }), res, {
        authorized: true,
        status: 200,
        identity: {
          subject: 'someone-else',
          issuer: 'https://id.example',
          scopes: [],
          claims: {},
        },
      });

      expect(res.status).toBe(403);
      expect(session.handled).not.toHaveBeenCalled();
    },
  );

  // Narrowing check: the owner must still be able to end and stream their own session, and an
  // unverified deployment (`none`/`bearer`) has no subject to compare and must be unaffected.
  it.each(['GET', 'DELETE'])('still lets the owner %s their own session', async (method) => {
    const owner = verifiedIdentity({
      subject: 'user-1',
      issuer: 'https://id.example',
      scopes: [],
      claims: {},
    });
    const logger = silentLogger();
    const sessions = new SessionManager<FakeSession>({ maxSessions: 10, idleTtlMs: 60_000, logger });
    const session = fakeSession('s1', owner);
    sessions.register('s1', session);
    const handler = createMcpHandler<FakeSession>({ sessions, logger, createSession: () => session });

    await handler(request(method, { 'mcp-session-id': 's1' }), response(), {
      authorized: true,
      status: 200,
      identity: { subject: 'user-1', issuer: 'https://id.example', scopes: [], claims: {} },
    });

    expect(session.handled).toHaveBeenCalled();
  });

  it('lets the same verified subject continue its own session', async () => {
    const owner = verifiedIdentity({
      subject: 'user-1',
      issuer: 'https://id.example',
      scopes: [],
      claims: {},
    });
    const logger = silentLogger();
    const sessions = new SessionManager<FakeSession>({ maxSessions: 10, idleTtlMs: 60_000, logger });
    const session = fakeSession('s1', owner);
    sessions.register('s1', session);
    const handler = createMcpHandler<FakeSession>({
      sessions,
      logger,
      createSession: () => session,
    });

    await handler(
      request('POST', { 'mcp-session-id': 's1' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      response(),
      { authorized: true, status: 200, identity: { subject: 'user-1', issuer: 'https://id.example', scopes: [], claims: {} } },
    );

    expect(session.handled).toHaveBeenCalled();
  });

  describe('request body bounds', () => {
    // An initialize is read before any session exists, so it was the unbounded door.
    it('refuses an oversized initialize with 413, before any session is admitted', async () => {
      const { handler, created } = setup();
      const res = response();
      const big = { ...INITIALIZE, params: { ...INITIALIZE.params, padding: 'x'.repeat(100_000) } };

      await handler(request('POST', {}, big), res, authorized);

      expect(res.status).toBe(413);
      expect(created).toHaveLength(0);
    });

    it('still lets a call on an admitted session carry a large body', async () => {
      const { handler, created, sessions } = setup();
      await handler(request('POST', {}, INITIALIZE), response(), authorized);
      const id = created[0]?.transport.sessionId ?? '';
      sessions.register(id, created[0] as FakeSession);
      const res = response();
      const big = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { pad: 'x'.repeat(100_000) } };

      await handler(request('POST', { 'mcp-session-id': id }, big), res, authorized);

      expect(res.status).not.toBe(413);
      expect(created[0]?.handled).toHaveBeenCalled();
    });

    it('answers 503 with Retry-After when the process is already buffering its budget', async () => {
      const bodyBudget = new BodyBudget(10, 4);
      const logger = silentLogger();
      const sessions = new SessionManager<FakeSession>({ maxSessions: 10, idleTtlMs: 60_000, logger });
      const handler = createMcpHandler<FakeSession>({
        sessions,
        logger,
        createSession: () => fakeSession(),
        bodyBudget,
      });
      const res = response();

      await handler(request('POST', {}, INITIALIZE), res, authorized);

      expect(res.status).toBe(503);
      expect(res.headers['Retry-After']).toBe('1');
    });
  });
});
