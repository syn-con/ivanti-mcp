// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';
import { createListRequestOfferingsTool } from './list-request-offerings.js';
import { createSubmitServiceRequestTool } from './submit-service-request.js';
import { createDeleteAttachmentTool } from '../attachments/delete-attachment.js';
import { createUploadAttachmentTool } from '../attachments/upload-attachment.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const PERSON = {
  recId: 'E1',
  category: 'employee',
  displayName: 'Paul H Chang',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

function deps(responses: Record<string, unknown>, ownRecordsOnly = false) {
  const { connection, urls } = connectionFixture({
    entities: { incident: {}, servicereq: {}, employee: {} },
    responses,
  });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly, actions: OPEN_ACTIONS } };
}

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...PERSON });
  return context;
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';
const body = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(text(result)) as Record<string, unknown>;

const OFFERINGS = {
  'Template/': [
    {
      strSubscriptionId: 'sub-1',
      strRecId: 'tpl-1',
      strName: 'New Smartphone Request',
      strDescription: 'A phone',
      // The 20-field raw shape, most of it rendering hints.
      strConfigOptions: '{"configData":{"hidePrice":false}}',
      strLayoutName: 'x',
    },
    { strSubscriptionId: 'sub-2', strRecId: 'tpl-2', strName: 'Address Change' },
    { strRecId: 'tpl-3', strName: 'Broken — no subscription id' },
  ],
};

describe('list_request_offerings', () => {
  it('flags offerings that share a description so the person chooses', async () => {
    const { deps: d } = deps({
      'Template/': [
        { strSubscriptionId: 's1', strRecId: 't1', strName: 'New Employee On-boarding', strDescription: 'New hire provisioning' },
        { strSubscriptionId: 's2', strRecId: 't2', strName: 'New Employee Setup', strDescription: 'New hire provisioning' },
        { strSubscriptionId: 's3', strRecId: 't3', strName: 'Address Change', strDescription: 'Change address' },
      ],
    });

    const result = body(await createListRequestOfferingsTool(d).handler({}, pinned()));

    expect(result['lookAlikes']).toEqual([['New Employee On-boarding', 'New Employee Setup']]);
    expect(String(result['lookAlikesNote'])).toContain('ask');
  });

  it('keeps both ids and drops the rendering hints', async () => {
    const { deps: d } = deps(OFFERINGS);

    const result = body(await createListRequestOfferingsTool(d).handler({}, pinned()));

    expect(result['returned']).toBe(2);
    expect((result['offerings'] as Record<string, unknown>[])[0]).toEqual({
      subscriptionId: 'sub-2',
      templateId: 'tpl-2',
      name: 'Address Change',
    });
  });

  it('drops an offering that cannot be submitted', async () => {
    // No subscriptionId means no way to request it, so it is not an offering.
    const { deps: d } = deps(OFFERINGS);

    const result = body(await createListRequestOfferingsTool(d).handler({}, pinned()));
    const names = (result['offerings'] as { name: string }[]).map((o) => o.name);

    expect(names).not.toContain('Broken — no subscription id');
  });

  it('searches locally, because Ivanti’s own search loses real hits', async () => {
    // Measured: the catalog's searchString matches whole words, so 'phone' misses
    // 'New Smartphone Request'.
    const { deps: d } = deps(OFFERINGS);

    const result = body(
      await createListRequestOfferingsTool(d).handler({ search: 'phone' }, pinned()),
    );

    expect((result['offerings'] as { name: string }[]).map((o) => o.name)).toEqual([
      'New Smartphone Request',
    ]);
  });

  it('asks who it is for rather than guessing', async () => {
    const { deps: d } = deps(OFFERINGS);

    const result = await createListRequestOfferingsTool(d).handler(
      {},
      { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('act_as');
  });
});

const SUBMITTED = {
  'POST ServiceRequest/new': {
    IsSuccess: true,
    ErrorText: '',
    ServiceRequests: [
      {
        strRequestRecId: 'sr1',
        strRequestNum: '10219',
        strName: 'Address Change',
        parameterTemplateParameterIds: { P1: 'i1' },
      },
    ],
  },
};

describe('submit_service_request', () => {
  it('reports a refusal Ivanti delivered inside a 200', async () => {
    const { deps: d } = deps({
      'POST ServiceRequest/new': {
        IsSuccess: false,
        ErrorText: "Parameter 'Department': Required parameter Department is not defined",
      },
    });

    const result = await createSubmitServiceRequestTool(d).handler(
      { subscriptionId: 'sub-1', answers: { P1: 'x' } },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing was created');
  });

  it('reads the request back and says when an answer did not store', async () => {
    const { deps: d } = deps({
      ...SUBMITTED,
      ServiceReqContainsServiceReqParam: {
        value: [
          { ParameterName: 'ForwardEmail', ParameterValue: 'false', SvcReqTmplParamLink_RecID: 'P1' },
        ],
      },
    });

    const result = body(
      await createSubmitServiceRequestTool(d).handler(
        { subscriptionId: 'sub-1', answers: { P1: true } },
        pinned(),
      ),
    );

    // Ivanti called this submit clean; only the read-back disagrees.
    expect(result['answersVerified']).toBe(false);
    expect(result['storedDifferently']).toEqual([
      { parameter: 'ForwardEmail', sent: 'true', stored: 'false' },
    ]);
  });

  /**
   * A failed read-back is not a passed one.
   *
   * `verifyStoredAnswers` is wrapped in a `.catch` — correctly, because the request EXISTS by then
   * and turning a filed request into a reported failure would be worse. But its result used to be
   * indistinguishable from "nothing mismatched": `undefined` rendered as `answersVerified: true`,
   * beside an `answerNote` promising the comparison had confirmed the answers individually. Per
   * this module's own measurements, a wrong offset sign stores a datetime as `0001-01-01` while
   * Ivanti still reports success — precisely the case the read-back exists to catch.
   */
  it('says the verification is unknown when the read-back fails', async () => {
    const { deps: d } = deps({
      ...SUBMITTED,
      ServiceReqContainsServiceReqParam: new Error('Ivanti 500 while reading the request back'),
    });

    const result = body(
      await createSubmitServiceRequestTool(d).handler(
        { subscriptionId: 'sub-1', answers: { P1: true } },
        pinned(),
      ),
    );

    expect(result['answersVerified']).toBe('unknown');
    expect(String(result['verifyWarning'])).toContain('NOT a confirmation');
    // The request itself was still filed, and its number still reported.
    expect(result['requestNumber']).toBeDefined();
  });

  /**
   * Every file is checked before any file is uploaded.
   *
   * The decode/empty/size checks used to live INSIDE the staging loop, and staging is a real
   * upload — `GetPackageDataSDA` → `GetUploadTicket` → a multipart POST. So when a later
   * attachment failed validation, the earlier ones were already in Ivanti while the caller was
   * told "Nothing was submitted": true about the service request, false about the tenant.
   *
   * The fixture stages nothing, so reaching the uploader at all fails with a session error. Seeing
   * the SIZE message instead is what proves the pre-pass ran first.
   */
  it('checks every attachment before uploading any of them', async () => {
    const { deps: d } = deps({ ...OFFERINGS, ...SUBMITTED });
    const tooBig = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');

    const result = await createSubmitServiceRequestTool(d).handler(
      {
        subscriptionId: 'sub-1',
        answers: { P1: 'x' },
        attachments: [
          { filename: 'report.txt', contentBase64: Buffer.from('fine').toString('base64') },
          { filename: 'capture.bin', contentBase64: tooBig },
        ],
      },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('capture.bin');
    expect(text(result)).toContain('over the');
    // And the honest part: nothing reached the tenant, so the old wording is still correct here.
    expect(text(result)).toContain('Nothing was submitted');
  });

  it('refuses to file in someone else’s name in enduser mode', async () => {
    const { deps: d } = deps(SUBMITTED, true);

    const result = await createSubmitServiceRequestTool(d).handler(
      { subscriptionId: 'sub-1', answers: {}, person: 'SOMEONE-ELSE' },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Paul H Chang');
  });

  describe('answer keys', () => {
    const PACKAGE = {
      'ServiceRequest/PackageData/sub-1/Default': {
        lstParamCategories: [
          {
            lstParameters: [
              { strName: 'Department_1', strRecId: 'P1', strType: 'combo', nSequenceNum: 1 },
              { strName: 'Model', strRecId: 'P2', strExistingRecId: 'X2', strType: 'text', nSequenceNum: 2 },
            ],
          },
        ],
      },
    };

    it('settles names to RecIds and says which', async () => {
      const { deps: d } = deps({ ...SUBMITTED, ...PACKAGE, ServiceReqContainsServiceReqParam: { value: [] } });
      const request = vi.spyOn(d.connection.transport, 'requestRequired');

      const result = body(
        await createSubmitServiceRequestTool(d).handler(
          { subscriptionId: 'sub-1', answers: { Department_1: { value: 'IT', recId: 'o1' }, P2: 'iPad' } },
          pinned(),
        ),
      );

      expect(result['keysSettled']).toEqual({ Department_1: 'P1' });
      const posted = JSON.stringify(request.mock.calls);
      expect(posted).toContain('P1');
      expect(posted).not.toContain('Department_1');
    });

    it('refuses a key that matches nothing, by name, before anything is sent', async () => {
      const { deps: d, urls } = deps({ ...SUBMITTED, ...PACKAGE });

      const result = await createSubmitServiceRequestTool(d).handler(
        { subscriptionId: 'sub-1', answers: { Colour: 'Black' } },
        pinned(),
      );

      expect(result.isError).toBe(true);
      expect(text(result)).toContain("'Colour'");
      expect(text(result)).not.toContain('mistyped');
      expect(text(result)).toContain('Department_1, Model');
      expect(text(result)).toContain('Nothing was submitted');
      expect(urls.some((url) => url.includes('ServiceRequest/new'))).toBe(false);
    });

    it('tells the model a status read now is not final', async () => {
      const { deps: d } = deps({ ...SUBMITTED, ServiceReqContainsServiceReqParam: { value: [] } });

      const result = body(
        await createSubmitServiceRequestTool(d).handler({ subscriptionId: 'sub-1', answers: { P1: 'x' } }, pinned()),
      );

      expect(String(result['statusNote'])).toContain('time it was read');
    });

    it('sends the answers as given when the form cannot be read', async () => {
      const { deps: d } = deps({ ...SUBMITTED, ServiceReqContainsServiceReqParam: { value: [] } });

      const result = await createSubmitServiceRequestTool(d).handler(
        { subscriptionId: 'sub-1', answers: { Anything: 'x' } },
        pinned(),
      );

      expect(result.isError).not.toBe(true);
    });
  });

  it('looks up the tenant offset only when a date is being sent', async () => {
    const { deps: d, urls } = deps({
      ...SUBMITTED,
      ServiceReqContainsServiceReqParam: { value: [] },
    });
    const tool = createSubmitServiceRequestTool(d);

    await tool.handler({ subscriptionId: 'sub-1', answers: { P1: 'plain text' } }, pinned());
    const beforeDate = urls.filter((url) => url.includes('orderby')).length;

    await tool.handler({ subscriptionId: 'sub-1', answers: { P2: '2026-09-30' } }, pinned());

    expect(beforeDate).toBe(0);
    expect(urls.filter((url) => url.includes('orderby')).length).toBeGreaterThan(0);
  });
});

describe('delete_attachment', () => {
  it('refuses an id that never existed rather than reporting a delete', async () => {
    // Ivanti answers 204 for this, so believing the status would report a file removed.
    const { deps: d } = deps({ attachments: { value: [] } });

    const result = await createDeleteAttachmentTool(d).handler({ attachmentId: 'nope' }, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nothing was deleted');
  });

  it('reports a delete Ivanti accepted but did not perform', async () => {
    const { connection } = connectionFixture({
      entities: { incident: {} },
      // The row survives the delete, which the fixture does not clear for this key.
      responses: { 'attachments?': { value: [{ RecId: 'a1', ATTACHNAME: 'payroll.xlsx' }] } },
    });
    const tool = createDeleteAttachmentTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    });

    const result = await tool.handler({ attachmentId: 'a1' }, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('still there');
  });
});

describe('upload_attachment', () => {
  const HELLO = Buffer.from('hello').toString('base64');

  it('refuses a file too large to send through a tool call', async () => {
    // Base64 costs 4 characters per 3 bytes and passes through the context twice.
    const { deps: d } = deps({ "incidents('i1')": { RecId: 'i1' } });
    const big = Buffer.alloc(3 * 1024 * 1024).toString('base64');

    const result = await createUploadAttachmentTool(d).handler(
      { object: 'Incidents', recordId: 'i1', filename: 'big.bin', contentBase64: big },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('attach it in Ivanti directly');
  });

  it('refuses something that is not base64 rather than storing an empty file', async () => {
    // Buffer.from drops what it cannot decode, so an empty result means bad input.
    const { deps: d } = deps({ "incidents('i1')": { RecId: 'i1' } });

    const result = await createUploadAttachmentTool(d).handler(
      { object: 'Incidents', recordId: 'i1', filename: 'x.txt', contentBase64: '!!!!' },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not valid base64');
  });

  it('explains a missing parent instead of reporting an Ivanti status', async () => {
    const { deps: d, urls } = deps({});

    const result = await createUploadAttachmentTool(d).handler(
      { object: 'Incidents', recordId: 'gone', filename: 'x.txt', contentBase64: HELLO },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('leaves a file attached to nothing');
    // And nothing was sent.
    expect(urls.filter((url) => url.includes('rest/Attachment'))).toEqual([]);
  });
});
