// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { createLicenceState, reasonFor } from './licence-state.js';
import type { LicenceClaims } from './token.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CLAIMS: LicenceClaims = { issuedAt: Math.floor(NOW / 1000), validUntil: '2027-03-31', customer: 'SD-1001' };

describe('createLicenceState', () => {
  it('starts closed, until the Hub has confirmed the licence', () => {
    const state = createLicenceState(() => NOW);

    expect(state.view()).toEqual({ status: 'closed', reason: 'the licence has not been confirmed with the Synergy Hub yet' });
    expect(state.isAdmitted()).toBe(false);
  });

  it('opens on a confirmation', () => {
    const state = createLicenceState(() => NOW);
    state.confirmed(CLAIMS);

    expect(state.view()).toEqual({ status: 'open', validUntil: '2027-03-31', confirmedAt: CLAIMS.issuedAt * 1000 });
  });

  it('holds through 30 days without the Hub, then closes', () => {
    const state = createLicenceState(() => NOW);
    state.confirmed(CLAIMS);
    state.unreachable('Could not reach the Synergy Hub');

    expect(state.view(NOW + 29 * DAY)).toMatchObject({ status: 'grace', graceEndsAt: NOW + 30 * DAY });
    expect(state.view(NOW + 31 * DAY).status).toBe('closed');
    expect(state.view(NOW + 31 * DAY).reason).toMatch(/not confirmed the licence for 30 days/);
  });

  it('stays closed when the Hub was never reached at all', () => {
    const state = createLicenceState(() => NOW);
    state.unreachable('Could not reach the Synergy Hub');

    expect(state.view()).toEqual({ status: 'closed', reason: 'Could not reach the Synergy Hub' });
  });

  it('closes on a refusal, whatever grace there was', () => {
    const state = createLicenceState(() => NOW);
    state.confirmed(CLAIMS);
    state.refused('license_suspended', reasonFor('license_suspended'));

    expect(state.view()).toEqual({ status: 'closed', code: 'license_suspended', reason: reasonFor('license_suspended') });
  });

  it('does not let a later network error soften a refusal into grace', () => {
    const state = createLicenceState(() => NOW);
    state.confirmed(CLAIMS);
    state.refused('no_seat', reasonFor('no_seat'));
    state.unreachable('timeout');

    expect(state.view()).toMatchObject({ status: 'closed', code: 'no_seat' });
  });

  it('reopens on the next confirmation after a refusal', () => {
    const state = createLicenceState(() => NOW);
    state.refused('license_suspended', reasonFor('license_suspended'));
    state.confirmed(CLAIMS);

    expect(state.view().status).toBe('open');
  });

  it('runs a restored licence in grace, measured from when it was issued', () => {
    const state = createLicenceState(() => NOW);
    state.restored(CLAIMS);

    expect(state.view(NOW + 10 * DAY)).toMatchObject({ status: 'grace', graceEndsAt: NOW + 30 * DAY });
  });

  it('closes once the licence end date has passed, even while confirmed', () => {
    const state = createLicenceState(() => NOW);
    state.confirmed({ ...CLAIMS, validUntil: '2026-11-04' });

    expect(state.view(NOW).status).toBe('open');
    expect(state.view(Date.UTC(2026, 10, 5, 0, 0, 1))).toMatchObject({ status: 'closed', reason: 'the licence ended on 2026-11-04' });
  });
});
