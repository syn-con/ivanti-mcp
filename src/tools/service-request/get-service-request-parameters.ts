// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { decodeParameter } from '../../ivanti/service-request/parameter-shape.js';
import { readFormPackage } from '../../ivanti/service-request/form-rules/form-package.js';
import { evaluateForm } from '../../ivanti/service-request/form-rules/evaluate-form.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import {
  buildQuery,
  MAX_TOP,
  quoteOdataString,
  readTotal,
  withQuery,
} from '../../ivanti/odata/query.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { resolveObject } from '../shared/resolve-object.js';
import { ObjectNotAllowedError } from '../shared/object-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/** The parameters live in their own Business Object, linked to the template by RecId. */
const PARAMETER_OBJECT = 'servicereqtemplateparams';

/** How far a form is read, a page of Ivanti's 100 at a time, before the rest is called cut off. */
const MAX_ROWS = 500;

interface PagedRows {
  rows: OdataRecord[];
  /** What Ivanti counted, when it said; the rows read otherwise. */
  total: number;
  /** Rows exist past what was read. */
  hasMore: boolean;
}

/**
 * Every row of one filtered read, a page at a time.
 *
 * This read ONE page of 100 and said nothing when there were more — so a form past 100
 * parameters lost its tail silently, and the submit was then refused, one missing parameter at a
 * time, for questions the caller had never been shown. Paging with `$skip` does not repeat rows
 * (measured, see `MAX_TOP`); where even `MAX_ROWS` is not the end, the answer says so.
 */
async function readPaged(
  transport: IvantiTransport,
  entitySet: string,
  query: { filter: string; orderBy?: string },
): Promise<PagedRows> {
  const rows: OdataRecord[] = [];
  let counted: number | undefined;

  for (;;) {
    const url = withQuery(
      transport.routes.entitySet(entitySet),
      buildQuery({ ...query, top: MAX_TOP, skip: rows.length, count: true }),
    );
    const payload = await transport.request<OdataRecord>(url);
    const page = readRows<OdataRecord>(payload, url);
    // The first page's count is the one asked about; later pages only confirm it.
    counted ??= readTotal(payload, page.length)?.total;
    rows.push(...page);

    const more = counted === undefined ? page.length === MAX_TOP : rows.length < counted;
    if (!more || page.length === 0) {
      return { rows, total: Math.max(counted ?? 0, rows.length), hasMore: false };
    }
    if (rows.length >= MAX_ROWS) {
      return { rows, total: Math.max(counted ?? 0, rows.length), hasMore: true };
    }
  }
}

function cutOffNote(read: PagedRows, what: string): Record<string, unknown> {
  return read.hasMore
    ? {
        hasMoreNote:
          `Only the first ${String(read.rows.length)} ${what} were read` +
          (read.total > read.rows.length ? ` of ${String(read.total)}` : '') +
          '. The rest are not shown here — do not treat this as the complete list.',
      }
    : {};
}

/**
 * The answers a submitted request actually carries.
 *
 * Separate object from the template's parameters: `servicereqparams` holds one row per answered
 * parameter on one request. It is reached through the request rather than named directly, for
 * the same reason notes are — an end user may read the answers on *their* request, and the
 * object stays outside the allowlist so there is no way to read anyone else's.
 *
 * Without this a person could submit a request through this server and then have no way to ask
 * what they had submitted, which is the first thing anyone asks afterwards.
 */
const ANSWER_OBJECT = 'servicereqparams';

/**
 * What is worth returning out of the ~44 fields Ivanti sends per parameter.
 *
 * The first twelve are what a caller needs to render the prompt and submit a value. The last
 * five describe parameters Ivanti fills in **itself** — calculated or auto-filled — and without
 * them a caller cannot tell those apart from the ones a human must answer.
 */
const PARAMETER_FIELDS = [
  'RecId',
  'Name',
  'DisplayName',
  'DisplayType',
  'Description',
  'SequenceNum',
  'RequiredExpression',
  'VisibilityExpression',
  'ReadOnlyExpression',
  'ValidationList_RecID',
  'ValidationConstraints',
  'Price',
  'IsCalculated',
  'ValueExpression',
  'AutoFillExpression',
  'TriggerFields',
  'ConfigOptions',
  'RequiresSubscription',
];

export function createGetServiceRequestParametersTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_service_request_parameters',
    title: 'Get service request parameters',
    description:
      'TWO QUESTIONS, ONE TOOL. Pass `templateId` for what an offering ASKS — before submitting. ' +
      'Pass `requestId` for what a submitted request ANSWERED — the natural follow-up to filing ' +
      'one, and the only way to read those answers back.\n\n' +
      'The questions one service request template asks — the form a requester fills in.\n\n' +
      'Takes the TEMPLATE RecId (from the service request template object), not a subscription ' +
      'id and not an offering name. A wrong id returns no parameters rather than an error.\n\n' +
      'Read `required` rather than `RequiredExpression`: the raw field is an expression and is a ' +
      'string either way, so `$(false)` looks true to a naive check. `required: true` is ' +
      'unconditional; absent WITH a `RequiredExpression` is conditional — read the expression, ' +
      'because a parameter can become required the moment another answer is given; absent with ' +
      'NO `RequiredExpression` is genuinely optional.\n\n' +
      '`VisibilityExpression` IS A CONDITION ON ANOTHER ANSWER ON THE SAME FORM, e.g. ' +
      '`$(IsThisForYou == false)`. A parameter whose expression is false is not on the form — do ' +
      'not answer it. Answering a hidden parameter, or omitting one your other answers have just ' +
      'revealed, is how a submit gets refused.\n\n' +
      'Parameters whose `DisplayType` is a list take their values from a validation list: use ' +
      'get_service_request_parameter_options for those instead of inventing values. A ' +
      '`DisplayType` of `category` is a SECTION HEADING, not a question — never answer it; ' +
      '`answerable` counts the rest.',
    annotations: {
      title: 'Get service request parameters',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      templateId: z
        .string()
        .optional()
        .describe(
          "RecId of the service request TEMPLATE — what an offering asks for, before anything " +
            'is submitted. From `templateId` on a list_request_offerings entry.',
        ),
      requestId: z
        .string()
        .optional()
        .describe(
          "RecId of a SUBMITTED request — what was actually answered on it. Use this for " +
            '"what did I ask for?" after submitting. Only on a request the caller owns.',
        ),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated fields, if the default set is not what you need.'),
      subscriptionId: z
        .string()
        .optional()
        .describe('With `answers`: the offering\'s `subscriptionId`.'),
      answers: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.null(),
            z.object({ value: z.string(), recId: z.string().optional() }),
          ]),
        )
        .optional()
        .describe(
          'Answers so far, by parameter Name or RecId — submit_service_request takes RecIds. Returns only `evaluation` (needs `subscriptionId`, ' +
            'not `templateId`): what is shown, required, missing, and how to fetch each filtered ' +
            'list. Call again after each answer.',
        ),
    },
    handler: (args, context) =>
      runTool('get_service_request_parameters', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        // These exist to serve service requests; where that object is gated away, so are they.
        if (!deps.gate.allows('ServiceReq')) {
          throw new ObjectNotAllowedError('ServiceReq', deps.gate.allowed);
        }

        if (args.requestId !== undefined && args.requestId !== '') {
          // Reached through the request, so it follows that request's ownership — the answers
          // object itself is never namable, and there is no route to anyone else's.
          const request = await resolveObject(deps, 'ServiceReq');
          await assertOwnRecordById(deps, context, request, args.requestId);

          const read = await readPaged(transport, ANSWER_OBJECT, {
            filter: `ParentLink_RecID eq ${quoteOdataString(args.requestId)}`,
          });
          const answered = read.rows;

          // A date answer stores the UTC instant of the chosen LOCAL day, so the raw value reads
          // back as the previous calendar date — narrating it verbatim tells the person they
          // asked for 30 September when they chose 1 October. The local day is what they picked.
          const offset = await deps.connection.serviceRequests.tenantOffset.get().catch(() => undefined);
          const localDay = (value: unknown): string | undefined => {
            if (typeof value !== 'string') return undefined;
            const at = Date.parse(value);
            if (Number.isNaN(at)) return undefined;
            return new Date(at + (offset?.minutes ?? 0) * 60_000).toISOString().slice(0, 10);
          };

          return jsonResult({
            requestId: args.requestId,
            returned: answered.length,
            total: read.total,
            hasMore: read.hasMore,
            ...cutOffNote(read, 'answers'),
            answers: answered.map((row) => {
              const type = row['DisplayType'];
              const value = row['ParameterValue'];
              const day = type === 'date' ? localDay(value) : undefined;
              return {
                parameter: row['ParameterName'] ?? null,
                // What to say to the person. Ivanti's own display value is the raw instant on a
                // date, which is not the day they chose.
                displayValue: day ?? row['ParameterDisplayValue'] ?? value ?? null,
                value: value ?? null,
                type: type ?? null,
              };
            }),
            note:
              '`parameter` is the technical name the template uses; call this with `templateId` ' +
              'for the display names if you need to show the form back. A `date` answer is ' +
              'stored as a UTC instant — `displayValue` is the local day the person actually ' +
              'chose, and `value` is the raw instant.',
          });
        }

        // Answers are evaluated against the form as the portal receives it, which is keyed by the
        // offering's subscriptionId alone — so no template read, and no repeat of the parameter
        // list on every call. The names and descriptions were read once, without answers.
        if (args.answers !== undefined) {
          if (args.subscriptionId === undefined || args.subscriptionId === '') {
            return errorResult(
              '`answers` is evaluated against the offering as the portal receives it, which is ' +
                "keyed by the offering's `subscriptionId` (from list_request_offerings). Pass it.",
            );
          }
          const offset = await deps.connection.serviceRequests.tenantOffset.get().catch(() => undefined);
          const form = await readFormPackage(transport, args.subscriptionId, -(offset?.minutes ?? 0));
          const person = context?.pin?.person();
          const user =
            person === undefined
              ? undefined
              : {
                  displayName: person.displayName,
                  fields: { RecId: person.recId },
                  ...(person.loginId === undefined ? {} : { loginId: person.loginId }),
                  ...(person.primaryEmail === undefined ? {} : { email: person.primaryEmail }),
                };
          return jsonResult({
            subscriptionId: args.subscriptionId,
            evaluation: {
              ...evaluateForm({
                parameters: form,
                answers: args.answers,
                ...(user === undefined ? {} : { user }),
              }),
              note:
                "Computed here from Ivanti's own rules, as the portal does in the browser. " +
                '`missing` is what to ask next; send each `defaults` value as the answer unless ' +
                'the person chooses otherwise; leave `autoFilled` out (Ivanti fills them); drop ' +
                '`answeredButHidden`; fetch each `options` entry only when `waitingOn` is empty. ' +
                '`cannotTell` lists rules this could not read — treat those parameters as ' +
                'unknown, not hidden. Ivanti still judges the submit.',
            },
          });
        }

        if (args.templateId === undefined || args.templateId === '') {
          return errorResult(
            'Give me a `templateId` to see what an offering asks for, or a `requestId` to see ' +
              'what was answered on a request that already exists.',
          );
        }

        const read = await readPaged(transport, PARAMETER_OBJECT, {
          filter: `ParentLink_RecID eq ${quoteOdataString(args.templateId)}`,
          orderBy: 'SequenceNum',
        });
        const { rows } = read;

        // Ivanti sends every field whatever is asked for, and a 16-parameter template is ~28 KB
        // of mostly UI layout. Dropping empties on top is safe here: for a form parameter,
        // absent means unset.
        const projected = projectRows(rows, parseFieldList(args.fields) ?? PARAMETER_FIELDS, {
          dropEmpty: true,
        });

        // Headings are not questions. Counting them as parameters sends a caller answering
        // four things that take no value, on Ivanti's one-refusal-at-a-time treadmill.
        const answerable = projected.filter(
          (parameter) => (parameter as { DisplayType?: unknown }).DisplayType !== 'category',
        ).length;

        const names = new Set(
          projected.map((parameter) => (parameter as { Name?: unknown }).Name).filter((n) => typeof n === 'string'),
        );
        const decoded = projected.map((parameter) => decodeParameter(parameter, names));

        const filtered = decoded.filter((parameter) => parameter['filteredBy'] !== undefined).length;
        const conditional = decoded.filter((parameter) => parameter['conditionedOn'] !== undefined).length;

        return jsonResult({
          templateId: args.templateId,
          returned: projected.length,
          total: read.total,
          hasMore: read.hasMore,
          ...cutOffNote(read, 'parameters'),
          ...(filtered + conditional === 0
            ? {}
            : {
                dependenciesNote:
                  'ANSWERS DEPEND ON ANSWERS HERE. Work down the form in SequenceNum order, ' +
                  'holding what you have answered so far. `conditionedOn` names the answers that ' +
                  'SHOW or REQUIRE a parameter: evaluate its VisibilityExpression against them ' +
                  '— if false, leave it out; if true, answer it, and a required rule ' +
                  'that now holds makes it mandatory. A parameter can appear only after another ' +
                  'one is answered, and that one can itself be conditional, so a chain is ' +
                  'normal. `filteredBy` names the answers a list\'s OPTIONS depend on: ask for the ' +
                  'options with those values, never before. When an earlier answer changes, ' +
                  're-check everything that names it: drop answers that are now hidden and re-' +
                  'fetch options that were filtered by it. If the option a person needs is not ' +
                  'under the parent they chose, say so and ask — do not guess another one.',
              }),
          answerable,
          ...(answerable === projected.length
            ? {}
            : {
                answerableNote:
                  `${String(projected.length - answerable)} of these have DisplayType ` +
                  '`category`: they are section headings on the form, not questions. Do not ' +
                  'answer them.',
              }),
          ...(projected.length === 0
            ? {
                note:
                  'No parameters for that id. The most common cause is passing a subscription ' +
                  "or offering id instead of the template's RecId.",
              }
            : {}),
          parameters: decoded,
        });
      }),
  });
}
