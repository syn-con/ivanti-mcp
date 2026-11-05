// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiTransport } from '../../http/transport.js';
import { parseConstraints, type ParameterConstraint } from '../parameter-shape.js';

/**
 * An offering's form as Ivanti's own portal receives it.
 *
 * `GET /api/rest/ServiceRequest/PackageData/{subscriptionId}/Default` is the whole form in one
 * call — every parameter, with its show / required / read-only / default rules already PARSED
 * into expression trees, and each tree's `FieldRefs` naming exactly the answers it reads. The
 * portal then evaluates them in the browser: ticking a checkbox sends nothing (HAR, 2026-10-25).
 *
 * The OData template parameters carry the same rules as text only, which is why the evaluator
 * reads this instead.
 */

/** A rule as Ivanti parses it. `Tree` is what `evaluateExpression` walks. */
export interface RuleExpression {
  Tree: unknown;
  FieldRefs: string[];
  /** The text it was written as, such as `$(ComputerRequired == true)`. */
  Source?: string;
}

export interface FormParameter {
  name: string;
  /** The template parameter's RecId, when the package states it. */
  recId?: string;
  type: string;
  sequence: number;
  visibility?: RuleExpression;
  required?: RuleExpression;
  readOnly?: RuleExpression;
  value?: RuleExpression;
  autoFill?: RuleExpression;
  /** The lists this one's options are filtered by. */
  constraints: ParameterConstraint[];
  validationListId?: string;
  /** Ivanti marks it hidden outright, whatever its visibility rule says. */
  hidden: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A rule with a tree to walk; anything else is "no rule", never a guess. */
function toRule(raw: unknown): RuleExpression | undefined {
  const rule = asRecord(raw);
  if (rule === undefined || rule['Tree'] === undefined || rule['Tree'] === null) return undefined;

  const refs = Array.isArray(rule['FieldRefs'])
    ? rule['FieldRefs'].filter((ref): ref is string => typeof ref === 'string')
    : [];
  const source = text(rule['Source']);
  return { Tree: rule['Tree'], FieldRefs: refs, ...(source === undefined ? {} : { Source: source }) };
}

/** Reads the parameters out of a package, in the order the form shows them. */
export function parseFormPackage(payload: unknown): FormParameter[] {
  const categories = asRecord(payload)?.['lstParamCategories'];
  if (!Array.isArray(categories)) return [];

  const parameters: FormParameter[] = [];
  for (const category of categories) {
    const rows = asRecord(category)?.['lstParameters'];
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const raw = asRecord(row);
      const name = text(raw?.['strName']);
      if (raw === undefined || name === undefined) continue;

      const constraints = Array.isArray(raw['validationConstraints'])
        ? (raw['validationConstraints'] as ParameterConstraint[])
        : parseConstraints(raw['strValidationConstraints']);
      // `strExistingRecId` is NOT this: it is the stored answer's id on an existing request. The
      // template parameter's own RecId — what a submit keys its answers by — is `strRecId`.
      const recId = text(raw['strRecId']) ?? text(raw['RecId']);
      const listId = text(raw['strValidationListRecId']);

      const visibility = toRule(raw['visibilityExpression']);
      const required = toRule(raw['requiredExpression']);
      const readOnly = toRule(raw['readOnlyExpression']);
      const value = toRule(raw['valueExpression']);
      const autoFill = toRule(raw['autoFillExpression']);

      parameters.push({
        name,
        ...(recId === undefined ? {} : { recId }),
        type: text(raw['strType']) ?? '',
        sequence: typeof raw['nSequenceNum'] === 'number' ? raw['nSequenceNum'] : 0,
        ...(visibility === undefined ? {} : { visibility }),
        ...(required === undefined ? {} : { required }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(value === undefined ? {} : { value }),
        ...(autoFill === undefined ? {} : { autoFill }),
        constraints,
        ...(listId === undefined ? {} : { validationListId: listId }),
        hidden: raw['bIsHidden'] === true,
      });
    }
  }

  return parameters.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Fetches one offering's form.
 *
 * `timeZoneMinutes` is the browser convention — minutes WEST of UTC, so `-60` on UTC+1 — which
 * the server uses to resolve date defaults.
 */
export async function readFormPackage(
  transport: IvantiTransport,
  subscriptionId: string,
  timeZoneMinutes: number,
): Promise<FormParameter[]> {
  const url = transport.routes.rest(
    `ServiceRequest/PackageData/${encodeURIComponent(subscriptionId)}/Default` +
      `?timeZone=${String(timeZoneMinutes)}`,
  );
  return parseFormPackage(await transport.request<unknown>(url));
}
