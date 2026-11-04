// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createHash, randomBytes } from 'node:crypto';

/**
 * What this installation tells the Synergy Hub it is (design §9f).
 *
 * The Hub is told a machine, not shown one: it hashes the three strings it is sent and never
 * checks them against hardware. A pod has no hardware identity that survives a restart, so the
 * three come from configuration that is fixed per installation — and every process of that
 * installation must send exactly the same three on every call. The Hub moves a seat when
 * `machineGuid` or `installGuid` changes, so two processes disagreeing would bounce one seat
 * between them on every heartbeat.
 */
export interface Fingerprint {
  readonly machineGuid: string;
  readonly biosUuid: string;
  readonly installGuid: string;
  /** Ties a stored token to this installation through the nonce the Hub signs (`nonceFor`). */
  readonly installHash: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A UUID-shaped value derived from `source`: the same input gives the same value on every
 * machine and every start. The version and variant digits are forced so it reads as a v4 UUID.
 */
export function deriveUuid(label: string, source: string): string {
  const h = sha256(`ivanti-mcp-standalone/${label}/${source.toLowerCase()}`);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

export function fingerprintFor(ids: { installId: string; machineId?: string | undefined }): Fingerprint {
  const installGuid = ids.installId.toLowerCase();
  const machineGuid = (ids.machineId ?? deriveUuid('machine', installGuid)).toLowerCase();
  return {
    machineGuid,
    // Derived rather than configured: the Hub only tolerates a BIOS change, so a value of its
    // own would buy nothing, and one fewer setting is one fewer thing to get wrong.
    biosUuid: deriveUuid('bios', machineGuid),
    installGuid,
    installHash: sha256(`install/${installGuid}`).slice(0, 32),
  };
}

/**
 * The nonce for one request: this installation's hash, then randomness. The Hub echoes the
 * nonce inside the token it signs, so a stored token copied from another installation carries
 * that installation's hash and is refused here (`isOwnNonce`).
 */
export function nonceFor(fingerprint: Fingerprint, random: string = randomBytes(16).toString('hex')): string {
  return `${fingerprint.installHash}.${random}`;
}

export function isOwnNonce(fingerprint: Fingerprint, nonce: unknown): boolean {
  return typeof nonce === 'string' && nonce.startsWith(`${fingerprint.installHash}.`);
}
