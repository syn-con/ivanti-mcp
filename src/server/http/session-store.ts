// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

export interface SessionStoreOptions {
  maxSessions: number;
  idleTtlMs: number;
  /** Injectable for tests; defaults to wall-clock. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  lastSeen: number;
  /** Who opened it, when a verified token said; the per-subject limit counts by this. */
  subject?: string;
  /** Requests being answered right now: a POST or DELETE with an answer still to give. */
  inFlight: number;
  /** Dedicated GET streams held open. The client's presence, not work in progress. */
  attached: number;
}

/** What a caller may judge an entry by when choosing one to close. */
export interface StoredSession<T> {
  id: string;
  value: T;
  subject?: string;
  idleMs: number;
  inFlight: number;
  attached: number;
}

/**
 * Bounded, idle-expiring map of live MCP sessions.
 *
 * Both limits matter. The TTL exists because `onsessionclosed` fires only on an explicit DELETE
 * and clients frequently vanish without sending one. The cap exists because in `none` mode
 * anything that can reach the port can `initialize` indefinitely, which is a denial-of-service
 * surface rather than merely a leak.
 *
 * The cap counts **reserved** slots as well as registered sessions. A session is only registered
 * once its `initialize` has run, so a cap that counted registrations alone admitted every one of
 * a burst of concurrent initializes and then turned the late ones away mid-handshake — as a 404
 * "Session not found", which reads as a server bug rather than as being full.
 */
export class SessionStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;
  private reserved = 0;
  private readonly reservedBySubject = new Map<string, number>();

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Registered sessions. */
  get size(): number {
    return this.entries.size;
  }

  /** Registered sessions plus the slots reserved for initializes still in flight. */
  get occupied(): number {
    return this.entries.size + this.reserved;
  }

  /** Returns the session and marks it as recently used. */
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    entry.lastSeen = this.now();
    return entry.value;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Returns false when the store is full, so the caller can refuse the request. */
  set(id: string, value: T, subject?: string): boolean {
    if (!this.entries.has(id) && this.occupied >= this.options.maxSessions) return false;
    this.entries.set(id, {
      value,
      lastSeen: this.now(),
      inFlight: 0,
      attached: 0,
      ...(subject === undefined ? {} : { subject }),
    });
    return true;
  }

  delete(id: string): T | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry?.value;
  }

  /** Holds a slot for a session not yet registered. False when there is none to hold. */
  reserve(subject?: string): boolean {
    if (this.occupied >= this.options.maxSessions) return false;
    this.reserved += 1;
    if (subject !== undefined) {
      this.reservedBySubject.set(subject, (this.reservedBySubject.get(subject) ?? 0) + 1);
    }
    return true;
  }

  /** Gives a reserved slot back — because it is being registered, or because it never will be. */
  unreserve(subject?: string): void {
    if (this.reserved > 0) this.reserved -= 1;
    if (subject === undefined) return;
    const held = (this.reservedBySubject.get(subject) ?? 0) - 1;
    if (held > 0) this.reservedBySubject.set(subject, held);
    else this.reservedBySubject.delete(subject);
  }

  /** Sessions and reserved slots belonging to this subject. */
  countFor(subject: string): number {
    let count = this.reservedBySubject.get(subject) ?? 0;
    for (const entry of this.entries.values()) {
      if (entry.subject === subject) count += 1;
    }
    return count;
  }

  /** Marks a request in flight on this session. */
  begin(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) entry.inFlight += 1;
  }

  /**
   * Marks it finished, which counts as use: a thirty-second write ends thirty seconds after it
   * was last "seen", and must not look idle for having taken that long.
   */
  end(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastSeen = this.now();
  }

  /** A client attached its dedicated GET stream. */
  attach(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) entry.attached += 1;
  }

  /** The stream ended; its client was last here now. */
  detach(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.attached = Math.max(0, entry.attached - 1);
    entry.lastSeen = this.now();
  }

  /** The least recently seen session that satisfies `accept`, if any does. */
  leastRecentlySeen(accept: (session: StoredSession<T>) => boolean): StoredSession<T> | undefined {
    const now = this.now();
    let oldest: StoredSession<T> | undefined;
    for (const [id, entry] of this.entries) {
      const candidate: StoredSession<T> = {
        id,
        value: entry.value,
        idleMs: now - entry.lastSeen,
        inFlight: entry.inFlight,
        attached: entry.attached,
        ...(entry.subject === undefined ? {} : { subject: entry.subject }),
      };
      if (!accept(candidate)) continue;
      if (oldest === undefined || candidate.idleMs > oldest.idleMs) oldest = candidate;
    }
    return oldest;
  }

  /**
   * How long until some session could have been quiet for `floorMs` — the soonest a full store
   * could make room. A busy session needs the whole floor after it finishes, so the floor is its
   * best case; with nothing registered, only reservations hold the slots, and those settle as
   * soon as their initialize does.
   */
  msUntilIdleFor(floorMs: number): number {
    const now = this.now();
    let soonest: number | undefined;
    for (const entry of this.entries.values()) {
      const wait = entry.inFlight > 0 || entry.attached > 0 ? floorMs : Math.max(0, entry.lastSeen + floorMs - now);
      if (soonest === undefined || wait < soonest) soonest = wait;
    }
    return soonest ?? 0;
  }

  /**
   * Removes everything idle for longer than the TTL and returns what was removed.
   *
   * A session answering a request, or with a client attached to its stream, is in use however
   * long ago it was last addressed: a write that outlives the TTL must not lose its session
   * mid-flight, and a client that vanishes drops its stream, which detaches it.
   */
  sweep(): { id: string; value: T }[] {
    const cutoff = this.now() - this.options.idleTtlMs;
    const expired: { id: string; value: T }[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.lastSeen <= cutoff && entry.inFlight === 0 && entry.attached === 0) {
        expired.push({ id, value: entry.value });
        this.entries.delete(id);
      }
    }

    return expired;
  }

  drain(): { id: string; value: T }[] {
    const all = [...this.entries].map(([id, entry]) => ({ id, value: entry.value }));
    this.entries.clear();
    return all;
  }
}
