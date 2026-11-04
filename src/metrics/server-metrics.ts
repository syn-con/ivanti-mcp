// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createRegistry, type Registry } from './registry.js';

/**
 * What this server counts, process-wide.
 *
 * Recorded whether or not `METRICS_ON` is set — a counter is an addition, and recording only when
 * someone listens would put a branch at every site for nothing. `METRICS_ON` decides whether
 * anything can READ them: the listener in `start-metrics.ts` is the only way out.
 *
 * Every label is the server's own vocabulary. A tool's name and outcome, an HTTP method and
 * status — never a person, a filter, a record or a session id.
 */
export const registry: Registry = createRegistry();

/** Seconds. A tool call spans several Ivanti requests and, for a write, a read-back. */
const TOOL_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
/** Seconds. The default read timeout is 10 s and the write timeout 30 s. */
const IVANTI_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const toolCalls = registry.counter(
  'ivanti_mcp_tool_calls_total',
  'Tool calls, by tool and outcome: ok, error, or the refusal that ended the call.',
  ['tool', 'outcome'],
);
const toolDuration = registry.histogram(
  'ivanti_mcp_tool_call_duration_seconds',
  'How long a tool call took, start to answer, by tool.',
  TOOL_BUCKETS,
  ['tool'],
);
const ivantiRequests = registry.counter(
  'ivanti_mcp_ivanti_requests_total',
  'Requests sent to Ivanti, by method and HTTP status; status 0 is a request that got no answer.',
  ['method', 'status'],
);
const ivantiDuration = registry.histogram(
  'ivanti_mcp_ivanti_request_duration_seconds',
  'How long Ivanti took to answer, by method.',
  IVANTI_BUCKETS,
  ['method'],
);
const ivantiNotSent = registry.counter(
  'ivanti_mcp_ivanti_requests_not_sent_total',
  'Requests never sent: every slot under IVANTI_MAX_CONCURRENT_REQUESTS stayed busy for as long as they could wait.',
);
const sessionsEvicted = registry.counter(
  'ivanti_mcp_sessions_evicted_total',
  'HTTP sessions closed to make room for a new one, at MCP_MAX_SESSIONS or MCP_MAX_SESSIONS_PER_SUBJECT.',
);
const sessionsRefused = registry.counter(
  'ivanti_mcp_sessions_refused_total',
  'New HTTP sessions refused with 503, because every session was busy at MCP_MAX_SESSIONS.',
);
const httpRejected = registry.counter(
  'ivanti_mcp_http_requests_rejected_total',
  'HTTP requests refused before reaching MCP, by reason: origin or unauthorized.',
  ['reason'],
);

export function recordToolCall(tool: string, outcome: string, ms: number): void {
  toolCalls.inc({ tool, outcome });
  toolDuration.observe(ms / 1000, { tool });
}

export function recordIvantiRequest(method: string, status: number, ms: number): void {
  const upper = method.toUpperCase();
  ivantiRequests.inc({ method: upper, status: String(status) });
  ivantiDuration.observe(ms / 1000, { method: upper });
}

export function recordIvantiRequestNotSent(): void {
  ivantiNotSent.inc();
}

export function recordSessionEvicted(): void {
  sessionsEvicted.inc();
}

export function recordSessionRefused(): void {
  sessionsRefused.inc();
}

export function recordHttpRejected(reason: 'origin' | 'unauthorized'): void {
  httpRejected.inc({ reason });
}

/** What the running server is, and what it holds — each read when scraped, never cached. */
export interface ServerState {
  version: string;
  mcpMode: string;
  /** Absent when Ivanti is not configured, or under stdio alone, where nothing checks it. */
  ready?: () => boolean;
  /** Absent when nothing caps requests to the tenant. */
  limiter?: { readonly inFlight: number; readonly waiting: number };
  /** Absent without the HTTP transport. */
  sessions?: () => number;
  /** The licence check: open, grace or closed (design §9f). */
  licence?: () => { status: string; confirmedAt?: number };
}

/** Wires the gauges. Called once at startup, and only when `METRICS_ON` is set. */
export function watchServer(state: ServerState, target: Registry = registry): void {
  const startedAt = Date.now() / 1000;

  target.gauge('ivanti_mcp_build_info', 'Always 1; the labels say which build and mode is running.', () => [
    [{ version: state.version, mcp_mode: state.mcpMode }, 1],
  ]);
  target.gauge(
    'ivanti_mcp_ivanti_ready',
    '1 while Ivanti answers the readiness check, 0 after two failures in a row (what /ready reports).',
    () => (state.ready === undefined ? undefined : state.ready() ? 1 : 0),
  );
  const limiter = state.limiter;
  target.gauge('ivanti_mcp_ivanti_requests_in_flight', 'Requests to Ivanti in flight now.', () => limiter?.inFlight);
  target.gauge(
    'ivanti_mcp_ivanti_requests_waiting',
    'Requests waiting for a slot under IVANTI_MAX_CONCURRENT_REQUESTS.',
    () => limiter?.waiting,
  );
  target.gauge('ivanti_mcp_sessions', 'HTTP sessions held now.', () => state.sessions?.());
  target.gauge(
    'ivanti_mcp_licence_state',
    '1 for the current state of the licence check: open, grace (the Hub unreachable, under 30 days) or closed (tools refused).',
    () => {
      const status = state.licence?.().status;
      return status === undefined ? undefined : ['open', 'grace', 'closed'].map((s) => [{ state: s }, s === status ? 1 : 0] as const);
    },
  );
  target.gauge(
    'ivanti_mcp_licence_confirmed_timestamp_seconds',
    'When the Synergy Hub last confirmed the licence, in seconds since the Unix epoch.',
    () => {
      const at = state.licence?.().confirmedAt;
      return at === undefined ? undefined : at / 1000;
    },
  );
  target.gauge('process_resident_memory_bytes', 'Resident memory size in bytes.', () => process.memoryUsage.rss());
  target.gauge('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.', () => process.memoryUsage().heapUsed);
  target.gauge(
    'process_start_time_seconds',
    'When the process started, in seconds since the Unix epoch.',
    () => startedAt - process.uptime(),
  );
}
