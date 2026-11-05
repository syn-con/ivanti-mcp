// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { listOfferings } from '../../ivanti/service-request/offerings.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { resolveSubject } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { connectionFor } from '../shared/connection-for.js';
import type { IvantiConnection } from '../../ivanti/connect.js';

/**
 * The most offerings one answer lists.
 *
 * The whole catalogue came back every time — 132 offerings on a stock tenant, each with its
 * description, re-sent with every later turn — when the question was almost always about one of
 * them. Past this the list is cut, and the answer says so with the total and how to narrow it:
 * `search` reaches every offering by any part of its name, so nothing is out of reach.
 */
const MAX_OFFERINGS = 50;

/** A RecId's display name, so an opaque id can be echoed back as a person. Best effort. */
async function findEmployeeName(
  deps: IvantiToolDeps,
  // Passed in rather than reached for: which offerings a person may see is read on the
  // caller's credential when there is one.
  connection: IvantiConnection,
  recId: string,
): Promise<string | undefined> {
  const record = await connection.transport
    .request<OdataRecord>(connection.transport.routes.record('employees', recId))
    .catch(() => undefined);
  const name = record?.['DisplayName'];
  return typeof name === 'string' && name !== '' ? name : undefined;
}

export function createListRequestOfferingsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_request_offerings',
    title: 'List request offerings',
    description:
      'The service catalog: what a person can request.\n\n' +
      'EACH OFFERING CARRIES TWO DIFFERENT IDS AND THEY ARE NOT INTERCHANGEABLE. ' +
      '`subscriptionId` is what submit_service_request takes; `templateId` is what ' +
      'get_service_request_parameters takes. Take both from the SAME entry — mixing two ' +
      "offerings' ids creates a request with none of the answers on it, and Ivanti reports that " +
      'as success.\n\n' +
      'Search is applied here, over name and description. Ivanti\'s own catalog search matches ' +
      'whole words and silently returns fewer offerings than exist — \'phone\' misses ' +
      "'New Smartphone Request' — so it is not used.",
    annotations: {
      title: 'List request offerings',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring over the name and description.'),
      topLevelOnly: z
        .boolean()
        .optional()
        .describe(
          'Only the catalog\'s top-level offerings — roughly 20 of 130 on a stock tenant, and ' +
            'what the self-service portal shows first. Needs an Ivanti session; the answer says ' +
            'if it could not be narrowed.',
        ),
      person: z
        .string()
        .optional()
        .describe(
          'Whose catalog to read, as their RecId. REQUIRES AN IDENTITY: with nobody pinned by ' +
            '`act_as` and no `person`, the call is REFUSED rather than answered for a default — ' +
            'this schema cannot say so structurally. NOTE this deployment returns the whole ' +
            'catalog either way: entitlement narrowing is not applied, so a RecId here changes ' +
            'nothing you can observe. Do not use it as a pre-flight entitlement check. ' +
            '(submit_service_request DOES honour its own `person`; the two arguments differ.)',
        ),
    },
    handler: (args, context) =>
      runTool('list_request_offerings', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const pinned = context.pin?.person();
        // A catalogue is per person — entitlements differ — so naming someone else would be a
        // way to read what a colleague is entitled to.
        const personRecId = resolveSubject(deps, context, args.person, (person) => person.recId);

        if (personRecId === undefined) {
          return errorResult(
            'Whose catalog? The offerings a person sees depend on their entitlements, so this ' +
              'needs someone: call `act_as` with the name of the person you are helping, or ' +
              'pass `person` with their RecId.',
          );
        }

        const result = await listOfferings({
          transport: connection.transport,
          session: connection.session,
          logger: deps.logger,
          personRecId,
          topLevelOnly: args.topLevelOnly ?? false,
          ...(args.search === undefined ? {} : { search: args.search }),
        });

        const offerings = result.offerings.slice(0, MAX_OFFERINGS);
        const hasMore = result.offerings.length > offerings.length;

        // Two offerings with one description are look-alikes, and choosing between them for the
        // person sent a request down the one that was later cancelled. They choose.
        const byDescription = new Map<string, string[]>();
        for (const offering of offerings) {
          const description = (offering.description ?? '').trim().toLowerCase();
          if (description === '') continue;
          byDescription.set(description, [...(byDescription.get(description) ?? []), offering.name]);
        }
        const lookAlikes = [...byDescription.values()].filter((names) => names.length > 1);

        return jsonResult({
          ...(lookAlikes.length === 0
            ? {}
            : {
                lookAlikes,
                lookAlikesNote:
                  'Offerings in each group share one description. Do not pick for the person: ask ' +
                  'which they want, and say what tells them apart if anything does.',
              }),
          returned: offerings.length,
          total: result.offerings.length,
          hasMore,
          ...(hasMore
            ? {
                hasMoreNote:
                  `${String(result.offerings.length)} offerings match; the first ` +
                  `${String(MAX_OFFERINGS)} by name are listed. What is not listed may still be ` +
                  'offered — narrow with `search` (any part of a name or description) or ' +
                  '`topLevelOnly` rather than telling the person it is not available.',
              }
            : {}),
          servedBy: result.servedBy === 'catalog' ? "the catalog's top level" : 'the whole catalog',
          /**
           * The person this answer is FOR, resolved whichever way it was given.
           *
           * This reported the pin and vanished entirely when `person` supplied the RecId — so a
           * caller handing over an opaque 32-hex id got no confirmation it resolved to the human
           * they meant, on a tool whose whole premise is that entitlements differ per person.
           */
          forPerson:
            pinned !== undefined && pinned.recId === personRecId
              ? pinned.displayName
              : ((await findEmployeeName(deps, connection, personRecId)) ?? personRecId),
          ...(result.note === undefined ? {} : { note: result.note }),
          offerings,
        });
      }),
  });
}
