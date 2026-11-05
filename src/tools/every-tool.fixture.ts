// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * The stub tenant and the arguments that drive **every registered tool** once.
 *
 * Shared because two guards need exactly the same harness and ask different questions of it:
 * `admin-ui-guard` proves no tool breaks when the admin console refuses, and
 * `impersonation-guard` proves none breaks — or quietly reaches for the wrong credential — when
 * this deployment cannot impersonate. Duplicating a hundred lines of stub data between them
 * would mean the two drifting apart, and a guard that no longer drives every tool is a guard
 * that passes for the wrong reason.
 *
 * A tool added without an `ARGUMENTS` entry fails both.
 */

/** Enough of a tenant that every tool takes its happy path. */
export const RESPONSES: Record<string, unknown> = {
  // Matched by substring in declaration order, so the relationship route comes before the record.
  // The target is linked, so unlink_records reaches Ivanti rather than refusing on its own guard.
  IncidentContainsTask: { value: [{ RecId: 't1' }], code: 'ISM_2000' },
  "incidents('abc')": { RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' },
  incidents: { value: [{ RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' }] },
  servicereqs: { value: [] },
  changes: { value: [] },
  employees: { value: [{ RecId: 'e1', LoginID: 'JSmith', DisplayName: 'Jon Smith' }] },
  // On the incident: upload_attachment reads the row back after linking, and a row on no record
  // is reported as an orphan rather than as attached.
  attachments: {
    value: [
      { RecId: 'a1', ATTACHNAME: 'work-order.log', ParentLink_RecID: 'abc', ParentLink_Category: 'Incident' },
    ],
  },
  // The fixture serves a file body as text, which is what download_attachment reads.
  'rest/Attachment': 'log line one',
  'POST journal__notess': { RecId: 'n1', NotesBody: 'hello', PublishToWeb: false },
  frs_approvalvotetrackings: {
    value: [
      {
        RecId: 'v1',
        // The guard runs without an identity, so the vote is refused before Ivanti is reached.
        Owner: 'somebody-else',
        Status: 'Pending',
        PrimaryParentObject: 'ServiceReq',
        PrimaryParentID: '10002',
      },
    ],
  },
  frs_knowledges: {
    value: [{ KnowledgeNumber: 10052, Title: 'VPN error 413', Status: 'Published', Details: '<p>Reconnect.</p>' }],
  },
  // add_note reads the note back and requires it on the record it was written to.
  journal__notess: {
    value: [{ RecId: 'n1', NotesBody: 'hello', PublishToWeb: false, ParentLink_RecID: 'abc' }],
  },
  // The multipart upload answers with the new attachment's RecId in `Message`, and leaves the
  // parent link unset — the tool patches it afterwards.
  'POST Attachment': [{ FileName: 'x.txt', IsUploaded: true, Message: 'A'.repeat(32) }],
  'PATCH attachments': { code: 'ISM_2000' },
  'DELETE attachments': { code: 'ISM_2000' },
  'Template/': [
    { strSubscriptionId: 'sub-1', strRecId: 'tpl-1', strName: 'New Laptop', strDescription: 'A laptop' },
  ],
  'POST ServiceRequest/new': {
    IsSuccess: true,
    ErrorText: '',
    ServiceRequests: [
      {
        strRequestRecId: 'sr1',
        strRequestNum: '10219',
        strName: 'New Laptop',
        parameterTemplateParameterIds: {},
      },
    ],
  },
  servicereqtemplateparams: { value: [{ RecId: 'p1', Name: 'StartDate' }] },
  ValidationList: [['r1', 'Accounting']],
  // The writes: a create answers with the stored record, a patch and a delete with nothing.
  'POST incidents': { RecId: 'abc', IncidentNumber: 1, Subject: 'stub' },
  'PATCH incidents': { RecId: 'abc', Subject: 'stub' },
  'DELETE incidents': { code: 'ISM_2000' },
};

export const ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_version: {},
  act_as: { person: 'JSmith' },
  switch_role: { role: 'ServiceDeskAnalyst' },
  list_business_objects: {},
  get_object_metadata: { object: 'Incidents' },
  get_record: { object: 'Incidents', recordId: 'abc' },
  list_records: { object: 'Incidents' },
  count_records: { object: 'Incidents' },
  get_related_records: { object: 'Incidents', recordId: 'abc', relationship: 'IncidentContainsTask' },
  fulltext_search_object: { object: 'Incidents', query: 'printer' },
  list_assigned_work: { person: 'JSmith' },
  get_service_request_parameters: { templateId: 't1' },
  get_service_request_parameter_options: { parameterId: '6D4B277C64354540AF1B6C5E96E8691A' },
  get_attachment_details: { attachmentId: 'a1' },
  search: { query: 'printer' },
  fetch: { id: 'incidents:abc' },
  get_pick_list_values: { object: 'Incidents', fields: ['Status'] },
  get_pick_list_constraints: { object: 'Incidents' },
  get_link_fields: { object: 'Incidents' },
  list_saved_searches: { object: 'Incidents' },
  saved_search: { object: 'Incidents', name: 'All Active', searchId: 'a1' },
  group_count: { object: 'Incidents', groupBy: 'Status', values: ['Active'] },
  list_quick_actions: { object: 'Incidents' },
  preview_quick_action: { object: 'Incidents', recordId: 'abc', actionId: 'act-1' },
  run_quick_action: { object: 'Incidents', recordId: 'abc', actionId: 'act-1' },
  preview_delete: { object: 'Incidents', recordId: 'abc' },
  // What `incidents('abc')` already holds: every written field is read back now, and a stub that
  // stored something other than what was written is a write that did not take.
  create_record: { object: 'Incidents', fields: { Subject: 'Printer' } },
  update_record: { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer' } },
  delete_record: { object: 'Incidents', recordId: 'abc' },
  close_ticket: { object: 'Incidents', recordId: 'abc' },
  reopen_ticket: { object: 'Incidents', recordId: 'abc' },
  search_knowledge: { query: 'vpn' },
  list_approvals: { person: 'JSmith' },
  vote_on_approval: { approvalId: 'v1', decision: 'approve' },
  list_notes: { object: 'Incidents', recordId: 'abc' },
  add_note: { object: 'Incidents', recordId: 'abc', note: 'hello' },
  upload_attachment: {
    object: 'Incidents',
    recordId: 'abc',
    filename: 'x.txt',
    contentBase64: 'aGVsbG8=',
  },
  delete_attachment: { attachmentId: 'a1' },
  download_attachment: { attachmentId: 'a1' },
  list_request_offerings: { person: 'e1' },
  submit_service_request: { subscriptionId: 'sub-1', answers: {}, person: 'e1' },
  link_records: {
    object: 'Incidents',
    recordId: 'abc',
    relationship: 'IncidentContainsTask',
    targetId: 't1',
  },
  unlink_records: {
    object: 'Incidents',
    recordId: 'abc',
    relationship: 'IncidentContainsTask',
    targetId: 't1',
  },
};
