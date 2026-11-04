// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { LicenceCheck } from './call/licence-gate.js';
import type { Config } from '../config/env-schema.js';
import type { IvantiConnection } from '../ivanti/connect.js';
import type { Logger } from '../logger.js';
import { createGetVersionTool } from './get-version.js';
import { createCountRecordsTool } from './records/count-records.js';
import { createCreateRecordTool } from './records/create-record.js';
import { createDeleteRecordTool } from './records/delete-record.js';
import { createUpdateRecordTool } from './records/update-record.js';
import { createLinkRecordsTool } from './relationships/link-records.js';
import { createUnlinkRecordsTool } from './relationships/unlink-records.js';
import { createGetRecordTool } from './records/get-record.js';
import { createGetRelatedRecordsTool } from './records/get-related-records.js';
import { createListAssignedWorkTool } from './records/list-assigned-work.js';
import { createListRecordsTool } from './records/list-records.js';
import { createGetAttachmentDetailsTool } from './attachments/get-attachment-details.js';
import { createUploadAttachmentTool } from './attachments/upload-attachment.js';
import { createDownloadAttachmentTool } from './attachments/download-attachment.js';
import { createDeleteAttachmentTool } from './attachments/delete-attachment.js';
import { createListRequestOfferingsTool } from './service-request/list-request-offerings.js';
import { createAddNoteTool } from './notes/add-note.js';
import { createSearchKnowledgeTool } from './knowledge/search-knowledge.js';
import { createListApprovalsTool } from './approvals/list-approvals.js';
import { createVoteOnApprovalTool } from './approvals/vote-on-approval.js';
import { createListNotesTool } from './notes/list-notes.js';
import { createSubmitServiceRequestTool } from './service-request/submit-service-request.js';
import { createFetchTool } from './search/fetch.js';
import { createFulltextSearchObjectTool } from './search/fulltext-search-object.js';
import { createSearchTool } from './search/search.js';
import { createGetServiceRequestParameterOptionsTool } from './service-request/get-service-request-parameter-options.js';
import { createGetServiceRequestParametersTool } from './service-request/get-service-request-parameters.js';
import { createGetObjectMetadataTool } from './schema/get-object-metadata.js';
import { createGetLinkFieldsTool } from './schema/get-link-fields.js';
import { createGetPickListConstraintsTool } from './schema/get-pick-list-constraints.js';
import { createGetPickListValuesTool } from './schema/get-pick-list-values.js';
import { createGroupCountTool } from './records/group-count.js';
import { createPreviewDeleteTool } from './records/preview-delete.js';
import { createListQuickActionsTool } from './quick-actions/list-quick-actions.js';
import { createPreviewQuickActionTool } from './quick-actions/preview-quick-action.js';
import { createRunQuickActionTool } from './quick-actions/run-quick-action.js';
import { createListSavedSearchesTool } from './search/list-saved-searches.js';
import { createSavedSearchTool } from './search/saved-search.js';
import { createListBusinessObjectsTool } from './schema/list-business-objects.js';
import { createObjectGate } from './shared/object-gate.js';
import { createActionGate } from './shared/action-gate.js';
import { createActAsTool } from './identity/act-as.js';
import { switchRoleTool } from './identity/switch-role.js';
import type { ToolDefinition } from './tool-definition.js';
import { audienceFor } from './audience.js';

export interface ToolContext {
  serverName: string;
  serverVersion: string;
  logger: Logger;
  /** Absent when no tenant is configured: the Ivanti tools then do not exist at all. */
  ivanti?: IvantiConnection;
  /** The licence check, which `get_version` reports (design §9f). */
  licence?: LicenceCheck;
}

/**
 * Decides which tools exist for a given audience.
 *
 * Narrowing happens here, at registration, rather than inside handlers: a tool that is
 * not registered never appears in `tools/list`, so the model cannot call it at all.
 */
export function selectTools(config: Config, context: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [createGetVersionTool(context)];

  if (context.ivanti === undefined) return tools;

  const actions = createActionGate(config);
  const audience = audienceFor(config, context.ivanti.capability.tier, actions.allowed.length);

  const deps = {
    connection: context.ivanti,
    gate: createObjectGate(config),
    logger: context.logger,
    ownRecordsOnly: audience.ownRecordsOnly,
    actions,
    auditNote: config.WRITE_AUDIT_NOTE === 'required',
  };

  // Who the conversation is helping. First in both modes, and in `enduser` the gate every record
  // tool below stands behind.
  tools.push(createActAsTool(deps));

  // `full` only. `enduser` opens the self-service role ENDUSER_ROLE names and stays there — a
  // tool that could change it would undo the one thing that makes that mode end-user. Deciding
  // it here rather than inside the handler means it never appears in `tools/list` at all.
  if (audience.switchRole) tools.push(switchRoleTool(deps));

  // Reads first: they need no session and work with any key role.
  tools.push(
    createListBusinessObjectsTool(deps),
    createGetObjectMetadataTool(deps),
    createGetRecordTool(deps),
    createListRecordsTool(deps),
    createCountRecordsTool(deps),
    createGetRelatedRecordsTool(deps),
    createFulltextSearchObjectTool(deps),
    createGetServiceRequestParametersTool(deps),
    createGetServiceRequestParameterOptionsTool(deps),
    createGetAttachmentDetailsTool(deps),
    // The retrievable pair: a connector that lacks either one is marked as not implementing
    // retrieval, and some clients then hide every other tool on it.
    createSearchTool(deps),
    createFetchTool(deps),
  );

  // "Assigned to me" is a staff question: it asks who is *working* a record, where an end user
  // only ever asks who it is *for*. Scoping it would not make it meaningful.
  if (audience.assignedWork) tools.push(createListAssignedWorkTool(deps));

  // Need the ASMX session: all of these live on a workspace or a create form, which OData
  // cannot see.
  if (audience.sessionTools) {
    tools.push(
      createGetPickListValuesTool(deps),
      createGetPickListConstraintsTool(deps),
      createGetLinkFieldsTool(deps),
      createGroupCountTool(deps),
    );

    // The tenant's own procedures — closing, reopening, cancelling. An end user gets them only
    // where the deployment named which ones (`ENDUSER_QUICK_ACTIONS`), and only on their own
    // records; `full` gets the whole surface. This is the general mechanism rather than a
    // close/reopen tool: the verbs are the tenant's, and their names are tenant text.
    if (audience.quickActions) {
      tools.push(
        createListQuickActionsTool(deps),
        createPreviewQuickActionTool(deps),
        createRunQuickActionTool(deps),
      );
    }

    // Staff surfaces, all of which answer across everyone or for the service account. A saved
    // search called "My …" records *this server's* account, so presenting one to an end user as
    // their own would be a lie the model could not detect.
    if (audience.staffSurfaces) {
      tools.push(
        createListSavedSearchesTool(deps),
        createSavedSearchTool(deps),
        createPreviewDeleteTool(deps),
      );
    }
  }

  // An end user may raise a ticket on an allowlisted object; the gate holds which objects, and
  // `ownershipFields` makes the ticket theirs.
  tools.push(createCreateRecordTool(deps));

  // Approvals are read, never cast: a vote would be recorded as this server's service account
  // rather than as the approver. See the tool for why that is not a gap worth closing.
  tools.push(createListApprovalsTool(deps));

  // Casting one needs the session, because the decision travels as a quick action on the vote
  // row — the only form of it that records the approver rather than this server's account.
  if (audience.sessionTools) tools.push(createVoteOnApprovalTool(deps));

  // The knowledge base, reached only through here: the allowlist can say which objects but not
  // which rows of one, and the audience rule here is a row filter.
  tools.push(createSearchKnowledgeTool(deps));

  // Notes, reached through the record they are on rather than by naming the note object — so
  // the allowlist keeps meaning "these tickets" and a note follows its ticket's ownership.
  tools.push(createListNotesTool(deps), createAddNoteTool(deps));

  // The service catalog. Both need to know who the request is for, which `act_as` supplies in
  // either mode — so they are registered in both.
  tools.push(createListRequestOfferingsTool(deps), createSubmitServiceRequestTool(deps));

  // Attaching a file to a record, and removing one. Both gate on the record the file hangs off
  // rather than on the attachment table, so an end user reaches only their own.
  tools.push(
    createUploadAttachmentTool(deps),
    createDownloadAttachmentTool(deps),
    createDeleteAttachmentTool(deps),
  );

  // Editing and deleting are now safe in `enduser` too: both read the record first and refuse one
  // that is not the caller's. Linking is not — `unlink_records` on a Contains relationship
  // severs a *third* record from its parent, which no ownership check on the two named records
  // would catch.
  tools.push(createUpdateRecordTool(deps), createDeleteRecordTool(deps));

  if (audience.linking) {
    tools.push(createLinkRecordsTool(deps), createUnlinkRecordsTool(deps));
  }

  return tools;
}

