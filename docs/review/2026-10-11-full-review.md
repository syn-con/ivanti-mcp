# Full code review — 11 October 2026

Against `01a8d23` (v0.3.3). The previous review was against `4807b1d` (v0.2.5); 154 files in `src/`
changed between them (13,062 insertions, 906 deletions) — the form-context and subtype work, the
catalog, the quick-action and approval tools, `exchange()`, the OAuth verifier and the HTTP session
manager among them.

## What was run

Thirteen finders: seven by area — the HTTP and auth surface; configuration and server; the Ivanti
HTTP, OData and metadata layer; identity and Ivanti sessions; every write path; the tool framework
and read tools; scripts, chart and docs — and six cross-cutting: dead code, DRY, SRP and layering,
TypeScript, hardcoded values and env wiring, security. Each read the source rather than the docs'
account of it and tried to refute its own findings before reporting. A merge combined duplicates
(the corroboration is noted per finding).

Every **high and medium** finding then went to one verifier, briefed to refute it first and then to
reproduce it; every survivor got a fix-correctness pass, whose `revisedFix` and class-not-instance
notes are used below. **Low findings were not verified** and are listed at the end as raised. There
was no gap round. Verification refuted nothing, but it moved several claims down (a medium to low in
four places) and found the proposed fix wrong in four (noted where it applies).

**Baseline.** `pnpm lint`, `pnpm typecheck`, `pnpm test` (**1,538 tests in 127 files**, 2.42 s) and
`pnpm build` pass. Coverage is 93.84 % statements, 85.01 % branches, 91.98 % functions, 94.93 %
lines. `pnpm audit --prod` reports nothing; `pnpm audit` reports one dev-only high
(`source-map-js` <1.2.2, GHSA-68fv-2mgg-jv7q, via `@vitest/coverage-v8>magicast`; not in the
production tree). `handbook:check`, `version:check` (0.3.3), `check:examples` (10 configurations)
and `scripts/check-chart.mjs` (helm 4.3.0, all 46 cases) pass. `pnpm budget`: the `full` manifest
sits at 37,985 of 38,000 characters (41 tools, longest `run_quick_action` 1,948); instructions at
most 1,963 of 2,000. `pnpm manifest:size`: 70,731 characters per request for `full`/`admin`
(manifest 68,801 + instructions 1,930), 62,277 for `enduser`; dearest tool `submit_service_request`
at 4,359. The tree is 163 source files (24,594 lines) and 22,298 lines of tests. Everything below
is something a green build does not catch.

## How to read it

The same scale as the previous reviews — severity is what a user or operator actually experiences:

| | |
|---|---|
| **high** | wrong data, or a silently failed write, that someone would act on; or a stated control that does not hold |
| **medium** | a real defect with a narrow trigger, or a loud failure in a case that should have been quiet |
| **low** | hygiene, a misleading message, a test that does not test what it says |

Counts: **1 high, 24 medium, 15 low** confirmed (40), plus 22 low findings not verified. Four
shapes recur:

1. **Two conversions of the same name.** The AdminUI object id is built one way in
   `form-context` and another everywhere else (1); the name narrowing in `act_as` ignores whether
   the records are one person (2); a validated field is compared exactly where the server never
   resolved its spelling (7); quick-action answers are looked up case-sensitively and unmatched
   keys dropped (8); loopback is defined three ways (40).
2. **"No answer" reported as a fact.** A transient `$metadata` failure becomes "no such object"
   (13); a swallowed secondary read becomes a confident partial answer (14); a failed sample is
   cached as "no person link" (4); a refused read-back after a successful POST is "nothing was
   changed" (12); a timeout on a create is rewrapped as a base-type refusal (6).
3. **A write or a control nobody reads back or runs.** The enduser ownership stamp (5);
   unlink and association link (9); a truncated base64 upload (10); the enduser Published filter,
   the action allowlist deny path and the listener's Origin check, none executed by any test
   (24, 25).
4. **A hand-kept mirror of something the code defines.** The chart against `validateConfig` (22),
   the handbook's default column against the schema (23), the `3000` literal against `MCP_PORT`
   (29), the chart against `envSchema` (28), the instructions and resource text against the tools
   (35). Each was true when written; none has a check that compares it.

---

## High

### 1. `form-context` builds the AdminUI object id its own way, so no subtype ever matches its workspace and subtypes get no form

`src/ivanti/session/form-context.ts:127`; also `entity-names.ts:89-98`, `workspaces.ts:76`,
`validated-write.ts:192-195`, `subtypes.ts:26`. **Reproduced.** Found by the Ivanti-transport and
DRY finders.

`createFormContext.resolve` builds the workspace key as
`` `${toCsdlEntity(entityRef).replace(/__/g, '#')}#`.replace(/##$/, '#') `` — `Task#Assignment#`;
the `##` replace never fires because `toCsdlEntity` already strips a trailing `#`. Workspaces keep
Ivanti's `Base#Sub`, and `servesEntity` splits on `#` (`entity-names.ts:96-97`), so a subtype never
equals its workspace id and never passes as its base. All fifteen `forms.get` call sites pass
`toObjectId(entity.name)`, whose own doc says a subtype keeps no trailing hash. Executed:
`task__assignment`, `ci__computer`, `ci__service` all give `servedByFormContext = []`; only
`Incident#` matches. `form-context.test.ts` has no subtype case. `docs/notes.md:525` records
`Task#Assignment` as having "no admin form" — plausibly this bug seen through the tool.

**Cost.** Form-based controls — validated fields, required rules, pick lists, link fields,
quick-action forms — switch off silently for every subtype. `create_record` on `Task__Assignments`
with a validated field logs "no form … writing as sent": the value goes out with no `_Valid`
companion, and if the stored text matches the read-back passes, so the write is reported confirmed
with the option identifier missing. `get_pick_list_values`, `get_pick_list_constraints` and
`get_link_fields` answer "no create form this role can reach"; `preview`/`run_quick_action` refuse
"this role has no form for it".

**Fix.** One conversion. Move `toObjectId` beside `toCsdlEntity` in `entity-names.ts` (keep a
re-export from `validated-write.ts` to limit churn), use it at `form-context.ts:127` and the cache
key at `:214`, and make `servesEntity` normalise both sides (lowercase, strip one trailing `#`) so a
trailing-hash difference cannot recur: a named subtype matches exactly, a base matches any
workspace with the same first segment. Fix `subtypes.ts:26` to take a CSDL name — `toCsdlEntity`
strips a real trailing `s` from `ci__address`. Re-measure the `notes.md:525` claim and keep it only
if a live probe still shows no form.
Class, not instance: hand-rolled conversions between CSDL names, entity sets and AdminUI ids that
disagree about the trailing `#` (the five sites above).
Tests that fail on the old code: `entity-names.test.ts` — `servesEntity(toObjectId('task__assignment'), 'Task#Assignment')`
is true (and `'task#assignment'`, `'task#'` guard cases stay false); `form-context.test.ts` — a
`CI#Computer` workspace row resolves a form and `GetWorkspaceData` receives `CI#Computer`;
`validated-write.test.ts` — a subtype create with a validated field produces a `_Valid` companion;
`subtypes.test.ts` — `findSubtypes(['ci__address','ci__address__x'], 'ci__address')` finds the
subtype.

Corroboration: Ivanti-transport, DRY. Reproduced (the verifier ran the expression in isolation; the
downstream tool consequences were read, not driven).

---

## Medium

### 2. `act_as` silently pins the one Active record among different people

`src/tools/identity/act-as.ts:214-215`. **Reproduced.**

The narrowing meant for duplicate records of one person is applied to every multi-way match:
`const active = named.filter((c) => statusProblem(c) === undefined); const narrowed = named.length > 1 && active.length === 1 ? active : named;`.
`sharesAKey` (line 61) is consulted only for the wording at `:234`. `act_as('John')` with
`[John Smith, Active]` and `[John Davis, New]` returned `pinned: true, actingFor: John Smith`.
`initial-design.md` §5: "Several → the person chooses."

**Failure.** Enduser: a new hire (Status New) says "I'm John"; the server pins the other John and
every record tool answers with his tickets, with no `question`. A Terminated asker becomes someone
else instead of being refused.

**Fix** (the original "drop only `refuse`" was judged wrong — a stale duplicate can carry any
non-active status). Add `sharesKeyWith(a, b)` (same lowercased login or email) and rewrite
`sharesAKey` on it. Collapse all-or-nothing:
`const survivor = named.length > 1 && active.length === 1 ? active[0] : undefined; const narrowed = survivor !== undefined && named.every((c) => c === survivor || sharesKeyWith(c, survivor)) ? [survivor] : named;`.
Update the comment at `:208-213`. No change to `statusProblem`, the `refuse` check at `:241` or the
verified path.
Tests (`act-as.test.ts`, beside the line-296 case): two different people, one Active one New →
`pinned:false`, both in `matches`; same with the other Terminated → asks; two records sharing a
login, the old one On Leave → still pins the Active one; the existing Terminated-duplicate test
keeps passing. The first two fail on the old code.

Corroboration: session-identity. Reproduced.

### 3. Blind-role fallback misreports Ivanti's active role as "configured" and skips the note

`src/ivanti/session/impersonated-session.ts:290`, `roles.ts:277`. Not reproduced; traced.

`chosenByConfiguration = choice.note === undefined`, but `chooseRole` also returns no note when it
keeps whatever role Ivanti made active in full mode (`:277`). With `GetUserData` permanently
refusing, roles come from `GetRolesForUser` with no flags, so `selfService` is undefined and the
second pass is skipped (`:325-332`), logging "the configured role matched" and omitting the blind
warning and `roleNote` (`:333-349`).

**Failure.** `MCP_MODE=full`, no `IVANTI_IMPERSONATION_ROLE`, an account whose active role is
SelfService and whose `GetUserData` 500s: `act_as` reports the role with no note and the staff
conversation reads zero incidents with full confidence — what `impersonation-plan.md` §8 exists to
prevent.

**Fix.** `chooseRole` returns `basis: 'configured' | 'active' | 'flag' | 'order' | 'only'` (seven
return sites); `chosenByConfiguration = choice.basis === 'configured'`. The blind note needs its
own wording for `'active'` ("Ivanti made X active and would not report which of this person's roles
are self-service … set `IVANTI_IMPERSONATION_ROLE`"); the existing text says the role came from the
list order, which is false there.
Tests: `impersonated-session.test.ts` — full mode, no pinned role, ActiveRole SelfService,
`GetUserData` failing permanently, flagless `GetRolesForUser` → `roleNote` present and the warning
fires (fails on old code); a pinned-role control still has no note; `roles.test.ts` — update the
`toEqual` assertions at `:89`/`:133` for the new field.

Corroboration: session-identity. Not reproduced.

### 4. `customer-link` caches `undefined` ("no person link") after a failed sample when the prefix is off the name ladder

`src/ivanti/people/customer-link.ts:173`. **Reproduced.**

The sampling read failing is caught into `rows = []`, `sampleFailed = true` (`:135-142`); then
`named === undefined → return undefined` at `:169-173` carries no marker, and `forEntity` (`:197`)
evicts only when `link?.foundBy === 'name' && link.sampleFailed`. The 2026-09-14 fix (finding 38)
missed this branch. Executed: entity `hrcase` with `ReporterLink_RecID/_Category`, one 503 then rows
→ both calls `undefined`, one read. The warn at `:136` says "falling back to the name ladder", which
did not happen.

**Failure.** Enduser with an allowlisted HR object whose person link is `ReporterLink`/
`EmployeeLink`: one 5xx on the ten-row sample at first use and every scoped read and write throws
`UnscopableObjectError` ("no person link") until restart.

**Fix.** `discover` returns `{ link, sampleFailed }`; `forEntity` evicts whenever `sampleFailed`,
whatever `link` is. Evict-and-return is smaller than throwing and needs no caller edits; fix the
warn text. The genuine-absence path (`candidates.length === 0`, no sample) stays cached.
Tests (`customer-link.test.ts`, beside "samples again", line 140): `ReporterLink` entity, one 503
then rows with category `Employee` → second call returns `foundBy 'data'`, reads is 2 (fails on old
code); companion: no failure, no hit, off-ladder prefix → still cached, reads is 1.
Class: an answer derived from a failed read cached for the process lifetime; `grep -rn "\.catch(" src/ivanti`
was not audited for others.

Corroboration: session-identity. Reproduced.

### 5. `create_record` never reads back the enduser ownership stamp and reports `filedFor` from the pin, not the record

`src/tools/records/create-record.ts:172` (also `:130`, `:185-193`), `own-records.ts:147-176`. Reproduced
by the finder, not by the verifier.

The customer-link pair and `CreatedBy` stamped by enduser mode are merged into the POST body
(`:130`) but excluded from `confirmWrite`'s `written` (`:167-176`, `written: fields`), and
`filedFor` is `context.pin?.person()?.displayName` (`:190`). `sessionStampedFields` reads the POST
echo that `:195-196` itself calls unreliable. Contrast `submit-service-request.ts:308-321`, which
reads `filedFor` off the record. Scratch run: read-back holds `ProfileLink_RecID: 'SVC-ACCOUNT'`
while the stamp sent `E1`; the tool answered `filedFor: 'Harold Sanders'` with no error.

**Failure.** A tenant rule that sets the customer from the session stores the service account; the
tool reports success filed for the person; every later `update_record`, `add_note` or
`upload_attachment` refuses "No such record is available to you" and `list_records` never shows it.

**Fix.** `written: { ...fields, ...owner }` (compare folds case, so `e1` vs `E1` and `employee` vs
`Employee` do not false-fail; `CreatedBy` lands in `ignoredByIvanti`). Derive `filedFor` from the
stored link field only when the read-back returned it and it matches; otherwise omit it. Export the
field names from `own-records.ts` instead of relying on key order. Enduser-specific error suffix:
the record exists, is not the person's, and they cannot edit it. Optionally read
`stampedFromTheSession` from `readBack.stored ?? created`.
Tests (`writes.test.ts`, "the fields that say whose record it is, in enduser"): read-back with
`ProfileLink_RecID: 'SVC-ACCOUNT'` → `isError` and the text names the field (fails on old code);
`'e1'`/`'employee'` → success with `filedFor`; link fields omitted → success, no `filedFor`,
`notConfirmed` lists them; `CreatedBy: 'svc'` → success with `ignoredByIvanti.CreatedBy`.
Same-class follow-ups: `submit_service_request` falls back to the RecId and does not fail on a
mismatch; `sessionStampedFields` reads the POST echo. Live check through `ivanti-http` before
release (the stored RecId's format).

Corroboration: writes. Not reproduced by the verifier.

### 6. `create_record` rewrites every POST failure on an object with subtypes as a base-type refusal

`src/tools/records/create-record.ts:135` (`:133-144`), `subtypes.ts:25-32`, `run-tool.ts:199-218`.
Not reproduced; the finder's scratch run matches the reading.

The `.catch` is unconditional on the error kind: whenever `findSubtypes` finds any `<base>__`
sibling the `IvantiApiError` becomes a plain `Error` ("X is a base type … create one of these
instead (Ivanti refused this create: …)"). `runTool` then logs it as `tool failed`, and the
"MAY HAVE TAKEN EFFECT" wording, `notePersonRefused` and the display-name translation are all lost.
Scratch: `journal` + `journal__notes`, POST status 0 → the base-type message. `notes.ts:22-24`
says creating on `journal` works; only Task was measured uncreatable (`notes.md:576-581`).
`writes.test.ts:555-571` covers only the 500-with-empty-body case.

**Failure.** A create on Journals past the 30 s write timeout is reported as refused with advice to
create a subtype — the retry-after-timeout incident the 2026-09-29 review's finding 4 fixed,
reopened for every object with subtypes. A 401 on the impersonated session skips renewal.

**Fix.** A shared predicate next to `findSubtypes`:
`isBaseTypeRefusal(error) = error instanceof IvantiApiError && error.status === 500 && error.body.trim() === ''`.
Look up subtypes only after it passes (also saves the `entityNames` + `admin.list` round trip on
every unrelated failure); rethrow everything else as the original error into the existing
`explainRequiredFields` / `explainFieldError` path. Reword `notes.md:576-581` to "a create refused
with an empty 500".
Tests (`writes.test.ts`, beside line 555): `journal`/`journal__notes`, POST status 0 → error text
carries "may have been applied" and not "base type" (fails on old code); 500 with a body → "Ivanti
refused the request (500)"; 401 `person` → `notePersonRefused`; 400 required-field → names the field.
Class: `throw new Error(` inside a `.catch(` over an `IvantiApiError`; only this instance in a write path.

Corroboration: writes. Not reproduced by the verifier.

### 7. A validated field the role's form does not carry is compared exactly, so a re-cased stored value is reported as not stored

`src/ivanti/write/validated-write.ts:277` (`:279-284`, `:461-463`), `compare-stored.ts:7-8`. Not
reproduced by the verifier.

On the unresolved paths `confirm` holds the caller's raw value (`:277`) and the read-back compares
exactly and case-sensitively, while `compare-stored.ts` justifies exactness with "this server
resolved that spelling itself" — false there. Free fields are case-folded (`:98-99`) and Ivanti's
lists match case-insensitively (`:316`). Scratch: `{Status:'active'}`, no workspaces, read-back
`'Active'` → `WriteNotStoredError` "usually a stale option list — re-read it". A third path the
finding did not list: on-form fields whose list is missing or not validated hit the `continue`
(~`:316`) in an otherwise resolved write.

**Failure.** A write Ivanti stored is reported as failed and logged at error; a model that re-sends
issues a no-op PATCH that re-runs the tenant's workflow mail (`update-record.ts:46-51`).

**Fix.** In the confirm loop branch on membership in the resolved values, not on the code path:
resolved entries compare exactly (so a wrong RecId/label swap is still caught); the rest use
`compareStored(intended, got, type)` — `'different'` fails, `'incomparable'` goes to `notConfirmed`.
Correct the `compare-stored.ts` header.
Tests (`validated-write.test.ts`, `confirmWrite`): no form, `confirm {Status:'active'}`, stored
`'Active'` → passes (old code throws); stored `'Logged'` → throws with `resolved:false`; field absent
from a non-empty form, re-cased → passes; mixed write — resolved field stored in a different case
still fails exactly, unresolved re-cased passes.

Corroboration: writes. Not reproduced by the verifier.

### 8. `run_quick_action` silently drops answers whose key matches no prompt, and matches prompt names case-sensitively

`src/tools/quick-actions/run-quick-action.ts:148` (`:131-137`). Not reproduced by the verifier.

`answers[prompt.FieldName]` is the only lookup; no reverse check. A mis-cased or unknown key is
ignored, the action commits without it, and the tool answers `ran: true`. Only Required, unanswered
prompts are refused. Scratch: prompt `Notes` (not required), `answers: { notes: …, Nonexistent: 'x' }`
→ committed `Value: null`, `{ran:true, saved:true}`. The same happens for a required prompt that
already has a default `Value`. `quick-actions.test.ts:184-198` covers only a missing required answer.

**Failure.** The comment, reassignment or resolution the person supplied is never sent and the
action is narrated as done with it — the silent-drop class the 2026-09-29 review fixed for
`update_record` (its finding 5). A mis-cased key for a required prompt gets a misleading
"unanswered" refusal.

**Fix.** A pure `settleAnswers(prompts, answers)` in `tools/quick-actions/answers.ts`, run before the
required check: resolve keys case-insensitively to the probe's spelling (the `knownFields` pattern),
refuse an unmatched key naming it and the available prompts ("Nothing was run."), refuse two keys
differing only by case, and refuse any answer when the probe returned no prompts. Hidden prompts
still fill. Any `answers` wording change needs `pnpm handbook:sync`.
Tests (`quick-actions.test.ts` plus a new `answers.test.ts`): `{ notes: 'x' }` against `Notes` → the
commit carries `Value: 'x'` (old code commits null); `{ Nonexistent: 'x' }` → `isError`, names both,
no `shouldSave:true` call; required `Note` answered as `note` succeeds; `Notes` and `notes` together
refused. Check `submit_service_request`'s `answers` for the same shape (not verified).

Corroboration: writes. Not reproduced by the verifier.

### 9. Relationship writes and quick actions report success from Ivanti's reply alone

`src/tools/relationships/unlink-records.ts:88`, `link-records.ts:238-275`,
`run-quick-action.ts:169-190`. Not run; the verifier found no observed case of Ivanti ignoring an
unlink.

`unlink_records` and `link_records` on a non-Contains relationship judge success from
`code === 'ISM_2000'` in a 200 although `link-records.ts` itself says that code "is not evidence";
the related-rows read happens before the write, never after. The read-back at `:250-271` runs only
`if (child?.kind === 'free' && target !== undefined)`. `run_quick_action` reports `ran: true, saved`
and its description (`:36-39`) delegates the read-back to the model. `CLAUDE.md`: "every write is read
back".

**Fix** (revised). Extract one shared membership helper (`relationships/membership.ts`) used by the
before-read and a new after-read in `unlink_records` and in `link_records` for every non-free case;
fail with "Ivanti answered ISM_2000 but <target> is still linked / not linked"; an after-read that
itself fails reports "accepted but not confirmed — check with `get_related_records`", never success.
For `run_quick_action`, do **not** key on `LastModDateTime` and do not make it an error: many
legitimate actions (email, create-child) leave the parent untouched, and `recordChanged:false` would
read as "nothing happened" and cause a retry that re-sends the email. Read the record before and
after, report a neutral `changedFields: [names]` (names only, never values), best-effort. Use
`transportFor(context)` for both. Shorten the `saved: true` description paragraph to pay for it; run
`pnpm budget`, `handbook:sync`, `manifest:size --compare`.
Tests (`relationships.test.ts`): unlink where the second GET still lists the target → `isError`,
"still linked"; second GET omits it → `unlinked`; second GET rejects → "not confirmed"; association
link with the second GET lacking the target → `isError`. `quick-actions.test.ts`: identical
before/after → no `changedFields`; a differing field → named.
Risks: +1 request per link/unlink, +2 per quick action; completeness of the related-rows read on a
high-cardinality relationship and read-after-write lag must be measured live.

Corroboration: writes. Not reproduced.

### 10. Attachment base64 is decoded leniently, so a garbled argument uploads a truncated file reported as attached

`src/tools/attachments/upload-attachment.ts:113`, `submit-service-request.ts:239-245`. **Reproduced**
(decode behaviour only).

`Buffer.from(text, 'base64')` never throws and stops at the first invalid character, so the only
checks (empty, size cap) pass a truncated payload and the surrounding `catch` is unreachable — its
own comment (`:118-119`) says as much. `Buffer.from('aGVsbG8=!!!d29ybGQ=','base64').toString()` →
`'hello'`. `submit_service_request` decodes the same way with no catch.

**Failure.** One stray character uploads the prefix as the whole file; `attached: true`; the service
desk opens a truncated screenshot or log.

**Fix.** `src/tools/shared/decode-base64.ts` exporting `decodeBase64Argument(text): Buffer | undefined`:
strip ASCII whitespace, decide url-safe/unpadded tolerance deliberately, validate against
`/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/` (the length-arithmetic check in
the finding is fragile), refuse a `data:` prefix with a pointed message, run the size cap on string
length before the regex. Delete the dead `catch`; in `submit_service_request` decode inside the
decode-all-first loop so "nothing reached the tenant" still holds.
Tests: `decode-base64.test.ts` (`'aGVsbG8=!!!d29ybGQ='` → undefined; valid and line-wrapped accepted;
`'abc$'` rejected); `upload-attachment.test.ts` — the garbled value → `isError` "not valid base64",
transport never called (old code uploads `hello`); `submit-service-request.test.ts` — one garbled
attachment of two → "Nothing was submitted", no staging calls.

Corroboration: writes. Reproduced (decode).

### 11. Tenant UTC offset is read off any string field ending in ±HH:MM, unbounded, and memoised for the process

`src/ivanti/service-request/tenant-offset.ts:45` (`:30`, `:44-58`, `:92-101`). Not reproduced by the
verifier; whether `Subject` precedes `LastModDateTime` in live JSON is unmeasured.

`parseOffset` scans every string field of the newest row and returns the first whose last six
characters match `[+-]\d{2}:\d{2}$`, with no datetime-shape or range check. Scratch: `Subject: 'Outage
window 09:00-12:30'` → `{ minutes: -750, observedAt: 'Outage window 09:00-12:30' }`. The test
decoy is only `Subject: 'Laptop'`. `notes.md:1070-1075` measured that a wrong-sign offset stores
`0001-01-01` while reporting success.

**Failure.** `submit_service_request` sends a wrong `localOffset` for every dated answer until
restart — a destroyed or 12.5 h-shifted date; `verifyStoredAnswers` undoes the same wrong offset and
calls it correct. `get_service_request_parameters` shifts displayed days the same way.

**Fix.** Anchor to `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?([+-])(\d{2}):(\d{2})$`; reject
hours > 14 or minutes ≥ 60 and export the 14 h limit as one shared constant that
`compare-stored.ts:25` derives from; try `LastModDateTime`, then `CreatedDateTime`, then any other
passing field; return `undefined` and log when none qualifies; do not memoise `undefined`
(`found ??= discover()` keeps one transient failure until restart).
Tests (`tenant-offset.test.ts`): decoy `Subject` plus `LastModDateTime …+02:00` → 120 (old code −750);
`+99:99` → undefined; decoy only → undefined; a failing first `get()` then a valid row → the second
call returns the offset; fractional seconds and `+05:45` still accepted.

Corroboration: writes, TypeScript. Not reproduced by the verifier.

### 12. `runTool` reports a request the limiter refused as "Nothing was changed" even when it was the read-back after a successful POST

`src/tools/shared/run-tool.ts:188`, `create-record.ts:167`, `validated-write.ts:428`,
`request-limiter.ts:21`. Not run.

The wording at `run-tool.ts:188-191` ("Nothing was changed. Try again in a moment.") is justified
for one request but spoken about the whole call. A `create_record` POST can succeed and the
`confirmWrite` GET then wait out the limiter and fail with `IvantiBusyError`.

**Failure.** Sixteen slots full for the write-timeout window: the POST succeeds, the confirm GET is
refused; the model reads "Nothing was changed" and files the ticket again — the duplicate-create
incident the 2026-09-29 finding 4 fixed for status 0/502/504, reopened through the limiter. The same
holds for any read-back failure after a write (0/502/504 → `noAnswer`'s "trying once more is safe";
4xx/5xx → "refused the request").

**Fix.** At the source, not in the wording: add `WriteUnconfirmedError` next to `WriteNotStoredError`
(entity set, RecId, `cause`; status and code only, never an echoed body), wrap **only** the
read-back `transport.request` in `confirmWrite`, and give `runTool` a branch beside
`WriteNotStoredError`: "the write was sent and accepted, but reading it back failed, so whether every
value took is unknown — read the record before doing anything else; do not repeat the write."
Keep the busy wording for a first request. Applies to `create_record` and `update_record`; audit
`add_note`, `link_records`, `unlink_records`, `vote_on_approval`, upload for the same shape.
Tests (`validated-write.test.ts`): a `request` rejecting with `IvantiBusyError`, then status 0, then
504 → `WriteUnconfirmedError`; `run-tool.test.ts`: the text contains "do not repeat" and neither
"Nothing was changed" nor "Trying once more is safe"; `create-record.test.ts` / `update-record.test.ts`:
POST resolves, GET rejects busy → no "Nothing was changed", RecId named.

Corroboration: tool-framework. Not reproduced.

### 13. The catalog turns a transient `$metadata` failure into "Ivanti has no Business Object named X", and remembers any unlisted 4xx as absence for the process lifetime

`src/ivanti/metadata/catalog.ts:122` (`:107-109`, `:158`, `:286`). **Reproduced on `dist`** by the
finder; not re-run by the verifier.

`fetchDocument()` collapses a retryable failure (status 0, 5xx, 401/403/429) into the same
`undefined` as a definitive miss, so `entity()` throws `UnknownEntityError` and `widen()`/
`entityNames()` silently answer a narrower tenant. Because "retryable" is a status denylist, a
404/400/408/405/409/410 is cached as "no such entity" forever, although the measured answer for an
unknown entity is a 200 with a field-less CSDL (`notes.md:673-676`; 404 `ISM_4004` only for disabled
service-root forms, `:799-801`). `catalog.test.ts:261-271` pins the defect.

**Failure.** During an app-pool recycle the model is told an external contact object does not exist;
`personObjects()` is memoised as `['employee']` until restart (the outcome the 2026-09-14 #19 was
closed against); at startup one 503 refuses to start with a message about `ENDUSER_BUSINESS_OBJECTS`;
an ingress answering 404 during a deploy makes `journal__notes` "no such object" until restart.

**Fix.** `fetchDocument` returns `{kind:'document'} | {kind:'missing'} | {kind:'unavailable', cause}`.
Only a CSDL-shaped 200 with no fielded type is `missing` (the one cached negative); every thrown
error or non-CSDL body is `unavailable` and is evicted. `entity()` collects failures across the seed,
the candidate graphs and the singular-correction fetch; if nothing is found and any fetch was
unavailable it throws a new `MetadataUnavailableError` (not `UnknownEntityError`, no suggestions
pass). `widen()` returns failed graphs and an `entityNamesDetailed(): {names, incomplete}` lets
`list_business_objects` say N graphs could not be read. `runTool` renders it as "could not be read;
nothing changed, try again". Consumers need no edit: `directory.ts:190` already rethrows and resets,
`validate-allowlist.ts:34` already ignores non-Unknown errors, `link-records.ts:55` rethrows. Add a
`notes.md` trap entry. If a live tenant is found to 404 typos, add a narrow uncached rule for a
404 carrying a real Ivanti code — do not restore the denylist.
Tests (`catalog.test.ts`, rewriting `:261-271`): 503/429/401/403/status 0/TypeError →
`MetadataUnavailableError`, and a later call after recovery resolves; 404/400/408/405/410 → first
call unavailable, second resolves, two fetches (old code: second still `UnknownEntityError`, one
fetch); `widen()` with 3 of 8 graphs failing → `incomplete`; a field-less 200 is still cached as a
miss; `directory.test.ts`: an unavailable graph does not memoise `['employee']`.

Corroboration: Ivanti-transport (raised twice, merged). Reproduced by the finder.

### 14. A swallowed secondary read is narrated as a fact (class, nine-plus instances)

`src/tools/records/group-count.ts:179`, `get-link-fields.ts:85`, `get-object-metadata.ts:54`/`:137`,
`shared/object-names.ts:16`, `list-approvals.ts:211-218`, `search-knowledge.ts:77-97`,
`get-service-request-parameters.ts:200`, `preview-delete.ts:85`, `submit-service-request.ts:315-321`/`:380`,
`shared/find-person.ts:42`. Not reproduced; the verifier did not check the "no catch branch is
covered" claim against `coverage-final.json`.

Handlers wrap a secondary read in `.catch(() => [] | undefined | {})` and emit text or omit keys as
if it had succeeded. `group_count` drops `total`/`unaccounted` with no `partial` under a comment
saying "a missing key cannot be told from not computed" (26 parallel reads against the default
16-request cap); `get_link_fields` says a link "was simply unset on all N rows sampled";
`get_object_metadata`'s `formFacts` turns any failure into "No field … carries a label this role can
see" **and swallows a person-session 401 before `runTool` can note it** — `notePersonRefused()` is
called only from `run-tool.ts:74`, so the impersonated session is not renewed; `list_approvals`
drops `requestedBy` although the doc says "always emitted, null included"; `search_knowledge` has
one sentence for "carries nothing" and "could not be read"; `get_service_request_parameters` says
"the local day" with a swallowed offset and `?? 0`; `preview_delete` swallows every status ≥ 500,
including the 502/504 that `run-tool.ts:257-258` classifies as "did not answer", and answers "no
working delete preview … proceed"; `submit_service_request` puts a RecId under `filedFor`;
`findPerson` turns an outage into "No employee matches … check the spelling". The 2026-09-29 review
fixed the same class in `list_notes` (#18).

**Failure.** Full request cap: 25 exact buckets presented as the whole. Lapsed impersonated session:
the role "has no labels" and the session is not renewed. Outage during `preview_delete`: "no preview,
proceed" and the cascade is never shown. 503 on employees: "No employee matches …".

**Fix** (revised). Triage first — documented benign fallbacks stay (`create-record.ts:114`/`:150`,
`update-record.ts:104`/`:131`, `list-approvals.ts:47`, `list-request-offerings.ts:35`,
`vote-on-approval.ts:187`/`:263`); `link-records.ts:223` is the only one that could change a write
decision and needs a look. A `tryRead(promise) → {ok:true,value} | {ok:false,error}` in
`tools/shared/try-read.ts` that also calls `notePersonRefused()` on a person-credential 401 (extract
that condition from `run-tool.ts:73-75`). Per site, carry the failure into the payload the way
`customer-link.ts:181` (`sampleFailed`) and `vote-on-approval.ts:290` do: `group_count`
`total: null, unaccounted: null, partial: true`; `get_link_fields` `sampleFailed: true`; `formFacts`
rethrows on a person 401 and says "labels could not be read"; `list_approvals` `subjectRead: 'failed'`;
`search_knowledge` splits the note; offset unknown → `displayValueNote`; `submit_service_request`
omits `filedFor` and adds a `recordWarning`; `object-names.ts` returns `known: false` so the "not
creatable" claim is skipped and "could not be checked" added; `findPerson` propagates (check
`act_as`, `list_assigned_work`, `list_approvals` callers first). `preview_delete`: the proposed
"500 + NullReferenceException only" signature is **not recorded** in `notes.md` or the tests —
measure it live first; interim, export `isUnanswered` from `run-tool.ts` and rethrow on it and on
503/429, keeping the swallow for a plain 500. Add an ESLint `no-restricted-syntax` rule on
`.catch(() => <literal>)` under `src/tools` with explicit disables at the benign sites, and a
sibling line to the "never report success from a 200" invariant. `group_count`'s description may
need a clause for `partial`.
Tests, one rejecting read per site: `group-count.test.ts` (503 on the total → `partial: true`, null
total); `get-link-fields.test.ts`; `get-object-metadata.test.ts` (person 401 → no "No field carries a
label", `usage.personRefused`); `find-person.test.ts` (503 propagates); `preview-delete.test.ts` (502
and 504 rethrown, plain 500 still `previewAvailable:false`); a `tryRead` unit test for the 401 flag.

Corroboration: tool-framework, dead-code, TypeScript, writes, SRP, session-identity (seven raw
findings merged). Not reproduced.

### 15. Four tools take the same `filter` argument and apply four different pre-flight checks

`src/tools/search/fulltext-search-object.ts:86` (also `group-count.ts:84`, `list-records.ts:108`,
`count-records.ts:61`, `shared/null-filter.ts:24`). Not run.

`assertNullFilterTypes` and `explainFieldError` exist because Ivanti answers a `$NULL` on a non-text
field and a mistyped field alike with "the field does not exist". `list_records` and `count_records`
apply them; `fulltext_search_object` runs only `assertOrderBy` before a bare `transport.request`;
`group_count` checks only `groupBy`, and a 400 in its fan-out is stringified per bucket (`:155-160`,
sliced to 120 characters).

**Failure.** `fulltext_search_object` with `ScheduledStartDate eq '$NULL'` → "Ivanti refused the
request (400). The record or field does not exist" and the model concludes the field is not real.
`group_count` with `Statuss eq 'Active'` → 25 buckets each carrying the 400, `partial: true`.

**Fix** (revised). A `prepareFilterRead(deps, context, resolved, {filter, orderBy})` in
`shared/read-preflight.ts` — identity first (`requirePerson`), then `assertOrderBy`,
`assertNullFilterTypes`, then `scopeToOwnRecords` (which already runs `assertSupportedFilter`) — and
an `explainReadError` for every `.catch`. Do **not** fold the checks into `scopeToOwnRecords`
itself: `search.ts:95` calls it with no filter and no `orderBy`. `group_count` also needs its
per-bucket catch to run `explainFieldError` on the caller's filter fields only, to stop slicing a
`FieldNameError`, and to rethrow once when every bucket failed with one. Audit the other tools with a
`filter` (`get_related_records`, `list_assigned_work`, `saved_search`, `list_approvals`).
Tests (`read-preflight.test.ts`, table-driven over all four tools): the `$NULL` date filter → the
`FieldNameError` text with zero requests sent; `Statuss` against a 400 → "has no field named
'Statuss' (did you mean: Status?)"; `group_count` returns one refusal, not 25 bucket errors.

Corroboration: tool-framework. Not reproduced.

### 16. The impersonation caveat on a zero is restated at every `zeroNote` call site, and `get_related_records`' own "REAL ZERO" omits it

`src/tools/records/get-related-records.ts:210` (also `shared/zero-note.ts:28-32`, `search.ts:195-206`,
`fulltext-search-object.ts:102`). Not run.

`zero-note.ts` says an impersonated zero is "the weakest of all" (measured 571 rows under one role, 1
under another) and each caller must remember to pass `impersonating`. Five do. `get_related_records`
composes its own "THAT IS A REAL ZERO … not the silent-empty failure" although its read goes through
`transportFor` (`:71`); `search` and `fulltext_search_object` (`noHitsNote`) carry no impersonation
sentence either; `saved-search.ts:56` and `list-saved-searches.ts:56` each re-derive the login.

**Failure.** Full mode with the ConfigDB pair, `act_as` a person whose role cannot see tasks,
`get_related_records` on `IncidentContainsTask`: zero rows and the payload says "a real zero … a
fact about the record" — the "no answer reported as no" shape.

**Fix.** An `impersonatedAs(context)` helper; `zeroNote(zeroContext, call)` reads it itself and the
`impersonating` field is removed from `ZeroContext`, so forgetting becomes a type error;
`noHitsNote(query, call)` appends a short impersonation sentence; route `get_related_records`' zero
(both branches) through `zeroNote`, keeping the "REAL ZERO" text verbatim when not impersonating
(`grep -rn 'REAL ZERO' src` first). Check the other zero-note emitters (`group_count`,
`list_assigned_work`, `list_notes`, `search_knowledge`).
Tests: a new `zero-note.test.ts` (impersonated context → the "NOT THE STRONG KIND OF ZERO" clause and
the login; none → no clause); `get_related_records` zero with an impersonating context does not carry
a bare "REAL ZERO"; `query-words.test.ts` for `noHitsNote`; a structural guard against
`.session()?.loginId` outside the helper.

Corroboration: DRY. Not reproduced; whether Ivanti hides related rows of a visible parent was not
checked.

### 17. The compact-default projection and its note are implemented three times, and `list_records`' copy decides the note by a different predicate than the projection

`src/tools/records/list-records.ts:205` (also `get-related-records.ts:157`/`:224-253`,
`get-record.ts:86`, `search/row-fields.ts:18`, `odata/compact-fields.ts:148`). **Reproduced** (the
function pair, not the handler).

`search/row-fields.ts` decides "compact or fell back" from `compact.fellBack`. `list_records`
projects with `compactFieldsFor(rows, extras)` but decides the note with `compactMissedObject(rows)`,
which ignores schema `extras`. Rows with `Status` and `WorkOrderRef` as extras → `fellBack = false`
with fields `[RecId, Subject, Status, WorkOrderRef]` while `compactMissedObject` returns a list, so
`list_records` emits "THIS OBJECT IS NOT ONE OF THE ONES THE DEFAULT KNOWS" over ordinary compact
rows. `get_related_records` has its own wording ("its own first few fields") and passes no extras, so
its two predicates agree; `ignoredFieldNames` is evaluated three times per response in both tools and
`get_record` re-implements it inline with a third sentence (`ignored-fields.ts:11` notes it).

**Failure.** The model is told the default did not fit and is given fields it already has; two
tools teach different rules about the same payload key.

**Fix.** `shared/compact-rows.ts` from `row-fields.ts`: `compactRows(rows, raw, entity?)` returns
`{fields, defaulted, note?, otherFields?}` from the single `compact.fellBack`. `get_related_records`
passes **no** extras (it holds the parent entity unless a row scope resolves the target; passing the
parent's would offer the wrong schema's fields). Delete `compactMissedObject` or redefine it as
`!compactFieldsFor(...).fellBack`. Compute `ignoredFieldNames` once; `get_record` calls
`ignoredFieldNames([record], fields)`/`ignoredFieldsNote`, unifying the sentence and the `note`/
`fieldsNote` key deliberately. `otherFields` then derives from populated fields. Runtime strings
are asserted in `saved-searches.test.ts:148` and `fulltext-search-object.test.ts:95`.
Tests: `list-records.test.ts` — the Status+WorkOrderRef case yields the compact sentence and no
`otherFields` (fails on old code); a shared-helper test that note and projection agree; a cross-tool
test that the fallback sentence is byte-identical in `list_records` and `get_related_records`.

Corroboration: tool-framework, DRY. Reproduced (function pair).

### 18. Handlers assemble the Ivanti protocol themselves; `ivanti/` offers primitives, not operations — and the copies have diverged

`src/tools/records/preview-delete.ts:59`, `search/saved-search.ts:62`/`:73`, `list-saved-searches.ts:68`,
`knowledge/search-knowledge.ts:88`/`:234`, `delete-record.ts:56`, `update-record.ts:95`,
`ivanti/attachments/upload.ts:259`, `own-records.ts:218`/`:255`/`:396`, `link-records.ts:61`.
Not run. The finding is a bundle; the verifier counted 12 non-test `isIvantiNotFound` sites and 24
tool files using `transport.request`.

The stated rule — `tools/` "never builds a URL or parses a response" — does not describe the code.
Concrete costs today: `saved_search` reads `payload['@odata.count']` raw (`:73`, `:83`) and
disagrees with `readTotal` (`query.ts:63-79`), which accepts numeric strings and marks `total <
rowCount` as `exact:false` (the queries resource promises `totalIsExact`) — a saved search with 25
rows and `@odata.count: 3` is reported `{returned:25,total:3}` and a count of `"548"` is dropped;
`search_knowledge` guesses `${subtypeName}s` for the entity set and hand-quotes literals instead of
`quoteOdataString`; the "treat only Ivanti's not-found as absent" read is copied six times (and the
copy that forgot has been a high finding twice); `assertRecordWritable`'s row is discarded and
re-read (three reads per update, two per delete or upload); `upload.ts:257-260` maps **any** parent
read error to `ParentNotFoundError`, the one divergent copy that is live today (narrow window:
`assertRecordWritable` has just succeeded).

**Fix** (revised — the fix-check judged the big-bang operations layer plus a blanket
`URLSearchParams` guard wrong: it fails 17 files at once). Tier 1: `ivanti/records/read-record.ts`
exporting `readRecordOrAbsent(transport, entitySet, recId)` (not-found and empty body → `undefined`,
everything else rethrows) replacing the six copies and the `upload.ts` `.catch(missingParent)`;
`saved_search` through `readTotal`, emitting `totalIsExact:false`; `quoteOdataString` and a
catalog-resolved entity set in `search-knowledge.ts`; `assertRecordWritable` returns the row and
`delete_record` skips its own pre-read (keep `confirmWrite`'s and the post-write reads fresh;
handle the enduser early-return `undefined`). Tier 2, incremental: move saved-search and
preview-delete payload construction into `ivanti/`, modelled on `ivanti/quick-actions/execute.ts`.
Guard test scoped to the defect class: no file under `src/tools` reads `'@odata.count'` or has a
`.catch(` whose handler calls `isIvantiNotFound` outside the helper.
Tests: `read-record.test.ts` (400 "Invalid key" and empty → undefined; 0/500/502 reject);
`upload.test.ts` (502 on the parent read rejects with that error, 400 still gives
`ParentNotFoundError`); `saved-search.test.ts` (25 rows with count 3 → `total:25, totalIsExact:false`;
`"548"` → 548); `delete-record.test.ts` (one GET before the DELETE).
The hypothetical "a new tool copies delete-record's bare catch" is a future risk; current copies
already filter with `isIvantiNotFound`. Verify 2026-09-14 finding 5 before claiming the others diverged.

Corroboration: SRP, tool-framework, DRY, writes. Not reproduced.

### 19. An ID token verifies as an access token in the configurations the docs recommend

`src/auth/oauth/verify-token.ts:249`. Not run; the verifier did not inspect jose's `typ` option.

`jwtVerify(token, keyResolver, { issuer, audience, requiredClaims: ['exp'], clockTolerance })` —
no `typ`; `OAUTH_REQUIRED_SCOPES` defaults to `[]` (`env-schema.ts:101`) and is enforced only when
non-empty (`:297-307`). `configuration.md:261` and `:325` tell operators to set
`OAUTH_AUDIENCE=<client-id>` for Zitadel and the second IdP, and the Entra one-app recipe (`:106-108`)
produces the same shape, so an OIDC ID token whose `aud` is the client id passes. `grep -rn "at+jwt\|'typ'" src docs`
finds nothing. The earlier refuted "algorithm confusion" concerned crafted headers, not a validly
signed token of the wrong kind.

**Failure.** Zitadel per the docs: a person's ID token (handed to front-ends, kept by SPAs, logged)
replayed as `Authorization: Bearer <id_token>` → `ok: true`, identity pinned from
`preferred_username`; under impersonation Ivanti's session opens as that person.

**Fix** (revised — the original validated-config warning was dropped: empty scopes is the shipped
default, so it would fire on nearly every oauth deployment). (1) An opt-in `OAUTH_REQUIRE_TYP`
(default off) passing `typ: 'at+jwt'` to `jwtVerify`; not for Entra v2 or default Keycloak (both
`JWT`), so recommend it only for IdPs emitting RFC 9068 (Auth0 on API audiences, Okta custom
servers) and tell operators to check their token's `typ` — Zitadel's was not verified. (2) An
always-on `rejectIdToken(header, claims)` after `jwtVerify`: 401 `invalid_token` when `typ` is `ID`/
`id_token` (case-insensitive), or the payload has `nonce`, `at_hash` or `c_hash`, or
`token_use === 'id'`. Partial protection only — an Entra or Zitadel ID token without those claims
still passes — so the docs must name `OAUTH_REQUIRED_SCOPES` (ID tokens carry no `scope`/`scp`) or a
distinct API audience as the complete control, beside `configuration.md:106/261/325` and
`.env.example:202`. Add the key to `env-schema.ts`, `validate-config.ts`, `config.fixture.ts`,
`create-verifier.ts`; confirm `initial-design.md` §10 lists no rejected alternative.
Tests (`verify-token.test.ts`; extend `issueToken` with `typ` and claims): `typ: 'ID'`, `at_hash`,
`nonce`, `token_use: 'id'` → 401 (all pass on old code today); with the flag on, `typ: 'JWT'`
rejected and `at+jwt`/`application/at+jwt` accepted; flag off, a typ-less token still passes;
`create-verifier.test.ts` for the wiring.

Corroboration: HTTP/auth. Not reproduced.

### 20. `WWW-Authenticate` truncation meant for prose is applied to the metadata URL and the scope list

`src/auth/oauth/www-authenticate.ts:26` (`:21-28`, `:47-50`). **Reproduced** (the truncation); the
`invalid_scope` loop at the IdP is inferred, not run.

`headerSafe` ends in `.slice(0, 200)` and `quote` applies it to every parameter, so `resource_metadata`
and `scope` — values the client acts on verbatim — are cut at 200 characters; the budget was
designed for `error_description` (`verify-token.ts:34-38`, `notes.md:375-381`). Only the
description has a truncation test (`www-authenticate.test.ts:53-61`).

**Failure.** Entra with four delegated scopes `api://<guid>/Ivanti.Read,…Attach` (~225 characters):
the challenge advertises the fourth cut mid-name, the client requests it, Entra answers
`invalid_scope`, every request is a 403 with no log line. A long ingress hostname pushes
`resource_metadata` past 200 and the client fetches a 404.

**Fix.** Split the sanitiser (every value, uncapped) from the cap (`error_description` only). The
sanitiser also silently rewrites a value (a quote, backslash or non-ASCII character becomes a space),
which splits a scope token or alters a URL — so `validateConfig` refuses when any
`OAUTH_REQUIRED_SCOPES` entry or `metadataUrl(MCP_PUBLIC_URL)` is changed by the sanitiser (export
it), plus an aggregate ceiling on the challenge (~4,000 characters). Keep the description cap.
`notes.md` entry.
Tests (`www-authenticate.test.ts`): ~225-character scope list and a 300-character metadata URL
round-trip intact (fail today); the 500-character description test still gives 200; `validate-config.test.ts`:
a scope with a quote or non-ASCII character, or an absurd `MCP_PUBLIC_URL`, is refused naming the value.

Corroboration: HTTP/auth. Reproduced (truncation).

### 21. Backtracking regexes on unbounded input are quadratic; one credentialed caller can stall every session

`src/ivanti/odata/filter.ts:144` (`:252`), `ivanti/http/errors.ts:208`/`:228`, `exchange.ts:165`,
`transport.ts:171`. **Reproduced.** The trigger needs a valid credential and calls are rate-limited;
the liveness-probe restart chain and any ingress body cap were not checked.

Three guards run ambiguous regexes over inputs nothing bounds: the `filter` argument of four tools
(`z.string()`, no `.max()`, reaching `assertSupportedFilter` before any request) and every Ivanti error
body (scrubbed before truncation). Measured: `findUnsupportedFilter` 20K/50K/100K/200K characters =
159/984/3,851/15,330 ms; `scrubErrorBody` 10K/50K/100K/200K = 121/2,853/11,422/46,972 ms; 18,181
repeated XML `SessionId` openers = 3,921 ms. The error-body half rests on `errors.ts`'s own account
of Ivanti echoing a submitted value (not measured against the tenant).

**Failure.** A credentialed `list_records` with a 200 KB single-identifier filter blocks the event
loop ~15 s per call; six calls inside `MCP_MAX_CALLS_PER_MINUTE` keep `/health` from answering for
90 s, the chart's liveness probe (30 s period, three failures) restarts the pod, and every
conversation ends.

**Fix** (revised — the proposed "truncate the error body before the scrub" was judged **wrong**: it
can cut a sensitive value in half and leave `"SessionId":"abc…` with no closer, so the partial value
goes through unredacted, inverting the file's own rule). (1) Add a left boundary to the filter
detectors, `/(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g` and
`/(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*)?'(?:[^']|'')*'/g`; test the unquoted-literal pattern and
whitespace runs too. (2) A shared bound on `filter`, `orderBy`, `search`, `query`, `fields` (8–16 KB,
the refusal stating the limit) on the four tools and any other tool taking `filter` (`grep "filter: z"`);
this changes the manifest, so `handbook:sync`, `manifest:size`, `budget`. (3) Replace the lazy
`[\s\S]*?` error-body scans with a linear pass — find openers, `indexOf` the closer from there, and
redact to end of body once for an opener with no closer. Fixing `scrubErrorBody` covers `exchange.ts`,
`transport.ts` and `asmx-session.ts`.
Tests: `filter.test.ts` — a 100 KB identifier through `findUnsupportedFilter` and
`referencedFieldNames` finishes under 250 ms (old code ~3.9 s); `errors.test.ts` — `'<SessionId>'.repeat(10_000)`
and the JSON equivalent finish under 250 ms, and an **opener with no closer must not leak its prefix**
(fails against a naive truncate-first fix); tool tests — a 100 KB filter refused by the schema before
any request.

Corroboration: security. Reproduced.

### 22. The chart claims to refuse what the server refuses at boot, but renders eight configurations that exit 78 — and `check-chart.mjs` enshrines one as valid

`charts/ivanti-mcp/templates/_helpers.tpl:101`, `scripts/check-chart.mjs:85`, `values.yaml:43`,
`docs/deployment.md:215`, `charts/ivanti-mcp/README.md:17`, `docs/handbook.html:589`. **Reproduced**
(three rendered with helm 4.3.0; the range checks were read, not rendered).

`ivanti-mcp.validate` mirrors only some of `validateConfig`. Each of these renders against BASE values:
`ivanti.impersonationRequired=true` without `configUrl` (`validate-config.ts:208-213`);
`server.maxSessionsPerSubject=5` under the default bearer mode (`:193-198`, needs `AUTH_MODE=oauth`);
`maxSessionsPerSubject=500` with `maxSessions=100` (`:199-204`); `timeoutMs=60000,writeTimeoutMs=5000`
(`:295-301`); `timeoutMs=1` (`:265-274`); `maxConcurrentRequests=0` (`:276-281`);
`maxCallsPerMinute=0` (`:282-287`); `publicUrl` containing `#` (`:114-116`). `check-chart.mjs:85-87`
sets `maxSessionsPerSubject: '5'` over a bearer BASE and expects it to render. `deployment.md:215`:
"It refuses to render what the server would refuse to start with." Also unlisted: `timeoutMs` set
alone above the 30,000 default write timeout, and a numeric `0` skipped by Helm's falsy `with`.

**Failure.** `helm install --set ivanti.impersonationRequired=true` with no ConfigDB URL succeeds; the
pod exits 78 and crash-loops at 03:00 — the failure the chart's header (`_helpers.tpl:97-99`) says it
exists to prevent; the chart's own suite is green.

**Fix.** Primary, for the class: a parity step in `check-chart.mjs` (or `check-chart-parity.mjs`)
that renders each non-refusing case, takes the Deployment container `env`, and feeds it to
`loadConfig` from `dist/config/load-config.js` (as `check-example-envs.mjs` does; a stub secret reader
for `*_FILE`); it fails when a rendered chart makes `loadConfig` throw, and a table of
"chart renders, server refuses" probes expects `helm template` to fail. Secondary: one `fail` per
server rule with the server's wording, computed from **effective** values using the server defaults
(timeout 10,000, write 30,000), testing `0` with `hasKey`/`kindIs` not `with`. Switch the
"optional server settings" case to oauth, add a `refuses` case per guard, fix `values.yaml:43`
("oauth only, ≤ maxSessions"), and soften or keep the three "refuses to render" sentences once the
parity check makes them true. `.github/actions/checks/action.yml` runs the chart check after the
build, so `dist/` exists there; add a `notes.md` entry and mention it in the release notes (some
values that render today will stop).
Tests: the eight `refuses` cases plus `timeoutMs` alone and `--set` versus `--set-string` `0`; the
parity script itself fails on the old chart for the same inputs.

Corroboration: scripts/chart, hardcode/env. Reproduced.

### 23. The handbook settings reference states defaults for `MCP_PORT` and `METRICS_PORT` that 0.3.3 removed, and its "complete" HTTP `.env` blocks omit `MCP_PORT`

`docs/handbook.html:1180` (also `:479-486`, `:713`), `docs/configuration.md:472-477`,
`.env.example:81`, `scripts/handbook-data.mjs:152`. Not run; read.

`const ENV` lists `MCP_PORT` with `def: "3000"` and `METRICS_PORT` with `def: "9464"`; the schema has
no default for either (`env-schema.ts:43-48`) and the server exits 78 without them
(`validate-config.ts:163-167`, `:381-385`). `handbook.html:713` — the one line #62 touched — says
"required when on — there is no default", contradicting its own table. Quickstart B's `.env`, the
"Internal HTTP service, shared token" block and `.env.example:81` ("Requires AUTH_MODE,
MCP_PUBLIC_URL and TRUSTED_ORIGINS") omit `MCP_PORT`. `handbook-data.mjs --check` compares names only.

**Failure.** A reader copies quickstart B as a complete loopback HTTP configuration;
`docker run … --env-file .env` exits 78 `MCP_PORT is required for HTTP transports`, while the
reference they consult says the default is 3000.

**Fix.** `MCP_PORT` `def: "—", req: "HTTP"`; `METRICS_PORT` `def: "—", req: "METRICS_ON"`; add
`MCP_PORT=3000` to quickstart B, `configuration.md:472-477` and `.env.example:81` (grep every
`HTTP_TRANSPORT_ON=true` block and every `METRICS_ON=true` block; never `METRICS_PORT == MCP_PORT`).
For the class: extend `handbook-data.mjs --check` to compare each `def` with the schema default.
Zod 4 requires care — unwrap `Default`/`Optional`/`Pipe`, read `defaultValue` as a getter, normalise
display text (`"true"`, `"empty"`, `"—"`) and allowlist the cosmetic ones; for `req`, only assert that an
entry with a conditional `req` has no schema default. Put the comparison in a pure function with its
own test (`scripts/lib/env-docs-drift.test.ts` or `src/config/env-docs.test.ts`) and triage what its
first run reports before enabling it.
Tests: the drift check fails today with exactly two entries; a synthetic wrong default is reported.

Corroboration: scripts/chart, hardcode/env. Not reproduced.

### 24. Origin 403, the 401 challenge and the `/health` detail gate are decided in the listener's inline switch and have no test above the pure predicates

`src/server/start-http.ts:295` (`:262-337`, `:313-321`, `:327-330`, `:267-281`). Not run; "passes
`pnpm test`" is inferred from the absence of tests. The anonymous `/ready` gate is tested.

The invariant "Origin validation on every HTTP mode" lives in one `case` of `createHttpServer`'s
callback; nothing sends an untrusted Origin, a wrong token, or an anonymous `/health` through the
listener. `grep -rn forbidden_origin src --include=*.test.ts` finds nothing; `validate-origin.test.ts`
tests the predicate alone; `mcp-handler.test.ts` starts after authorization; `post()` in
`start-http.test.ts` sends only content-type and accept. `mcp-handler.ts:160-163` records that the
ownership gate "used to reach `handleRequest` without it".

**Failure.** A refactor that moves authorization before routing and drops the origin branch, or
reorders the health case, ships green: a DNS-rebound page can drive `/mcp` in `none` mode, or a 401
goes out without its challenge and OAuth clients loop on discovery.

**Fix.** Tests only, in `start-http.test.ts` beside the `/ready` block — the extraction in the
finding is a separate refactor and not needed for testability. (1) Origin: for `none`, `bearer`,
`oauth`, `POST /mcp` initialize with `Origin: https://evil.example` → 403 `{error:'forbidden_origin'}`;
a trusted and an absent Origin pass; no session was created; and the 403 precedes authorization
(evil Origin plus wrong token → 403, not 401); optionally GET with a session id. (2) 401 challenge:
wrong bearer token and a rejecting oauth verifier → 401 `{error:'unauthorized'}`; in oauth the header
contains `Bearer` and `resource_metadata=<metadataUrl(MCP_PUBLIC_URL)>` (assert loosely; check
`authorize-request.ts` before asserting a header in bearer mode). (3) `/health`: anonymous →
exactly `MINIMAL_HEALTH`; with the valid token → `buildHealth` output. Mutation-check: delete the
`isOriginAllowed` branch, the `setHeader`, and swap the health ternary; each must fail a test. Out of
scope: `createRequestHandler` extraction, moving `ListenError` (imported by `start-metrics.ts:11`) and
`openModeWarnings`.

Corroboration: HTTP/auth, SRP, security. Test-only change.

### 25. Stated controls and post-review fixes that no test executes; the "tests beside the file" rule does not hold

`src/tools/knowledge/search-knowledge.ts:192`, `shared/action-gate.ts:47`/`:52`, `list-approvals.ts:206-242`,
`shared/ignored-fields.ts:36`, `shared/zero-note.ts:72`, `records/preview-delete.ts`,
`shared/session-stamp.ts`, `ivanti/parent-link.ts`. Not run; the verifier did not open
`coverage-final.json`, so the line figures and the "49 modules without a sibling test, 19 imported by
no test" counts are the finder's.

`search_knowledge` has no test file; its article-by-number path and the enduser audience rule
(`and Status eq 'Published'`) have never executed under test. The enduser quick-action allowlist's
deny path never runs: `ActionNotAllowedError` is never constructed in a test, because the
own-records gate refuses before `deps.actions.allows` (`preview-quick-action.ts:71`,
`run-quick-action.ts:91`) and `quick-actions.test.ts` uses `OPEN_ACTIONS` only. `list_approvals`'
`subjectOf`, `ignoredFieldsNote` and three of four `zeroNote` branches likewise.
`preview_delete`'s two cases sit in `group-count.test.ts:185` and miss its only branch (the 5xx).

**Failure.** Dropping the `enduser ? " and Status eq 'Published'"` clause lets an end user read any
Draft article by number and the suite stays green; a regression in `createActionGate` lets end users
run any of the 104 actions; `readWholeArticle`'s `${subtypeName}s` guess can be wrong with nobody
noticing.

**Fix.** `search-knowledge.test.ts` (enduser URL contains the Published clause and an empty row
refuses; full URL does not; subtype body, HTML stripping, keyword filters); `action-gate.test.ts`
plus a `quick-actions.test.ts` case with `createActionGate(configFixture({MCP_MODE:'enduser',
ENDUSER_QUICK_ACTIONS:[…]}))` and the owner lookup stubbed so `allows` is reached (otherwise the test
passes for the wrong reason); list, preview and run refuse with the `It allows:` text;
`list-approvals`, `ignored-fields`, `zero-note` tests; move the `preview_delete` cases and add the 5xx
ones. Mutation-check each by deleting the control it covers. A sibling-test guard only if scoped to
files that call `defineTool(` under `src/tools`, with a reasoned exemption list computed fresh (tools
covered through `register-tools` or `every-tool.fixture` otherwise make it noise). A function-coverage
threshold at today's measured level, optional, after confirming the baseline does not fail it.

Corroboration: dead-code, SRP. Not reproduced.

---

## Low

Fifteen findings, each confirmed by a verifier's source read (not run unless stated) but rated low.

### 26. `confirmWrite` reports an unreadable record as "did NOT store" for validated fields but "could not be read back" for free fields

`src/ivanti/write/validated-write.ts:462` (`:433-438`, `:476-479`), `compare-stored.ts:36`. Not run.
When the read-back is `undefined` (204/empty), every `confirm` entry compares against `''` and
raises `WriteNotStoredError` with stale-list advice, logged at error; the free-field loop in the same
function files it under `notConfirmed`. No test covers `confirm` non-empty with `read` undefined
(`validated-write.test.ts:389-396` uses `written` only). **Fix:** when `read === undefined`, push
every confirm and companion name to `notConfirmed` ("could not be read back") and never call
`miss()`; test beside the free-field one. Trigger is rare (an empty read-back right after a
successful write); the write succeeded, so a retry is mostly harmless. Corroboration: writes.

### 27. Two copies of the ASMX call stack with divergent envelope rules

`src/ivanti/session/impersonated-session.ts:165`, `asmx-session.ts:119-155`, `roles.ts:101`. Not
run. The verifier **downgraded** this from medium and judged the stated failure path wrong (the role
decision goes through the `GetRolesForUser` fallback), and the `d ?? parsed` fallback may be
deliberate if `GetRolesForUser` lacks the envelope (unchecked). `asmx-session.ts:137-154` throws
"answered without the expected d envelope"; `impersonated-session.ts:155-156,165` reads an empty body
as `{}` and returns `parsed.d ?? parsed`. ~90 lines of JSON POST, form handler and multipart upload
exist twice; header spellings are repeated (`asmx-session.ts:255,272,295`, `impersonated-session.ts:190,201,219`).
**Fix:** `session/asmx-calls.ts` — `createAsmxCalls(context, routes, {sid, csrf})` with one envelope
rule and a per-call `{envelope:false}` where genuinely needed; one test file for the three shapes.
Corroboration: session-identity, DRY, TypeScript.

### 28. The Helm chart has no value for `MCP_IDENTITY_IDLE_TTL_SECONDS` and nothing checks the chart against `envSchema`

`charts/ivanti-mcp/templates/deployment.yaml:76`, `values.yaml:48`/`:192`, `env-schema.ts:54-66`,
`docs/configuration.md:621`, `scripts/check-chart.mjs`. **Reproduced.** Of 38 schema keys the Deployment
wires 37; the identity TTL has no values key, env line or README row, while its sibling
`server.sessionIdleTtlSeconds` exists — the trap `env-schema.ts` says the split avoids. `extraEnv` is an
escape hatch and the 1,800 s default is safe, so low. **Fix:** `server.identityIdleTtlSeconds` in
values, Deployment (`with`) and README plus a `has` case; for the class a check (in `check-chart.mjs` or
`handbook-data.mjs --check`, which already imports `envSchema`) that every schema key minus an explicit
forced list appears in `deployment.yaml` as itself or its `_FILE` form. Corroboration: five finders.

### 29. After #62, the literal `3000` survives in eleven configurator sites, the generated compose publishes `'3000:3000'`, and the Dockerfile still `EXPOSE`s 3000/9464

`docs/handbook.html:1322` (also `:1303`, `:1372`, `:1419`, `:1474`, `:1628`, `:1769`), `docker/compose.yaml:52`,
`docker/Dockerfile:96`/`:99`, `docs/deployment.md:133`. Not run. The verifier rated the original
medium too high. The configurator has `const METRICS_PORT = 9464` and no MCP equivalent; the
generated compose uses a literal `ports:` where the repository's `compose.yaml` interpolates
`${MCP_PORT:?set MCP_PORT in .env}`. **Failure:** a user changes `MCP_PORT=8080` in the downloaded
`.env`; the generated compose still publishes 3000, the healthcheck (reads `MCP_PORT`) says healthy,
and nothing answers — the #62 symptom. **Fix:** `const MCP_PORT = 3000` and derive every literal;
`buildComposeText` emits the interpolated form; `buildValuesText` emits `server.port`; drop both
`EXPOSE` lines (or comment them) and the `deployment.md:133` clause; add `EXPOSE` to
`check-docker-context.mjs`'s owned facts. Corroboration: scripts/chart, hardcode/env, dead-code.

### 30. `oauth.audience` is quoted as a scalar while its sibling lists are joined

`charts/ivanti-mcp/templates/deployment.yaml:117`, `values.yaml:85`. **Reproduced.** `OAUTH_AUDIENCE`
uses `{{ . | quote }}` while `OAUTH_SCOPES_SUPPORTED`/`OAUTH_REQUIRED_SCOPES` use `join ","`; a YAML list
renders as `"[api://a api://b]"` and every token is refused with "not issued for this server". The
verifier rated it low: only an operator who writes a list hits it. **Fix:** accept a list or string
(`kindIs "slice"`), `join ","`, a `check-chart` case with two audiences asserting `"api://a,api://b"`.
Corroboration: scripts/chart.

### 31. "Set but ignored by the mode" is refused for `ENDUSER_*` and `AUTH_MODE`, but four other settings are silently dropped

`src/config/validate-config.ts:343` (`:135-137`, `:155-160`, `:360-373`, `:215`, `:303`),
`.env.example:371`, `create-server.ts:112-135`. Not run. `IVANTI_IMPERSONATION_ROLE` without the
ConfigDB pair, `OAUTH_*` under `none|bearer`, `BEARER_TOKEN` under `none|oauth`, and `IVANTI_MAX_TIER`
with no tenant are accepted and never read; `.env.example` promises "never silently ignored". The
role-without-pair case is the notable one (the deployment believes sessions are narrowed; they run
under the service account's Admin role); leftover `OAUTH_*` after moving to bearer is dead config, not
a bypass. `IVANTI_MAX_TIER` was not checked in depth. **Fix:** one derived rule per axis mirroring
`ENDUSER_SETTINGS`, using `provided` (`load-config.ts:72`); a test per rule. Examples and the chart's
`with`-guarded entries already comply. Corroboration: config-server.

### 32. A refused API key at the startup probe exits 1 with a raw stack, not 78

`src/index.ts:223` (`:39-41`), `ivanti/http/base-path.ts:122`/`:129`, `docs/configuration.md:608`. Not
run. Only `ConfigError` (78) and `ListenError` get quiet exits; the probe's "Ivanti refused the API
key: 401 … check `IVANTI_API_KEY`" is a plain `Error` that dumps `error.stack` and exits 1, which
`RestartPreventExitStatus=78` (`deployment.md:97`) treats as transient. **Failure:** a wrong key in a
systemd unit restarts every 5 s forever against the tenant's auth path. **Fix:** a typed
`TenantRefusedError` for 401/403 mapped to `ConfigError` at `index.ts:54` (same for `createOAuthSetup`
failures already attributed to a setting); "could not reach" stays exit 1; log via
`logger.error('startup failed', {error})`; add the symptom-table row. Whether 401 should be 78 is a
judgement call (a rotated key fixed in place would then need a manual restart). Corroboration: config-server.

### 33. In-flight accounting conflates the SSE stream with a running request, and the sweep ignores it

`src/server/http/session-store.ts:172`, `session-manager.ts:152`/`:165`/`:218`, `mcp-handler.ts:118`.
Not run; the 1,511 ms GET-stream experiment is the finder's. `inFlight` counts the dedicated GET
stream (held for the client's life) and a running POST alike, so subject eviction's "prefer one doing
nothing" cannot tell attached-idle from mid-write, and `sweep()` closes by `lastSeen` alone. The
verifier's read: scenario (b), the TTL closing a stream-attached, request-less session, is largely
intended; scenario (a), a mid-write session evicted when both of a subject's streams are attached,
is the defect, and `create_record` retried after that may create twice. No sweep-versus-`inFlight`
test exists. **Fix:** `begin/end` for POST/DELETE (`inFlight`), `attach/detach` for GET (`attached`);
eviction prefers `inFlight === 0`, the floor protects `attached`, `sweep()` skips both; session-store
tests. Corroboration: HTTP/auth.

### 34. `register-tools.ts` has six reasons to change

`src/tools/register-tools.ts:263` (`:86`, `:349`, `:468`, `:520`, `:616`), `resources/register-resources.ts:7`.
Not run (`wc -l`, grep); `madge --circular` is clean. 713 lines hold tool selection, conversation
lifecycle, identity gate and token auto-pin, impersonated-session keep/renew/retry, rate limiting and
call accounting, with eleven shared closure variables and retry control riding on `usage.personRefused`.
The 2026-09-29 findings 8, 13, 24 and 49 all landed here. **Fix:** keep it as the pipeline; extract
`select-tools.ts` (+ `ToolContext`), `call/conversation.ts`, `call/rate-limit.ts`,
`call/identity-gate.ts`, `call/session-keeper.ts` (taking a `refused()` predicate),
`call/call-log.ts`; the gate at `:575-588` must stay in one visible place (`CLAUDE.md`: it lives in
`registerTools`). Corroboration: tool-framework, SRP.

### 35. Two reference documents contradict the tools they sit beside

`src/resources/write-recipes.ts:13`, `workflow.ts:40`, `register-resources.ts:51`, `resources.test.ts:60`.
Not run. `write-recipes` teaches `create_record` on `Journals` with the text in `Subject` although
`add_note` (registered everywhere) writes `journal__notes` with `NotesBody`; in enduser `Journals` is
outside the allowlist, so the gate refuses the recipe. `workflow` says saved searches called "My …"
resolve for the signed-in account, "do not present those results as anyone else's", unconditionally,
while the tool descriptions say that under impersonation "those really are their records" — the
verifier judged the impersonation half overstated. `resources.test.ts` checks only that tool names
exist. **Fix:** rewrite the notes section to point at `add_note`/`list_notes`; make the saved-search
paragraph conditional on `canImpersonate`; a resource test asserting `NotesBody`/`journal__notes`
appear and `JournalType: 'Notes'` does not. Corroboration: tool-framework.

### 36. `ivanti/` imports upward

`src/ivanti/session/roles.ts:4`, `impersonated-session.ts:4`/`:340`, `ivanti/http/exchange.ts:5`/`:117`,
`tools/shared/read-rows.ts:10`, `config/env-schema.ts:5`, `auth/impersonation.ts:4`,
`auth/oauth/create-verifier.ts:6`. Not run (grep: three upward imports from `ivanti/`). `CLAUDE.md` says
`ivanti/` "knows nothing about MCP", yet `ivanti/session` branches on `McpMode` and names
`ENDUSER_ROLE`/`IVANTI_IMPERSONATION_ROLE` in a refusal (a renamed setting already left a stale name
there once), and `exchange()` imports the usage tally that `read-rows.ts` says `ivanti/` never
touches. **Fix:** a `RolePolicy` union built in `create-server.ts`; `exchange()` takes an optional
`observe`; correct the `read-rows.ts` comment; ESLint `no-restricted-imports` so `src/ivanti/**` may not
import config, usage, tools, server or auth, and `src/config/**` may not import `ivanti`.
Corroboration: SRP.

### 37. `IvantiConnection` is handed whole to every tool; the credential guard is a source regex with a declared blind spot

`src/tools/shared/deps.ts:15`, `connect.ts:52`, `connection-for.ts:60`, `credential-guard.test.ts:100`,
`list-request-offerings.ts:26`. Not run; the verifier's grep found **no** positional caller reading
`transport`/`session`/`forms`/`workspaces` off a whole `deps.connection`, so nothing is wrong today.
`credential-guard.test.ts:100-105` says a positional hand-off is "deliberately not matched", and
`connection-for.ts:60-66` re-implements the workspaces and forms construction of `connect.ts:176`/`:220`,
so a new session-derived member added to `connectIvanti` would stay on the service account's role under
the person's name (`switch_role` had exactly this bug). **Fix:** split into `TenantFacts` and
`IvantiView` with `deps.view(context)` (about 40 files); cheaper: build the view in one function
used by both `connectIvanti` and `connectionFor`. Corroboration: SRP.

### 38. `runTool` maps 22 refusal classes through an open `instanceof` chain

`src/tools/shared/run-tool.ts:61`, `known-fields.ts:118`, `upload-attachment.ts:153`, `switch-role.ts:81`.
Not run; no current class falls through (the two unnamed ones are caught locally). A refusal class
nobody wires is logged as `tool failed` at error level with a stack, and `pnpm usage:report` counts
the caller's mistake as a fault — it has happened once (`FieldNotOnObjectError`, fixed by
subclassing). **Fix:** a `Refusal extends Error` base carrying `level` and `outcome`, one
`instanceof Refusal` branch, and a test that walks `src/**/*.ts` for `export class \w+Error` and
requires each to be a `Refusal`, an `IvantiApiError`, or in an allowlist (`ConfigError`, `ListenError`).
Corroboration: TypeScript.

### 39. Request bodies are buffered with no bound on how many are in flight, and before session admission

`src/server/http/read-body.ts:19` (`:23-33`), `mcp-handler.ts:187`/`:214`, `start-http.ts:254`,
`values.yaml:173`. Not run (no OOM test). The attacker needs a valid token or `AUTH_MODE=none`, and an
ingress normally buffers or caps bodies; the "not counted by the session cap" point is secondary. Each
POST body is buffered up to 4 MiB before `sessions.admit()`, with no process-wide budget or
`maxConnections`; under the chart's 512Mi limit, ~200 sockets trickling a 4 MiB initialize over the
120 s window is ~800 MiB. **Fix:** a process-wide in-flight body budget (e.g. 64 MiB) answered 503 +
`Retry-After`; a per-socket concurrent-request cap; read an initialize with a small cap and keep
4 MiB for `tools/call` on an admitted session; document the per-request memory figure in `values.yaml`.
Corroboration: security.

### 40. Naming and literal conversions are re-derived by hand where an exported helper exists; two definitions of "loopback" disagree

`src/ivanti/session/admin-catalog.ts:67`, `workspaces.ts:76`, `form-context.ts:127`,
`search-knowledge.ts:234`/`:238`, `null-filter.ts:38`, `field-table.ts:40`, `validate-config.ts:6`/`:9`/
`:96`/`:101`, `discover-metadata.ts:45`, `start-http.ts:121`, `start-metrics.ts:50`, and the link-pair
sites (`explain-required-fields.ts:40`, `ownership-writes.ts:55`, `form-context.ts:271`,
`customer-link.ts:91`). Not run. `entity-names.ts`'s header says it was ported because "three
inconsistent conversions had grown up independently"; it has regrown. The `toObjectId` instance is
finding 1. The concrete one: `LOOPBACK_ADDRESSES` (`127.0.0.1`, `::1`, `localhost`) drives the
exposure warnings while `LOOPBACK_HOST` (`/^127(\.\d{1,3}){3}$/…`) drives URL checks, so
`MCP_BIND=127.0.0.2` logs "not loopback: anything that can reach port … acts in Ivanti …
unauthenticated" while `http://127.0.0.2` is accepted — a false alarm that errs safe. The verifier
noted `admin-catalog`/`workspaces` skip `hashForm` deliberately (their ids already contain `#`), so
that item is not a drop-in copy. **Fix:** replace each copy with the exported helper; one
`edmTypeName()` in `csdl.ts`; one `isLoopbackHost()` used by both exposure checks and
`discover-metadata.ts` (test `127.0.0.2` is not "exposed"); one `categoryFieldOf(recIdField)`; an
ESLint or grep test for the regex literals outside their home module. Corroboration: DRY,
config-server.

---

## Refuted before filing

Nothing was refuted at verification: every high and medium finding was reproduced or reasoned through
from the source by its verifier, and several were downgraded or had their fix revised (noted above).
The finders refuted some of their own candidates before reporting them and those were not carried
into this list; the previous reports' "Refuted — do not re-file" sections still stand.

## Not verified

**Unverified, as raised.** These 22 low findings were not sent to a verifier. Treat each as a claim
to check, not a defect to fix. (The merge produced a 23rd empty placeholder entry, dropped here.)

1. **Dead exports and consumer-less members** — `src/tools/shared/result.ts:21`: `textResult`, `NULL_FILTER_CAVEAT`, `isStdioTransport`, `initialIdentity`, `SessionStore.has`, `identityIfKnown`, `CustomerLink.ambiguous` (computed, never consulted), `maskStringLiterals`, module-private exports in `validate-config`, `ARGUMENTS` for tools no `selectTools` output registers, a duplicated `McpMode` union.
2. **Stale doc comments** — `src/config/validate-config.ts:81`: seven JSDoc blocks sit directly above another JSDoc block and attach to nothing; a stale "still being built" line; two duplicated `catalog.ts` paragraphs; `connect.ts` re-derives `pathOf()` with a `new URL()` that can throw.
3. **Timeout defaults declared in five modules production never reaches** — `src/ivanti/http/transport.ts:19` (and `base-path.ts`, `asmx-session.ts`, `impersonated-session.ts`, `central-config.ts`): three copies of 15,000 against the configured 30,000, under comments saying they read env; the probe's bound is per attempt.
4. **Server defaults restated by hand** — `.env.example:389`: sixteen "default:" annotations, five `values.yaml` comments, the chart README, the handbook `def` column and `configuration.md` copy `env-schema.ts`; nothing compares them (all match except the two ports; see finding 23).
5. **`HEALTHCHECK_TIMEOUT_MS` is read by the image and documented nowhere** — `docker/healthcheck.mjs:32`: `Number()` of a bad value is NaN, which `AbortSignal.timeout` treats as no timeout; `MCP_PUBLISH_ADDR`/`METRICS_PUBLISH_ADDR` are missing from the handbook ENV table.
6. **Tests that assert less than their names claim** — `src/server/http/read-body.test.ts:31`: "without buffering it all" asserted with one chunk; a constant tested against itself; sweep tests never exercise a busy session; a vacuous scrub `catch` in the `asmx-session` test; `roles.test.ts` titled for behaviour the code reversed; `if (target !== undefined || target === undefined)` in `switch-role.test.ts`.
7. **"Annotate every tool explicitly" is enforced by neither type nor test** — `src/tools/tool-definition.ts:77`: `ToolSpec.annotations` is the SDK's all-optional type; only `get_version`'s hints are asserted. All 41 tools comply today by discipline.
8. **The shutdown test does not exercise the ordering the code says matters** — `src/server/start-http.test.ts:228`: sessions-before-listener (`start-http.ts:394-397`) can be reversed and the test still passes.
9. **No guard test for "every Ivanti request goes through `exchange()`"** — `src/ivanti/http/exchange.ts:88`: the only bare fetches today are OAuth discovery; the credential invariant has such a guard.
10. **`healthcheck.mjs` restates zod's `stringbool` truthy set with no test holding them together** — `docker/healthcheck.mjs:22` against `env-schema.ts:30-31`; `notes.md` records they diverged once (`HTTP_TRANSPORT_ON=y` "reported healthy forever").
11. **Two chart guards have no case in `check-chart.mjs`** — `scripts/check-chart.mjs:37`: `ivanti.configUrl needs the ConfigDB key` (`_helpers.tpl:154-156`) and `server.authMode=bearer needs a bearer token` (`:160-162`); the metricsToken-reuse guard is covered for `bearerToken` only.
12. **`AUTH_MODE=oauth requires OAUTH_ISSUER` has no test where it lives** — `src/config/validate-config.ts:303`: its only test (`create-verifier.test.ts:68-69`) exercises an unreachable duplicate at `create-verifier.ts:55` that throws a plain `Error` (exit 1, not 78).
13. **"Reaches Ivanti only through the two documented surfaces" filters the ASMX surface out** — `src/tools/admin-ui-guard.test.ts:89`: only entries starting with `http` are kept, and ASMX calls are recorded as `Services/….asmx/Method`.
14. **Startup and transport messages name the wrong cause** — `src/ivanti/http/base-path.ts:128`: a non-CSDL 200 is reported as "could not reach"; the transport reports any non-JSON 2xx as "answered 200"; `base-path.test.ts:55-66` pins the wording.
15. **`IvantiApiError.truncate` measures bytes but cuts in UTF-16 units** — `src/ivanti/http/errors.ts:159`: a non-Latin body keeps up to ~3× the cap; `errors.test.ts:31-35` asserts only `/truncated/`. (Its other two raw parts are covered by finding 13 and by item 14 here.)
16. **A startup failure after a transport is serving exits without running shutdown** — `src/index.ts:102`: stdio is connected at `:106` and HTTP bound at `:147` before OAuth setup, `ListenError` or allowlist errors can throw; `main().catch` never calls `close()`, so an opened Ivanti session stays on the tenant.
17. **Unrepresentable auth states are represented** — `src/server/http/authorize-request.ts:123`: a 500 ("verifier not initialised"), a 501 (`AUTH_MODE=undefined`) and `?? ''` fallbacks on the OAuth metadata route (an RFC 9728 document with an empty `resource`).
18. **A `*_FILE` read failure is reported without naming the setting** — `src/config/load-config.ts:59`: the `ConfigError` is the bare `EACCES: permission denied, open '/run/secrets/bearer_token'`.
19. **Instructions say the key "could not open a session" when the tier was capped by `IVANTI_MAX_TIER`** — `src/server/instructions.ts:102`: `probeCapability` returns `reason: 'capped by IVANTI_MAX_TIER'`.
20. **`ENDUSER_QUICK_ACTIONS` is checked against the tenant nowhere** — `src/index.ts:77`: only `ENDUSER_BUSINESS_OBJECTS` is; `CLAUDE.md`/`architecture.md` say tenant-naming settings are checked and `env-schema.ts` says it is "the one"; a misspelling silently narrows to nothing.
21. **Under oauth with stdio on, the stdio conversation's usage lines carry the wrong manifest fingerprint** — `src/server/create-server.ts:164`: `fingerprintManifest(tools, instructions)` uses the verified-path text while a stdio connection is sent `instructionsWithoutToken`.
22. **Validation bounds hardcoded inline in both the check and the message** — `src/config/validate-config.ts:276`: `IVANTI_MAX_CONCURRENT_REQUESTS` (1–256) and `MCP_MAX_CALLS_PER_MINUTE` (1–10000) against the named `TIMEOUT_BOUNDS_MS`; `.env.example` restates the ranges by hand.

## What nobody looked at

- **The live tenant.** Nothing was driven through `ivanti-http` (a read-only probe was denied by the permission classifier); every reproduction ran against the connection fixture. Unmeasured: Ivanti's JSON key order on `servicereqs` rows (finding 11), the subtype workspace id format (1), whether `ISM_2000` can lie on an association (9), whether a tenant rule overrides the customer on create (5), the `preview_delete` failure signature (14), whether Ivanti echoes a large submitted value into an error body (21), and whether it 404s typos (13).
- **Load.** No concurrent-session, memory or socket test; the body-buffering figure (39) and the session-eviction races (33) are arithmetic and reading. The liveness-restart chain in finding 21 was not checked.
- **Runtime of the full suite by the finders.** Most finders did not run `pnpm test`; the baseline above was measured once, separately. `coverage-final.json` claims in findings 14 and 25 were not re-checked by verifiers.
- **`src/auth/oauth/` beyond the verifier**, JWKS and discovery internals; the MCP SDK's `StreamableHTTPServerTransport` internals and `jose`/`fast-xml-parser` sources beyond audit and a 30-case token fuzz; Zitadel's access-token `typ`.
- **`src/ivanti/` internals** the area finders only touched through consumers: `session/` (asmx-session, central-config, capability, admin-catalog), `service-request/`, `attachments/`, `quick-actions/execute.ts`, `write/compare-stored.ts`; `$filter` interpolation in those modules.
- **`src/tools/`** beyond the traced paths: the write tools' bodies were read where they intersect reads; `list-notes`, `list-request-offerings`, most of `get-service-request-parameters`, `approvals/*` and `notes/*` were skimmed; `get_related_records` pagination under an owner row scope was noted and not filed.
- **The six reference documents' content** under `src/resources/` — read only for contradictions with the tools (finding 35), not for correctness about Ivanti; the same limit as the two previous reviews.
- **Scripts, docs and CI as text only.** `scripts/lib/*` arithmetic, the Dockerfile and compose behaviour (no docker on the machine; `${MCP_PORT}` interpolation beside a generated `.env` was relied on from Compose's documented rule), `.github/workflows` execution (branch protection, secrets, `.trivyignore.yaml` expiry), `deploy/systemd/`, `postman/`, `docs/handbook.html` prose beyond the quickstart, Deploy steps, ENV table and generators, and `configuration.md`'s IdP sections beyond the symptom table. Kubernetes `fsGroup` with `defaultMode 0400` on the secret volume was reasoned, not deployed.
- **Judged acceptable and not filed**, so as not to re-file: `role: 'Admin'` in `AuthenticateTenantAPIKey`; `BASE_PATH_CANDIDATES`; `PERSON_OBJECTS` with its absent-object fallback; `WORK_OBJECTS` closed-status lists (a stated assumption that can be turned off); the `Published`, `Pending` and `journal__notes` constants; exit code 0 on a timed-out shutdown (a decision); the service-account ASMX session never being released at shutdown (outside scope, noted only); the 5 s keep-alive on the metrics listener; unauthenticated rate limiting per client IP (left to the proxy by design).
- **Test strength at scale.** The 124 test files were not read for assertions weaker than their names; only the files named above were; 34 `toBeDefined()`/`not.toThrow()` sites were listed and not judged one by one.
