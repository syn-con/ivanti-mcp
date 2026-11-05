// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  buildProtectedResourceMetadata,
  metadataPaths,
  metadataUrl,
} from '../auth/oauth/protected-resource-metadata.js';
import type { CallerIdentity } from '../auth/identity.js';
import type { TokenVerifier } from '../auth/oauth/verify-token.js';
import type { Config } from '../config/env-schema.js';
import { ConfigError } from '../config/load-config.js';
import { isExposedToNetwork } from '../config/validate-config.js';
import type { Logger } from '../logger.js';
import type { CallContext } from '../tools/tool-definition.js';
import type { McpConnection } from './create-server.js';
import { authorizeRequest, type AuthorizationResult } from './http/authorize-request.js';
import { buildHealth, MINIMAL_HEALTH } from './http/health.js';
import { ALWAYS_READY, type Readiness } from './http/readiness.js';
import { createMcpHandler, type McpSession } from './http/mcp-handler.js';
import { sendJson } from './http/respond.js';
import { resolveRoute } from './http/resolve-route.js';
import { SessionManager, type SessionSlot } from './http/session-manager.js';
import { isOriginAllowed } from './http/validate-origin.js';
import { recordHttpRejected } from '../metrics/server-metrics.js';

const SWEEP_INTERVAL_MS = 30_000;

/**
 * How long an idle keep-alive connection stays open — longer than whatever sits in front.
 *
 * An AWS ALB and the nginx ingress both keep an idle upstream connection for 60 s and reuse it;
 * Node's default closes it after 5. A request the proxy sent down a connection this server had
 * just closed came back as a sporadic 502 that no log on this side ever saw.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Above the keep-alive timeout, as Node's own guidance puts it: otherwise a request arriving late
 * on a reused connection can be cut at the header stage before the keep-alive timer would have.
 */
export const HEADERS_TIMEOUT_MS = 66_000;

/**
 * How long receiving a request may take — the request only, never the answer, so a tool call that
 * waits thirty seconds on an Ivanti write is not affected by it. Sized for the 4 MB body limit on
 * a slow uplink. Node refuses a value below the headers timeout.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

export interface HttpDeps {
  verifier?: TokenVerifier;
  /** A fresh server per session: `connect()` binds one transport at a time. */
  createMcpServer: (context: CallContext) => McpConnection;
  serverName: string;
  serverVersion: string;
  /** Resolved once at startup: reading it walks node_modules, and /health is a hot path. */
  sdkVersion: string;
  /** What the `listening on http` line carries besides the address — the manifest, the tools. */
  listeningFields?: Record<string, unknown>;
  /** Whether the tenant still answers; always ready when absent, as with no Ivanti configured. */
  readiness?: Readiness;
}

/** The listener could not bind. Already logged; the process has nothing to serve and exits. */
export class ListenError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ListenError';
  }
}

/** Why a bind failed, in the words of the setting that fixes it. */
export function explainListenFailure(
  error: NodeJS.ErrnoException,
  bind: string,
  port: number,
  /** Which settings to name: the metrics listener has its own. */
  settings: { bind: string; port: string } = { bind: 'MCP_BIND', port: 'MCP_PORT' },
): string {
  const where = `Cannot listen on ${bind}:${String(port)}`;
  switch (error.code) {
    case 'EADDRINUSE':
      return (
        `${where}: the port is already in use. Stop whatever holds it, or set ${settings.port} ` +
        'to a free one.'
      );
    case 'EACCES':
      return (
        `${where}: permission denied. A port below 1024 needs privileges this server does not ` +
        `have — the image runs as uid 65532 — so set ${settings.port} to 1024 or above.`
      );
    case 'EADDRNOTAVAIL':
      return (
        `${where}: this host has no such address. Set ${settings.bind} to one of its own ` +
        'addresses, or to 0.0.0.0 inside a container.'
      );
    default:
      return `${where}: ${error.message}`;
  }
}

/**
 * What an unauthenticated listener owes its operator, said before it binds.
 *
 * Warned, not refused: inside a container `0.0.0.0` is the ordinary bind, and whether that
 * reaches a network is decided by how the port is published, which this process cannot see.
 */
export function openModeWarnings(
  config: Config,
): { message: string; fields: Record<string, unknown> }[] {
  if (config.AUTH_MODE !== 'none') return [];
  const where = { bind: config.MCP_BIND, port: config.MCP_PORT };
  if (!isExposedToNetwork(config)) {
    return [
      {
        message: 'AUTH_MODE=none: no authentication, the network is the only boundary',
        fields: { ...where, trustedOrigins: config.TRUSTED_ORIGINS },
      },
    ];
  }
  const port = String(config.MCP_PORT);
  return [
    {
      message:
        `AUTH_MODE=none on ${config.MCP_BIND}, not loopback: anything that can reach port ` +
        `${port} acts in Ivanti through this server's account, unauthenticated`,
      fields: {
        ...where,
        trustedOrigins: config.TRUSTED_ORIGINS,
        advice:
          `In a container, publish the port on loopback only (-p 127.0.0.1:${port}:${port}); ` +
          'elsewhere set MCP_BIND=127.0.0.1, or AUTH_MODE to bearer or oauth.',
      },
    },
  ];
}

interface Session extends McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * The listener, plus the teardown that has to happen before it stops listening.
 *
 * `close()` is not `http.close()`: that waits for every in-flight response, and the dedicated
 * `GET /mcp` SSE stream IS an in-flight response held open for the life of the client — measured
 * at 131 s in notes.md, i.e. the ordinary state rather than an edge. With one client attached the
 * callback and the `'close'` event never fired, so nothing that hung off them ever ran and the
 * process waited for SIGKILL.
 */
export interface HttpServer {
  server: Server;
  /** Closes every session (which releases its Ivanti session), then stops the listener. */
  close: () => Promise<void>;
  /** Sessions held now, for the metrics gauge. */
  sessionCount: () => number;
}

/**
 * Serves the MCP endpoint, a health probe and the OAuth metadata document.
 *
 * This function is wiring. The decisions live in collaborators that can be tested without a
 * socket: `resolveRoute` for dispatch, `authorizeRequest` for the door, `SessionManager` for
 * admission and expiry, `readJsonBody` and `describeRpc` for the payload.
 */
export async function startHttp(
  config: Config,
  logger: Logger,
  deps: HttpDeps,
): Promise<HttpServer> {
  // `validateConfig` already refuses HTTP without a port. Checked again here so that a config
  // which skipped it fails as configuration, never as `listen(undefined)` on a random port.
  const port = config.MCP_PORT;
  if (port === undefined) throw new ConfigError(['MCP_PORT is required for HTTP transports.']);

  const sessions = new SessionManager<Session>({
    maxSessions: config.MCP_MAX_SESSIONS,
    idleTtlMs: config.MCP_SESSION_IDLE_TTL_SECONDS * 1000,
    logger,
    ...(config.MCP_MAX_SESSIONS_PER_SUBJECT === undefined
      ? {}
      : { maxPerSubject: config.MCP_MAX_SESSIONS_PER_SUBJECT }),
  });

  const publicUrl = config.MCP_PUBLIC_URL;
  // oauth is only servable with all three; checked here so that nothing below has to model "oauth,
  // but no verifier" or "oauth, but no resource" as a state a request can be in.
  if (config.AUTH_MODE === 'oauth') {
    const missing = [
      deps.verifier === undefined ? 'a token verifier' : undefined,
      publicUrl === undefined ? 'MCP_PUBLIC_URL' : undefined,
      config.OAUTH_ISSUER === undefined ? 'OAUTH_ISSUER' : undefined,
    ].filter((name) => name !== undefined);
    if (missing.length > 0) {
      throw new ConfigError([`AUTH_MODE=oauth cannot be served without ${missing.join(', ')}.`]);
    }
  }
  const protectedResource =
    config.AUTH_MODE === 'oauth' && publicUrl !== undefined && config.OAUTH_ISSUER !== undefined
      ? buildProtectedResourceMetadata({
          resource: publicUrl,
          issuer: config.OAUTH_ISSUER,
          scopesSupported: config.OAUTH_SCOPES_SUPPORTED,
          resourceName: 'Ivanti MCP',
        })
      : undefined;
  const oauthPaths =
    publicUrl !== undefined && protectedResource !== undefined
      ? new Set(metadataPaths(publicUrl))
      : new Set<string>();
  const resourceMetadataUrl = publicUrl !== undefined ? metadataUrl(publicUrl) : undefined;

  const authorize = (request: IncomingMessage): Promise<AuthorizationResult> =>
    authorizeRequest(
      config,
      { authorization: request.headers.authorization },
      { verifier: deps.verifier, resourceMetadataUrl },
    );

  const createSession = (identity: CallerIdentity, slot: SessionSlot<Session>): Session => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string): void => {
        // Into the slot `admit()` reserved for it, which nothing else can have taken meanwhile.
        slot.commit(sessionId, session);
      },
      onsessionclosed: (sessionId: string): void => {
        sessions.unregister(sessionId);
      },
    });

    // The identity is fixed when the session is created, which is what "pinned per session"
    // means for the verified path: a later request cannot change who this conversation acts as.
    // The session id is not fixed — it does not exist until `initialize` completes — so it is
    // read when a tool is called rather than captured now.
    const connection = deps.createMcpServer({
      identity,
      get sessionId(): string | undefined {
        return transport.sessionId;
      },
    });

    const session: Session = {
      transport,
      server: connection.server,
      identity,
      connect: () => connection.server.connect(transport),
      // The connection's close, not the transport's: that one returns before the person's Ivanti
      // session is released, so shutdown awaited it and then exited ahead of the release.
      close: () => connection.close(),
    };

    return session;
  };

  const handleMcp = createMcpHandler<Session>({
    sessions,
    logger,
    createSession,
    ...(config.OAUTH_IDENTITY_CLAIM === undefined
      ? {}
      : { directoryClaim: config.OAUTH_IDENTITY_CLAIM }),
  });

  const http = createHttpServer(
    {
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    (request, response): void => {
      void (async (): Promise<void> => {
        switch (resolveRoute(request.url, oauthPaths)) {
          case 'health': {
            // Always 200, because a liveness probe cannot authenticate — but the detail is gated
            // on the same authorization as everything else. Anonymous callers learn only that
            // the process is alive.
            const permitted = await authorize(request);
            sendJson(
              response,
              200,
              permitted.authorized
                ? buildHealth({
                    name: deps.serverName,
                    version: deps.serverVersion,
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    sdkVersion: deps.sdkVersion,
                    sessions: () => sessions.size,
                  })
                : MINIMAL_HEALTH,
            );
            return;
          }

          case 'ready': {
            // Unauthenticated, like /health, because a readiness probe cannot authenticate either.
            // 503 while the tenant is not answering, so a Service or load balancer stops routing
            // here until it is. Why, and since when, only to a caller who could see the rest.
            const permitted = await authorize(request);
            const { ready, ...detail } = (deps.readiness ?? ALWAYS_READY).state();
            sendJson(response, ready ? 200 : 503, {
              status: ready ? 'ready' : 'not-ready',
              ...(permitted.authorized ? detail : {}),
            });
            return;
          }

          case 'oauth-metadata': {
            // Unauthenticated by necessity: this document is how a client discovers *how* to
            // authenticate, so requiring a token to read it would be circular.
            if (protectedResource === undefined) {
              sendJson(response, 404, { error: 'not_found' });
              return;
            }
            sendJson(response, 200, protectedResource);
            return;
          }

          case 'mcp': {
            if (!isOriginAllowed(request.headers.origin, config.TRUSTED_ORIGINS)) {
              recordHttpRejected('origin');
              logger.warn('rejected request with untrusted origin', {
                origin: request.headers.origin,
              });
              sendJson(response, 403, { error: 'forbidden_origin' });
              return;
            }

            const authorization = await authorize(request);
            if (!authorization.authorized) {
              recordHttpRejected('unauthorized');
              logger.warn('rejected unauthorized request', { reason: authorization.reason });
              if (authorization.challenge !== undefined) {
                response.setHeader('WWW-Authenticate', authorization.challenge);
              }
              sendJson(response, authorization.status, { error: 'unauthorized' });
              return;
            }

            await handleMcp(request, response, authorization);
            return;
          }

          default:
            sendJson(response, 404, { error: 'not_found' });
        }
      })().catch((error: unknown) => {
        logger.error('request handler failed', { error });
        if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      });
    },
  );

  for (const warning of openModeWarnings(config)) logger.warn(warning.message, warning.fields);

  // Awaited, and only then announced: `listen()` returns before the port is bound, so the line
  // used to say "listening" for a server about to die of EADDRINUSE — as an uncaught exception
  // with a stack, a moment after the log had said all was well.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      http.off('listening', onListening);
      const reason = explainListenFailure(error, config.MCP_BIND, port);
      logger.error('cannot listen on http', {
        bind: config.MCP_BIND,
        port,
        code: error.code,
        reason,
      });
      reject(new ListenError(reason, error.code));
    };
    const onListening = (): void => {
      http.off('error', onError);
      resolve();
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen(port, config.MCP_BIND);
  });

  const address = http.address();
  logger.info('listening on http', {
    bind: config.MCP_BIND,
    // The port actually bound, which is the configured one unless that was 0.
    port: typeof address === 'object' && address !== null ? address.port : port,
    authMode: config.AUTH_MODE,
    mcpMode: config.MCP_MODE,
    maxSessions: config.MCP_MAX_SESSIONS,
    ...(config.MCP_MAX_SESSIONS_PER_SUBJECT === undefined
      ? {}
      : { maxSessionsPerSubject: config.MCP_MAX_SESSIONS_PER_SUBJECT }),
    ...deps.listeningFields,
  });

  const stopSweeping = sessions.startSweeping(SWEEP_INTERVAL_MS);

  return {
    server: http,
    sessionCount: () => sessions.size,
    async close(): Promise<void> {
      // Order matters. Closing the sessions ends their SSE streams, which is what lets
      // `http.close()` finish at all; doing it the other way round waits forever on the stream it
      // is trying to drain. Awaited, because closing a session is what releases the person's
      // Ivanti session and the process must not exit before that request leaves.
      stopSweeping();
      await sessions.closeAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      // Anything still holding a socket after that — a client that never read its response — is
      // not worth the grace period.
      http.closeAllConnections();
    },
  };
}
