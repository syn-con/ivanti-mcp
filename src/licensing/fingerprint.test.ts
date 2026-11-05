// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveUuid, fingerprintFor, isOwnNonce, nonceFor } from './fingerprint.js';

const INSTALL = '3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03';
const NAMESPACE_UID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('fingerprintFor', () => {
  it('sends the same three values on every start, so the Hub keeps one seat', () => {
    expect(fingerprintFor({ installId: INSTALL })).toEqual(fingerprintFor({ installId: INSTALL }));
  });

  it('derives the machine from the install ID when none is given', () => {
    const fingerprint = fingerprintFor({ installId: INSTALL });

    expect(fingerprint.installGuid).toBe(INSTALL);
    expect(fingerprint.machineGuid).toBe(deriveUuid('machine', INSTALL));
    expect(fingerprint.biosUuid).toBe(deriveUuid('bios', fingerprint.machineGuid));
  });

  it('uses a given machine ID, so the same install ID in another cluster is another machine', () => {
    const here = fingerprintFor({ installId: INSTALL, machineId: NAMESPACE_UID });
    const elsewhere = fingerprintFor({ installId: INSTALL });

    expect(here.machineGuid).toBe(NAMESPACE_UID);
    expect(here.machineGuid).not.toBe(elsewhere.machineGuid);
  });

  it('ignores the case an ID was written in', () => {
    expect(fingerprintFor({ installId: INSTALL.toUpperCase() })).toEqual(fingerprintFor({ installId: INSTALL }));
  });

  it('derives values the Hub and the server both accept as UUIDs', () => {
    const fingerprint = fingerprintFor({ installId: INSTALL });

    expect(z.uuid().safeParse(fingerprint.machineGuid).success).toBe(true);
    expect(z.uuid().safeParse(fingerprint.biosUuid).success).toBe(true);
  });
});

describe('nonceFor', () => {
  it('carries this installation, so a token copied from another one is told apart', () => {
    const mine = fingerprintFor({ installId: INSTALL });
    const theirs = fingerprintFor({ installId: '00000000-0000-4000-8000-000000000009' });

    expect(isOwnNonce(mine, nonceFor(mine))).toBe(true);
    expect(isOwnNonce(mine, nonceFor(theirs))).toBe(false);
    expect(isOwnNonce(mine, null)).toBe(false);
  });

  it('is new on every request', () => {
    const fingerprint = fingerprintFor({ installId: INSTALL });

    expect(nonceFor(fingerprint)).not.toBe(nonceFor(fingerprint));
  });
});
