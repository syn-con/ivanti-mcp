// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import { createLogger, type Logger } from '../logger.js';
import { ANONYMOUS, assertedIdentity, verifiedIdentity, type CallerIdentity } from '../auth/identity.js';
import {
  createImpersonationSlot,
  type ImpersonationSlot,
  type SessionOpener,
} from '../auth/impersonation.js';
import { IvantiApiError } from '../ivanti/http/errors.js';
import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';
import { sample } from '../metrics/sample.fixture.js';
import { registerTools, selectTools } from './register-tools.js';
import type { ToolDefinition } from './tool-definition.js';
import type { LicenceCheck } from './call/licence-gate.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const context = { serverName: 'ivanti-mcp', serverVersion: '0.1.0', logger: logger() };

const CALL = { identity: ANONYMOUS };

const config = configFixture;

describe('selectTools', () => {
  it('exposes only get_version when no tenant is configured', () => {
    // Without a connection the Ivanti tools do not exist at all, rather than existing and
    // failing: an unregistered tool never appears in tools/list.
    expect(selectTools(config(), context).map((tool) => tool.name)).toEqual(['get_version']);
    expect(selectTools(config({ MCP_MODE: 'enduser' }), context).map((t) => t.name)).toEqual([
      'get_version',
    ]);
  });

  it('adds the schema tools once a tenant is configured', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config(), { ...context, ivanti: connection }).map((t) => t.name);

    expect(names).toContain('list_business_objects');
    expect(names).toContain('get_object_metadata');
  });

  it('gives an end user the same read-only schema tools', () => {
    const { connection } = connectionFixture();

    const names = selectTools(config({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['Incident'] }), {
      ...context,
      ivanti: connection,
    }).map((t) => t.name);

    expect(names).toContain('get_object_metadata');
  });
});

describe('registerTools', () => {
  it('registers each supplied tool on the server', () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;

    const { names } = registerTools(server, selectTools(config(), context), CALL, logger());

    expect(names).toEqual(['get_version']);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      'get_version',
      expect.objectContaining({ title: 'Get server version' }),
      expect.any(Function),
    );
  });

  it('shares one config object across servers rather than rebuilding the schemas', () => {
    // This is the point of hoisting the registry: `registerTool` stores the config by
    // reference, so a shared definition means one copy of the schemas for every session.
    const tools = selectTools(config(), context);
    const a = vi.fn();
    const b = vi.fn();

    registerTools({ registerTool: a } as unknown as McpServer, tools, CALL, logger());
    registerTools({ registerTool: b } as unknown as McpServer, tools, CALL, logger());

    expect(a.mock.calls[0]?.[1]).toBe(b.mock.calls[0]?.[1]);
    // The callback is NOT shared, and must not be: it carries the identity of one conversation.
    // A shared closure would be a shared caller.
    expect(a.mock.calls[0]?.[2]).not.toBe(b.mock.calls[0]?.[2]);
  });

  it('hands every handler the context of the session that registered it', async () => {
    const registerTool = vi.fn();
    const tools = selectTools(config(), context);
    const call = { identity: assertedIdentity('jsmith'), sessionId: 's1' };

    registerTools({ registerTool } as unknown as McpServer, tools, call, logger());
    const callback = registerTool.mock.calls[0]?.[2] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    await callback({});

    // get_version reports the provenance, which is how the harness can tell the paths apart.
    expect(JSON.stringify(await callback({}))).toContain('asserted');
  });

  // A model in a loop, or a client replaying one, is stopped here rather than at the tenant.
  it('refuses a conversation\'s calls past its limit for the minute, and says how long to wait', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T08:00:00Z') });
    try {
      const registerTool = vi.fn();
      const tools = selectTools(config(), context);
      const call = { identity: assertedIdentity('jsmith'), sessionId: 's1' };
      registerTools({ registerTool } as unknown as McpServer, tools, call, logger(), undefined, undefined, 2);
      const callback = registerTool.mock.calls[0]?.[2] as (
        args: Record<string, unknown>,
      ) => Promise<{ isError?: boolean; content: { text: string }[] }>;

      await callback({});
      vi.advanceTimersByTime(20_000);
      await callback({});
      const refused = await callback({});

      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain('Wait 40 s');

      // The first call leaves the window a minute after it was made.
      vi.advanceTimersByTime(40_000);
      expect((await callback({})).isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts every call by tool and outcome', async () => {
    const registerTool = vi.fn();
    registerTools({ registerTool } as unknown as McpServer, selectTools(config(), context), CALL, logger());
    const callback = registerTool.mock.calls[0]?.[2] as (args: Record<string, unknown>) => Promise<unknown>;
    const before = sample('ivanti_mcp_tool_calls_total', { tool: 'get_version', outcome: 'ok' });
    const timed = sample('ivanti_mcp_tool_call_duration_seconds_count', { tool: 'get_version' });

    await callback({});

    expect(sample('ivanti_mcp_tool_calls_total', { tool: 'get_version', outcome: 'ok' })).toBe(before + 1);
    expect(sample('ivanti_mcp_tool_call_duration_seconds_count', { tool: 'get_version' })).toBe(timed + 1);
  });

  it('audits every call without ever logging its arguments', async () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const log = { ...logger(), info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, fields }) };
    const registerTool = vi.fn();

    registerTools(
      { registerTool } as unknown as McpServer,
      selectTools(config(), context),
      { identity: assertedIdentity('jsmith'), sessionId: 's1' },
      log,
    );
    const callback = registerTool.mock.calls[0]?.[2] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    await callback({ secret: 'ticket text nobody should log' });

    expect(lines[0]).toMatchObject({
      message: 'tool called',
      fields: { tool: 'get_version', sessionId: 's1', identity: 'asserted' },
    });
    // An asserted subject is a claim, not a fact, and arguments carry personal data.
    expect(JSON.stringify(lines)).not.toContain('jsmith');
    expect(JSON.stringify(lines)).not.toContain('ticket text');
  });

  it('stamps every line a call causes with the tool, the session and the request id', async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = (line: string): void => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    };
    // A second logger, deep in the handler, stands in for the transport's `ivanti request` line:
    // the context belongs to the call, not to whichever logger writes.
    const deep = createLogger('debug', sink);
    const probe: ToolDefinition = {
      name: 'probe',
      config: { title: 'Probe', description: 'Logs from inside.', inputSchema: {}, annotations: {} },
      handler: () => {
        deep.debug('ivanti request');
        return { content: [] };
      },
    };
    const registerTool = vi.fn();
    const transport: { sessionId?: string } = {};

    registerTools(
      { registerTool } as unknown as McpServer,
      [probe],
      {
        identity: ANONYMOUS,
        get sessionId(): string | undefined {
          return transport.sessionId;
        },
      },
      createLogger('debug', sink),
    );
    // Over HTTP the id exists only once `initialize` completes, which is after registration.
    transport.sessionId = 's1';
    const callback = registerTool.mock.calls[0]?.[2] as (
      args: Record<string, unknown>,
      extra: { requestId: number },
    ) => Promise<unknown>;
    await callback({}, { requestId: 7 });

    expect(lines.find((line) => line.message === 'ivanti request')).toMatchObject({
      tool: 'probe',
      sessionId: 's1',
      rpcId: 7,
    });
    expect(lines.find((line) => line.message === 'tool called')).toMatchObject({ sessionId: 's1' });
  });

  describe('the usage line', () => {
    type Line = Record<string, unknown> | undefined;
    const harness = (
      handler: ToolDefinition['handler'],
      manifest?: { manifest: string; manifestChars: number },
    ): { call: (args?: Record<string, unknown>) => Promise<Line>; endConversation: () => Promise<void> } => {
      const lines: Record<string, unknown>[] = [];
      const tool: ToolDefinition = {
        name: 'probe',
        config: { title: 'Probe', description: 'Measured.', inputSchema: {}, annotations: {} },
        handler,
      };
      const registerTool = vi.fn();
      const registered = registerTools(
        { registerTool } as unknown as McpServer,
        [tool],
        { identity: ANONYMOUS, sessionId: 's1' },
        createLogger('info', (line) => lines.push(JSON.parse(line) as Record<string, unknown>)),
        undefined,
        manifest,
      );
      const callback = registerTool.mock.calls[0]?.[2] as (
        args: Record<string, unknown>,
      ) => Promise<unknown>;
      return {
        call: async (args = {}) => {
          await callback(args).catch(() => undefined);
          return lines.filter((line) => line.message === 'tool finished').at(-1);
        },
        endConversation: registered.endConversation,
      };
    };
    const run = (handler: ToolDefinition['handler'], args: Record<string, unknown> = {}): Promise<Line> =>
      harness(handler).call(args);

    it('recognises the same arguments in any order, without writing them down', async () => {
      const probe = harness(() => ({ content: [] }));

      const first = await probe.call({ object: 'Incident', top: 5 });
      const reordered = await probe.call({ top: 5, object: 'Incident' });
      const different = await probe.call({ object: 'Incident', top: 6 });

      expect(first?.argsHash).toEqual(reordered?.argsHash);
      expect(first?.argsHash).not.toEqual(different?.argsHash);
      expect(JSON.stringify(first)).not.toContain('Incident');
    });

    it('says which conversation a call belongs to, and moves on when one ends', async () => {
      const probe = harness(() => ({ content: [] }));

      const before = await probe.call();
      await probe.endConversation();
      const after = await probe.call();

      expect(before?.conversation).toMatch(/^[0-9a-f]{8}\.0$/);
      expect(after?.conversation).toBe(String(before?.conversation).replace(/\.0$/, '.1'));
    });

    it('counts the rows a call read, so an empty answer is visible', async () => {
      const { readRows } = await import('./shared/read-rows.js');

      const empty = await run(() => {
        readRows(undefined, 'https://t/x');
        return { content: [] };
      });
      const two = await run(() => {
        readRows({ value: [{}, {}] }, 'https://t/x');
        return { content: [] };
      });
      const none = await run(() => ({ content: [] }));

      expect(empty).toMatchObject({ rowsRead: 0 });
      expect(two).toMatchObject({ rowsRead: 2 });
      // A call that read no collection says nothing, rather than claiming an empty answer.
      expect(none).not.toHaveProperty('rowsRead');
    });

    it('stamps the version of the instructions the call was made under', async () => {
      const line = await harness(() => ({ content: [] }), { manifest: 'a1b2c3d4e5f6', manifestChars: 73_000 }).call();

      expect(line).toMatchObject({ manifest: 'a1b2c3d4e5f6', manifestChars: 73_000 });
    });

    it('says how much a call put into the conversation, but never what', async () => {
      const line = await run(
        () => ({ content: [{ type: 'text', text: '{"Subject":"Printer on fire"}' }] }),
        { object: 'Incident' },
      );

      expect(line).toMatchObject({
        tool: 'probe',
        sessionId: 's1',
        outcome: 'ok',
        argsChars: '{"object":"Incident"}'.length,
        resultChars: '{"Subject":"Printer on fire"}'.length,
        ivantiRequests: 0,
      });
      expect(JSON.stringify(line)).not.toContain('Printer');
      expect(JSON.stringify(line)).not.toContain('Incident');
    });

    it('names the refusal a call ended in, which is what points at the description to fix', async () => {
      const line = await run(async () => {
        const { runTool } = await import('./shared/run-tool.js');
        const { UnsupportedFilterError } = await import('../ivanti/odata/filter.js');
        return runTool('probe', logger(), () => {
          throw new UnsupportedFilterError({ kind: 'function', name: 'contains' } as never);
        });
      });

      expect(line).toMatchObject({ outcome: 'UnsupportedFilterError' });
    });

    it('counts the Ivanti requests a call made', async () => {
      const { countIvantiRequest } = await import('../usage/call-usage.js');

      const line = await run(() => {
        countIvantiRequest();
        countIvantiRequest();
        return { content: [] };
      });

      expect(line).toMatchObject({ ivantiRequests: 2 });
    });

    it('is written even when the handler throws', async () => {
      const line = await run(() => {
        throw new Error('boom');
      });

      expect(line).toMatchObject({ outcome: 'fault', resultChars: 0 });
    });
  });
});

const HAROLD = {
  RecId: 'e1',
  DisplayName: 'Harold Sanders',
  FirstName: 'Harold',
  LastName: 'Sanders',
  LoginID: 'HSanders',
  PrimaryEmail: 'HSanders@example.com',
  Status: 'Active',
};

interface Result {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/** A registered server whose tools can be called by name, as the transport would call them. */
function serve(
  tools: ReturnType<typeof selectTools>,
  options: {
    idleMs?: number;
    impersonation?: ImpersonationSlot;
    identity?: CallerIdentity;
    logger?: Logger;
    licence?: LicenceCheck;
  } = {},
) {
  const registerTool = vi.fn();
  const handle = registerTools(
    { registerTool } as unknown as McpServer,
    tools,
    {
      identity: options.identity ?? ANONYMOUS,
      ...(options.impersonation === undefined ? {} : { impersonation: options.impersonation }),
    },
    options.logger ?? logger(),
    options.idleMs,
    undefined,
    undefined,
    options.licence,
  );

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const entry = registerTool.mock.calls.find((made) => made[0] === name);
    const callback = entry?.[2] as (a: Record<string, unknown>) => Promise<Result>;
    return callback(args);
  };

  return { call, handle, names: handle.names };
}

/** A configured tenant, so `act_as` exists and the gate is live. */
function tenant(
  options: {
    idleMs?: number;
    impersonation?: ImpersonationSlot;
    identity?: CallerIdentity;
    logger?: Logger;
    responses?: Record<string, unknown>;
    licence?: LicenceCheck;
  } = {},
) {
  const { connection } = connectionFixture({
    entities: { employee: {} },
    responses: options.responses ?? { $filter: { value: [HAROLD] } },
  });
  return serve(selectTools(config(), { ...context, ivanti: connection }), options);
}

/** A token that names Harold by the claim `act_as` looks a person up with. */
const SIGNED_IN = verifiedIdentity({
  subject: 'opaque-pairwise-id',
  issuer: 'https://idp',
  scopes: [],
  claims: { email: 'HSanders@example.com', email_verified: true },
});

/** A licence check stuck in one state. */
const licenceIn = (status: 'open' | 'grace' | 'closed', reason = 'the licence key has been revoked in the Synergy Hub'): LicenceCheck => ({
  view: () => (status === 'open' ? { status } : { status, reason }),
});

describe('the licence gate', () => {
  it('refuses every tool, act_as included, while the licence is closed, and says why', async () => {
    const { call, names } = tenant({ licence: licenceIn('closed') });

    for (const name of names.filter((tool) => tool !== 'get_version')) {
      const result = await call(name, name === 'act_as' ? { person: 'HSanders' } : {});
      // Refused before the identity gate and before the handler: nothing reached Ivanti.
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain('not licensed');
      expect(result.content[0]?.text, name).toContain('revoked in the Synergy Hub');
    }
  });

  it('lets get_version through, so a server with no tenant can still say why', async () => {
    const { call } = serve(selectTools(config(), context), { licence: licenceIn('closed') });

    expect((await call('get_version')).isError).toBeUndefined();
  });

  it('admits calls while the Hub is merely unreachable', async () => {
    const { call } = tenant({ licence: licenceIn('grace', 'Could not reach the Synergy Hub') });

    expect((await call('act_as', { person: 'HSanders' })).isError).toBeUndefined();
  });

  it('reads the licence on every call, so a renewal reopens it without a restart', async () => {
    let status: 'open' | 'closed' = 'closed';
    const { call } = tenant({ licence: { view: () => (status === 'open' ? { status } : { status, reason: 'suspended' }) } });

    expect((await call('act_as', { person: 'HSanders' })).isError).toBe(true);
    status = 'open';
    expect((await call('act_as', { person: 'HSanders' })).isError).toBeUndefined();
  });
});

/**
 * The gate every call passes through, tested at the level the transport calls: a handler invoked
 * directly in a unit test never meets it, which is exactly why it lives here and not in a tool.
 */
describe('the identity gate', () => {
  it('refuses every tool but act_as until somebody is pinned', async () => {
    const { call, names } = tenant();
    expect(names).toContain('act_as');
    expect(names.length).toBeGreaterThan(20);

    for (const name of names.filter((tool) => tool !== 'act_as')) {
      const result = await call(name);
      // Refused before the handler ran, so nothing was asked of Ivanti on nobody's behalf.
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain('act_as');
    }
  });

  it('gates get_version too: a version is an answer, and answers wait for a person', async () => {
    const { call } = tenant();
    expect((await call('get_version')).isError).toBe(true);
  });

  it('answers once act_as has pinned somebody', async () => {
    const { call } = tenant();

    expect((await call('act_as', { person: 'HSanders' })).isError).toBeUndefined();
    expect((await call('get_version')).isError).toBeUndefined();
  });

  it('cannot require an identity where nothing can pin one', async () => {
    // No tenant, so `act_as` is not registered. Gating the one remaining tool would leave a
    // server that answers nothing at all and offers no way to fix that.
    const { call, names } = serve(selectTools(config(), context));

    expect(names).toEqual(['get_version']);
    expect((await call('get_version')).isError).toBeUndefined();
  });
});

describe('the conversation', () => {
  const opener = (): ImpersonationSlot =>
    createImpersonationSlot(() =>
      Promise.resolve(impersonatedSessionFixture({ loginId: 'HSanders' })),
    );

  it('forgets the person once it has gone quiet, and hands the Ivanti session back', async () => {
    vi.useFakeTimers();
    try {
      const impersonation = opener();
      const { call } = tenant({ idleMs: 1_000, impersonation });

      await call('act_as', { person: 'HSanders' });
      expect(impersonation.session()).toBeDefined();
      expect((await call('get_version')).isError).toBeUndefined();

      vi.advanceTimersByTime(1_001);

      // This is the stdio fix: one process is one connection for its whole life, so without
      // this the first person stayed pinned through every conversation that followed.
      expect((await call('get_version')).isError).toBe(true);
      // Given back rather than left to expire — the slot refuses a second login while it holds
      // one, so a conversation that kept it would refuse the next person by name.
      expect(impersonation.session()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the person while the conversation is still being had', async () => {
    vi.useFakeTimers();
    try {
      const { call } = tenant({ idleMs: 1_000 });
      await call('act_as', { person: 'HSanders' });

      for (let turn = 0; turn < 5; turn += 1) {
        vi.advanceTimersByTime(900);
        expect((await call('get_version')).isError).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends when the client initializes again on the same connection', async () => {
    const impersonation = opener();
    const { call, handle } = tenant({ impersonation });

    await call('act_as', { person: 'HSanders' });
    expect((await call('get_version')).isError).toBeUndefined();

    await handle.endConversation();

    expect((await call('get_version')).isError).toBe(true);
    expect(impersonation.session()).toBeUndefined();
  });

  it('refuses a call that outlived the conversation it was made in', async () => {
    vi.useFakeTimers();
    try {
      const { connection } = connectionFixture({ entities: { employee: {} } });
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A directory lookup still in flight when the conversation ends. `act_as` used to pin the
      // discarded pin and answer `pinned: true`, after which every other tool refused — the model
      // was told it had an identity and then contradicted on the next call.
      (connection.people as unknown as { directory: unknown }).directory = {
        find: async () => {
          await slow;
          return [
            {
              recId: 'e1',
              category: 'employee',
              displayName: 'Harold Sanders',
              loginId: 'HSanders',
              primaryEmail: 'HSanders@example.com',
              matchedOn: 'login',
              status: 'Active',
            },
          ];
        },
      };

      const { call } = serve(
        selectTools(config(), { ...context, ivanti: connection }),
        { idleMs: 1_000 },
      );

      const pending = call('act_as', { person: 'HSanders' });
      vi.advanceTimersByTime(1_001);
      await call('get_version');
      release();

      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('conversation ended while that call was running');
      // And the conversation really is empty, rather than holding somebody it never reported.
      expect((await call('get_version')).isError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts over, rather than remembering the last person it was told about', async () => {
    const { call, handle } = tenant();
    const pinnedIn = async (): Promise<Record<string, unknown>> =>
      JSON.parse((await call('act_as', { person: 'HSanders' })).content[0]?.text ?? '{}') as Record<
        string,
        unknown
      >;

    await pinnedIn();
    // Within one conversation the same person again is recognised as the same person.
    expect(await pinnedIn()).toMatchObject({ pinned: true, repeated: true });

    await handle.endConversation();

    // Across conversations they are somebody this one has not met — which is what makes room
    // for a different person, the case stdio could never reach before.
    expect(await pinnedIn()).toMatchObject({ pinned: true, repeated: false });
  });
});

describe('a signed-in conversation', () => {
  it('pins itself on the first call that needs it', async () => {
    const { call } = tenant({ identity: SIGNED_IN });

    // No `act_as` in sight: the token already named the person, and making the model repeat what
    // the issuer said is a round trip that can only go wrong.
    const result = await call('get_version');

    expect(result.isError).toBeUndefined();
  });

  it('resolves the person once, however many calls arrive together', async () => {
    const { connection } = connectionFixture({
      entities: { employee: {} },
      responses: { $filter: { value: [HAROLD] } },
    });
    const find = vi.fn(() =>
      Promise.resolve([
        {
          recId: 'e1',
          category: 'employee',
          displayName: 'Harold Sanders',
          loginId: 'HSanders',
          primaryEmail: 'HSanders@example.com',
          matchedOn: 'email',
          status: 'Active',
        },
      ]),
    );
    (connection.people as unknown as { directory: unknown }).directory = { find };

    const { call } = serve(selectTools(config(), { ...context, ivanti: connection }), {
      identity: SIGNED_IN,
    });

    const answers = await Promise.all([call('get_version'), call('get_version'), call('get_version')]);

    expect(answers.every((answer) => answer.isError === undefined)).toBe(true);
    // One lookup shared, not one per caller — and no caller refused for losing the race.
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('reports what act_as said when the token names nobody, as the failure it is', async () => {
    const { call } = tenant({
      identity: SIGNED_IN,
      // Nobody matches the claim.
      responses: { $filter: { value: [] }, $search: { value: [] } },
    });

    const result = await call('get_version');

    expect(result.isError).toBe(true);
    // The useful explanation is act_as's own, under a line saying which question failed.
    expect(result.content[0]?.text).toContain('who you are from the signed-in token');
    expect(JSON.stringify(result.content)).toContain('administrator');
  });

  it('does not sign in a conversation that only claims to be someone', async () => {
    // An asserted identity is a claim, and a claim has to be made deliberately through act_as.
    const { call } = tenant({ identity: assertedIdentity('HSanders') });

    const result = await call('get_version');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('act_as');
  });

  it('signs in again after the conversation ends', async () => {
    const { call, handle } = tenant({ identity: SIGNED_IN });
    expect((await call('get_version')).isError).toBeUndefined();

    await handle.endConversation();

    expect((await call('get_version')).isError).toBeUndefined();
  });

  // A directory 5xx or a timeout was cached with the attempt and replayed on every call for the
  // rest of the conversation — one bad second, and the signed-in person could do nothing.
  it('tries again after a failed attempt rather than replaying it', async () => {
    const { connection } = connectionFixture({ entities: { employee: {} } });
    const find = vi
      .fn()
      .mockRejectedValueOnce(new IvantiApiError({ status: 503, method: 'GET', url: 'https://t/x' }))
      .mockResolvedValue([HAROLD_CANDIDATE]);
    (connection.people as unknown as { directory: unknown }).directory = { find };
    const { call } = serve(selectTools(config(), { ...context, ivanti: connection }), {
      identity: SIGNED_IN,
    });

    const failed = await call('get_version');
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('calling `act_as` tries again');

    expect((await call('get_version')).isError).toBeUndefined();
    expect(find).toHaveBeenCalledTimes(2);
  });

  // A question is not a failure: it stands until the person answers it.
  it('keeps asking the same question rather than looking the person up again', async () => {
    const { connection } = connectionFixture({ entities: { employee: {} } });
    const find = vi.fn(() => Promise.resolve([{ ...HAROLD_CANDIDATE, matchedOn: 'name' }]));
    (connection.people as unknown as { directory: unknown }).directory = { find };
    const { call } = serve(selectTools(config(), { ...context, ivanti: connection }), {
      identity: verifiedIdentity({
        subject: 's',
        issuer: 'https://idp',
        scopes: [],
        claims: { preferred_username: 'Harold Sanders' },
      }),
    });

    expect(JSON.stringify((await call('get_version')).content)).toContain('confirm');
    expect(JSON.stringify((await call('get_version')).content)).toContain('confirm');
    expect(find).toHaveBeenCalledTimes(1);
  });
});

/** What the directory answers for Harold, as `act_as` receives it. */
const HAROLD_CANDIDATE = {
  recId: 'e1',
  category: 'employee',
  displayName: 'Harold Sanders',
  loginId: 'HSanders',
  primaryEmail: 'HSanders@example.com',
  matchedOn: 'LoginID',
  status: 'Active',
};

/** A tenant whose directory knows exactly the people named, by login. */
function directoryOf(
  people: Record<string, typeof HAROLD_CANDIDATE>,
  options: { impersonation?: ImpersonationSlot; logger?: Logger; extra?: ToolDefinition[] } = {},
) {
  const { connection } = connectionFixture({ entities: { employee: {}, incident: {} } });
  (connection.people as unknown as { directory: unknown }).directory = {
    find: (claim: string) => Promise.resolve(people[claim] === undefined ? [] : [people[claim]]),
  };
  return serve([...selectTools(config(), { ...context, ivanti: connection }), ...(options.extra ?? [])], {
    ...(options.impersonation === undefined ? {} : { impersonation: options.impersonation }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

/**
 * A tool that answers with the login of the session it ran on — or, on the sessions named, is
 * refused by Ivanti as unauthenticated, the way a request on a dead session is.
 */
function probeTool(options: {
  readOnly: boolean;
  refusedOn?: ImpersonatedSession[];
  /** Whose credential the refusal came back on; a dead session is the person's. */
  refusedAs?: 'person' | 'service';
}) {
  const runs: (string | undefined)[] = [];
  const tool: ToolDefinition = {
    name: 'probe',
    config: {
      title: 'Probe',
      description: 'Reports its session.',
      inputSchema: {},
      annotations: { readOnlyHint: options.readOnly },
    },
    handler: async (_args, call) => {
      const { runTool } = await import('./shared/run-tool.js');
      return runTool('probe', logger(), () => {
        const held = call?.impersonation?.session();
        runs.push(held?.sid);
        if (held !== undefined && options.refusedOn?.includes(held) === true) {
          throw new IvantiApiError({
            status: 401,
            method: 'GET',
            url: 'https://t/HEAT/api/odata/x',
            credential: options.refusedAs ?? 'person',
          });
        }
        return Promise.resolve({ content: [{ type: 'text' as const, text: held?.sid ?? 'service account' }] });
      });
    },
  };
  return { tool, runs };
}

const sessionAs = (sid: string, overrides: Partial<ImpersonatedSession> = {}): ImpersonatedSession =>
  impersonatedSessionFixture({ sid, loginId: 'HSanders', ...overrides });

/**
 * The Ivanti session a conversation holds as its person, across the life of the conversation.
 */
describe('the person\'s Ivanti session', () => {
  /**
   * A conversation that ends while `act_as` is still opening a session. With nobody pinned yet,
   * ending it released nothing; the handshake then landed in the next conversation's slot, and
   * every `act_as` there for anyone else was refused — naming the first person — until a restart.
   */
  it('is given back when the conversation ends mid-handshake, and the next person gets in', async () => {
    const landings: ((session: ImpersonatedSession) => void)[] = [];
    const impersonation = createImpersonationSlot(
      () => new Promise<ImpersonatedSession>((resolve) => landings.push(resolve)),
    );
    const { call, handle } = directoryOf(
      { HSanders: HAROLD_CANDIDATE, ACope: { ...HAROLD_CANDIDATE, recId: 'e2', displayName: 'Anna Cope', loginId: 'ACope' } },
      { impersonation },
    );

    const first = call('act_as', { person: 'HSanders' });
    await vi.waitFor(() => {
      expect(landings).toHaveLength(1);
    });
    // Not awaited first: giving back an in-flight handshake waits for it to land.
    const ended = handle.endConversation();
    landings[0]?.(sessionAs('tenant#HAROLD#1'));
    await ended;
    expect((await first).isError).toBe(true);

    const next = call('act_as', { person: 'ACope' });
    await vi.waitFor(() => {
      expect(landings).toHaveLength(2);
    });
    landings[1]?.(impersonatedSessionFixture({ sid: 'tenant#ANNA#1', loginId: 'ACope' }));

    expect((await next).isError).toBeUndefined();
    expect(impersonation.session()?.loginId).toBe('ACope');
  });

  it('is re-opened when Ivanti refuses it, and a read is retried on the new one', async () => {
    const dead = sessionAs('tenant#DEAD#1');
    const fresh = sessionAs('tenant#FRESH#1');
    const opened = [dead, fresh];
    const open = vi.fn(() => Promise.resolve(opened.shift() ?? fresh));
    const probe = probeTool({ readOnly: true, refusedOn: [dead] });
    const { call } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { impersonation: createImpersonationSlot(open), extra: [probe.tool] });

    await call('act_as', { person: 'HSanders' });
    const result = await call('probe');

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('tenant#FRESH#1');
    expect(probe.runs).toEqual(['tenant#DEAD#1', 'tenant#FRESH#1']);
    expect(open).toHaveBeenCalledTimes(2);
  });

  // The service account's own calls — schema, directory, the tenant's offset — say nothing about
  // the person's session. Re-opening it over their 401 threw away a session that was fine.
  it('is kept when the 401 came from the service account, not the person\'s session', async () => {
    const held = sessionAs('tenant#HELD#1');
    const open = vi.fn(() => Promise.resolve(held));
    const impersonation = createImpersonationSlot(open);
    const probe = probeTool({ readOnly: true, refusedOn: [held], refusedAs: 'service' });
    const { call } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { impersonation, extra: [probe.tool] });

    await call('act_as', { person: 'HSanders' });
    const result = await call('probe');

    expect(result.isError).toBe(true);
    expect(probe.runs).toEqual(['tenant#HELD#1']);
    expect(open).toHaveBeenCalledTimes(1);
    expect(impersonation.session()).toBe(held);
  });

  // A write refused partway may already have done part of its work; repeating it would do it twice.
  it('is re-opened for a write too, but the write is not repeated', async () => {
    const dead = sessionAs('tenant#DEAD#1');
    const fresh = sessionAs('tenant#FRESH#1');
    const opened = [dead, fresh];
    const impersonation = createImpersonationSlot(() => Promise.resolve(opened.shift() ?? fresh));
    const probe = probeTool({ readOnly: false, refusedOn: [dead] });
    const { call } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { impersonation, extra: [probe.tool] });

    await call('act_as', { person: 'HSanders' });
    const result = await call('probe');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('was not repeated');
    expect(probe.runs).toEqual(['tenant#DEAD#1']);
    expect(impersonation.session()).toBe(fresh);
  });

  it('refuses rather than answering as the service account when it cannot be re-opened', async () => {
    const dead = sessionAs('tenant#DEAD#1');
    const open = vi
      .fn()
      .mockResolvedValueOnce(dead)
      .mockRejectedValue(new Error('Ivanti has no enabled user named HSanders.'));
    const probe = probeTool({ readOnly: true, refusedOn: [dead] });
    const { call } = directoryOf(
      { HSanders: HAROLD_CANDIDATE },
      { impersonation: createImpersonationSlot(open as SessionOpener), extra: [probe.tool] },
    );

    await call('act_as', { person: 'HSanders' });
    const refused = await call('probe');
    const again = await call('probe');

    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('does not answer as its own account');
    expect(refused.content[0]?.text).toContain('no enabled user');
    // The next call tried again, and still never ran on the service account.
    expect(again.isError).toBe(true);
    expect(probe.runs).toEqual(['tenant#DEAD#1']);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('is re-opened before the call once it is past the expiry CentralConfig gave it', async () => {
    vi.useFakeTimers();
    try {
      const expiring = sessionAs('tenant#OLD#1', {
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      const fresh = sessionAs('tenant#NEW#1');
      const opened = [expiring, fresh];
      const probe = probeTool({ readOnly: true });
      const { call } = directoryOf(
        { HSanders: HAROLD_CANDIDATE },
        { impersonation: createImpersonationSlot(() => Promise.resolve(opened.shift() ?? fresh)), extra: [probe.tool] },
      );

      await call('act_as', { person: 'HSanders' });
      vi.advanceTimersByTime(10 * 60_000);
      await call('probe');

      expect(probe.runs).toEqual(['tenant#NEW#1']);
    } finally {
      vi.useRealTimers();
    }
  });

  // RemoveSession ends nothing on Ivanti's side and can take its whole timeout to say so.
  it('is given back after a quiet spell without holding up the call that noticed', async () => {
    const impersonation = createImpersonationSlot(() =>
      Promise.resolve(sessionAs('tenant#A#1', { release: () => new Promise<void>(() => undefined) })),
    );
    const { call } = serve(
      selectTools(config(), {
        ...context,
        ivanti: connectionFixture({ entities: { employee: {} }, responses: { $filter: { value: [HAROLD] } } })
          .connection,
      }),
      { idleMs: 1, impersonation },
    );
    await call('act_as', { person: 'HSanders' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const answered = await Promise.race([
      call('get_version').then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => { resolve('still waiting'); }, 200)),
    ]);

    expect(answered).toBe('answered');
    expect(impersonation.session()).toBeUndefined();
  });
});

describe('a call the conversation outlived', () => {
  const slowTool = (readOnly: boolean) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tool: ToolDefinition = {
      name: 'probe',
      config: { title: 'Probe', description: 'Slow.', inputSchema: {}, annotations: { readOnlyHint: readOnly } },
      handler: async () => {
        await done;
        return { content: [{ type: 'text', text: 'done' }] };
      },
    };
    return { tool, finish };
  };

  const outlive = async (readOnly: boolean): Promise<string> => {
    const slow = slowTool(readOnly);
    const { call, handle } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { extra: [slow.tool] });
    await call('act_as', { person: 'HSanders' });

    const pending = call('probe');
    await handle.endConversation();
    slow.finish();
    return (await pending).content[0]?.text ?? '';
  };

  it('tells the model to retry a read', async () => {
    expect(await outlive(true)).toContain('then retry');
  });

  // The write reached Ivanti whatever became of its result; "retry" would do it twice.
  it('tells the model to check before repeating a write', async () => {
    const text = await outlive(false);

    expect(text).toContain('may already have been made');
    expect(text).not.toContain('then retry');
  });

  // Ending the conversation empties its slot, and an empty slot means "the service account" to
  // everything that routes a request — so the rest of a running write went out as this server.
  it('keeps running on the person\'s session, never the service account', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen: (string | undefined)[] = [];
    const tool: ToolDefinition = {
      name: 'probe',
      config: { title: 'Probe', description: 'Slow.', inputSchema: {}, annotations: { readOnlyHint: false } },
      handler: async (_args, call) => {
        await done;
        seen.push(call?.impersonation?.session()?.sid);
        return { content: [] };
      },
    };
    const impersonation = createImpersonationSlot(() => Promise.resolve(sessionAs('tenant#HAROLD#1')));
    const { call, handle } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { impersonation, extra: [tool] });
    await call('act_as', { person: 'HSanders' });

    const pending = call('probe');
    await handle.endConversation();
    finish();
    await pending;

    expect(impersonation.session()).toBeUndefined();
    expect(seen).toEqual(['tenant#HAROLD#1']);
  });
});

/**
 * The audit line for a write says which record it was aimed at — by id, never by value. Without
 * it a `delete_record` line said who deleted something and never what.
 */
describe('the audit line for a write', () => {
  const audited = async (tool: string, args: Record<string, unknown>) => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const log: Logger = {
      ...logger(),
      info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, fields }),
    };
    const { call } = directoryOf({ HSanders: HAROLD_CANDIDATE }, { logger: log });
    await call('act_as', { person: 'HSanders' });
    await call(tool, args);
    return lines.filter((line) => line.message === 'tool called' && line.fields?.['tool'] === tool);
  };

  it('names the record delete_record was aimed at', async () => {
    const [line] = await audited('delete_record', { object: 'Incidents', recordId: 'A1B2C3' });

    expect(line?.fields?.['targets']).toEqual({ object: 'Incidents', recordId: 'A1B2C3' });
  });

  it('names the record update_record changed, and none of the values it wrote', async () => {
    const lines = await audited('update_record', {
      object: 'Incidents',
      recordId: 'A1B2C3',
      fields: { Subject: 'Printer on fire', Symptom: 'smoke from tray 2' },
    });

    expect(lines[0]?.fields?.['targets']).toEqual({ object: 'Incidents', recordId: 'A1B2C3' });
    expect(JSON.stringify(lines)).not.toContain('Printer on fire');
    expect(JSON.stringify(lines)).not.toContain('Subject');
  });

  it('names nothing for a read', async () => {
    const [line] = await audited('get_record', { object: 'Incidents', recordId: 'A1B2C3' });

    expect(line?.fields).not.toHaveProperty('targets');
  });
});
