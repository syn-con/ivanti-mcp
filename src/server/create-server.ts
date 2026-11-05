// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { LicenceCheck } from '../tools/call/licence-gate.js';
import type { Logger } from '../logger.js';
import {
  createImpersonationSlot,
  type ImpersonationSlot,
  type SessionOpener,
} from '../auth/impersonation.js';
import {
  openImpersonatedSession,
  type ImpersonatedSession,
} from '../ivanti/session/impersonated-session.js';
import { registerTools, selectTools } from '../tools/register-tools.js';
import { registerResources, selectResources } from '../resources/register-resources.js';
import type { CallContext } from '../tools/tool-definition.js';
import { buildInstructions } from './instructions.js';
import { fingerprintManifest, type ManifestFingerprint } from '../tools/manifest-fingerprint.js';
import { readPackageMetadata } from '../version.js';

// package.json is the single source of truth for both, so a published image and the version it
// reports cannot disagree.
const { name: SERVER_NAME, version: SERVER_VERSION } = readPackageMetadata();

export { SERVER_NAME, SERVER_VERSION };

/**
 * One connection's server, and the way to end it that waits for what ending it starts.
 *
 * `McpServer.close()` alone is not that. The SDK runs `onclose` synchronously and awaits nothing
 * it starts, so the release `releaseOnClose` begins was still in flight when `close()` resolved —
 * and a shutdown that awaited it exited ahead of the request handing the person's Ivanti session
 * back.
 */
export interface McpConnection {
  server: McpServer;
  /** Closes the transport, then resolves once any Ivanti session it held has been released. */
  close: () => Promise<void>;
}

export interface ServerFactory {
  /** Names of the tools every server produced by this factory exposes. */
  toolNames: string[];
  /** URIs of the reference documents it exposes. Empty when no tenant is configured. */
  resourceUris: string[];
  /** Which instructions this deployment sends to a verified caller, and what they cost per request. */
  manifest: ManifestFingerprint;
  /** The same for the connection `context` describes: a caller without a token is sent other text. */
  manifestFor: (context: CallContext) => ManifestFingerprint;
  /**
   * A fresh server per connection — the SDK forbids one instance holding two transports — bound
   * to the identity that connection established.
   */
  create: (context: CallContext) => McpConnection;
}

/**
 * Builds the tool definitions **once**, then hands out a server per connection.
 *
 * The split matters because `Protocol.connect()` refuses a second transport ("use a separate
 * Protocol instance per connection"), so servers must be per-session — but the definitions
 * they register need not be. Building them once keeps a session cheap: its cost is a map of
 * names pointing at shared objects, not a rebuilt copy of every schema.
 */
export interface ServerFactoryDeps {
  logger: Logger;
  /** The licence check (design §9f). Absent only in tests, where every call is licensed. */
  licence?: LicenceCheck;
  /** Absent when no tenant is configured. */
  ivanti?: IvantiConnection;
}

/**
 * Gives an Ivanti session back when the conversation holding it ends.
 *
 * Exported so the guarantee can be tested on the path that actually runs, rather than on a
 * reconstruction of it. It chains rather than replaces: `onclose` may already carry the SDK's own
 * teardown, and dropping that to add this would trade one leak for another.
 *
 * Returns the release the last close started, because `onclose` cannot: the SDK calls it and
 * moves on, so whoever must not exit before the release leaves — shutdown — awaits this instead.
 */
export function releaseOnClose(server: McpServer, slot: ImpersonationSlot): () => Promise<void> {
  let releasing: Promise<void> = Promise.resolve();
  const previous = server.server.onclose;
  server.server.onclose = (): void => {
    releasing = slot.release();
    previous?.call(server.server);
  };
  return () => releasing;
}

/**
 * A fresh `initialize` on a live connection is a new conversation, so the previous one ends.
 *
 * Chains rather than replaces, for the same reason `releaseOnClose` does: the SDK sets its own
 * handler and dropping it would trade one bug for another. A connection's *first* `initialize`
 * fires this too, which is a no-op — there is nobody pinned yet to forget.
 */
export function endOnInitialize(server: McpServer, endConversation: () => Promise<void>): void {
  const previous = server.server.oninitialized;
  server.server.oninitialized = (): void => {
    void endConversation();
    previous?.call(server.server);
  };
}

export function createServerFactory(config: Config, deps: ServerFactoryDeps): ServerFactory {
  // Built once, from process-wide facts. `canImpersonate` is the gate: a deployment whose
  // ConfigDB is unconfigured or unreachable gets no opener, so no connection gets a slot, so
  // `act_as` keeps its existing meaning without a single conditional in the tools.
  const ivanti = deps.ivanti;
  const centralConfig =
    ivanti?.capability.canImpersonate === true ? ivanti.centralConfig : undefined;
  const opener: SessionOpener | undefined =
    ivanti !== undefined && centralConfig !== undefined
      ? (login: string): Promise<ImpersonatedSession> =>
          openImpersonatedSession({
            centralConfig,
            routes: ivanti.transport.routes,
            // The tenant hostname IS Ivanti's `tenantId`. Taken from the URL that actually
            // answered at startup rather than re-derived from configuration.
            tenantHost: new URL(ivanti.metadataUrl).hostname,
            login,
            rolePolicy:
              config.MCP_MODE === 'enduser'
                ? { mode: 'enduser', role: config.ENDUSER_ROLE, setting: 'ENDUSER_ROLE' }
                : {
                    mode: 'full',
                    setting: 'IVANTI_IMPERSONATION_ROLE',
                    ...(config.IVANTI_IMPERSONATION_ROLE === undefined
                      ? {}
                      : { pinnedRole: config.IVANTI_IMPERSONATION_ROLE }),
                  },
            // The handshake is POSTs end to end, so it gets the write budget.
            timeoutMs: config.IVANTI_WRITE_TIMEOUT_MS,
            // The person's requests count against the same cap as everyone else's.
            ...(ivanti.limiter === undefined ? {} : { limiter: ivanti.limiter }),
            logger: deps.logger,
          })
      : undefined;

  const toolContext = {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    logger: deps.logger,
    ...(deps.ivanti === undefined ? {} : { ivanti: deps.ivanti }),
    ...(deps.licence === undefined ? {} : { licence: deps.licence }),
  };

  const tools = selectTools(config, toolContext);
  // Built once for the same reason the tools are: the text is shared by reference, so a session
  // costs a map entry rather than a copy of every document.
  const resources = selectResources(config, toolContext);

  const instructionsFor = (withToken: boolean): string | undefined =>
    buildInstructions({
      capability: deps.ivanti?.capability,
      mode: config.MCP_MODE,
      ...(config.AUTH_MODE === undefined || !withToken ? {} : { authMode: config.AUTH_MODE }),
      resourceUris: resources.map((resource) => resource.uri),
    });
  const instructions = instructionsFor(true);
  // A conversation that carries no token is told to ask who it is helping, whatever AUTH_MODE
  // says: with stdio beside an `oauth` HTTP transport, the stdio conversation was told the sign-in
  // already named the person — and the gate, finding no token, refused every call until `act_as`.
  // Built once too; identical to the other wherever AUTH_MODE is not `oauth`.
  const instructionsWithoutToken = config.AUTH_MODE === 'oauth' ? instructionsFor(false) : instructions;

  // Once, like the tools: it is a property of the deployment, not of a session.
  const manifest = fingerprintManifest(tools, instructions);
  // The usage lines of a connection must carry the fingerprint of the text it was actually sent.
  const manifestWithoutToken =
    instructionsWithoutToken === instructions
      ? manifest
      : fingerprintManifest(tools, instructionsWithoutToken);
  const manifestFor = (context: CallContext): ManifestFingerprint =>
    context.identity.provenance === 'verified' ? manifest : manifestWithoutToken;

  return {
    toolNames: tools.map((tool) => tool.name),
    resourceUris: resources.map((resource) => resource.uri),
    manifest,
    manifestFor,
    create: (context: CallContext): McpConnection => {
      const sent = context.identity.provenance === 'verified' ? instructions : instructionsWithoutToken;
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        // Said once, at connect time, rather than repeated in every tool description.
        sent === undefined ? {} : { instructions: sent },
      );

      // Unset, the SDK drops these on the floor. Warn rather than error, and no stack: the HTTP
      // transport reports client mistakes here too — a wrong Accept header, invalid JSON, an
      // expired session — and at error level any client could fill the log with them.
      server.server.onerror = (error: Error): void => {
        deps.logger.warn('mcp protocol error', { reason: error.message });
      };

      // Per connection, like the pin — and released here rather than anywhere else, so the thing
      // that creates an Ivanti session is the thing that gives it back.
      const impersonation = opener === undefined ? undefined : createImpersonationSlot(opener);
      const released =
        impersonation === undefined
          ? (): Promise<void> => Promise.resolve()
          : releaseOnClose(server, impersonation);

      // Its own knob: on stdio this is the only thing that ends a conversation, and how long a
      // person's records stay reachable is not the same question as how long a dead HTTP session
      // may hold memory.
      const { endConversation, mayAnswer } = registerTools(
        server,
        tools,
        { ...context, ...(impersonation === undefined ? {} : { impersonation }) },
        deps.logger,
        config.MCP_IDENTITY_IDLE_TTL_SECONDS * 1000,
        manifestFor(context),
        config.MCP_MAX_CALLS_PER_MINUTE,
        deps.licence,
      );
      endOnInitialize(server, endConversation);
      registerResources(server, resources, mayAnswer, deps.logger);
      return {
        server,
        close: async (): Promise<void> => {
          await server.close();
          await released();
        },
      };
    },
  };
}
