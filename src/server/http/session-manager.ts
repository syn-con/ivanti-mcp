// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { SessionStore, type StoredSession } from './session-store.js';
import { recordSessionEvicted, recordSessionRefused } from '../../metrics/server-metrics.js';

export interface ClosableSession {
  close: () => void | Promise<void>;
}

/**
 * How long a session must have been quiet before a full server may close it for a newcomer.
 *
 * Short, because clients abandon sessions without a DELETE as a matter of course (notes.md) and
 * the TTL that would otherwise free them is thirty minutes. Not zero, because a session between
 * two tool calls of a live conversation is quiet too, and closing it costs that person their
 * pinned identity.
 */
export const EVICTION_FLOOR_MS = 60_000;

export interface SessionManagerOptions {
  maxSessions: number;
  idleTtlMs: number;
  logger: Logger;
  /** Sessions one verified subject may hold; absent is no limit of its own. */
  maxPerSubject?: number;
  /** Injectable for tests. */
  now?: () => number;
}

/** Who is knocking, for the line that records a session opening. Never used to decide anything. */
export interface ClientDetails {
  remoteAddress?: string;
  userAgent?: string;
}

export interface AdmissionRequest {
  /** The verified subject, when there is one. Under `none` and `bearer` there never is. */
  subject?: string;
  client?: ClientDetails;
}

/** A slot held for one `initialize` until it either registers a session or fails. */
export interface SessionSlot<T> {
  /** Registers the session into the slot reserved for it. */
  commit: (id: string, session: T) => void;
  /** Gives the slot back when it was never committed; true when it did. */
  cancel: () => boolean;
}

export type Admission<T> =
  | { admitted: true; slot: SessionSlot<T> }
  | { admitted: false; retryAfterSeconds: number };

/**
 * Session lifecycle policy: admission, expiry and shutdown.
 *
 * `SessionStore` is the data structure — a bounded map with an idle timeout. This is the
 * policy around it: when a new session is admitted, what is closed to make room, when expiry
 * runs, and what gets logged. The split keeps the store generic while this layer knows about MCP
 * sessions.
 */
export class SessionManager<T extends ClosableSession> {
  private readonly store: SessionStore<T>;
  /** Closes started by eviction or expiry, which shutdown must wait for as well as its own. */
  private readonly closing = new Set<Promise<void>>();
  private readonly evictionFloorMs: number;

  constructor(private readonly options: SessionManagerOptions) {
    this.store = new SessionStore<T>({
      maxSessions: options.maxSessions,
      idleTtlMs: options.idleTtlMs,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    // A TTL shorter than the floor sweeps first anyway; the floor must not promise longer.
    this.evictionFloorMs = Math.min(EVICTION_FLOOR_MS, options.idleTtlMs);
  }

  get size(): number {
    return this.store.size;
  }

  get(id: string): T | undefined {
    return this.store.get(id);
  }

  /**
   * Marks a request in flight on this session until the returned function is called.
   *
   * A session answering something — a long write — is in use however long ago it was last
   * addressed: neither the cap nor the idle sweep closes it, and the subject limit takes it last.
   */
  busy(id: string): () => void {
    this.store.begin(id);
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.store.end(id);
    };
  }

  /**
   * Marks a client attached to this session's dedicated SSE stream until the returned function is
   * called. Held for the client's life, so it says the client is present, not that anything is
   * running: eviction still prefers a session with no request in flight, and the cap and the
   * sweep leave an attached one alone.
   */
  attach(id: string): () => void {
    this.store.attach(id);
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.store.detach(id);
    };
  }

  register(id: string, session: T, request: AdmissionRequest = {}): boolean {
    if (!this.store.set(id, session, request.subject)) {
      this.options.logger.warn('session cap reached, dropping new session', { sessionId: id });
      void this.closeTracked(session);
      return false;
    }
    this.options.logger.info('session opened', {
      sessionId: id,
      sessions: this.store.size,
      ...request.client,
    });
    return true;
  }

  /**
   * The session ended from its own side — a client's DELETE, a transport that closed.
   *
   * Its close is tracked like any other, because closing is what hands the person's Ivanti session
   * back: a DELETE a moment before a SIGTERM started a release that shutdown never waited for. The
   * transport is already closed, so the connection's `close()` only awaits that release. A session
   * evicted earlier is gone from the store by now, and is not closed twice.
   */
  unregister(id: string): void {
    const value = this.store.delete(id);
    if (value !== undefined) void this.closeTracked(value);
    this.options.logger.info('session closed', { sessionId: id, sessions: this.store.size });
  }

  /**
   * Makes room for a new session and reserves it, or says when to come back.
   *
   * In order: a subject over its own limit loses its least recently used session; a full server
   * sweeps what has expired, then closes the least recently used session that has been quiet past
   * the floor. Refusing is the last resort, and only when every session is in use — the cap used
   * to refuse outright, and since abandoned sessions are the ordinary case, it turned newcomers
   * away for up to the whole idle TTL while the slots were held by nobody.
   *
   * The slot is held from here, not from registration, so concurrent initializes cannot all be
   * admitted against the same free slot.
   */
  admit(request: AdmissionRequest = {}): Admission<T> {
    const { subject } = request;
    const perSubject = this.options.maxPerSubject;

    if (subject !== undefined && perSubject !== undefined) {
      while (this.store.countFor(subject) >= perSubject) {
        // Their own session, and preferably one doing nothing — but theirs either way: a person
        // opening another has usually abandoned the last, and the limit is theirs to live within.
        const own = (session: StoredSession<T>): boolean => session.subject === subject;
        const victim =
          this.store.leastRecentlySeen((session) => own(session) && session.inFlight === 0) ??
          this.store.leastRecentlySeen(own);
        if (victim === undefined) break; // only their own initializes in flight hold the slots
        this.evict(victim, 'subject limit');
      }
    }

    if (this.store.occupied >= this.options.maxSessions) {
      this.expire('idle');
    }

    if (this.store.occupied >= this.options.maxSessions) {
      const victim = this.store.leastRecentlySeen(
        (session) =>
          session.inFlight === 0 && session.attached === 0 && session.idleMs >= this.evictionFloorMs,
      );
      if (victim !== undefined) this.evict(victim, 'cap');
    }

    if (!this.store.reserve(subject)) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(this.store.msUntilIdleFor(this.evictionFloorMs) / 1000),
      );
      recordSessionRefused();
      this.options.logger.warn('refusing new session, cap reached', {
        cap: this.options.maxSessions,
        retryAfterSeconds,
      });
      return { admitted: false, retryAfterSeconds };
    }

    let settled = false;
    return {
      admitted: true,
      slot: {
        commit: (id, session): void => {
          if (settled) return;
          settled = true;
          this.store.unreserve(subject);
          if (this.register(id, session, request)) this.holdToSubjectLimit(subject, id);
        },
        cancel: (): boolean => {
          if (settled) return false;
          settled = true;
          this.store.unreserve(subject);
          return true;
        },
      },
    };
  }

  /**
   * The subject's limit, enforced again once a session is registered.
   *
   * Admission counts slots reserved for initializes still in flight, but cannot close one — so two
   * initializes from one subject at the same instant were both admitted, and the subject sat above
   * its limit for as long as the sessions lived. Here the newcomer is registered, and the subject's
   * least recently used OTHER session closes until the count is back at the limit.
   */
  private holdToSubjectLimit(subject: string | undefined, kept: string): void {
    const perSubject = this.options.maxPerSubject;
    if (subject === undefined || perSubject === undefined) return;
    const other = (session: StoredSession<T>): boolean => session.subject === subject && session.id !== kept;
    while (this.store.countFor(subject) > perSubject) {
      const victim =
        this.store.leastRecentlySeen((session) => other(session) && session.inFlight === 0) ??
        this.store.leastRecentlySeen(other);
      if (victim === undefined) return; // the rest are still initializing; each enforces on commit
      this.evict(victim, 'subject limit');
    }
  }

  private evict(victim: StoredSession<T>, reason: string): void {
    this.store.delete(victim.id);
    recordSessionEvicted();
    this.options.logger.info('session evicted', {
      sessionId: victim.id,
      reason,
      idleMs: victim.idleMs,
      sessions: this.store.size,
    });
    void this.closeTracked(victim.value);
  }

  private expire(reason: string): void {
    for (const { id, value } of this.store.sweep()) {
      this.options.logger.debug('closing session', { sessionId: id, reason });
      void this.closeTracked(value);
    }
  }

  /**
   * Closes a session and remembers the close until it settles.
   *
   * Closing is what hands the person's Ivanti session back, so it is asynchronous, and a close
   * started by eviction a moment before a SIGTERM is one shutdown must still wait for.
   */
  private closeTracked(value: T): Promise<void> {
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(value.close()).catch(() => undefined);
    } catch {
      closing = Promise.resolve();
    }
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing));
    return closing;
  }

  /** Starts periodic expiry; returns the function that stops it. */
  startSweeping(intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.expire('idle');
    }, intervalMs);
    timer.unref();

    return (): void => {
      clearInterval(timer);
    };
  }

  /**
   * Closes every live session and WAITS for them.
   *
   * It used to fire each `close()` and return, which read as tidy and did nothing: closing a
   * session is what runs `releaseOnClose`, and that hands an impersonated Ivanti session back to
   * the tenant. On shutdown the process exited first, so the release request never left the
   * machine and the session sat open until Ivanti timed it out — measured at 18,000 s.
   */
  async closeAll(): Promise<void> {
    for (const { id, value } of this.store.drain()) {
      this.options.logger.debug('closing session', { sessionId: id, reason: 'shutdown' });
      void this.closeTracked(value);
    }
    await Promise.all([...this.closing]);
  }
}
