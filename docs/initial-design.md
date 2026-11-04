# Ivanti MCP — Design

**Status:** implemented, 0.2.3 · **Updated:** 2026-10-01 · Written 2026-09-10, before any code.

What was decided, why, and — in §10 — what was rejected, so it is not re-litigated. How the
result works is in [`architecture.md`](./architecture.md); traps in [`notes.md`](./notes.md).

## Decisions at a glance

| # | Topic | Decision |
|---|---|---|
| 1 | Transport and auth | Separate axes: `STDIO_TRANSPORT_ON` / `HTTP_TRANSPORT_ON` (either or both) and `AUTH_MODE` (`none` / `bearer` / `oauth`), fixed at startup, failing closed |
| 2 | Tenancy | One instance, one Ivanti tenant. Always |
| 3 | Ivanti credential | One service account — the call-centre operator — optionally signing in *as* the person through CentralConfig |
| 4 | Audiences | Two startup modes: `full` (IT staff) and `enduser` |
| 5 | Identity | `act_as` once per conversation, gating every other tool; a token's claim replaces the question under `oauth` |
| 6 | Permissions | No role system in the server — tool annotations and the client's harness; Ivanti's own roles apply under impersonation |
| 7 | Metrics | Prometheus on a listener of its own, off by default (`METRICS_ON`), loopback by default, with an optional scrape-only token — never on the MCP port (§9e) |
| 8 | Licensing | Activated against the Synergy Hub at startup and renewed by heartbeat; an unlicensed server starts but refuses every tool but `get_version`; 30 days' grace offline, across restarts (§9f) |

## 1. Authentication modes

**Transport and authentication are two axes.** An early version made `stdio` an auth mode, which
turned `stdio` and `none` into two spellings of "no authentication" and left the transport
unnameable. Transports are independent booleans, so a deployment can change one without restating
the other.

| Toggle | Default | Auth applies? | Fits |
|---|---|---|---|
| `STDIO_TRANSPORT_ON` | on | No — the credential is the ability to run the process | local clients, `docker run -i` |
| `HTTP_TRANSPORT_ON` | off | Yes, required | everything remote |

Both off is refused; both on gives each its own `McpServer`. The spec agrees on stdio:
*"Implementations using an STDIO transport SHOULD NOT follow this specification, and instead
retrieve credentials from the environment."*

| `AUTH_MODE` (HTTP only) | The caller proves | Fits |
|---|---|---|
| `none` | nothing — the network is the boundary | trusted internal networks |
| `bearer` | a static token | CI, scripts, workspace connectors |
| `oauth` | an OAuth 2.1 access token from the organisation's IdP | Claude, spec-compliant clients, SSO |

HTTP without `AUTH_MODE` refuses to start, and `AUTH_MODE` without HTTP is an error — it would read
as protection that is not there. Only `oauth` carries a *user* identity; the others authenticate a
client. Under `oauth` the server is a resource server only and never mints a token. **mTLS was
dropped**: it identifies a machine, and the container does not terminate TLS, so the check belongs
at the proxy.

### 1.1 `none` — open mode inside a trusted network

For internal deployments where the network *is* the boundary. It must never happen by accident:
`AUTH_MODE=none` is explicit only, `MCP_BIND` defaults to `127.0.0.1` so exposure is a second
deliberate key, and startup says so loudly. **`Origin` validation is mandatory in every HTTP mode**
— a spec MUST, answering 403 on an invalid `Origin` — and matters most here, because "inside the
network" includes every employee's browser, and without it a page they merely visit can drive the
server (DNS rebinding). An IP allowlist (`ALLOWED_CIDRS`) was designed as a modifier and not built.

## 2. One instance, one tenant

Staging, UAT and production are three containers, not three tenants in one process. That removes
`tenants.yaml`, `/{tenant}/mcp` routing, a `tenant` parameter on every tool, `list_tenants`, and a
trusted-issuer list — one instance trusts one issuer. The cost is that registering all three in one
client triples the tool list; register production deliberately and name the servers distinctly.

## 3. Ivanti credential: the call-centre operator model

One API key belongs to one Ivanti "MCP user", and every operation runs as that account; the person
an operation is *for* goes in the record's Customer field — as a call-centre operator logs a caller.
Per-user keys are not provisionable for ~40k employees. In `enduser` mode the operator has no
judgement and an attacker-influenced input channel, so **Customer is data, not authorization**.

**Given a CentralConfig key, the server signs in as the person instead** — Ivanti then applies their
own access, and their name lands on what they write. Optional and off by default:
[`impersonation-plan.md`](./impersonation-plan.md).

**One key, four wire surfaces, three calling conventions:**

| Surface | Auth | Wire |
|---|---|---|
| OData `…/api/odata/businessobject/…` | `Authorization: rest_api_key=<key>` | JSON |
| REST `…/api/rest/…` — attachments, search, service requests | same header | JSON |
| ASMX `…/HEAT/Services/…asmx/<Method>` | SID cookie + CSRF, from a handshake using the key | JSON POST, `{d:…}` |
| `$metadata` | `rest_api_key` | XML |

OData and REST return records; ASMX returns what makes them comprehensible — the catalog, forms,
display names, valid values, quick actions, delete cascades. A REST-only server can read and write
but cannot say what a field means or which values are valid.

**The credential decides a capability tier, probed at startup, failing soft.** `odata` (the key
alone) serves every read; `session` (the handshake opens) adds identity and workspaces; `admin` (the
admin console answers) adds the complete catalog. Narrowing happens at registration, so a tool the
credential cannot serve never appears. The admin console is used when available and never required
— most customers will not issue an admin key. The handshake *requests* `role: 'Admin'` and Ivanti
silently downgrades, so the effective role is always read back.

**The effective identity goes in the server `instructions`.** Anything Ivanti resolves "for the
current user" answers for the service account, and a model not told so reports one person's queue
as another's.

## 4. Operating modes: `full` and `enduser`

| | `full` | `enduser` |
|---|---|---|
| Audience | IT staff | employees |
| Business Objects | all | allowlisted (`ENDUSER_BUSINESS_OBJECTS`) |
| Operations | everything, including production writes and deletes | create, attach, notes, service requests, allowlisted quick actions — on the caller's own records |
| Ivanti credential | the service account, or the person | the service account, or the person |
| Identity | required — `act_as` | required — `act_as` |

Allowlists key on the **technical** Business Object name, never the per-tenant display name, and
are resolved at startup — an unknown name refuses to start. A production `READ_ONLY` gate was
rejected: production is where the work happens. The surface narrows by audience, not environment.

## 5. Identity

The model **asks who the person is**; under `oauth` the token answers instead. **Accepted risk:** an
employee can claim to be a colleague — the exposure the phone line already has. **The new risk:**
ticket text is written by whoever filed the ticket, so injected content could change the identity
mid-conversation. Mitigations:

- **Pin once per conversation, server-side.** The first resolved person is stored; a later,
  different one is refused, not honoured.
- **Resolve names to a record**, with disambiguation — a real record, not a matched string.
- **Audit the identity and its provenance** (`asserted` / `verified`) on every call.
- **A token beats any claim** — ignored entirely, not merged, or the strong path has a bypass.
- **Never expose lookup by incident number in `enduser`** — numbers are sequential, so it would be
  ticket enumeration.

### Resolving the person: `act_as`

**One tool, called once, not an argument on every tool** — an argument fails silently the first
time the model forgets it and answers for the service account. **Every other tool refuses until it
succeeds, in both modes** (since 2026-09-17; `full` was once ungated). The gate decides *whether the
conversation may answer*, not *whose records*: an IT agent pins themselves and works the queue. It
ends the unattributed conversation, which put the service account on every audit line. It lives in
`registerTools`, where a tool cannot forget it. Only `act_as` and a no-tenant deployment are outside.

**A signed-in conversation pins itself** lazily, on the first call that needs it, by running
`act_as`'s own handler — one copy of the matching rules, not two. Not at `initialize`: a slow tenant
would fail the connection, and a name-only match needs somewhere to ask for confirmation.

**A conversation ends on silence or a fresh `initialize`** (2026-09-17). A stdio process is one
connection for life, so an editor carried one person's pin into every later conversation. Silence
(`MCP_IDENTITY_IDLE_TTL_SECONDS`, default 1800; bias it short) and a re-`initialize` stand in for
"the user cleared the context". Neither is model-reachable — a tool that ended a conversation could
shed the pin, and time is the one thing ticket text cannot forge.

**Matching.** `LoginID`, `PrimaryEmail`, or `FirstName` + `LastName` across `employee` (628 here)
and `externalcontact` (2) — never the assembled `DisplayName` ("John M Doe"). `eq` is
case-insensitive. `$filter` has no string functions, so partial names go through keyword search,
which over-matches (`"John"` → Scott Johnson), and are re-filtered on whole tokens. The pin is the
link *pair*, `ProfileLink_RecID` + `ProfileLink_Category`. Exact match → resolved; else re-filtered
search, capped → candidates; nothing → refused.

| Provenance | Behaviour |
|---|---|
| unverified | The model asks and runs the ladder. One candidate → confirm, pin. Several → the person chooses. None → refuse |
| `verified` | An exact match on the configured claim pins silently; anything less only after confirmation that **shows what matched what** — the token proves who the person is, not which record is theirs |

A candidate list is not a claim — only the choice pins. A confident match stays `asserted`.

| Case | Answer |
|---|---|
| No match | refused — never an empty result, which reads as "you have no tickets" |
| Too many | capped; ask for something narrower |
| `Terminated` | refused |
| `New`, `On Leave` | pinned, flagged |
| Verified token, no Ivanti record | refused — they cannot file one either |

**`act_as` is a directory search and bounded like one** — minimum query length, capped candidates,
only disambiguating fields. **The pin comes before any ticket text**: every record-returning tool
requires it, so no untrusted content reaches the model before the first claim. **A person is in one
object, not both** (decided 2026-09-12); if a tenant ever has both, the caller sees two candidates.

**One person per MCP session; the multi-person gateway is deferred.** A Slack or Teams bot
multiplexing everyone over one session would pin the first person. Under `oauth` each request
carries its own token and a second verified subject gets 403. Under `none` and `bearer` there is no
per-request principal. The real answer is to let the gateway carry the identity its platform
already authenticated — a provenance between `asserted` and `verified` — designed against a real
deployment, not an imagined one. Meanwhile `enduser` over HTTP without `oauth` warns at startup; a
hard refusal would also break the legitimate one-session-per-user `bearer` deployment.

### Attachments: bytes in a tool call, not a hosted upload page

`overlord-service` hands the user an upload URL and keeps a token store. This server may run over
stdio with no HTTP listener, so `upload_attachment` takes base64 in the call, capped at **2 MB** —
base64 is 4 characters per 3 bytes and crosses the context twice. A deployment wanting the hosted
flow builds it around this server. `request_attachment_upload` and `check_attachment_upload` are not
ported, and `resources.test.ts` fails if a document promises them.

## 6. Permissions: annotations, not roles

No role system in the server: only `oauth` could feed one. Tools are annotated, and the client's
harness applies its own permissions. The defaults make an unannotated tool destructive and
open-world — safe but useless — so every tool is explicit:

| Kind | Annotation |
|---|---|
| reads, metadata, previews | `readOnlyHint: true`, `idempotentHint: true` |
| additive writes — create, link, upload, submit, add a note | `destructiveHint: false`, set explicitly |
| overwrites and deletes — update, delete, unlink, run a quick action, vote | `destructiveHint: true` |

`openWorldHint: true` on tools returning ticket text: in an ITSM system the **read** tools are the
prompt-injection surface. Annotations bind only clients with a harness, which is fine — the
operator deploys this server.

## 7. Container and deployment

- **`MCP_PUBLIC_URL` is required and never derived from the request.** A proxy rewrites Host and
  scheme, but the RFC 9728 document and token audiences must match the external URL exactly.
- **Secrets through `*_FILE`** so they stay out of `docker inspect`; the inline form is accepted
  too, and giving both is refused.
- **No TLS in the container** — TLS at the proxy. The server never reads `X-Forwarded-*`, so a
  spoofed header cannot change what it trusts.
- **`/health` is unauthenticated**, and answers `{"status":"ok"}` and nothing else to anonymous callers.
- **Distroless, nonroot** (uid 65532): no shell, so the application reads `*_FILE` itself and the
  health check is a Node script; secrets must be readable by 65532. Details:
  [`deployment.md`](./deployment.md), traps in `notes.md`.

## 8. Configuration

Every setting is in `.env.example`, and [`configuration.md`](./configuration.md) is the guide.
Designed here and **not built**: `ALLOWED_CIDRS` (an IP allowlist modifier) and
`TRUSTED_PROXY_CIDR` (moot — `X-Forwarded-*` is never read).

## 9. Implementation stack

- **TypeScript**, on `gcr.io/distroless/nodejs22-debian13` (Debian 12 until 0.3.1). Pinned to 6.x by `typescript-eslint`.
- **pnpm**, for its strict layout: importing something undeclared fails the build — which is how
  the transitive-`express` trap is caught. Lockfile committed, version pinned.
- **`@modelcontextprotocol/sdk` 1.31.0**, which implements protocol **`2025-11-25`**, not
  `2026-07-28` (1.30.0 shipped a day before it; 1.31.0 did not move it). Check `LATEST_PROTOCOL_VERSION` before building to a newer
  requirement.
- **Zod v4, imported from the root.** The SDK is v4-first; importing `zod/v3` sends it down a legacy
  JSON-schema path where the types stop matching.
- **OAuth is built on `node:http`, and `express` is not a dependency.** The SDK's metadata router
  and bearer middleware are express-based, and the RFC 9728 document is small enough to serve
  directly. Never mount the SDK's `mcpAuthRouter` or `proxyProvider` — the authorization-server
  half. The verifier is ours: `jose` against the IdP's JWKS, checking `iss`, `aud` membership and
  `exp`.

## 9b. Open questions

None. The one recorded — whether `enduser` reads would start as a session-scoped read-back — was
settled: `enduser` reads the caller's own records through the discovered customer link, in every
auth mode. Token propagation to Ivanti is settled by §11.

## 9c. Identity provider survey (measured 2026-09-10)

| IdP | `jwks_uri` | introspection | DCR | PKCE advertised |
|---|---|---|---|---|
| **Entra ID** | ✓ | ✗ | ✗ | **absent** |
| Okta | ✓ | ✓ | ✓ | ✓ |
| Auth0 | ✓ | ✗ | ✓ | ✓ |
| Keycloak | ✓ | ✓ | ✓ | ✓ |
| Zitadel | ✓ | ✓ | ✓ | ✓ |
| Google | ✓ | ✗ | ✗ | ✓ |
| JumpCloud | ✓ | ✗ | ✗ | ✓ |
| Duende IdentityServer | ✓ | ✓ | ✗ | ✓ |
| Salesforce | ✓ | ✓ | ✓ | ✓ |
| GitLab | ✓ | ✓ | ✗ | ✓ |

1. **JWKS is universal; introspection is not (6/10)** — so JWKS is the path.
2. **DCR is missing on half**, so a pre-registered client (`--client-id`) is the default.
3. **Entra alone omits `code_challenge_methods_supported`** — see §12.
4. **JWT is reachable everywhere, often by configuration**: Okta needs a custom authorization
   server, Auth0 the `audience` parameter, Zitadel the app's token type set to JWT; Entra should pin
   `requestedAccessTokenVersion: 2`; Keycloak defaults to JWT.

## 9d. Logging and measurement (decided 2026-09-28 → 29)

- **Structured JSON to stderr, each level with one job**: `debug` every MCP and Ivanti request,
  `info` lifecycle and the per-call audit and usage lines, `warn` running degraded, `error` faults
  in this server with the stack. The table is in [`architecture.md`](./architecture.md#logging).
- **`debug` carries the Ivanti query.** This reverses "request logs carry the path, never the
  query": the query is what diagnoses a failed call, and `debug` is the level for diagnosis. It is
  documented as personal data instead (`.env.example`, the chart, `configuration.md`). A write's
  values are logged at no level — its field names are.
- **Every Ivanti request goes through `exchange()`**, one function that times out, scrubs, logs
  and turns every failure into an `IvantiApiError` — seven hand-written copies had drifted apart.
- **Cost is measured in characters, not tokens.** The server is vendor-agnostic and every model
  family tokenizes differently; characters are what the server controls, need no credential and
  are deterministic, which is what lets CI compare a pull request with its base. The `Counter`
  interface leaves room for one vendor's tokenizer where a deployment serves one family.
- **What the model re-reads is kept small.** A result rides along on every later request, so
  results are compact JSON, and `get_object_metadata` returns its fields as rows with links folded.
  The indirect cost — failed turns a description causes — is measured by the usage lines and judged
  version against version; see [`usage.md`](./usage.md).

## 9e. Metrics on a port of their own (decided 2026-10-01)

- **A separate listener, never the MCP port.** Every credential that guards the MCP port reaches the
  tools: under `none` nothing guards it, under `bearer` the scraper would hold the token that calls
  `update_record` and `delete_record`, and under `oauth` it would need a signed-in identity from the
  IdP. And whatever fronts the MCP port — an ingress, a tunnel, a TLS proxy — must never route to
  metrics, which a port of their own makes structural rather than a path rule someone has to keep.
  `METRICS_PORT` equal to `MCP_PORT` with HTTP on is refused.
- **Off by default, behind one toggle (`METRICS_ON`).** An internet-facing deployment turns metrics
  off with one setting. Off, there is no listener, and the other `METRICS_*` settings are ignored
  rather than refused, so turning them off never needs anything else changed.
- **Loopback by default, and an optional token of its own.** What is served carries no person
  names, filters, record ids or ticket text — only tool names, outcomes, HTTP methods and statuses,
  and timings — but error rates by tool still say what a deployment is used for. `METRICS_BIND`
  defaults to `127.0.0.1` like `MCP_BIND`; `METRICS_TOKEN` (32 characters or more) is a scrape-only
  secret, refused when it equals `BEARER_TOKEN` or an Ivanti key, because a scraper must hold a
  secret that reaches nothing else. Any request a browser sends (`Origin` or `Sec-Fetch-Site`) is
  refused with 403, closing DNS rebinding from a web page the operator merely visits.
- **No client library.** The registry is hand-written (`src/metrics/registry.ts`): counters, gauges
  read at scrape time and histograms, in the text format. A library would be more code shipped,
  another notice and another thing for a scanner to flag. Instruments are recorded whether or not
  metrics are on; `METRICS_ON` decides only whether anything can read them.

## 9f. Licensing through the Synergy Hub (decided 2026-11-04)

The product is licensed by the Synergy Hub (`Synergy.Hub`, Context B: on-premise products) under
the product key `ivanti-mcp-standalone`. Only two of the Hub's operations are used — activate and
heartbeat — plus its public keys to check what they return. One licence gives full access: no
feature is gated, usage is not reported, and the update feed is not read.

- **The Hub is told a machine, not shown one.** A "machine" is three strings the client sends —
  `machineGuid`, `biosUuid`, `installGuid` — compared as a hash and never checked against
  hardware. A container has no stable hardware identity, so the server is given or derives the
  three: `installGuid` is fixed per installation (the chart derives it from the namespace and
  release name; the operator sets it under Docker; stdio generates it into the config folder),
  `machineGuid` is `LICENSE_MACHINE_ID` when set and otherwise derived from `installGuid`, and
  `biosUuid` is derived from `machineGuid`. The chart *derives* rather than generates: Helm's
  `lookup` answers nothing under `helm template` and Argo CD, so a random value kept in a Secret
  would be a new one — and a new seat — on every such render. For the same reason the chart does
  not yet pass the namespace UID: reading it is a cluster-scoped lookup a namespace-scoped
  installer may not make. Every process of one installation sends identical
  values on every call — the Hub moves a seat when `machineGuid` or `installGuid` changes, so two
  pods sending different values would bounce it between them on every heartbeat.
- **Activate on every start, keep nothing about the activation.** Activate is idempotent per
  fingerprint: the same three values get the same activation and seat back. Restarts, upgrades and
  a rollout's overlapping pods hold one seat. Each release takes its own seat (revisit when the
  licence model says otherwise).
- **Heartbeat every 4 minutes.** The token expires 5 minutes after issue (`exp`); the licence's
  real end is `validUntil`. A token is trusted only once its ES256 signature checks against the
  Hub's published keys and its `aud` contains `ivanti-mcp-standalone`.
- **Unlicensed means tools refused, never a refusal to start.** One licence check in
  `registerTools`, ahead of the identity gate, refuses every tool but `get_version` — `act_as`
  included, so nothing reaches Ivanti on anyone's behalf — and every refusal carries the reason.
  `get_version` reports the licence, but where a tenant is configured the identity gate still holds
  it until `act_as`, so the refusal text, not `get_version`, is what a model can always read. Health
  and readiness do not depend on it: a pod restarted for being unlicensed would come back
  unlicensed. Refusing to start would make a Hub outage a crash loop.
- **30 days' grace without the Hub, across restarts.** The Hub enforces no grace period itself;
  this is the product's choice, as in SDAP. The last verified token and the keys that verified it
  are stored — in a Secret under the chart, a file under Docker and stdio — and a restart while
  the Hub is unreachable reopens from it. The grace clock is the token's own signed `iat`, so
  editing the store cannot extend it, and the request nonce (echoed inside the signed token)
  carries a hash of `installGuid`, so a token copied from another installation is refused. Any
  refusal from the Hub clears the store.
- **The Hub's address is built in** (`https://hub.itsmcloud.lt`) and may be overridden with
  `LICENSE_HUB_URL`; an empty or plain-`http` value is refused rather than read as "licensing
  off" — the mistake SDAP's first client made.
- **No offline activation.** Outbound HTTPS to the Hub is a requirement; air-gapped deployments are
  not supported.

## 10. Rejected alternatives

| Rejected | Why |
|---|---|
| Multi-tenant container with `tenants.yaml` | Overcomplicated for three environments; the process is a better fence, and it adds a `tenant` parameter to every tool |
| Per-user Ivanti API keys | Not provisionable for ~40k employees |
| A production `READ_ONLY` gate | Production is where the work happens |
| A role/permission system in the server | Only `oauth` could feed it; annotations and the harness cover it |
| Re-implementing Ivanti's authorisation server-side | Superseded by the operator model, the Customer field and, now, impersonation |
| ~~Ivanti impersonation~~ | **Reversed 2026-09-14** — CentralConfig does mint a session for a named person, and Ivanti scopes it. Optional, off by default |
| ~~Impersonating only records, not every surface~~ | **Reversed the same day.** The 551s that made forms look unreachable came from a session never *activated* — `SelectRole` must run after `InitializeSession`, even naming the reported role. Every surface now follows the person; only tenant facts stay on the service account |
| **RFC 7662 introspection** | **Deferred, not abandoned** — below |
| **More than one replica** | **Deferred, not abandoned** — below |
| A shared package with `overlord-service` | Forked (2026-09-11) to evolve independently — see the plan, *Fork, not shared package* |
| Dropping `search_knowledge` from `full` | Kept: it strips the article's HTML (~2,600 characters of markup around 400 words), truncates with the cut stated, and shows `Status` |
| Exposing service-request staging ids | Staging happens inside the submit: an id is one-shot and a second submit *moves* the file |
| Voting through "Approve My Vote" on the approval | "My" is the session, and an admin key's override bypasses the real approver. `vote_on_approval` acts on the approver's own vote row |
| Voting by setting the vote row's `Status` | Stores the status, overwrites `VotedBy`, and the workflow never fires |
| Driving a headless browser to evaluate a form's rules | Considered 2026-10-25. The portal evaluates them in JavaScript from one download, but the rules are a small expression language over parsed trees, so a port of the evaluator (from `ivanti-mobile`) is deterministic and carries no Chromium, login or markup dependency |
| Ranking roles by object-workspace count | Built, then deleted (2026-09-14): the counts do not separate the classes, and are unavailable on an impersonated session. Ivanti's `SelfServiceRole` flag decides |
| `SetRoleForUserSession` to select a role | `Session.asmx/SelectRole` re-points the session without re-authenticating |
| `FindActiveTenantRecord` as the startup probe | The only probe that catches a wrong tenant — but it returns the database connection string and encryption key |
| A `list_roles` tool | Roles ride in the `act_as` and `switch_role` replies for free, and a list-or-mutate tool cannot be annotated honestly |
| Exact token counts from one vendor's API (`count_tokens`) | The server serves any model: a count exact for one family is wrong for the next, and it needs a credential and the network. Characters, with a pluggable `Counter` (§9d) |
| A separate `LOG_IVANTI_QUERIES` switch on top of `debug` | The query is what diagnoses, and a second switch is one more thing to forget mid-incident. `debug` is documented as personal data instead |
| Logging a write's values, even at `debug` | They are ticket text; the field names answer "what was sent" |
| A logging library (`pino`) | What was missing — timestamps, error serialisation, request context — was about thirty lines on a logger of eighty |
| Failing a pull request on manifest growth | A warning that prevents failed turns can be worth its characters; the usage report judges it, so CI's size check informs. The per-description caps still fail |
| Pretty-printed JSON results | A third of every result was indentation, re-sent with every later request, and the reader is a model |
| A release that checks and publishes in one job | The design until 2026-09-29, chosen to build `dist/` once. **Reversed:** `id-token: write` reaches every step of its job, and the checks run every devDependency, so any package in the tree could have signed as the release or pushed a tag. A read-only *Gate* and a *Publish* that installs no npm package, for a second checkout and one artifact hop — [`deployment.md`](./deployment.md#releasing) |
| Metrics on the MCP port, behind its auth | Every credential that guards the MCP port reaches the tools: under `none` nothing guards it, under `bearer` the scraper holds the token that calls `delete_record`, under `oauth` it needs a signed-in identity from the IdP. And the ingress or proxy in front of the MCP port would route to metrics too. A port of its own (§9e) |
| Refusing to start without a licence | A Hub outage would become a crash loop, and the operator could not ask the server why. Tools are refused instead, each refusal saying why (§9f) |
| Real hardware identifiers for the licence fingerprint | A pod has none that survive a restart, and the image's `/etc/machine-id` is the same for every customer. Generated and derived values, fixed per installation (§9f) |
| A ReadWriteOnce volume for the stored licence token | Stalls the rolling update when the new pod lands on another node. A Secret survives restarts and node moves (§9f) |
| An `emptyDir` for the stored licence token | Lost when the pod moves node, which is when a restart is most likely |
| Gating features from the licence token | One licence gives full access (decided 2026-11-04); the token's `features` claim is not read |
| Scaling out by hashing `Mcp-Session-Id` at the ingress | Offered by the chart as `sessionAffinity` until 2026-09-29, and never able to work: the pod answering `initialize` mints the id, so the request that opens a session carries nothing to route by. The chart refuses it and more than one replica; scaling out needs a shared session store |

### Introspection — deferred

Absent on 4 of 10 IdPs including Entra, so it cannot be the universal path. It would cost a round
trip to the IdP on every request and a runtime dependency on its availability; caching fixes the
latency but gives up instant revocation, its main advantage. **Revisit if** an IdP's policy forbids
JWT, an IdP has no `jwks_uri`, or instant revocation becomes a requirement. It is additive:
everything depends on one `TokenVerifier` type, and `looksLikeJwt()` would route to a second
implementation enabled by `OAUTH_INTROSPECTION_CLIENT_ID` / `_SECRET` — roughly 100 lines.

### More than one replica — deferred

Decided 2026-10-01. Staging and UAT serve the people who build and test, and never approach the
load one process carries. Production is not obviously different: one pod holds ~104 MiB idle and
~64 KiB per open session (the Handbook's measurement on Linux), a tool call spends its time
waiting on Ivanti rather than on this process, and the tenant is the ceiling — more replicas send
more load at the same Ivanti. What one pod does not give is availability: a restart, a node
failure or a deploy ends every open conversation, and the client starts a new session (under
`oauth` the person is pinned again from the token; otherwise `act_as` is called again). Nothing is
lost, and a deploy can wait for a quiet window.

**Revisit if** a load test shows one pod saturating below production's expected peak, or
production is given a zero-downtime requirement. The cheapest route is then stateless HTTP under
`oauth` — the token names the person on every request, so any pod serves any request, and each
keeps its own Ivanti session per person — with no shared store; `bearer` and `none` stay single.
A Redis session store for every mode is the other, and costs a dependency to run and secure.

## 11. Spec conformance (verified 2026-09-10, against the 2026-07-28 authorization spec)

**Client registration is not ours.** CIMD and DCR fall on clients and authorization servers; a
resource server serves no `/register` and hosts no client metadata document. **stdio does not do
OAuth** — the spec says it should not.

What the `oauth` mode does, all implemented:

- **Serves Protected Resource Metadata (RFC 9728)** both ways clients look for it: the
  `resource_metadata` pointer in `WWW-Authenticate`, and the well-known URI with path insertion
  (`/public/mcp` → `/.well-known/oauth-protected-resource/public/mcp`).
- **Validates every token**, rejecting those not issued for it: `aud` membership in
  `OAUTH_AUDIENCE`, configured apart from `MCP_PUBLIC_URL`, because no mainstream IdP mints `aud`
  from RFC 8707's `resource`.
- **Never relays a token** — *"MUST NOT pass through the token it received"*. So passing a caller's
  token to Ivanti is forbidden outright, and the single-key operator model is the conforming design.
- **Answers with the right codes:** 401 for a missing or invalid token, 403 `insufficient_scope`
  with `scope` and `resource_metadata`, 400 for a malformed request.
- **Never advertises `offline_access`**, and requires `MCP_PUBLIC_URL` to be a canonical URI —
  absolute, no fragment, no trailing slash (`canonicalUriProblems()`).

## 12. Entra and PKCE metadata

The spec says a client **MUST refuse to proceed** when an authorization server omits
`code_challenge_methods_supported`, and Entra omits it — on `common`, `organizations`, `consumers`
and a real tenant — while supporting PKCE S256 in practice. **Tested 2026-09-11: Claude Code
proceeds** and issues a real authorization request. A stricter client might refuse, and nothing
server-side can fix another party's metadata. The Entra finding that does bind deployments is
different: the server's URL must be a registered Application ID URI, which means **a public HTTPS
hostname on a domain verified in that tenant** — see [`configuration.md`](./configuration.md).
