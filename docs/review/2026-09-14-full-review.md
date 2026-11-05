# Full code review — 14 September 2026

Against `b17be17` (v0.2.0, the release that added impersonation).

> **Status: all 38 are fixed**, on `review/findings-2026-09-14`. The findings below are left as
> they were written — a report edited to match the fix stops being evidence of what was wrong.
> Read [`STATUS.md`](./STATUS.md) for what each fix was and where it landed.

## What was run

Sixteen reviewers, one per dimension, each reading the source rather than this repo's account of
it. Every finding then went to an independent skeptic whose brief was to **refute** it — find the
guard, the caller that does not exist, the test that already covers it, the documented reason —
and to default to refuted when it could not construct the failure from a real entry point. Findings
that survived and claimed to be serious went to three more reviewers, one each for
exploitability, blast radius, and whether the proposed fix is itself correct. A seventeenth pass
asked only *what did nobody look at*, and went at the gaps.

**136 agents, 3,929 tool calls, 30 minutes.** 86 findings raised, **24 refuted**. After merging the
same defect found independently from several directions — a dozen were, which is corroboration
rather than noise — **38 distinct defects** remain, numbered below.

Everything here was read at least twice by agents with no shared context, and the highest-severity
claims were then checked by hand against the source before being written up. Where a reviewer and
its skeptic disagreed, both positions are recorded.

The baseline matters for reading this: `pnpm lint`, `pnpm typecheck`, **767 tests across 93 files**
and `pnpm build` all pass. Everything below is something a green build does not catch.

## How to read it

Severity is about **what a user or operator actually experiences**, after the skeptic's correction
and not as first claimed:

| | |
|---|---|
| **high** | wrong data, or a silently failed write, that someone would act on; or a stated control that does not hold |
| **medium** | a real defect with a narrow trigger, or a loud failure in a case that should have been quiet |
| **low** | hygiene, a misleading message, a test that does not test what it says |

**There is no critical finding.** One was filed as critical and the skeptic corrected it down: no
finding in this review exposes one person's data to another, and none bypasses a security control
from an unauthenticated entry point. That is worth stating plainly, because the list below is long.

Three recurring shapes are worth naming up front, because most of the list is one of them:

1. **A catch that turns a failure into a success shape.** `.catch(() => undefined)` appears in
   several places where `undefined` already means something benign — "not found", "nothing
   mismatched", "no such object" — so a timeout becomes a fact about the tenant.
2. **Impersonation is newer than the code it passes through.** v0.2.0 routed most surfaces onto the
   person's credential. The ones it missed are missed *quietly*, because the service account is
   usually an admin and therefore usually answers.
3. **A guard that names the thing it guards.** Several of the static guards match on a literal
   spelling, so an equivalent spelling walks past them — and the build stays green, which is
   exactly the signal the guard exists to provide.

---

## High

### 1. The credential guard's regex is defeated by destructuring, and three tools answer as the service account

`src/tools/shared/credential-guard.test.ts:50` — `src/tools/records/list-assigned-work.ts:52`,
`src/tools/schema/list-business-objects.ts:109`, `src/tools/records/create-record.ts:98`

The guard matches `/deps\.connection\.(transport|session|forms|workspaces)\b(?!\s*,)/`. A file that
writes `const { transport } = deps.connection;` never produces that string, so the guard never sees
it. `list_assigned_work` captures the **service-account transport at factory scope** — outside the
handler, so `transportFor` cannot apply even in principle — and `list_business_objects` destructures
`{ capability, metadata, workspaces, admin }`, taking the service account's role workspaces while
impersonating. `create_record` and `update_record` pass `connection: deps.connection` wholesale into
`resolveValidatedWrite` (finding 6), which is invisible for the same reason.

The guard's docstring says a forgotten `transportFor` "does not fail: it answers as the service
account, returning rows the caller may not be entitled to". That is exactly what happens, and the
test that exists to catch it passes.

**Where it shows.** Not where you would first look. `docs/notes.md:986` measures the service account
(Admin) and an impersonated `ServiceDeskAnalyst` both reading 551 incidents — comparing those two
would suggest, wrongly, that OData ignores the role. The demonstrable divergence is
`switch_role('SelfService')`: every `transportFor` tool then reads **0** incidents while
`list_assigned_work` still reads the tenant's 551.

**→** Route `list_assigned_work` and `list_business_objects` through `connectionFor` (or declare them
in `SERVICE_ACCOUNT_BY_DESIGN` with a reason). Then widen the guard: drop the `(?!\s*,)` lookahead,
which exempts nothing real once `stripResolved` has run, and add a pattern for handing
`deps.connection` to a helper. Do **not** widen it to bare `deps\.connection` — nine files
legitimately read `metadata`/`people`/`capability` off it, and a nine-entry false-positive allowlist
would destroy the guard's signal.

### 2. `group_count` interpolates `groupBy` into the filter, and OData's precedence ORs the scope away

`src/tools/records/group-count.ts:126`

```ts
const conditions = [`${args.groupBy} eq ${quoteOdataString(value)}`];
if (scoped.filter !== undefined && scoped.filter !== '') conditions.push(`(${scoped.filter})`);
```

The *value* is quoted; the **field name is not**, and `groupBy` is `z.string()` with no validation
against the object. When the caller supplies `values`, the pick-list path that would otherwise reject
an unknown field is skipped entirely (`let values = args.values ?? []` — the form walk only runs when
the array is empty). So `groupBy: "Status ne 'zzz' or Status"` yields

```
Status ne 'zzz' or Status eq '<value>' and (ProfileLink_RecID eq '<their recid>')
```

and `and` binds tighter than `or` in OData, so the own-records constraint applies only to the second
disjunct. The scope is gone.

What escapes is **counts, not rows** — the request sends `$top: 1` and the tool reports
`@odata.count` — but that is a working equality oracle over other people's records
(`Subject eq '<guess>' or Status`, with a `values` entry that matches nothing). `total` at line 159
is computed from `scoped.filter` alone and stays correctly scoped, which is why the discrepancy is
not obvious in the output.

**→** Validate `groupBy` against the resolved entity's fields before it reaches the filter — the same
refusal `assertOrderBy` and `assertSupportedFilter` already make client-side — and parenthesise the
generated clause.

### 3. A failure during the response body escapes the error wrapper, and the schema cache keeps it forever

`src/ivanti/http/transport.ts:158` and `src/ivanti/metadata/catalog.ts:106`

Two bugs that are harmless apart and bad together.

In `send()`, the `try` closes before `const text = await response.text();`. The `AbortSignal.timeout`
is still armed during the body read, and so is the socket — a timeout mid-body, a reset
(`TypeError: terminated`), a proxy dropping a long transfer or a decompression failure all throw a
raw error rather than an `IvantiApiError`.

In `fetchDocument`, the only eviction is:

```ts
const transportFailure = error instanceof IvantiApiError && error.status === 0;
if (transportFailure) documents.delete(url);
```

A raw `TimeoutError` is not an `IvantiApiError`, so `Promise<undefined>` stays in the map with no TTL
and no eviction. `$metadata` is the largest document the server fetches (~325 KB), which is precisely
where a mid-body failure is likeliest.

The result: one transient hiccup and the process answers **`Ivanti has no Business Object named
'Incident#'`** for the rest of its life, making no further HTTP request, logged at `debug` as
`retryable: false`. Because `routes.metadata('incidents')` is byte-identical to the startup probe's
URL, poisoning the seed kills `incident` — the most-used object — permanently.

The poisoning is per URL, not global: `entityNames()` throws only when no document parsed, so
`list_business_objects` degrades rather than dying.

**→** Move `response.text()` inside the `try`. Independently, widen the eviction predicate: cache
only a definitive Ivanti answer (a 200 carrying the fabricated field-less document, or a 404), and
evict `status === 0`, 5xx, 401/403/429 and any non-`IvantiApiError` throw.

### 4. The cross-subject session check runs on POST only

`src/server/http/mcp-handler.ts:93`

`sameSubject()` — the check design §5 relies on to stop one verified OAuth subject using another's
session — sits in the POST branch. The non-POST branch looks the session up by `Mcp-Session-Id`,
confirms it exists, and calls `existing.transport.handleRequest(request, response)` with no subject
comparison at all.

So under `AUTH_MODE=oauth`, a holder of a **valid token for a different subject** can send
`DELETE /mcp` with someone else's session id and destroy their conversation — `handleDeleteRequest`
runs `finally { await this.close() }` and answers 200. `mcp-handler.test.ts:212` covers the POST case
and only the POST case.

The SSE half is less than it first appears, and the skeptic was right to narrow it: a GET does attach
to the victim's dedicated SSE stream, but this codebase sends no server-initiated messages — no
`sendLoggingMessage`, no notifications, no `elicitInput` — and tool results travel on the POST's own
stream keyed by request id. So the realistic harm is **denial of service on another subject's
session**, not disclosure of their data.

**→** Hoist the check above the method split: run it immediately after `sessions.get(sessionId)`
succeeds, so GET, DELETE and POST share one gate. Add the two missing tests.

### 5. `assertRecordWritable` fails open in `full` mode

`src/tools/shared/own-records.ts:301`

```ts
const record = await transport.request<OdataRecord>(url).catch(() => undefined);
if (record === undefined) {
  if (deps.ownRecordsOnly) throw new NotYourRecordError();
  return undefined;                      // ← full mode: the ReadOnly test below never runs
}
if (record['ReadOnly'] === true) throw new RecordClosedError(resolved.entity.name);
```

The catch swallows **every** failure, not just Ivanti's not-found dialect — a 500, a 502 from the
proxy, the transport's own 10-second timeout. In `full` mode (the default: `MCP_MODE` defaults to
`full`) that returns normally and the closed-record refusal is skipped. The write proceeds, Ivanti
accepts a PATCH to a closed record and answers 200, and the tool **reports success**.

`docs/notes.md:688` narrows the blast radius usefully: Ivanti polices closure everywhere except
updates — a DELETE of a closed record answers 400, and a reopen action answers `saved: true,
status: 'error'` while changing nothing. So `delete_record`, `run_quick_action` and
`preview_quick_action` are backstopped by the tenant. The damage is on the **update** path, which is
the one place notes.md records that "Ivanti does not hold the line", plus `add_note`,
`upload_attachment` and `delete_attachment`, which create child rows pointing at a closed parent.

**→** Narrow the catch the way `delete_record` already does
(`delete-record.ts:63` — `if (isIvantiNotFound(error)) return undefined; throw error;`). A read that
failed for any other reason must refuse the write, not disable the guard.

### 6. An impersonated write resolves its pick lists on the service account

`src/tools/records/create-record.ts:98`, `src/tools/records/update-record.ts:95`

Both tools compute the person-scoped connection on their first handler line and then hand
`resolveValidatedWrite` the **service-account** one:

```ts
const connection = connectionFor(deps, context);   // line 88
...
await resolveValidatedWrite({ connection: deps.connection, ... });   // line 98
```

Inside, that connection supplies the create form, the `GetFormValidationListData` session and the
pre-write read of cascade parents. So the *validation* runs against the Admin account's form while
the *write* goes out on the person's SID. Where the two forms differ — which is the entire reason
`get_pick_list_values` exists — a value the person's own role never offers is accepted, attached to
its RecId, stored (OData does not enforce form lists), and then confirmed by `confirmWrite`, which
correctly uses the person's transport. The tool reports a validated write of a value that role could
not have chosen.

The second effect is an echo: `storedParents` reads the target record on the service account and
surfaces it, in `full` mode, without an ownership check.

**→** Pass `connection` — the `connectionFor` result already in scope — at both call sites. That one
substitution routes the form, the pick-list session and the parent read onto the person's credential.

### 7. `submit_service_request` never consults the enduser object gate

`src/tools/service-request/submit-service-request.ts:130`

Every other object-taking tool passes through `createObjectGate`. This one does not, so in an
`enduser` deployment whose allowlist omits `ServiceReq`, a caller can still create one. Worse, the
read-back path performs two ungated OData GETs on the gated object —
`servicereqs('<recId>')` and `.../ServiceReqContainsServiceReqParam` — and surfaces `ProfileFullName`
and `CreatedBy` from them in the result. So gated-object data does come back.

It is high and not critical because `resolveSubject` still refuses the `person` argument in `enduser`
mode: a caller reaches their own record, not a colleague's.

`enduser-gate.test.ts:239` does gate the *parameter* tools on `ServiceReq`, which makes the omission
here read as deliberate when it is not.

**→** Gate the tool on `ServiceReq` the way its sibling parameter tools already are, and extend the
enduser-gate test to the submit itself.

### 8. `act_as` pins a different person when the name has three or more tokens

`src/ivanti/people/directory.ts:209`

The exact-match filter builds `FirstName eq <first token> and LastName eq <last token>`. For
"Mary Jane Watson" that is `FirstName eq 'Mary' and LastName eq 'Watson'` — which matches
**Mary Watson**, a different employee, exactly. An exact hit short-circuits: "An exact hit on a key
answers on its own", so the loose search that would have applied `claimMatchesRow`'s whole-token
filter never runs, and a single candidate is pinned without confirmation.

"Silently" is slightly too strong — the response does report `actingFor.name: "Mary Watson"`. But
nothing compares that against what was claimed, and the mismatch is **indistinguishable from the
middle-name mismatch the manifest and `docs/notes.md:587` teach the model to expect**
("Katherine Joseph" → "Katherine M Joseph"). Seen in reverse it reads as the same benign phenomenon.

Separately: `docs/initial-design.md:325` specifies "One candidate → confirm, then pin" for the
anonymous path, and the code pins at `act-as.ts:275` with no confirmation — the confirmation at
line 203 is guarded on `verified`.

**→** Require the candidate to account for **every** token of the claim before treating an exact hit
as decisive — `claimMatchesRow` already computes that — or fall through to confirmation whenever the
claim has more tokens than the matched name.

### 9. `act_as`'s verified-match confirmation is silenced by any non-empty `person` argument

`src/tools/identity/act-as.ts:203`

```ts
if (verified && only.matchedOn === 'name' && (choice === undefined || choice === '')) {
```

The guard keys on the **presence** of `choice`, never on whether it matches the candidate. And
`chosenBy` only filters when `candidates.length > 1`, so with exactly one candidate the argument is
never compared to anything. On a deployment whose token claim is a human name
(`OAUTH_IDENTITY_CLAIM=name`, or an IdP whose `preferred_username` is "Ann Marie"), a single wrong
match is pinned as `provenance: 'verified'` with the confirmation suppressed — and the tool's own
schema invites the argument that suppresses it ("Give whatever they gave you"). Passing
`person: "x"` has the same effect.

This is not identity spoofing: `act-as.ts:130` still takes the lookup term from the token
(`verified ? identity.directoryKey : args.person`), so every candidate came from the token's own
claim. It also needs a name-shaped claim — an email or UPN has no whitespace, so `exactFilter` emits
no FirstName/LastName clause. Within those limits it is a stated control that does not hold, which is
why the skeptic raised it from the reviewer's "low".

**→** Treat `person` as confirmation only when it actually identifies the candidate — RecId, login,
email or display name — rather than as a flag whose mere presence means "confirmed".

---

## Medium

### 10. `vote_on_approval` refuses the person's own approvals, and says something self-contradictory doing it

`src/tools/approvals/vote-on-approval.ts:99`

`list_approvals` matches an approver three ways, because its own docstring records that Ivanti is
inconsistent: `Owner eq <login>` **or** `Owner eq <displayName>` **or** `Owner_Valid eq <recId>`.
`vote_on_approval` then checks one:

```ts
if (owner.toLowerCase() !== person.loginId.toLowerCase())
```

So a row the server has just told the person is theirs is refused as somebody else's. `PinnedPerson`
carries `recId` and `displayName` as required fields and neither is consulted.

Two corrections from the live tenant. The display-name variant is rare — 1 of 26 rows, and already
decided, so it only surfaces under `includeDecided: true`. The **dominant** spelling is a third one
that neither the code nor the docs anticipate: `Owner` holds an **email address**.
`docs/notes.md:710` says "Owner is the approver's login" and `list-approvals.ts:84` says "a LOGIN on
most rows and a DISPLAY NAME on some" — neither mentions email.

And the message is worse than it reads, because `person.displayName` is the same three-space string:
*"That approval is waiting on Becky   Smith, not on Becky   Smith."*

It fails **closed** — nobody can vote on someone else's row — which is why this is medium and not
high. The harm is a dead end with no fallback offered.

**→** Accept the same three identifiers the listing composes, preferring `Owner_Valid` (the employee
RecId, which never varies). Fix the two docstrings to include the email spelling.

### 11. `switch_role` leaves the form cache on the role the conversation has left

`src/tools/shared/connection-for.ts:43`, `src/tools/identity/switch-role.ts:76`

`connectionFor` memoises one connection per session **object**, and `switchTo` mutates the role
inside that same object — so the WeakMap key never changes and nothing is invalidated. Every
form-derived answer for the rest of the conversation describes the previous role, including a cached
`undefined` meaning "no form this role can reach".

Concretely: ask for `Change#` pick lists under `ServiceDeskAnalyst`, get "no create form this role
can reach" (cached); `switch_role('ChangeManager')`, which answers *"What records are visible follows
this role, from the next call onwards"*; ask again, get the same refusal forever.

Two narrowings the skeptic established. The blast radius is `forms`, not both members — the scoped
`workspaces` catalog has exactly one consumer, the form walk. And `transport-for`'s WeakMap needs no
invalidation: the SID does not change across a role switch, so the cached transport stays correct.

**→** Export an invalidation from `connection-for.ts` (delete the `perSession` entry) and call it in
`switch_role` after `switchTo` succeeds.

### 12. Two concurrent `act_as` calls share one handshake, and the slot ends up mislabelled

`src/auth/impersonation.ts:58`

```ts
if (current !== undefined) { /* different-person guard */ }
...
pending ??= open(login);      // joins an in-flight handshake without comparing the login
...
openedFor = login;            // set from the joiner, whose handshake never ran
```

The guard is inside `if (current !== undefined)`, so it cannot fire while the first handshake is
still in flight. A second `act_as` for a different person joins that promise and is handed the first
person's session.

**No data crosses.** The continuations resume in registration order, so the caller who created
`pending` is also the first to reach `pin.pin`; the joiner is always refused by
`IdentityConflictError` before returning anything. `current`, the opener's login and the pin always
agree.

The surviving defect is that `openedFor` is left naming the **refused** person. The module documents
"Repeating the same login is a no-op" — after this, a later `act_as` for the person who *is* pinned
and *is* impersonated is refused by the slot, naming someone else. In `enduser` mode, where a model
is told to retry `act_as` whenever a record tool refuses, that is a stuck conversation.

**→** Claim the login when the handshake is created, not after it resolves: keep `pendingFor`
alongside `pending`, compare against it before joining, and set `openedFor` from the handshake that
actually ran.

### 13. Three failure paths leak the CentralConfig session, and shutdown leaks the rest

`src/ivanti/session/impersonated-session.ts:140`, `src/server/start-http.ts:190`, `src/index.ts:121`

A CentralConfig session is minted at `impersonated-session.ts:96` and released on three of the ways
the rest of the function can fail — lines 143, 247 and 301. `InitializeSession` throwing (line 140),
`GetRolesForUser` throwing (line 226) and `SelectRole` throwing (lines 266/310) all propagate with
the session still open on the tenant. `act_as` then reports "could not open an Ivanti session as
them", the model retries with the person's email instead of their login, and each attempt mints
another session that survives until the tenant timeout — measured at 18,000 s here.

The shutdown path leaks the rest, twice over:

- `startHttp` hangs every cleanup off `http.on('close')`, and `index.ts` calls
  `http.close(() => process.exit(0))`. `http.close()` does not end in-flight responses, and the
  dedicated `GET /mcp` SSE stream **is** an in-flight response held open for the life of the client
  (`docs/notes.md:160` records a measured 131-second stream). With one client attached — the ordinary
  state — neither the callback nor the `'close'` event fires. `stopSweeping()` and
  `sessions.closeAll()` never run and the process waits for SIGKILL.
- And on the path where the callback *does* fire, the release still does not happen:
  `releaseOnClose` → `void slot.release()` is fire-and-forget async, while `process.exit(0)` runs as a
  later listener on the same synchronous `'close'` emit. The release request never reaches Ivanti.

**→** Wrap everything after `impersonated-session.ts:96` in one `try/catch` that releases and
rethrows, replacing the three individual calls. In `shutdown()`, run `sessions.closeAll()` and
`stopSweeping()` **before** `http.close()`, await the releases, and bound the whole thing with
`http.closeAllConnections()` or an unref'd deadline so the process always exits within the grace
period.

### 14. `answersVerified: true` is reported when the read-back never ran

`src/tools/service-request/submit-service-request.ts:236`

```ts
const check = await verifyStoredAnswers(...).catch(() => undefined);
...
...(check === undefined || (check.mismatches.length === 0 && check.missing.length === 0)
  ? { answersVerified: true }
```

"The read-back found nothing wrong" and "the read-back did not happen" are the same value. A 500, a
timeout, an expired impersonated SID or unrecognised prose in `value` all produce
`answersVerified: true`, next to an `answerNote` that says *"the comparison below does"* confirm the
answers individually.

The trigger is an infrastructure event rather than a routine one, and the compounding harm the
reviewer described — a date stored as `0001-01-01T00:00:00` passing as verified — needs that failure
to coincide with an actual storage corruption. Hence medium, not high. The `.catch` itself is right
and should stay; letting it propagate would turn a filed request into a reported failure.

**→** Keep the failure distinguishable and emit a third state — `answersVerified: 'unknown'` with the
reason — rather than folding it into the success branch.

### 15. Files are uploaded before the later ones are validated, then reported as "Nothing was submitted"

`src/tools/service-request/submit-service-request.ts:177`

Decode, empty and size checks live **inside** the staging loop, and staging is a real upload
(`GetPackageDataSDA` → `GetUploadTicket` → multipart POST). Two attachments where the second is 3 MB:
the first is already in Ivanti when the second fails the cap, and the caller is told
*"'capture.bin' is 3072 KB, over the 2 MB limit … Nothing was submitted."*

The "no service request was created" half is true. What is wrong is the implication that nothing
reached the tenant. The same happens on every `SubmitRefusedError` — whose message ends "Nothing was
created" — and Ivanti's refusals are documented as routine.

Honest limit: the fate of an abandoned staging record is **unmeasured** in this repo. The
permanent-orphan claim is extrapolated from `POST /api/rest/Attachment`, which is a different
endpoint; a staging ticket may well expire. Worth one round trip to settle.

**→** Decode and validate every attachment in a first pass before staging any, and on a later failure
name the files already staged rather than asserting nothing was sent.

### 16. Datetime verification reads the caller's value in the *server's* timezone

`src/ivanti/service-request/submit.ts:246`

```ts
const sentAt = Date.parse(sent);
return !Number.isNaN(sentAt) && storedAt - localOffset * 60_000 === sentAt;
```

The tool tells models to send `YYYY-MM-DDTHH:MM` in the tenant's local time. ECMAScript resolves a
zone-less date-**time** string in the host's zone (a date-only string is UTC — hence the bare-date
branch being correct). So the same submit verifies differently depending on where the process runs,
and on a host in the tenant's own timezone — the documented deployment, "beside the tenant it talks
to" — a correctly stored value is reported as `storedDifferently`. The docstring says that false
mismatch "sends a tester into a second, non-idempotent submit", i.e. a duplicate request.

**→** Parse `sent` in the tenant's frame: append `Z` when the string carries no zone, so the
comparison never touches the host clock.

### 17. A field name that differs only in case is dropped, and reported as *not* dropped

`src/ivanti/odata/projection.ts:37`

`projectRow` matches with `field in row` — case-sensitive. `ignoredFieldNames` matches
`key.toLowerCase()` — case-insensitive. So a name with the wrong casing is removed from every row
**and** omitted from `ignoredFields`.

Ivanti spells keys both ways (`RecId`, but `ProfileLink_RecID`), so a model normalising casing is
routine. `fields: "ProfileLink_RecId, subject, status"` returns rows containing only `RecId`, no
`ignoredFields`, no note — and the model narrates "these incidents have no subject or status set".
On `get_record` the other half fires: nothing matches, the whole-row fallback returns all ~180
fields, and the tool's own description had promised *"Names the object does not have come back in
`ignoredFields` with a warning — never silently dropped"* and *"A bare incident is ~180 fields and
~10 KB of JSON"*.

**→** Resolve each requested name against the row's own keys case-insensitively, emitting the row's
spelling — so a mis-cased name either returns its value or is reported, never neither.

### 18. The attachment tools are an existence oracle, and it does not need a pinned person

`src/tools/attachments/download-attachment.ts:71`, `src/tools/attachments/delete-attachment.ts:59`

An id that is not an attachment answers *"No attachment with RecId …"*; an attachment belonging to
someone else answers *"No such record is available to you."* Two different answers, so a RecId can be
confirmed live against the tenant's attachment table. `get_attachment_details` closes this with
`missingRecordMessage(deps)`; its two siblings do not.

Measured, and wider than reported: with `MCP_MODE=enduser` and **no `act_as` at all**, both offenders
still answer the first message. They return before `requirePerson` runs — which contradicts
`own-records-guard.test.ts`'s stated invariant that every record-returning tool refuses until an
identity is pinned.

**→** Use `missingRecordMessage(deps) ?? <the existing sentence>` in both, exactly as
`get-attachment-details.ts:79` does.

### 19. `personObjects()` memoises a transport failure as "this tenant has no such object"

`src/ivanti/people/directory.ts:170`

The catalog deliberately distinguishes retryable from definitive: `status === 0` is forgotten so the
next caller retries, any real HTTP reply is cached as "no". `personObjects()` sits above that and
memoises the **derived** list unconditionally, cancelling the retry the catalog arranged.

`externalcontact` is not in the seed graph, so resolving it is a separate fetch. One timeout during
the first `act_as` and `present` is `['employee']` for the life of the process: every external
contact is "no such person" from then on — which in `enduser` mode means those people cannot use the
server at all. Nothing above `debug` is logged.

**→** Do not memoise a list derived from a failed lookup — catch only the catalog's "this tenant does
not have it" signal and let anything else reject, the way `admin-catalog.ts:88` already clears its
own cache on failure.

### 20. `scrubErrorBody` leaves a listed field intact when its value contains a backslash

`src/ivanti/http/errors.ts:97`

`SENSITIVE_FIELDS` matches the value with `[^"\\]*`, which excludes backslash. On a tenant whose
logins are domain-qualified (`CORP\jsmith`), the ASMX 500 body `docs/notes.md:852` records nests its
logging context as a JSON **string**, so the login arrives escaped: `\"LoginId\":\"CORP\\jsmith\"`.
The character class stops at the backslash, the whole match fails, and the field is passed through —
into `IvantiApiError.body`, which `run-tool.ts:182` returns verbatim to the model. Reproduced against
the real wire shape: the neighbouring `SessionId` and `Hostname` redact correctly while `LoginId`
does not.

**→** Match a JSON string value as JSON defines it — `(?:\\\\.|[^"\\])*` — and add cases for a value
containing `\\` and one containing `\"`.

### 21. `ENDUSER_BUSINESS_OBJECTS` mangles any object whose CSDL name ends in `s`

`src/config/env-schema.ts:142`

`toCsdlEntity()` strips a trailing `s` unconditionally, which is right for `Incidents` and wrong for
`journal__notes`, `address`, `nrn_roomreservations`, `frs_surveyresults` — all real. `catalog.ts:164`
already fixed exactly this trap for `entity()`; the config transform re-applies it.

Two cases. Write the technical name and the process exits 78 with *"names 'journal__note', which this
tenant does not have. Did you mean: journal__notes?"* — advice to type what was already typed. Write
the `#` or entity-set dialect and it starts, with the object permanently unreachable while every
refusal message lists it as allowed.

Medium rather than high, because it is fail-**closed** in both directions: `toCsdlEntity` is applied
symmetrically to the stored entry and to the queried ref, so a mismatch always lands on "refuse". It
never widens access. The first case is loud; only the second runs silently.

**→** Keep both spellings — store `[raw.toLowerCase(), toCsdlEntity(raw).toLowerCase()]`, accept
either at startup, and test both in `ObjectGate.allows`. Better: have
`validateBusinessObjectAllowlist` return what the catalog actually resolved and build the gate from
that.

### 22. "An empty variable is unset" is not applied to the three `*_FILE` secrets

`src/config/load-config.ts:46`

`withoutEmpty(env)` builds `resolved`, and then the secret loop reads the **raw** `env`:
`resolved[key] = readSecret(env, key, readFile)`. So `BEARER_TOKEN`, `IVANTI_API_KEY` and
`IVANTI_CENTRAL_CONFIG_API_KEY` never get the normalisation every other setting gets.

Clearing the inline form to switch to the file form — the documented `docker run -e X=` gesture —
exits 78 with *"Both BEARER_TOKEN and BEARER_TOKEN_FILE are set; provide exactly one"*, when only one
is. The mirror case fails identically.

And one direction fails **open**: `AUTH_MODE=bearer` with `BEARER_TOKEN='   '` starts the server with
a three-space bearer token. Without the bug, `withoutEmpty` would drop it and `validate-config.ts:134`
would refuse to start.

**→** One line: `resolved[key] = readSecret(resolved, key, readFile)`.

### 23. Two guards that report an invariant they do not enforce

`src/tools/shared/order-by.ts:43` and `src/tools/approvals/list-approvals.ts:137`

`zeroNote`'s default branch tells the model: *"THIS IS A REAL ZERO: the field and sort names were
checked against the object before the request … It is a fact about the data, not a typo."* Two places
take that branch without having done the checking.

`assertOrderBy` **skips** empty comma-separated clauses rather than refusing them, and both callers
send the caller's raw `orderBy` string rather than a re-join of what the guard validated. So
`"Priority asc, CreatedDateTime desc,"` — a trailing comma, the commonest way a generated list ends —
reaches Ivanti unvalidated. Verified by execution: `assertOrderBy` accepts that, a leading comma, a
doubled comma, and a bare `","`.

`list_approvals` sends a hardcoded `$orderby=DueDateTime asc` on a tenant-owned Business Object,
through `buildQuery`, which only runs `assertSupportedFilter` and never checks a sort.

Both are stated conservatively here, because the decisive premise — that Ivanti answers a *malformed*
`$orderby` with 204, as it does for a *wrong field name* — is asserted in this repo rather than
measured for the malformed case. What is certain today is the false claim in the payload.

**→** Refuse an empty clause and send the validated re-join; resolve the votes entity and run
`assertOrderBy` on `DueDateTime asc`, or drop the sort and order client-side at `top: 25`.

### 24. The manifest budget guard is structurally blind to every non-impersonation branch

`src/tools/description-budget.test.ts:88`

The helper hardcodes `capability: { …, canImpersonate: true }` under the comment *"this must measure
the WIDEST manifest a caller can be sent, not a narrower one that happens to fit."* Impersonation
descriptions are **shorter**, so it measures the narrower one. Measured on the real `selectTools`:

| | total | headroom of 38,000 | `run_quick_action` |
|---|---|---|---|
| `canImpersonate: false` (the default deployment) | **37,902** | 98 | **1,948** of 2,000 |
| `canImpersonate: true` | 37,693 | 307 | 1,758 |

And the escape hatch is not 190 characters — it is unbounded. Because the else-branch literal is
never concatenated in the measured build, it contributes **0**: the test sees 1,758 whether that
branch is 328 characters or 3,280. Both the per-description cap and the manifest total are unguarded
there.

`CLAUDE.md:145` then states the figures backwards — "37,991 … the widest manifest, with impersonation
on", followed two lines later by the observation that impersonation-on descriptions are shorter.
Neither number is right.

**→** Make `canImpersonate` a third dimension of `MODES`, or take the max of both manifests. Then
restate CLAUDE.md from the test rather than by hand.

### 25. Three documents tell the model about tools this deployment does not have

`src/tools/approvals/list-approvals.ts:38`, `src/tools/records/create-record.ts:43`,
`src/tools/attachments/delete-attachment.ts:25`

`resources.test.ts` fails the build if a *resource* names an unregistered tool, on the stated grounds
that a model cannot tell "not registered here" from "you called it wrong". The higher-traffic surface
— tool descriptions — has no such guard. Tallied across the six mode × tier deployments:

| | admin | session | odata |
|---|---|---|---|
| `full` | 0 | 0 | 6 |
| `enduser` | **2** | **2** | 8 |

The two `enduser` cases are gated on mode alone, so they fire at **every** tier, including `admin` —
100% of enduser deployments, not a narrow odata-only case. `list_approvals` also repeats the dead
pointer in every response body (`voting: 'vote_on_approval casts their decision…'`).

**→** Extend the resources cross-reference test to tool descriptions and to that response field, then
branch the offending sentences the way `act_as`, `run_quick_action`, `search_knowledge`, `add_note`
and `list_notes` already branch.

### 26. `saved_search` tells the model the records are not the person's, while returning exactly theirs

`src/tools/search/saved-search.ts:26`

The description asserts unconditionally: *"A name beginning 'My' resolves against the account this
server signs in as, never the person asking; the result says so."* Under impersonation the tool runs
on `transportFor`, which sends only `Cookie: SID=<the person's session>` — so Ivanti resolves "my" as
them, and the rows **are** theirs. The runtime `answeredFor` note repeats the denial.

`list_saved_searches` already gets this right, marking "My Open Incidents" with
`answersFor: '<login>'`. The sibling was not updated with it.

**→** Branch the paragraph on `capability.canImpersonate` and emit `answeredFor` from
`context.impersonation?.session()?.loginId` when one is open.

### 27. The Handbook still states the impersonation limitation this release disproved

`docs/handbook.html:1086`

The `IVANTI_CONFIG_URL` entry says impersonation is *"Record surface only — forms, pick lists, quick
actions and the catalog keep the service account, because Ivanti refuses a session minted this way on
those."* That is the pre-0.2.0 belief, which `connection-for.ts` documents as wrong and PR #26
unwound.

It matters because `README.md:12` designates the Handbook as "start here". An operator deciding
whether to issue a ConfigDB key reads that a quick action will be attributed to the service account,
and either declines to configure impersonation or builds an audit expectation that is false.

**→** Replace with the `.env.example` wording: every surface follows the person; only tenant-wide
facts — schema, admin catalog, person directory, tenant UTC offset — stay on the service account.

### 28. `catalog.entity()` interpolates the caller's object name into the `$metadata` URL unencoded

`src/ivanti/metadata/catalog.ts:190`, `src/ivanti/odata/url.ts:60`

`metadata()` is the only builder in `url.ts` that interpolates a caller-derived segment without
encoding — contradicting that file's own stated principle at line 39 and `docs/notes.md:568`. A `#`
in the name truncates the URL at a fragment, so a lookup that should hit `$metadata` sends an
authenticated GET to a different path entirely.

The security framing the reviewer reached for does **not** hold up: in `full` mode the gate is open,
but the response only ever reaches `parseCsdl` and the caller gets `Unknown object`, so it is a blind
primitive with no readback. The demonstrable consequence is that the second candidate,
`${ref.toLowerCase()}s`, is dead weight for any `#`-form name — `toGuessedEntitySet` already handles
that dialect — so every `#`-form lookup that misses its first graph sends one pointless authenticated
request to a path that is not `$metadata`.

**→** `encodeURIComponent` the graph segment in `metadata()`, and drop the second candidate when
`ref` contains `#`.

### 29. OAuth discovery has no timeout, so a black-holed IdP hangs startup

`src/auth/oauth/create-verifier.ts:23`

```ts
const defaultFetch: FetchLike = (url) => fetch(url);
```

No `AbortSignal`, and `createOAuthSetup` is awaited in `main()` **before** `startHttp`. A firewall
that accepts the connection and drops the traffic leaves each candidate bounded only by undici's
300-second `headersTimeout`; with Entra's three discovery candidates that is ~15 minutes during which
nothing listens on `MCP_PORT`, `docker/healthcheck.mjs` exits 1 with `ECONNREFUSED`, and the
container is neither healthy, serving, nor exited.

The Ivanti probe already solved this with `PROBE_TIMEOUT_MS`; the OAuth path did not inherit it.

**→** `fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })`.

### 30. Three guard tests assert less than they claim

`src/tools/own-records-guard.test.ts:81` and `:174`, `src/tools/enduser-gate.test.ts:188`

- **The quick-action tools are never built.** `GATED` sets only `MCP_MODE` and
  `ENDUSER_BUSINESS_OBJECTS`, so `ENDUSER_QUICK_ACTIONS` is empty and `register-tools.ts:129` skips
  all three tools. The guard's promise — "a tool added to `selectTools` without an entry fails the
  last assertion rather than passing silently" — is therefore false for exactly the three tools that
  run a tenant's own close/cancel procedures. `enduser-gate.test.ts:188` goes further and asserts
  they *should not exist*, which a real deployment with `ENDUSER_QUICK_ACTIONS` set contradicts.
  `createActionGate` has no test anywhere.
- **The person-argument guard never passes a person.** The test written for the hole where a `person`
  argument bypassed the pin asserts that each name is a key of a hand-written map — a property of the
  test file. Revert `resolveSubject` to the shape its docstring calls wrong and only one unrelated
  test fails. `grep -rn 'NotYourQueue' src --include=*.test.ts` returns nothing.
- **Nothing asserts the own-records constraint reaches the request.** `scopeToOwnRecords` is tested
  on the string it returns; no test checks that the string is put in a URL. Four of the five call
  sites — `list-records.ts:121`, `count-records.ts:71`, `fulltext-search-object.ts:82`,
  `group-count.ts:129` and `:161` — can have the constraint removed with **767/767 still green** and
  typecheck clean. The fixture matches by URL substring and returns its row regardless of `$filter`.

**→** Add `ENDUSER_QUICK_ACTIONS: ['Close From Self Service']` to `GATED` and classify the three
tools; drive the person-argument loop against real handlers with a foreign name; assert on the
recorded URL, as `records.test.ts:192` already does for a caller filter.

### 31. `requestBinary` sends the tenant API key while every other call on that transport sends the SID

`src/ivanti/http/transport.ts:226`

`requestBinary` is the only method on `IvantiTransport` that does not go through `send()`, so it
never reaches the branch whose own comment reads *"One credential or the other, never both: sending
the key as well would have Ivanti answer for the service account and quietly undo the
impersonation."* `sid` is destructured at line 110 and never read:

```ts
headers: { Authorization: `rest_api_key=${apiKey}`, Accept: '*/*' },
```

Probed against the real `createTransport` with a recording fetch: on `asPerson('tenant#SID123#1')`,
the OData attachment-row read **and** the OData DELETE of that same attachment carry
`Cookie: SID=…`, while `GET /api/rest/Attachment?ID=…` carries the API key. It predates
impersonation — landed in #12, two days before #25/#26 — and was not revisited.

**It is not a demonstrated file leak, and the first skeptic was right to say so.** The byte fetch is
unreachable unless a read of that attachment row on the person's own credential has already returned
it, the object gate has allowed the parent's category, and in `enduser` mode `assertOwnRecordById`
has confirmed the parent is theirs — all on the person's transport. An actual leak needs Ivanti to
show someone the attachment **row** over OData while refusing them the **bytes** over REST, which
nothing here has measured and which is the less likely direction for two views of one Business
Object.

What is certain: the download is performed and logged in Ivanti as the service account rather than
the person, breaking the audit attribution that is the whole point of the feature; its authorisation
rests on an assumption where every comparable claim in this codebase rests on a measurement; and
`credential-guard.test.ts` cannot see it, because `download-attachment.ts` correctly calls
`transportFor` and the defect lives one layer below what a grep over `tools/` can reach. The clinching
detail is that the DELETE of the same attachment already runs on the SID — this codebase does not
itself believe that surface needs the API key.

**→** Route `requestBinary` through the same credential branch as `send()`, and measure whether
`/api/rest/Attachment?ID=` accepts a SID cookie before assuming the swap is free.

### 32. The licence prune deletes the only copy of four dependencies' licence text

`scripts/third-party-notices.mjs:53`, `docker/Dockerfile:46`, `scripts/release-tarball.sh:33`

Two halves, both verified by staging the production tree and running the real prune.

The generator extracts only `/^.*copyright.*$/im` and emits no licence bodies, while its own comment
says the permission text "is included once below". There is no below: the file is 122 lines of header
and two tables, with **0** hits for "permission is hereby granted", "AS IS" or "WARRANT". `hasText`
is computed at line 55 and read nowhere in the repo.

That would be harmless if the packages' own files survived, and for 94 of 99 they do. Four ship their
licence **only** as Markdown — `jose@6.2.12` (MIT), `ms@2.1.3` (MIT), `qs@6.16.0` (BSD-3-Clause),
`json-schema-typed@8.0.2` (BSD-2-Clause) — and `-name '*.md' -delete` removes them. For those four
the MIT permission notice and the BSD conditions-and-disclaimer then exist nowhere in the image or
the tarball; only the copyright line survives, in the table.

So the Dockerfile's comment "LICENCE files stay" is true for 94 and false for exactly the four that
needed it, and commit `39f9d25`'s stated premise — "the per-package LICENSE files inside
`node_modules` already survived the size prune, which was the reason to keep them" — is the
assumption that fails. `pnpm check:licenses` cannot catch it: `--check` regenerates the body with the
same code and string-compares, so it is a drift check, not a compliance check.

**→** Exclude licence-named files from both prunes (`-not -iname 'licen[cs]e*'`), and append the
deduplicated permission texts to the generated document using the `hasText`/`text` the script already
reads.

---

## Low

### 33. A JWKS outage is reported to every client as an invalid token

`src/auth/oauth/verify-token.ts:134`

Every throw out of `jwtVerify` collapses to `401 invalid_token "Access token is not valid"`, and the
original error is discarded rather than logged. When egress to the IdP is blocked, jose's `reload()`
rejects and every client reads 401 as "your token is bad", discards it, re-runs the authorization
code flow — successfully, since the browser can still reach the IdP — and presents a fresh token to
the same 401. A re-authentication loop across all users, whose only log line is
`rejected unauthorized request … reason: 'Access token is not valid'`, naming neither the JWKS URI
nor the network error.

**→** Log the cause once on the default branch, and map jose's fetch/timeout failures
(`JWKSTimeout`, `TypeError: fetch failed`) to 503 so clients back off instead of re-authenticating.

### 34. `exp` is not a required claim

`src/auth/oauth/verify-token.ts:128`

`jwtVerify` is called with `issuer`, `audience` and `clockTolerance` but no `requiredClaims`, and
jose only checks `exp` when it is present. A token carrying `iss`, `aud` and `sub` and no `exp`
verifies forever: disabling the user at the IdP changes nothing, and a token captured from a log is a
permanent credential for the whole tool surface.

Marked *plausible* rather than confirmed, and low, because it needs an authorization server that
mints access tokens without `exp` — which RFC 9068 §2.2 forbids and no mainstream IdP does. It is
cheap insurance against one that does.

**→** `requiredClaims: ['exp']`, plus a `describeFailure` case so the refusal reads as "carries no
expiry".

### 35. `ENDUSER_ROLE` is documented in five places as validated at startup, and is validated nowhere

`.env.example:324`, `examples/env/impersonation-oauth.env:23`, `charts/ivanti-mcp/values.yaml`,
`src/config/env-schema.ts:147`, and the Handbook

One of them promises it "exits 78 rather than failing per-person later". `src/index.ts` performs
exactly one tenant-side startup check — `validateBusinessObjectAllowlist`, for
`ENDUSER_BUSINESS_OBJECTS` — and the role is not among them. `ENDUSER_BUSINESS_OBJECTS` really does
get that treatment, which makes the asymmetry invisible to a reader of either document.

Low rather than medium, because "silently falls back" is wrong: `chooseRole` returns a `note` on
every substitution, which is logged and surfaced as `roleNote` in the `act_as` response. The defect
is precisely that a **startup** signal was demoted to a **per-call** note — which is what
`examples/env/impersonation-oauth.env:25` promises will not happen.

**→** Either add the check beside `validateBusinessObjectAllowlist`, or correct all five texts to say
the role is resolved per person with a note.

### 36. The blind-role warning prescribes a setting that `enduser` refuses

`src/ivanti/session/impersonated-session.ts:318`

When Ivanti will not report which roles are self-service, the session appends: *"Set
`IVANTI_IMPERSONATION_ROLE` to decide it explicitly."* In `enduser` mode — where that note matters
most — `validate-config.ts:178` refuses that exact setting and the process exits 78. The mode's own
setting is `ENDUSER_ROLE`.

The note also fires unconditionally on the `!flagsKnown` path, including when `ENDUSER_ROLE` matched
a role **by name**, so it asserts the role "was taken from the order it listed them … rather than
chosen" when it was in fact chosen by configuration. `choice.note` is captured at line 267 and never
re-examined.

**→** Append the note only when the role really was unchosen, and name the setting the running mode
accepts.

### 37. CLAUDE.md's manifest figures are wrong and contradict themselves

`CLAUDE.md:145`

"37,991 characters … the widest manifest, with impersonation on", then two lines later the note that
impersonation-on descriptions are shorter. Measured: 37,902 with impersonation **off** (98 under
budget) and 37,693 with it on (307 under). Neither stated number is right, and the two sentences
assert opposite things about which case is widest.

It is actionable in the wrong direction — the same paragraph tells the reader the budget is about to
fail "by design", which is what makes a wrong baseline costly.

**→** Restate from the corrected test rather than by hand (see finding 24).

### 38. A cached person-link guess is indistinguishable from a measured one

`src/ivanti/people/customer-link.ts:121`

A transport failure while sampling rows is swallowed into the same empty-row-set shape as a genuine
"no records yet", and the name-ladder answer it produces is cached for the process lifetime with no
retry — behind a `logger.debug` line that the default `LOG_LEVEL=info` hides. Reproduced against the
real module: the second call returns the same object with one transport call made.

Most of what was first claimed for this does **not** hold, and is worth recording so nobody re-files
it. The ladder can only name a link pair the object actually has, and on `incident`, `change` and
`servicereq` it picks the same field the data would, so scoping stays correct. An object whose person
link is outside the four preferred prefixes raises a loud `UnscopableObjectError`, and a mismatched
field fails closed in `assertOwnRecord`.

The residue is real but small: `categoriesSeen: []` makes `ownershipFields` stamp a created record
with the CSDL casing `employee` rather than the tenant's stored `Employee` — the exact guess
`docs/notes.md:797` says must be read off real rows. And `foundBy`/`ambiguous`, the two fields
computed to flag precisely this, are read by no production code.

**→** Do not cache a result derived from a rejected sample, and log that rejection above `debug`.

---

## What was checked and found sound

The negative space matters as much as the list — a review that only reports defects reads as though
nothing else was looked at. Each reviewer recorded what they verified and could not break.

**Credential separation on the wire.** `transport.ts:127` sends `Cookie: SID=` **exclusively or**
`Authorization: rest_api_key=`, never both, so an impersonated request cannot silently carry the
tenant key — with the one exception at finding 31. `scrubErrorBody` still runs on that path;
`impersonated-session.ts` scrubs its own SID from error bodies; `central-config.ts` redacts the whole
query string (which carries the login) before logging and drops `ConnectionString`/`ProviderName`
rather than storing them.

**The impersonation lifecycle, apart from the leaks in finding 13.** Both WeakMaps are module-level
but keyed by the per-conversation session **object**, so nothing is reachable across conversations,
and `release()` makes the key unreachable. `releaseOnClose` chains onto an existing `onclose` rather
than replacing it. `act_as` orders `pin.check` → open → `pin.pin`, which is the fix `notes.md`
records for the bricked-conversation bug; a failed open returns an error and never downgrades to the
service account. `openImpersonatedSession` always calls `SelectRole`, including when the role already
matches — the activation finding PR #26 was built on — and re-reads the flags afterwards.
`chooseRole` refuses rather than running a role-less session, and never infers "self-service" from a
role's name.

**The three identity rules.** `pin()` delegates to `check()` rather than restating the rules, so the
two cannot drift. `act_as` is the **only** caller of `pin.pin` anywhere in `src/`. The pin is per
`McpServer` and a server is per connection, so stdio and HTTP get the same object lifetime. In a
deployment without impersonation there is no `await` between `check` and `pin`, so that path is
atomic; the impersonation window was raced against the real handler and the pin stayed consistent
with the live session.

**The quick-action surface**, which has no test of its own. Read in full: `OPEN_ACTIONS` only for
non-enduser, trimmed and case-folded matching, empty means none. Ordering in `run_quick_action` is
right — `assertRecordWritable` before anything is listed, the gate checked on the **resolved**
action's name before the no-op check and before any probe, `executeAction` never builds `GridParams`,
the commit echoes a token from its own fresh probe, `describeFailure` reads
`validationErrors[recId].fieldErrors[field].fieldMessages[]`. The absence of a test is real; no
behavioural defect was found behind it.

**Prototype pollution.** All 13 dynamic property writes in non-test source go into plain `{}`
literals, so a `__proto__` key is an inert assignment; nothing uses `Object.assign` onto a shared
object or a recursive merge. One `in`-operator prototype-chain hit exists (`pick-lists.ts:108`) and
is mitigated by the caller computing `unknownFields` from CSDL and naming them.

**ReDoS.** ~55 regexes applied to tenant- or caller-controlled text, none with nested or ambiguous
quantifiers. `search-knowledge`'s HTML stripper is a chain of linear replacements; `directory.ts`'s
`split(/\s+/)` and `filter.ts`'s literal-stripping alternation are linear.

**Supply chain.** `pnpm-workspace.yaml` sets `onlyBuiltDependencies: [esbuild]` and pnpm 10 runs no
other lifecycle scripts, so CI's `pnpm install --frozen-lockfile` is not the hole it looks like. All
four runtime deps are pinned or caret-pinned against a v9 lockfile; the SDK is pinned exactly. GHA
cache writes from fork PRs are scope-isolated; no `pull_request_target`, no secrets in `verify`.

**Container and chart.** The three stages, `--node-linker=hoisted`, `COPY package.json` next to
`dist/`, distroless `:nonroot`, the exec-form HEALTHCHECK and `healthcheck.mjs` exiting 0 when HTTP
is off all match their documentation. `.dockerignore` excludes `.env`, `.env.*`, `*.pem`, `*.key`.
The chart's pod security context is complete: `runAsNonRoot`, uid/gid 65532, `fsGroup` for the
projected secret, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true`, `capabilities: drop ALL`, secret `defaultMode: 0400`, `readOnly`
mount. SPDX headers survive into `dist/`.

**`/health` is correctly gated** — see the refutations below.

**The static guards that do work.** `impersonation-guard.test.ts` drives every registered tool with
no slot, an empty slot, and a slot whose opener rejected, asserting that no tool opens a session of
its own accord. `admin-ui-guard.test.ts` drives every tool over a tenant whose admin console refuses.
`resources.test.ts` drives all six mode × tier combinations. Those three are not vacuous.

**A credential-routing sweep done exhaustively rather than by regex.** Every file under
`src/tools/**` was checked two ways: those touching `deps.connection` without importing
`transportFor`/`connectionFor` (six files — all accounted for in finding 1, the one declared
exemption, or surfaces `connectionFor` deliberately keeps on the service account), and those using
both (22 files, all computing the person's transport on their first handler line and using it
consistently). **The holes in finding 1 are the complete set at tool level.** There is no third tool
nobody noticed.

---

## What was refuted

24 of the 86 findings raised did not survive. They are not listed individually, but the recurring
reasons are worth recording, because each is a place where the code looks wrong and is not:

- **The session store's `lastSeen` is not stale under a held SSE stream** — the keep-alive is a
  server-to-client comment, and `get()` is called per request.
- **`unlink_records`/`link_records` skipping `assertRecordWritable`** — a relationship edit is not a
  write to the record, and Ivanti polices the closed cases itself.
- **Filter-composition imbalance in `scopeToOwnRecords`** — the caller's filter is parenthesised
  first, which is exactly what makes `A or B and mine` safe there. (`group_count`, finding 2, is a
  different code path that does not use it.)
- **An unbounded metadata `Map`** — reachable only by an authenticated caller naming distinct
  objects, and bounded in practice by the tenant's object count.
- **`MAX_CANDIDATES = 5` as an enumeration oracle** — the logging clause it rested on does not exist.
- **Version pins at 0.1.0 in the README and deployment docs** — real drift, but the failure narrative
  attached to it did not follow.
- **`switch_role` registered without a `canImpersonate` check** — a **written decision**
  (`docs/impersonation-plan.md` §9: "registered in `full` mode and nowhere else"), with a
  purpose-built refusal distinguishing "this deployment does not open Ivanti sessions" from "nobody
  is being acted for yet". Two messages exist *because* both deployment shapes register the tool. The
  only residue is a CLAUDE.md wording nit: "`switch_role` where impersonation is configured" would
  read better as "in `full` mode; it refuses where impersonation is not configured".
- **`/health` disclosing the build fingerprint** — the branch is
  `permitted.authorized ? buildHealth(...) : MINIMAL_HEALTH`, so under `bearer`/`oauth` an
  unauthenticated caller gets `{"status":"ok"}` and nothing more. Under `AUTH_MODE=none` the full
  payload is served, which is the documented decision (`notes.md` §Observability: detail "requires
  the same authorization as any other request") and discloses less than the wide-open `/mcp` endpoint
  already does to the same caller. The Origin invariant is scoped to the Streamable HTTP endpoint;
  against a real rebinding page the check would be inert on a GET anyway, and the absence of CORS
  headers stops an ordinary cross-origin page reading the body.

Two of those last three came from the completeness critic, whose findings — unlike the other sixteen
reviewers' — had faced no skeptic. They were sent through one afterwards, which is the only reason
they are in this section rather than in the list above.

---

## What nobody looked at

Stated so the report's own limits are legible:

1. **The content of the six MCP resource documents** (`src/resources/*.ts`, ~24,000 characters).
   `resources.test.ts` checks only that no document names an unregistered tool. Nobody has read them
   for factually wrong claims about Ivanti — the same defect class the manifest-driving exercise was
   invented to catch on tool descriptions, applied to a surface that exercise never pulled. **This is
   the largest unread body of model-facing text in the repo.**
2. **`fetch`'s id round-trip** and `record-identity.ts`'s `firstOwnText` against real rows.
3. **`src/server/http/{respond,read-body,session-store,describe-rpc}.ts`** at the line level — covered
   from the outside only.
4. **`explain-field-error.ts` and `explain-required-fields.ts`** — in no reviewer's file list, and
   they are the path by which a wrong display name becomes a wrong instruction to the model.
5. **`postman/` and `examples/env/*.env` beyond a secret grep.** `check-example-envs.mjs` enforces
   that examples load, not that they are coherent — findings 35 and 21 are instances of exactly that.
6. **Anything needing a live tenant.** Several judgements here are fail-closed *arguments* rather than
   measurements, and each is flagged where it occurs: whether `/api/rest/Attachment?ID=` accepts a SID
   cookie (31), what Ivanti answers to a malformed `$orderby` (23), what becomes of an abandoned
   staging record (15), and whether `RemoveSession` wants the composed SID or the bare id — if it
   wants the bare id, every release is a silent no-op, which would compound finding 13.
7. **`docs/handbook.html` beyond its embedded `DATA` blob**, and `deploy/systemd/`.

## Suggested order

Cheapest-first, by defect-prevented per line changed:

1. **One-line fixes with no design question**: 22 (`resolved` not `env`), 29 (discovery timeout),
   5 and 19 (narrow the two catches), 6 (`connection` not `deps.connection`), 18
   (`missingRecordMessage`), 16 (parse as UTC), 20 (the JSON-value regex).
2. **The guards, before anything else drifts**: 1 (widen the credential guard *after* routing the
   three tools), 24 (measure both manifests), 30 (the three test gaps). These are what stop the next
   round of this list.
3. **Then the reachable ones**: 2 (`group_count`), 4 (hoist `sameSubject`), 3 (the body-read/cache
   pair), 7 (gate the submit), 8 and 9 (`act_as`).
4. **Docs in the same pass as the code they describe**: 27, 37, 35, 25, 26.

