// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { IvantiToolDeps } from '../shared/deps.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/** The most options one answer carries; the rest are reached through `search`. */
const MAX_OPTIONS = 100;

const PARAMETER_OBJECT = 'servicereqtemplateparams';
const RECID = /^[0-9A-F]{32}$/i;

/**
 * Whether Ivanti knows a parameter by this id. Only asked when a list came back empty: Ivanti
 * answers a well-formed id that matches nothing with an empty list, which reads exactly like a
 * parameter whose list holds no rows. A read that fails for any other reason proves nothing, so
 * it counts as "exists" and the empty answer stands.
 */
async function parameterExists(
  transport: ReturnType<typeof transportFor>,
  parameterId: string,
): Promise<boolean> {
  try {
    const row = await transport.request<unknown>(transport.routes.record(PARAMETER_OBJECT, parameterId));
    return row !== undefined && row !== null;
  } catch (error: unknown) {
    // Measured: Ivanti answers a record id it does not hold with 400, not 404.
    return !(error instanceof IvantiApiError && (error.status === 400 || error.status === 404));
  }
}

/** Each option arrives as a row of cells: `[recId, value, label?]`. */
function toOption(row: unknown): { recId: string; value: string; label: string } | undefined {
  if (!Array.isArray(row) || row.length < 2) return undefined;

  // Cells arrive as strings, numbers or nulls; anything else is not a value a caller can submit.
  const cell = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  };

  const value = cell(row[1]);
  if (value === '') return undefined;

  return { recId: cell(row[0]), value, label: cell(row[2]) || value };
}

export function createGetServiceRequestParameterOptionsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_service_request_parameter_options',
    title: 'Get service request parameter options',
    description:
      'The legal values for one service request parameter whose type is a list.\n\n' +
      'Takes the parameter RecId from get_service_request_parameters. Some lists are ' +
      'CONSTRAINED by another answer on the same form — a site narrows the equipment, a ' +
      'category narrows the software. Those parameters carry `constraints`; pass the ' +
      "constraining parameter's `ConstraintFieldName` and the value chosen for it, or the list " +
      'comes back empty or wrong.\n\n' +
      'An empty list has three causes and the answer says which: no constraint supplied for a ' +
      'dependent list, a constraint whose value matches nothing, or a `search` term that does ' +
      'not begin an option label.',
    annotations: {
      title: 'Get service request parameter options',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      parameterId: z.string().describe('RecId of the parameter (32 hex characters), copied exactly from get_service_request_parameters.'),
      search: z
        .string()
        .optional()
        .describe(
          'Matches the START of the option LABEL, case-insensitively — not a substring, and ' +
            'never the value. `Bob` finds "Bob M Levitt"; `Levitt` finds nothing, and so does ' +
            '`BLevitt`, which is the value you would have to submit. Search by the first word, ' +
            'or omit it and read the whole list.',
        ),
      constraints: z
        .array(
          z.object({
            queryFieldName: z
              .string()
              .describe("The parameter's `ConstraintFieldName` from its constraints."),
            value: z.string().describe('The value chosen for the constraining parameter.'),
          }),
        )
        .optional()
        .describe('Values for the answers this list depends on.'),
      validationListId: z
        .string()
        .optional()
        .describe("The parameter's `ValidationList_RecID`, when it has one."),
    },
    handler: (args, context) =>
      runTool('get_service_request_parameter_options', deps.logger, async () => {
        // These exist to serve service requests; where that object is gated away, so are they.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
        }

        // A model copying a 32-character id by hand drops characters, and the answer to a mangled
        // id is an empty list — which it then explained as a tenant whose form has no options.
        if (!RECID.test(args.parameterId)) {
          return errorResult(
            `'${args.parameterId}' is ${String(args.parameterId.length)} characters, and a parameter ` +
              'RecId is 32 hex characters, so it is not one. Copy the `RecId` from ' +
              'get_service_request_parameters exactly rather than retyping it.',
          );
        }

        const transport = transportFor(deps.connection.transport, context);
        // A POST, despite being a read: the constraints travel in the body.
        const url = transport.routes.rest(
          `ServiceRequest/${encodeURIComponent(args.parameterId)}/ValidationList`,
        );

        const rows = await transport.request<unknown[]>(url, {
          method: 'POST',
          body: {
            constraintParams:
              args.constraints?.map((constraint) => ({
                queryFieldName: constraint.queryFieldName,
                value: constraint.value,
                condition: null,
              })) ?? null,
            parameterConfig: null,
            query: args.search ?? '',
            strCustomerLocation: '',
            strRecId: args.parameterId,
            strValidationName: '',
            strValidationRecId: args.validationListId ?? '',
            values: [],
          },
        });

        const all = Array.isArray(rows)
          ? rows.map(toOption).filter((option) => option !== undefined)
          : [];
        // A requester list under one department is 200 rows (~25 KB), and a caller that only
        // needed to know whether one person is on it read all of them. `search` narrows by label.
        const options = all.slice(0, MAX_OPTIONS);

        if (options.length === 0 && !(await parameterExists(transport, args.parameterId))) {
          return errorResult(
            `No parameter has the RecId '${args.parameterId}', so there is no list to be empty. ` +
              'Copy the `RecId` from get_service_request_parameters exactly — one character ' +
              'out is enough to match nothing.',
          );
        }

        return jsonResult({
          parameterId: args.parameterId,
          returned: options.length,
          ...(all.length > options.length
            ? {
                total: all.length,
                hasMore: true,
                moreNote:
                  `Showing the first ${String(options.length)} of ${String(all.length)}. Narrow ` +
                  'with `search` (it matches the START of the label) rather than reading them all.',
              }
            : {}),
          // Three different causes, and the old note named only one of them — so a caller whose
          // constraints were correct and whose `search` was simply the wrong shape was told to
          // go on supplying constraints. That cost one tester ~67 calls.
          ...(options.length === 0
            ? {
                // Three causes, and it must name the RIGHT one. The old wording said "supply the
                // constraining answer" even when `constraintsUsed` two lines below proved one had
                // been supplied — naming a specific wrong fix, which is worse than saying
                // nothing. It sent a tester probing a constraint name that was already correct.
                note:
                  args.search !== undefined && args.search !== ''
                    ? `No options start with '${args.search}'. This matches the beginning of the ` +
                      'option label, not a substring and not the value — drop `search` and read ' +
                      'the whole list rather than trying another term.'
                    : args.constraints !== undefined && args.constraints.length > 0
                      ? 'No options matched the constraints below. They WERE applied, so the ' +
                        'constraint field name is not the problem — the likeliest cause is that ' +
                        'a value you passed is not one the parent parameter actually holds. ' +
                        "Check it against that parameter's own options before changing anything " +
                        'else.'
                      : 'No options, and no constraints were supplied. If this parameter is ' +
                        'constrained by another answer, supply that answer — a dependent list ' +
                        'is empty rather than complete until its parent is given. If its ' +
                        '`ValidationConstraints` is `[]` it is NOT dependent on anything, and ' +
                        'this means the validation list itself holds no rows on this tenant: ' +
                        'nothing can ever be selected here, and any chain hanging off it is ' +
                        'dead. Check the parameter before assuming a missing constraint.',
                ...(args.constraints === undefined || args.constraints.length === 0
                  ? {}
                  : { constraintsUsed: args.constraints }),
              }
            : {}),
          // A constrained list is the options UNDER those parents, not the parameter's whole
          // range. A person or item missing from it is not proof they do not exist: they may
          // belong to another parent. Said whether or not the list is empty, because a short
          // answer from a correct filter reads exactly like a complete one.
          ...(args.constraints === undefined || args.constraints.length === 0
            ? {}
            : {
                scopedTo: args.constraints,
                scopeNote:
                  'This list holds only what is valid UNDER those constraints. Something absent ' +
                  'here — a person, a site, an item — may belong under a different value of the ' +
                  'parent; it does not mean it does not exist, and retrying its spelling will ' +
                  'not find it. If the person is not listed under the parent they chose, say so ' +
                  'and ask which parent they belong to (or have the parent changed) rather than ' +
                  'substituting someone else or looping through spellings. If their OWN record ' +
                  'leaves that parent empty (a blank Department), the fix is a data change for ' +
                  'their administrator: do not edit the record to make the form accept them ' +
                  'unless they ask for exactly that.',
              }),
          options,
        });
      }),
  });
}
