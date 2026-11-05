// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { metadataUrl } from '../auth/oauth/protected-resource-metadata.js';
import { createImpersonationSlot } from '../auth/impersonation.js';
import type { TokenVerifier } from '../auth/oauth/verify-token.js';
import { configFixture } from '../config/config.fixture.js';
import type { Config } from '../config/env-schema.js';
import { ConfigError } from '../config/load-config.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';
import type { Logger } from '../logger.js';
import { releaseOnClose, type McpConnection } from './create-server.js';
import type { Readiness } from './http/readiness.js';
import { MINIMAL_HEALTH } from './http/health.js';
import { EVICTION_FLOOR_MS } from './http/session-manager.js';
import {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  ListenError,
  openModeWarnings,
  startHttp,
  type HttpDeps,
  type HttpServer,
} from './start-http.js';

type LogCall = (message: string, fields?: Record<string, unknown>) => void;
type SpyLogger = { [K in keyof Logger]: Mock<LogCall> };

const spyLogger = (): SpyLogger => ({
  debug: vi.fn<LogCall>(),
  info: vi.fn<LogCall>(),
  warn: vi.fn<LogCall>(),
  error: vi.fn<LogCall>(),
});

/** Loopback, an ephemeral port, and nothing else between a request and the handler. */
const httpConfig = (overrides: Partial<Config> = {}): Config =>
  configFixture({
    STDIO_TRANSPORT_ON: false,
    HTTP_TRANSPORT_ON: true,
    AUTH_MODE: 'none',
    MCP_BIND: '127.0.0.1',
    MCP_PORT: 0,
    MCP_PUBLIC_URL: 'http://127.0.0.1/mcp',
    TRUSTED_ORIGINS: ['http://127.0.0.1'],
    ...overrides,
  });

interface Opened {
  /** Every connection handed out, in order. */
  connections: McpConnection[];
  /** How many of them have handed their Ivanti session back. */
  released: () => number;
}

/**
 * Connections built the way `createServerFactory` builds them — a real `McpServer`, a slot that
 * already holds an Ivanti session, `releaseOnClose` between them — with a release that takes a
 * moment, as the RemoveSession request does.
 */
const impersonatingConnections = (
  releaseMs = 30,
): { createMcpServer: HttpDeps['createMcpServer']; opened: Opened } => {
  const connections: McpConnection[] = [];
  let released = 0;
  const createMcpServer = (): McpConnection => {
    const server = new McpServer({ name: 'test', version: '0' });
    const slot = createImpersonationSlot(() =>
      Promise.resolve(
        impersonatedSessionFixture({
          release: () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                released += 1;
                resolve();
              }, releaseMs);
            }),
        }),
      ),
    );
    void slot.open('HSanders');
    const releasing = releaseOnClose(server, slot);
    const connection: McpConnection = {
      server,
      close: async (): Promise<void> => {
        await server.close();
        await releasing();
      },
    };
    connections.push(connection);
    return connection;
  };
  return { createMcpServer, opened: { connections, released: () => released } };
};

const deps = (overrides: Partial<HttpDeps> = {}): HttpDeps => ({
  createMcpServer: impersonatingConnections().createMcpServer,
  serverName: 'test',
  serverVersion: '0',
  sdkVersion: '0',
  ...overrides,
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
};

const urlOf = (http: HttpServer): string =>
  `http://127.0.0.1:${String((http.server.address() as AddressInfo).port)}/mcp`;

const post = async (
  http: HttpServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; sessionId: string | null; retryAfter: string | null }> => {
  const response = await fetch(urlOf(http), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  // Read to the end: an initialize answers on an SSE stream that closes after its one message.
  await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    retryAfter: response.headers.get('retry-after'),
  };
};

let running: HttpServer[] = [];
let blockers: NetServer[] = [];

const start = async (config: Config, logger: Logger, httpDeps: HttpDeps): Promise<HttpServer> => {
  const http = await startHttp(config, logger, httpDeps);
  running.push(http);
  return http;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(running.map((http) => http.close()));
  await Promise.all(
    blockers.map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))),
  );
  running = [];
  blockers = [];
});

describe('startHttp: binding', () => {
  /**
   * `listen()` returns before the port is bound. The line said "listening" and the process then
   * died of EADDRINUSE as an uncaught exception. The port it names now is the one actually bound,
   * which with MCP_PORT=0 exists only after the bind — so a line logged early could not carry it.
   */
  it('announces itself only once the port is bound, naming the port it got', async () => {
    const logger = spyLogger();

    const http = await start(httpConfig(), logger, deps({ listeningFields: { tools: ['x'] } }));

    const port = (http.server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    expect(logger.info).toHaveBeenCalledWith(
      'listening on http',
      expect.objectContaining({ port, tools: ['x'], authMode: 'none' }),
    );
  });

  it('fails clearly when the port is taken, and never claims to be listening', async () => {
    const blocker = createNetServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const logger = spyLogger();

    const failure = startHttp(httpConfig({ MCP_PORT: taken }), logger, deps());

    await expect(failure).rejects.toBeInstanceOf(ListenError);
    await expect(failure).rejects.toThrow(/already in use.*MCP_PORT/);
    expect(logger.error).toHaveBeenCalledWith(
      'cannot listen on http',
      expect.objectContaining({ code: 'EADDRINUSE', port: taken }),
    );
    expect(logger.info).not.toHaveBeenCalledWith('listening on http', expect.anything());
  });

  // `listen(undefined)` would bind a random port and report success.
  it('refuses to start without a port rather than pick one', async () => {
    const logger = spyLogger();

    const failure = startHttp(httpConfig({ MCP_PORT: undefined }), logger, deps());

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(/MCP_PORT is required/);
    expect(logger.info).not.toHaveBeenCalledWith('listening on http', expect.anything());
  });

  /**
   * Node's 5 s keep-alive default sits under the 60 s an ALB or the nginx ingress keeps an idle
   * upstream connection: the proxy reused a connection this server had just closed, and answered
   * the client 502.
   */
  it('keeps idle connections open longer than a proxy in front of it does', async () => {
    const http = await start(httpConfig(), spyLogger(), deps());

    expect(http.server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(http.server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(http.server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(http.server.headersTimeout).toBeGreaterThan(http.server.keepAliveTimeout);
    // Receiving the request only; it must not be what cuts a long tool call short.
    expect(http.server.requestTimeout).toBeGreaterThanOrEqual(http.server.headersTimeout);
  });
});

describe('startHttp: shutdown', () => {
  /**
   * A session's close was `() => void transport.close()`, so `closeAll()` resolved at once and the
   * process exited while the RemoveSession request for each impersonated session was still
   * leaving — the session then sat open on the tenant until Ivanti timed it out.
   */
  it('waits for every session to hand its Ivanti session back before it resolves', async () => {
    const { createMcpServer, opened } = impersonatingConnections(50);
    const http = await startHttp(httpConfig(), spyLogger(), deps({ createMcpServer }));

    expect((await post(http, INITIALIZE)).status).toBe(200);
    expect((await post(http, INITIALIZE)).status).toBe(200);

    await http.close();

    expect(opened.released()).toBe(2);
  });

  /**
   * The dedicated `GET /mcp` stream is an in-flight response held open for the client's life, so
   * `http.close()` never finishes while one is attached. Closing the sessions first is what ends
   * the stream; reverse the two and this hangs instead of resolving.
   */
  it('closes sessions before the listener, so an attached stream cannot hold shutdown forever', async () => {
    const { createMcpServer, opened } = impersonatingConnections(5);
    const http = await startHttp(httpConfig(), spyLogger(), deps({ createMcpServer }));
    const { sessionId } = await post(http, INITIALIZE);
    const stream = new AbortController();
    const attached = await fetch(urlOf(http), {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId ?? '' },
      signal: stream.signal,
    });
    expect(attached.status).toBe(200);

    const outcome = await Promise.race([
      http.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);
    stream.abort();

    expect(outcome).toBe('closed');
    expect(opened.released()).toBe(1);
  });
});

describe('startHttp: the session cap', () => {
  /**
   * Clients abandon sessions without a DELETE as a matter of course. At the cap the server used to
   * refuse every newcomer until the thirty-minute TTL swept the abandoned ones.
   */
  it('closes the least recently used quiet session to admit a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { createMcpServer, opened } = impersonatingConnections(5);
    const logger = spyLogger();
    const http = await start(
      httpConfig({ MCP_MAX_SESSIONS: 1 }),
      logger,
      deps({ createMcpServer }),
    );

    const abandoned = await post(http, INITIALIZE);
    vi.setSystemTime(Date.now() + EVICTION_FLOOR_MS + 1_000);
    const newcomer = await post(http, INITIALIZE);

    expect(abandoned.status).toBe(200);
    expect(newcomer.status).toBe(200);
    await vi.waitFor(() => {
      expect(opened.released()).toBe(1);
    });
    // The client that abandoned it gets the answer that tells it to initialize again.
    const late = await post(
      http,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': abandoned.sessionId ?? '' },
    );
    expect(late.status).toBe(404);
    expect(logger.info).toHaveBeenCalledWith(
      'session evicted',
      expect.objectContaining({ sessionId: abandoned.sessionId, reason: 'cap' }),
    );
  });

  it('refuses when every session is recent, with a Retry-After that says when one could free', async () => {
    const http = await start(httpConfig({ MCP_MAX_SESSIONS: 1 }), spyLogger(), deps());

    await post(http, INITIALIZE);
    const refused = await post(http, INITIALIZE);

    expect(refused.status).toBe(503);
    expect(Number(refused.retryAfter)).toBeGreaterThan(EVICTION_FLOOR_MS / 1000 - 5);
    expect(Number(refused.retryAfter)).toBeLessThanOrEqual(EVICTION_FLOOR_MS / 1000);
  });

  /**
   * `admit()` counted registered sessions, and a session registers only once its initialize has
   * run. Two initializes arriving together both got the one free slot; the loser failed to
   * register mid-handshake and was answered 404 "Session not found" — a bug to the client, when
   * the truth was "full".
   */
  it('reserves the slot at admission, so a concurrent initialize is refused rather than lost', async () => {
    const { createMcpServer } = impersonatingConnections();
    let first = true;
    const slowFirst: HttpDeps['createMcpServer'] = (context) => {
      const connection = createMcpServer(context);
      if (first) {
        first = false;
        const connect = connection.server.connect.bind(connection.server);
        connection.server.connect = async (transport) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return connect(transport);
        };
      }
      return connection;
    };
    const http = await start(
      httpConfig({ MCP_MAX_SESSIONS: 1 }),
      spyLogger(),
      deps({ createMcpServer: slowFirst }),
    );

    const statuses = (await Promise.all([post(http, INITIALIZE), post(http, INITIALIZE)]))
      .map((answer) => answer.status)
      .sort();

    expect(statuses).toEqual([200, 503]);
  });

  it('records the client address and user agent when a session opens', async () => {
    const logger = spyLogger();
    const http = await start(httpConfig(), logger, deps());

    await post(http, INITIALIZE, { 'user-agent': 'claude-code/2.1' });

    expect(logger.info).toHaveBeenCalledWith(
      'session opened',
      expect.objectContaining({ remoteAddress: '127.0.0.1', userAgent: 'claude-code/2.1' }),
    );
  });

  it('holds one signed-in subject to its own limit by closing its oldest session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { createMcpServer, opened } = impersonatingConnections(5);
    const verifier: TokenVerifier = (token) =>
      Promise.resolve({
        ok: true,
        identity: { subject: token, issuer: 'https://id.example.com', scopes: [], claims: {} },
      });
    const http = await start(
      httpConfig({
        AUTH_MODE: 'oauth',
        OAUTH_ISSUER: 'https://id.example.com',
        MCP_MAX_SESSIONS_PER_SUBJECT: 1,
      }),
      spyLogger(),
      deps({ createMcpServer, verifier }),
    );

    const alice = { authorization: 'Bearer alice' };
    const firstAlice = await post(http, INITIALIZE, alice);
    const bob = await post(http, INITIALIZE, { authorization: 'Bearer bob' });
    vi.setSystemTime(Date.now() + 1_000);
    const secondAlice = await post(http, INITIALIZE, alice);

    expect([firstAlice.status, bob.status, secondAlice.status]).toEqual([200, 200, 200]);
    await vi.waitFor(() => {
      expect(opened.released()).toBe(1);
    });
    const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const onFirst = await post(http, tools, {
      ...alice,
      'mcp-session-id': firstAlice.sessionId ?? '',
    });
    const onBobs = await post(http, tools, {
      authorization: 'Bearer bob',
      'mcp-session-id': bob.sessionId ?? '',
    });
    expect(onFirst.status).toBe(404);
    // Another subject's session is not theirs to lose.
    expect(onBobs.status).not.toBe(404);
  });
});

describe('openModeWarnings', () => {
  it('names the exposure when an unauthenticated server binds beyond loopback', () => {
    const [warning, ...rest] = openModeWarnings(
      httpConfig({ MCP_BIND: '0.0.0.0', MCP_PORT: 3000 }),
    );

    expect(rest).toEqual([]);
    expect(warning?.message).toContain('0.0.0.0');
    expect(warning?.message).toContain('not loopback');
    // Inside a container 0.0.0.0 is normal, so the advice is about publishing, not refusing.
    expect(warning?.fields.advice).toContain('-p 127.0.0.1:3000:3000');
  });

  it('keeps the plain warning on loopback', () => {
    const warnings = openModeWarnings(httpConfig({ MCP_BIND: '127.0.0.1' }));

    expect(warnings.map((warning) => warning.message)).toEqual([
      'AUTH_MODE=none: no authentication, the network is the only boundary',
    ]);
  });

  it('says nothing when there is authentication', () => {
    expect(
      openModeWarnings(httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: 't', MCP_BIND: '0.0.0.0' })),
    ).toEqual([]);
  });
});

describe('startHttp: /ready', () => {
  const notReady: Readiness = {
    state: () => ({ ready: false, reason: 'Ivanti GET 503', checkedAt: '2026-09-30T08:00:00.000Z' }),
    checkNow: () => Promise.resolve(),
    stop: () => undefined,
  };
  const get = async (http: HttpServer, headers: Record<string, string> = {}) => {
    const response = await fetch(urlOf(http).replace(/\/mcp$/, '/ready'), { headers });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  // With no Ivanti configured there is nothing to wait for.
  it('is ready when nothing was given to check', async () => {
    const http = await start(httpConfig(), spyLogger(), deps());

    expect(await get(http)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  it('answers 503 while the tenant is not answering, with why to a caller who may see it', async () => {
    const http = await start(httpConfig(), spyLogger(), deps({ readiness: notReady }));

    expect(await get(http)).toEqual({
      status: 503,
      body: { status: 'not-ready', reason: 'Ivanti GET 503', checkedAt: '2026-09-30T08:00:00.000Z' },
    });
  });

  // A probe cannot authenticate, so the endpoint answers anyone — and says nothing more to them.
  it('tells an anonymous caller only that it is not ready', async () => {
    const token = 't'.repeat(40);
    const http = await start(
      httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: token }),
      spyLogger(),
      deps({ readiness: notReady }),
    );

    expect(await get(http)).toEqual({ status: 503, body: { status: 'not-ready' } });
    expect((await get(http, { authorization: `Bearer ${token}` })).body).toMatchObject({ reason: 'Ivanti GET 503' });
  });
});

/**
 * The rules the listener applies before anything else — Origin, the door, the health detail gate —
 * decided in its own routing, so they are exercised here through a real socket. The predicates are
 * tested alone; nothing else notices if a refactor drops the call to one.
 */
describe('startHttp: the listener enforces its rules', () => {
  const TOKEN = 't'.repeat(40);
  const EVIL = 'https://evil.example';
  const TRUSTED = 'http://127.0.0.1';
  const rejectingVerifier: TokenVerifier = () =>
    Promise.resolve({ ok: false, status: 401, error: 'invalid_token', description: 'nope' });
  const acceptingVerifier: TokenVerifier = (token) =>
    Promise.resolve({
      ok: true,
      identity: { subject: token, issuer: 'https://id.example.com', scopes: [], claims: {} },
    });

  const modes: [string, Partial<Config>, Partial<HttpDeps>, Record<string, string>][] = [
    ['none', { AUTH_MODE: 'none' }, {}, {}],
    ['bearer', { AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }, {}, { authorization: `Bearer ${TOKEN}` }],
    [
      'oauth',
      { AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://id.example.com' },
      { verifier: acceptingVerifier },
      { authorization: 'Bearer alice' },
    ],
  ];

  const send = async (
    http: HttpServer,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown }> => {
    const response = await fetch(urlOf(http).replace(/\/mcp$/, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
  };

  describe.each(modes)('Origin validation under AUTH_MODE=%s', (_mode, overrides, extra, credentials) => {
    it('refuses an untrusted Origin with 403 and opens no session', async () => {
      const http = await start(httpConfig(overrides), spyLogger(), deps(extra));

      const refused = await send(http, '/mcp', { ...credentials, origin: EVIL }, INITIALIZE);

      expect(refused.status).toBe(403);
      expect(refused.json).toEqual({ error: 'forbidden_origin' });
      expect(http.sessionCount()).toBe(0);
    });

    it('lets a trusted Origin and an absent one through', async () => {
      const http = await start(httpConfig(overrides), spyLogger(), deps(extra));

      const trusted = await send(http, '/mcp', { ...credentials, origin: TRUSTED }, INITIALIZE);
      const absent = await send(http, '/mcp', credentials, INITIALIZE);

      expect(trusted.status).toBe(200);
      expect(absent.status).toBe(200);
      expect(http.sessionCount()).toBe(2);
    });

    it('also refuses an untrusted Origin on GET', async () => {
      const http = await start(httpConfig(overrides), spyLogger(), deps(extra));

      const refused = await send(http, '/mcp', {
        ...credentials,
        origin: EVIL,
        'mcp-session-id': 'whatever',
        accept: 'text/event-stream',
      });

      expect(refused.status).toBe(403);
    });
  });

  // Origin is judged before the credential: a page that cannot be trusted learns nothing about the
  // door, and a refactor that authorizes first would answer 401 here.
  it('judges the Origin before the credential', async () => {
    const http = await start(
      httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }),
      spyLogger(),
      deps(),
    );

    const answer = await send(http, '/mcp', { origin: EVIL, authorization: 'Bearer wrong' }, INITIALIZE);

    expect(answer.status).toBe(403);
  });

  describe('the 401', () => {
    it('answers a wrong bearer token with 401 and the generic body', async () => {
      const http = await start(
        httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }),
        spyLogger(),
        deps(),
      );

      const answer = await send(http, '/mcp', { authorization: 'Bearer wrong' }, INITIALIZE);

      expect(answer.status).toBe(401);
      expect(answer.json).toEqual({ error: 'unauthorized' });
      expect(http.sessionCount()).toBe(0);
    });

    it('carries the oauth challenge naming the metadata document, for a rejected and a missing token', async () => {
      const config = httpConfig({
        AUTH_MODE: 'oauth',
        OAUTH_ISSUER: 'https://id.example.com',
        MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
      });
      const http = await start(config, spyLogger(), deps({ verifier: rejectingVerifier }));

      for (const headers of [{ authorization: 'Bearer bad' }, {} as Record<string, string>]) {
        const answer = await send(http, '/mcp', headers, INITIALIZE);

        expect(answer.status).toBe(401);
        expect(answer.json).toEqual({ error: 'unauthorized' });
        const challenge = answer.headers.get('www-authenticate') ?? '';
        expect(challenge).toMatch(/^Bearer /);
        expect(challenge).toContain(`resource_metadata="${metadataUrl('https://mcp.example.com/mcp')}"`);
      }
    });
  });

  describe('/health', () => {
    it('tells an anonymous caller only that the process is alive', async () => {
      const http = await start(
        httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }),
        spyLogger(),
        deps(),
      );

      const answer = await send(http, '/health');

      expect(answer.status).toBe(200);
      expect(answer.json).toEqual(MINIMAL_HEALTH);
    });

    it('gives the detail to a caller holding the token', async () => {
      const http = await start(
        httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }),
        spyLogger(),
        deps({ serverName: 'ivanti', serverVersion: '9.9.9' }),
      );

      const answer = await send(http, '/health', { authorization: `Bearer ${TOKEN}` });

      expect(answer.json).toMatchObject({ status: 'ok', name: 'ivanti', version: '9.9.9', sessions: 0 });
    });

    it('gives an anonymous caller no more for a wrong token', async () => {
      const http = await start(
        httpConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }),
        spyLogger(),
        deps(),
      );

      expect((await send(http, '/health', { authorization: 'Bearer wrong' })).json).toEqual(MINIMAL_HEALTH);
    });
  });

  describe('the oauth metadata document', () => {
    it('is served unauthenticated, and only in oauth mode', async () => {
      const oauth = await start(
        httpConfig({
          AUTH_MODE: 'oauth',
          OAUTH_ISSUER: 'https://id.example.com',
          MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
        }),
        spyLogger(),
        deps({ verifier: rejectingVerifier }),
      );
      const none = await start(httpConfig(), spyLogger(), deps());
      const path = '/.well-known/oauth-protected-resource/mcp';

      expect((await send(oauth, path)).json).toMatchObject({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://id.example.com'],
      });
      expect((await send(none, path)).status).toBe(404);
    });
  });

  // `authorizeRequest` models none of these: the listener refuses to start in a state where oauth
  // has no verifier or no resource to name.
  it('refuses to start in oauth mode without a verifier', async () => {
    const failure = startHttp(
      httpConfig({ AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://id.example.com' }),
      spyLogger(),
      deps(),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(/token verifier/);
  });
});
