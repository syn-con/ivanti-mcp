// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { FormParameter } from './form-rules/form-package.js';

/**
 * Settles the keys of a submit's answers to the parameter RecIds Ivanti files them under.
 *
 * `get_service_request_parameters` evaluates answers by parameter Name and a submit takes them by
 * RecId, so a caller that carried the first tool's keys into the second was refused with
 * "Required parameter Department is not defined" — which reads as an answer left out, not as the
 * wrong kind of key. A name that picks out exactly one parameter is unambiguous, so it is settled
 * here; a key that is neither is named back to the caller.
 *
 * Only a form that states its parameters' RecIds is judged. Without them nothing can be said about
 * a key, and the answers go to Ivanti as given — which is what happened before this existed.
 */

/** Characters apart, counting an insertion, deletion or change as one. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** A model retyping a 32-character id drops or swaps a character; two is the most it has been. */
const NEAR = 2;

export interface SettledAnswers<T> {
  answers: Record<string, T>;
  /** Name → RecId, for the keys that were names. */
  renamed: Record<string, string>;
  /** Keys that are neither a parameter's RecId nor its Name. */
  unknown: string[];
  /** For an unknown key one or two characters from a parameter's RecId: which one it likely meant. */
  nearMisses: Record<string, { recId: string; name: string }>;
}

export function settleAnswerKeys<T>(
  parameters: readonly FormParameter[],
  given: Record<string, T>,
): SettledAnswers<T> | undefined {
  const withIds = parameters.filter((parameter) => parameter.recId !== undefined);
  if (withIds.length === 0) return undefined;

  const byRecId = new Map(withIds.map((parameter) => [(parameter.recId ?? '').toLowerCase(), parameter.recId ?? ''] as const));

  // A name two parameters share picks out neither of them.
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const parameter of withIds) {
    if (byName.has(parameter.name)) ambiguous.add(parameter.name);
    byName.set(parameter.name, parameter.recId ?? '');
  }

  const answers: Record<string, T> = {};
  const renamed: Record<string, string> = {};
  const unknown: string[] = [];
  const nearMisses: Record<string, { recId: string; name: string }> = {};
  for (const [key, answer] of Object.entries(given)) {
    const recId = byRecId.get(key.toLowerCase());
    const named = ambiguous.has(key) ? undefined : byName.get(key);
    const settled = recId ?? named;
    if (settled === undefined) {
      unknown.push(key);
      const close = withIds
        .map((parameter) => ({ parameter, distance: editDistance(key.toLowerCase(), (parameter.recId ?? '').toLowerCase()) }))
        .filter((candidate) => candidate.distance <= NEAR)
        .sort((a, b) => a.distance - b.distance)[0];
      if (close !== undefined && key.length >= 16) {
        nearMisses[key] = { recId: close.parameter.recId ?? '', name: close.parameter.name };
      }
      continue;
    }
    if (recId === undefined) renamed[key] = settled;
    answers[settled] = answer;
  }
  return { answers, renamed, unknown, nearMisses };
}
