# Notes — traps and gotchas

Running list of things that bite. **Not** design decisions (those are in
[`initial-design.md`](./initial-design.md)) and **not** sequencing (that is
[`implementation-plan.md`](./implementation-plan.md)).

The entry criterion: *something that passes locally, or looks fine in review, and fails
somewhere else.* Each note says what breaks, why, and what to do.

---

## Packaging and containers

**Production dependency updates must regenerate `THIRD-PARTY-NOTICES.md`.** Dependabot updates
the manifest and lockfile, but the notices still describe the old installed tree, so CI's
`check:licenses` fails even when the application tests pass. Run `pnpm run licenses`, then
`pnpm check:licenses`, and commit the generated file with the dependency update. The `run` is
required: `pnpm licenses` invokes pnpm's built-in license-listing command instead of this
repository's generator.

**A repository transfer does not move existing GHCR charts or rewrite image signatures.**
The project now lives at [syn-con/ivanti-mcp](https://github.com/syn-con/ivanti-mcp), with its
handbook at <https://syn-con.github.io/ivanti-mcp/>. Chart versions through 0.3.9 are still published
under `ghcr.io/tyrunasj/charts/ivanti-mcp`; later releases publish under `ghcr.io/syn-con/charts/ivanti-mcp`.
The handbook keeps its 0.3.9 generated Helm commands on the existing package; the next
`version:sync` switches them to `syn-con`. Old images still need the signing identity from their
original release notes. Changing that identity to the current repository URL makes verification
fail. The Docker Hub image remains `tyrunas/ivanti-mcp`.

**`.dockerignore` must not exclude `package.json`.**
The server reads its own name and version from the manifest at startup, so the image has to
`COPY package.json` alongside `dist/`. A `.dockerignore` that filters it out passes every local
test and fails only in the container, at boot. → Verify by running the built image, not just
`pnpm build`.

**Distroless has no shell, so `*_FILE` secrets must be read by the application.**
There is no entrypoint wrapper to export them into the environment with `sh -c`;
`read-secret-file.ts` reads them in-process, before the schema parses anything.

**A digest-pinned base image can go stale while its tag is abandoned.** A container scan on
2026-09-30 flagged `libssl3 3.0.18-1~deb12u2` and `libc6 2.36-9+deb12u13` in 0.2.5 and 0.3.0 —
one critical and six high in Trivy. Debian had fixed every one of them in bookworm
(`openssl 3.0.20-1~deb12u2`, `glibc 2.36-9+deb12u14`), but the newest
`gcr.io/distroless/nodejs22-debian12:nonroot` was the very digest the Dockerfile pinned, still on
Node 22.22.0: distroless had stopped rebuilding its Debian 12 images. Pinning was right —
Dependabot proposes a new digest only when the tag moves, and this tag no longer moved. 0.3.1
moved to `nodejs22-debian13` (none critical, one high with no fix published, Node 22.23.3). Node
itself carries its own OpenSSL, so the flagged `libssl3` was never on the TLS path to Ivanti; it
was in the image, and scanners count what is in the image. The check that would have caught it
is a scan of the built image, not of the lockfile.

**A fix Debian has published is not in distroless yet.** The first CI run of the image scan
(2026-09-30) failed on two highs in `libssl3t64 3.5.7-1~deb13u2`: Debian had shipped
`deb13u3` within the hour, Trivy's database knew, and `gcr.io/distroless/nodejs22-debian13:nonroot`
still pointed at the digest the Dockerfile pinned. Nothing in this repository could fix it until
distroless rebuilt. So a pull request's scan reports and the release blocks; a release that cannot
wait accepts the finding in `.trivyignore.yaml` with an expiry, and the Dependabot digest bump —
or a manual one — carries the fix when it lands.

**`scratch` ships no CA bundle; every distroless image does.**
Needed for TLS to Ivanti *and* for fetching the IdP's JWKS. A missing trust store surfaces as a
**token-validation failure**, not as an obvious TLS error — which sends you debugging OAuth when
the problem is the base image. Distroless images, `static` included, carry `ca-certificates` and
`tzdata` (upstream README, checked 2026-09-28), and `nodejs22-debian13` inherits both. This bites
only if the base ever became `scratch`. *(Corrected 2026-09-28: this entry once said `static` had
no CA bundle, and a sibling said distroless had no tzdata. Both were wrong.)*

**pnpm's `node_modules` cannot be copied between image stages.**
The default layout is symlinks into a content-addressed store, and a `COPY --from=deps` moves the
links without their target. `pnpm install --prod --node-linker=hoisted` writes real directories,
which is what a distroless runtime can use.

**A distroless image has no shell, so `HEALTHCHECK CMD` cannot be a command line.**
It has to be the exec form against the image's own node — `["/nodejs/bin/node", "…"]` — and the
check itself has to be a script the image carries. `docker/healthcheck.mjs` is plain JS for that
reason: there is no build step inside the image.

**A file-based Docker secret keeps its host ownership, and a distroless image is not root.**
`secrets:` mounts the file as it is on the host, so a key written by your own account with mode 600
is unreadable by uid 65532 inside the container. The server exits 78 with
`EACCES: permission denied, open '/run/secrets/bearer_token'` and the container restart-loops —
which reads like a missing file rather than a permission. `chown 65532:65532` the secret and keep
mode 600: the container can read it and the host account cannot, which is the right way round.

**The tenant hostname resolving on the host says nothing about the container.**
Measured: `dig` on a Mac answered a public address, and the same name inside a container on that
Mac answered `192.168.1.215` — a LAN address it could not route to, so every startup probe failed
as a transport error rather than a 404. `--add-host` (or `extra_hosts:`) pins the address the host
uses. On a Linux host **on that LAN** the same image needs none of this: the name resolves to the
LAN address and the tenant answers. So the failure is a property of where the container runs, not
of the image — check DNS from inside a container before suspecting the server.

**`docker run -e VAR=` sets the variable to an empty string, it does not unset it.**
That is the idiom for clearing a value inherited from `--env-file`, so an empty string now means
"absent" when configuration loads. Before that, `-e AUTH_MODE=` failed with
`Invalid option: expected one of "none"|"bearer"|"oauth"`, which reads like a typo in the schema
rather than a deliberate override.
*(Solved: `withoutEmpty` in `load-config.ts` treats an empty value as unset. Verified in the code 2026-09-28.)*

**Docker's published ports bypass ufw and firewalld.**
`-p 3000:3000` binds every host interface, and Docker writes its own iptables rules ahead of the
host firewall — so a port "blocked" in ufw is open. Inside the container `MCP_BIND=0.0.0.0` is
right; the host side must be `127.0.0.1:3000:3000` unless the port is meant to be reachable.
`docker/compose.yaml` and the configurator both publish on loopback by default.

**The health check must parse booleans exactly as `z.stringbool` does.**
`HTTP_TRANSPORT_ON=y` (or `enabled`) started HTTP while `healthcheck.mjs`, which knew only `true`
and `1`, concluded HTTP was off and exited 0 for ever. Any second parser of the environment has to
accept the same spellings, case-insensitively.

**Cosign 3 signs differently, and the verify command hides it.** From `cosign-installer` 4 the
release signs with cosign 3, which writes a Sigstore bundle as an OCI 1.1 referrer — no
`sha256-<digest>.sig` tag any more, so a registry's tag list no longer shows a signature and
`cosign tree` (or the referrers API) is where to look. `cosign verify` 3.x reads both formats, so
older releases still verify; 2.6 needs `--new-bundle-format` for new ones, and 2.5 cannot verify
them at all ("bundle support for image signatures is not yet implemented").

## Toolchain

**TypeScript is pinned to 6.x deliberately.**
TS 7 (the native port) is released, but `typescript-eslint` declares `typescript >=4.8.4 <6.1.0`
— its canary too. Installing TS 7 gives an unmet-peer warning and silently breaks type-aware
linting. Revisit when typescript-eslint supports 7.

**`pnpm.onlyBuiltDependencies` in `package.json` is ignored by pnpm 10.**
It moved to `pnpm-workspace.yaml`. Without it, esbuild's build script never runs and vitest
cannot start. pnpm warns, but the warning is easy to scroll past.

**`types: ["node"]` must be explicit in `tsconfig.json`.**
`tsconfig.build.json` includes only `src`, and without the explicit `types` entry Node globals
are not discovered there — `pnpm typecheck` passes while `pnpm build` fails with
`Cannot find name 'process'`.

**`src/version.ts` must stay at the root of `src/`.**
It resolves `../package.json` via `import.meta.url`, which works only because `rootDir: src` →
`outDir: dist` preserves depth. Moving it into a subdirectory breaks the path at runtime, not at
compile time.

---

## Dependencies

**Never import `zod/v3`.**
The MCP SDK is v4-first internally (`zod/v4`, `zod/v4-mini`, public types in `z.core.*`). Its
`zod-json-schema-compat` shim branches on `isZ4Schema()`; a v3 schema silently takes the legacy
`zod-to-json-schema` path and the types stop matching the SDK's. It surfaces as confusing generic
errors on `registerTool`, not as a version mismatch.

**`express` arrives transitively via the SDK — declare it before importing it.**
It resolves today only through hoisting. That breaks under pnpm's strict layout and gives no
semver protection. *Currently we do not use it at all*: the OAuth metadata document is small
enough to serve from `node:http`, so the server stays framework-free. Keep it that way unless
something genuinely needs the SDK's express-based routers.

**The SDK's own version cannot be read from `@modelcontextprotocol/sdk/package.json`.**
Its `exports` map has a `./*` entry that resolves that specifier to `dist/cjs/package.json`,
which contains only `{"type":"commonjs"}` — so you get `undefined` rather than an error. Resolve
a real module and walk up to the package root instead (`readSdkVersion()` in `src/version.ts`).

**SDK 1.31.0 implements protocol `2025-11-25`, not `2026-07-28`.**
1.30.0 shipped one day before that revision, and 1.31.0 did not move it. Check `LATEST_PROTOCOL_VERSION` before assuming a
2026-07-28 requirement is buildable in TypeScript.

---

## MCP protocol

**Never write to stdout.**
Under the stdio transport it carries the JSON-RPC stream; anything written there corrupts the
protocol. All logging goes to stderr via `createLogger`.

**The manifest budget counts half the manifest.**
`MANIFEST_BUDGET` and the per-description cap measure description characters. What a client is
sent is the whole tool — name, description and the JSON Schema of its arguments, argument
descriptions included — and measured with `pnpm manifest:size`, the name + schema part was
about as large as the descriptions: `submit_service_request`'s schema outweighed its description.
A tool trimmed to pass the cap can still be one of the dearest. → Judge a change with
`pnpm manifest:size --compare`, not with the budget alone. *(Found 2026-09-28.)*

**A result costs more than its size: it is re-sent with every later request.** Measured with
`pnpm usage:report`: one `get_object_metadata` call on `incident` returned 20,258 characters and
stayed in the conversation for every request after it; `employee` returned 37,656. A third of every
result was JSON indentation, and most of the rest of that one was shape — the same keys on each of
162 fields, and every link listed as `X`, `X_RecID` and `X_Category`. → Results are compact JSON,
and the metadata's fields are `name|type|label|flags` rows with links folded: 20,258 → 7,883.
Judge a result by what the model re-reads, not by whether it is complete. *(Measured live
2026-09-29.)*

**Tool annotations default to *destructive* and *open-world*.**
An unannotated tool reads as dangerous — safe, but useless. Every tool needs explicit values, and
**additive writes must set `destructiveHint: false` explicitly** because the default is `true`.

**`onsessionclosed` fires only on an explicit `DELETE`.**
Clients frequently vanish without one, so an idle TTL is not optional — and neither is a session
cap, since in `none` mode anything that reaches the port can `initialize` forever.

**One `StreamableHTTPServerTransport` holds one `sessionId`.**
A single shared transport collides the moment a second client connects — the second `initialize`
is rejected with `Invalid Request: Server already initialized`, and Claude Code's health check is
enough to trigger it because it counts as a second client. *(Fixed 2026-09-10: transport **and**
`McpServer` per session, keyed by `Mcp-Session-Id`.)*

**One `McpServer` cannot serve two connections.**
`Protocol.connect()` throws `Already connected to a transport… use a separate Protocol instance
per connection`. A singleton server is not an option — it holds per-connection state (negotiated
protocol version, client capabilities, in-flight aborts). What *can* be shared is the tool
definitions: `registerTool` stores config by reference, so build them once
(`createServerFactory`) and register the same objects on every session.

**`tools/list` re-runs zod → JSON Schema on every call.**
The SDK converts inside the `ListToolsRequestSchema` handler, not at registration. So the cost of
many tools is CPU per list request, not memory per session. Worth measuring once the Ivanti tools
land; memoising the conversion by schema object is the fix if it shows.

**An SSE stream's elapsed time is not request latency.**
The `GET /mcp` that opens the event stream stays open for the life of the connection, so logging
its duration the same way as an RPC call made a perfectly healthy 131-second stream look like a
pathological request. Streams log `mcp stream opened` / `mcp stream closed` with `attachedMs`;
RPC calls log `mcp request` with `ms`.
*(Solved: `mcp-handler.ts` logs a stream apart from a request. Verified in the code 2026-09-28.)*

**Clients disconnect without sending DELETE — routinely, not exceptionally.**
Observed live: clearing auth in Claude Code dropped the connection and opened a new session
without ever sending `DELETE`, so `onsessionclosed` never fired and the old session sat in memory
until the idle sweep. This is the *normal* case, which makes `MCP_SESSION_IDLE_TTL_SECONDS`
load-bearing rather than defensive — without it every re-authentication leaks a session
permanently, and `MCP_MAX_SESSIONS` would eventually be reached by ordinary use.
The cap then refused every newcomer with 503 for up to the whole TTL while the slots were held by
nobody. *(Solved 2026-09-29: at the cap a new session closes the least recently used one quiet for
60 s with nothing in flight; 503 only when every session is busy.)*

**An argument name the schema does not have was dropped in silence — and for `orderBy` that meant
a confident wrong answer.** Zod strips unknown keys and the SDK hands the handler the parsed value.
`orderby` (the OData spelling) returned rows in Ivanti's RecId order, and `orderby: 'NoSuchField'`
was accepted too: `assertOrderBy` guarded a parameter that never arrived. *(Measured 2026-09-17.)*

Fixed by closing the shapes, not by accepting the alias: `strictInput` in `defineTool` builds
`z.strictObject(shape, { error })` — `.strict()` ignores its parameters — so the SDK refuses before
the handler and names the near miss. `suggestNames` is asked second, because it skips a
case-insensitive match. A zero-argument tool stays open: clients send a dummy property to one.

**A suggestion that ranks only by containment offers noise for a typo.** `suggestNames` matched a
name that contains the guess, or is contained in it — so `Incidnet` was offered `ci` (two letters of
it, and a real object) and never `incident`, which neither contains nor is contained by a
transposition. A field typo in a filter (`Stauts`) got no suggestion at all. The refusal is the one
lesson a model gets at the moment it is wrong, so a bad suggestion buys a second wrong call — and
the short `object` description now leaves that lesson to the refusal. → `suggestNames` has a
typo tier (Damerau-Levenshtein, one slip under five letters, two above), and a name found inside
the guess must be at least half of it. The write path's private `orTypos` fallback, which the
noise had been blocking, is gone. *(Measured live 2026-09-29.)*

**Closing the shapes blinded an existing guard.** `description-budget.test.ts` enumerated
`inputSchema` with `Object.entries`, which on a `ZodObject` yields zod's internals — it measured zero
parameters and passed. `declaredArguments` reads either form. A test that enumerates a structure
fails silently when the structure changes shape.
*(Solved: `strictInput` and `declaredArguments`. Verified in the code 2026-09-28.)*

**The narration rule listed Ivanti's names and forgot the server's own.** A model obeyed "answer in
the tenant's words" and still opened with *"I need to call `act_as`"* — the instructions themselves
said "call `act_as` with it". A tool name addresses this server exactly as `ProfileLink_RecID`
addresses Ivanti. Fixed with one clause — *"Never name a tool to a person; ask in plain words"* —
for a net −1 character. *(Observed 2026-09-17.)*
*(Solved 2026-09-17. Verified in the code 2026-09-28.)*

**Elicitation exists in this SDK and is unused — an open investigation, not a trap.**
Protocol `2025-11-25` (what SDK 1.30 implements) gives the server `server.elicitInput(...)`, which
asks the **user** a question directly instead of asking the model to ask. That is interesting for
exactly one thing here: the whole threat `act_as` is built against is a name that came from a
record rather than from the person, and today the only defence is a sentence in the tool
description telling the model where the name must come from. A name collected by elicitation
provably came from the human.

What to establish before building on it:
- **Which clients implement it.** The SDK throws `Client does not support elicitation` when the
  client did not declare the capability at `initialize`, and `getClientCapabilities()` reports it —
  so support is detectable and the fallback to today's prompt is writable. A version that *depends*
  on it is unusable everywhere it is absent, which is most places today.
- **What a decline looks like** versus a timeout versus a transport that dropped — three different
  situations that must not collapse into one refusal.
- **How it behaves under stdio**, where there is no browser and the client is a terminal.
- **Whether it is worth it at all** once the identity is verified: a signed-in conversation pins
  itself from the token, so elicitation would only strengthen the *asserted* path — which is
  explicitly an accepted risk (design §5), the same one the phone line has.

**Session state is in-memory.**
`SessionStore` is a `Map` in the process. Restart drops every session (clients re-`initialize`,
so it reconnects rather than errors), and **there is one replica**: `initialize` carries no
`Mcp-Session-Id`, the pod that answers it mints one, and no hash of a pod-minted id routes the
next request back to that pod — so "sticky routing by `Mcp-Session-Id`" cannot work, and the chart
refuses `replicaCount > 1`. A second instance answers `404 Unknown or expired session`.

---

**`McpServer.close()` resolves before the release it starts.**
The SDK calls `onclose` synchronously, so a `void slot.release()` inside it is still in flight when
`close()` has resolved — and `process.exit` raced it. The factory's `close` now returns the release
promise and shutdown awaits it, bounded by the shutdown deadline.

**`StdioServerTransport` never notices stdin ending, and `listen()` returns before the port is bound.**
A stdio client that quits left the process running with its Ivanti session held; the server now
tears the conversation down on stdin end (only when HTTP is off — a container's stdin ends at
once). And `server.listen()` returns immediately: "listening on http" was logged before an
`EADDRINUSE` that then killed the process. Log on the `listening` event.

**Node's 5 s keep-alive is shorter than every load balancer's idle timeout.**
The proxy reuses a connection Node has already closed and answers 502. `keepAliveTimeout` is 65 s
and `headersTimeout` 66 s; `requestTimeout` bounds receiving the request only, never the answer.

**Admission counted only registered sessions.** Concurrent `initialize` requests near the cap all
passed `admit()`, were refused by `register()`, and the SDK answered them `404 Session not found`.
A slot is now reserved at admission and given back if the initialize fails.

## Configuration

**Transport and `AUTH_MODE` are separate axes.**
An early version folded `stdio` into `AUTH_MODE`, which made `stdio` and `none` two spellings of
"no authentication" and left no way to say "HTTP" without also picking a door. Both directions now
fail closed: HTTP on with no `AUTH_MODE` refuses to start, and an `AUTH_MODE` set while HTTP is
off is an error rather than a silently ignored setting that looks protective.
*(Solved: separate settings, and both mismatches refuse to start in `validate-config.ts`. Verified in the code 2026-09-28.)*

**Transports are two booleans, not one list.**
`STDIO_TRANSPORT_ON` / `HTTP_TRANSPORT_ON`, both may be on. A list (`MCP_TRANSPORT=stdio,http`)
was tried and rejected: changing one transport means restating the whole list, which is exactly
what breaks under layered env config — a compose override or k8s patch that sets only `http`
would silently drop `stdio`. Booleans also need reading, not parsing.

**Turn `STDIO_TRANSPORT_ON=false` in an HTTP-only container.**
Left on with no stdin attached the transport just sees EOF — harmless, but noise. It is on by
default because it listens on no socket, which is the safe default when nothing was said.

## OAuth

**`OAUTH_AUDIENCE` is not `MCP_PUBLIC_URL`.**
It defaults to it, but **no mainstream IdP mints `aud` from the client's RFC 8707 `resource`
parameter** — Zitadel emits a numeric project id (audience comes from the scope
`urn:zitadel:iam:org:project:id:{projectId}:aud`), Entra emits an App ID URI (`api://…`).
Keycloak behaves the same way. A verifier written to the spec's literal wording rejects every
real token. Validation is **membership in `aud`**, which may be an array.

**`MCP_PUBLIC_URL` must be a canonical resource URI** — absolute, no fragment, no trailing slash.
It is compared verbatim against the token audience, so a stray `/` produces an audience mismatch
that reads like a client bug. Enforced by `canonicalUriProblems()` at startup.

**Entra's issuer string depends on the token version.**
v1: `https://sts.windows.net/{tid}/` · v2: `https://login.microsoftonline.com/{tid}/v2.0`. Pin
`requestedAccessTokenVersion: 2` in the app registration so this is not ambiguous.

**Entra's metadata resolves only on the third discovery probe.**
Its issuer carries a path, and only the path-*appending* form
(`{issuer}/.well-known/openid-configuration`) answers. Dropping the fallback order breaks Entra
while leaving Zitadel working.

**JWKS must refetch on an unknown `kid`.** Entra rotates signing keys; a cache that never
refreshes turns a routine rotation into an outage. `createRemoteJWKSet` handles this — do not
replace it with a naive fetch-once.

**Zitadel's *default* access token is opaque, not JWT.**
Our instance is configured for JWT, so JWKS validation is enough. A new Zitadel app will default
back to opaque, and a JWKS verifier cannot validate it at all — there is nothing to parse.
Introspection (RFC 7662) is the fallback if that ever becomes necessary.

**Half of mainstream IdPs do not support Dynamic Client Registration.**
Measured 2026-09-10: absent on Entra, Google, JumpCloud, Duende and GitLab; present on Okta,
Auth0, Keycloak, Zitadel and Salesforce. So `claude mcp add --client-id <id> --callback-port <n>`
against a **pre-registered** app is the normal path, not a workaround. Assuming DCR works is the
mistake.

**A DCR-created client inherits the IdP's *default* token type.**
Cost real time here: Zitadel's default is Bearer (opaque), so every `/mcp` re-authentication
registered a brand-new app that was opaque again, and flipping one app to JWT lasted exactly
until the next re-auth. Pin the client id instead of chasing apps. Okta has the same shape — its
*org* authorization server issues opaque tokens while a *custom* one issues JWTs.

**Multi-tenant Entra apps are not supported, and the failure is subtle.**
Microsoft's tenant-independent metadata returns an issuer containing a `{tenantid}` placeholder
that a validator is expected to substitute with the token's own `tid` before comparing. Our
verifier matches `iss` exactly, which is right for single-tenant and wrong for multi-tenant. Set
`signInAudience: AzureADMyOrg`. A deployment per tenant is the supported shape anyway.

**In Entra, a redirect URI under *Web* is not the same as one under *Mobile and desktop*.**
They are different manifest arrays (`web.redirectUris` vs `publicClient.redirectUris`), and
`allowPublicClient` defaults to **false** — so a CLI client registered under *Web* is treated as
confidential and asked for a secret it does not have.

**Entra does not advertise `code_challenge_methods_supported`.**
It is the only one of ten surveyed that omits it, and the spec says a conformant client **MUST
refuse to proceed** when it is absent. Entra does support PKCE S256 — it just does not say so.
Nothing server-side can fix another party's metadata document. See design §12.

**A `WWW-Authenticate` description has a length budget; a log line does not.**
The opaque-token diagnostic was ~286 characters against a 200-character cap, so the header was
truncated mid-sentence and the *remedy* — "Set the application to issue JWT access tokens" — never
reached the client. A diagnosis whose fix is cut off is worse than no diagnosis. `TokenVerification`
therefore carries a short `description` for the challenge and an optional longer `detail` for the
log.
*(Solved: `TokenVerification` carries `description` for the challenge and `detail` for the log. Verified in the code 2026-09-28.)*

**`WWW-Authenticate` values must be printable ASCII.**
RFC 6750 restricts them to %x20-21 / %x23-5B / %x5D-7E, and Node throws
`Invalid character in header content` on anything outside Latin-1 — turning a clean 401 into a
500. An em dash in an error message was enough. `buildWwwAuthenticate` sanitises and truncates,
because the description is prose and prose acquires punctuation.
*(Solved: `buildWwwAuthenticate` replaces anything outside the RFC 6750 range. Verified in the code 2026-09-28.)*

**Never mount the SDK's `mcpAuthRouter` or `proxyProvider`.**
They are the *authorization-server* half — `authorize`, `token`, `register`, `revoke`. Mounting
them turns this server into an IdP. We serve only `mcpAuthMetadataRouter`-equivalent metadata and
bearer verification.

---

**jose's key cache goes stale after 10 minutes, and a failed reload throws.**
Past `cacheMaxAge` every `getKey` awaits a reload, so an IdP outage turned every request into a
503 although the keys in hand still verified. The resolver now falls back to the last good key
set and backs off (30 s up to 5 min) between refresh attempts; an unknown `kid` still refreshes.
A *discovered* `jwks_uri` must be https (or loopback), like the configured one.

**`email` is not an identity unless the IdP says it verified it.**
Keycloak's account console, Auth0 with self-signup and Entra optional claims for guests let a user
set their own address. The default claim order now uses `email` only with `email_verified: true`;
Entra and Zitadel access tokens often carry no `email_verified`, so they fall through to
`preferred_username` / `upn`, or need `OAUTH_IDENTITY_CLAIM`.

## Ivanti

**Business Object allowlists key on the *technical* name**, never the display name — display
names are customizable and localizable per tenant, so a rename silently empties the allowlist.

**Incident numbers are sequential.** Exposing `get_record` by IncidentNumber in `enduser` mode is
ticket enumeration across the whole company; the model would happily walk #11160, #11161, #11162.

**Ticket text is attacker-controlled.** Anyone who can file a ticket can put text in front of the
model, which is why read tools carry `openWorldHint: true` and why an asserted identity is pinned
server-side rather than re-read from tool arguments.

**The Ivanti auth header is `rest_api_key=<key>` — equals sign, not a space.**
`Authorization: rest_api_key=super-secret-key`. Asserted by a test in `overlord-service`; our
first placeholder guessed the space form. *(Resolved 2026-09-11.)*

**`AuthenticateTenantAPIKey`'s `role` argument is a request, not a guarantee.**
Asking for a role the account does not hold silently downgrades to its real one. On a live tenant
in 2026-09 it went further: an account holding several roles (`HasMultipleRoles: True`) answered
`ActiveRole: Admin` no matter what was asked for — `ServiceDeskAnalyst`, `SelfService` and
`Employee` all came back as Admin, and the admin console answered 200 for each. So the argument
cannot be used to *drop* privilege either, and a server cannot test its own degraded path by
asking for a lesser role. Read the effective role back from `InitializeSession` (it reports
`ActiveRole`) and refine it with `Session.asmx/GetUserData`; never assume what was asked for.

**Without impersonation, anything Ivanti resolves "for the current user" answers for the service
account.** A saved search called "My …" returns the API key's service account's items, never the
caller's, and filtering by `Customer` is the only thing that reflects the person actually asking —
which is why the effective `DisplayName` belongs in the server instructions. With the ConfigDB pair
configured, `act_as` opens Ivanti's own session for the person, and "my" then means them.

**The `/HEAT` prefix is usually present but not always.**
`…/HEAT/api/odata/…` on some tenants, `…/api/odata/…` on others. Probe both once at startup and
keep whichever answers, rather than making it a config field someone gets wrong.

**The BO catalog has two sources and neither is strictly better.**
`Workspace.asmx/GetRoleWorkspaces` is role-scoped and rich (display names, layouts) but needs the
ASMX session. `$metadata` entity-type names need only `rest_api_key` and are **wider** — OData
access is governed by Object Permissions, not workspace membership, so an analyst role reads
plenty of objects it has no workspace for.

**`InitializeSession` already reports the effective role.**
Its `SessionStatus` carries `ActiveRole`, `ActiveRoleDisplayName`, `UserName` and
`SessionCsrfToken`, so the identity is known after step two and `GetUserData` only adds the display
name. That matters because `GetUserData` is the step most likely to fail — treating it as optional
keeps the session usable and the role honest. Measured live 2026-09-11.

**The SID is not a GUID.** `AuthenticateTenantAPIKey` answers `"<host>#<KEY>#1"` — 58 characters on
a live tenant. Anything validating it as a GUID would reject a working session.

**`GetRoleWorkspaces` already carries the Business Object id — do not derive it from the layout.**
Each row has `ID` (`Incident#`, `OnboardingRequest#`, `XLJ_Car#`, `CI#Service`) and a `Profile`;
the object workspaces are the ones with `Profile === 'ObjectWorkspace'` — 24 of 31 on a live
tenant, and every one of their ids is real. Deriving the object from `LayoutName` instead
(`Onboarding` → `Onboarding#`, `CarLayout` → `Car#`) is wrong for exactly the interesting cases,
and the confirmation call it forces — `GetWorkspaceData` — answers **HTTP 500** for a wrong guess
rather than a clean "no". One call, no guessing, no 500s. *(Corrected 2026-09-11 after measuring;
the earlier layout-derivation came from `overlord-service`.)*

**The admin console is real, and the path needs `services/`.**
`/HEAT/AdminUI/AppDesign.asmx/GetBriefBusinessObjects` answers **404**;
`/HEAT/AdminUI/services/AppDesign.asmx/GetBriefBusinessObjects` answers **200** with the tenant's
complete catalog — 1324 objects, 505 KB, ~50 ms warm — each with `id`, `name`, `displayName`,
`description`, `commonlyUsed` and `pureValidationObject`. Booleans arrive as the strings `'True'`
and `'False'`. An admin-rights key reaches it; a key without those rights does not, which is why
everything built on it falls back to the workspace list and then to the metadata names.

**`permissions` in that catalog is not an access boundary.**
It takes the values 0, 2 and 3 (47 / 829 / 448 objects), and a `permissions: 0` object such as
`CurrencyCode#` still reads perfectly well over OData. It describes admin-console design rights,
not data access — filtering a catalog by it would hide objects the caller can read.

**The handshake is fast.** Measured with curl on a live tenant: `AuthenticateTenantAPIKey` 18-58 ms,
`InitializeSession` 29 ms, `GetUserData` 68 ms. A slow handshake means something else is wrong.

**The `.ashx` handlers live one folder deeper than expected.**
`/HEAT/handlers/GridDataHandler.ashx` answers 404; the real path is
`/HEAT/handlers/GridDataHandler/GridDataHandler.ashx` — a folder per handler, found by reading the
app's own `Default.aspx`. The third calling convention is confirmed there: a form-urlencoded body,
the CSRF token as a **lowercase `_csrftoken` header**, and a `text/html` reply. Without that header
the handler answers **551**; with it, 200. The payload each handler wants is its own business and
is still unknown for GridDataHandler. *(Corrected 2026-09-11 — the earlier note said the handler
was absent on this tenant.)*

**Ivanti names a field three times, and the user reads the one nearest them.**

| Layer | Where it lives | Example |
|---|---|---|
| technical name | the object | `Symptom` |
| display name | `TableMeta.Fields[].DisplayName` | `Description` |
| form label | a form control's `Label` | whatever this form's designer chose |

A form may rename a field **for its own users**, so the display name is not the last word: two
forms over the same object can show the same field under different words, and the words a person
quotes are their form's. `fieldLabels` therefore resolves form label → display name → technical
name, in that order.

**The limit of that, measured:** the form this server resolves is the create/header form, and on a
stock tenant it binds almost no fields — `Incident.Admin.Header.AUSpark` has **one** field-bound
control out of twenty. So nearly every label in practice comes from layer 2, and a field renamed
on some other form is invisible here. That is a gap to know about rather than one to paper over:
when a user's words match nothing, ask which screen they are reading rather than assuming the
field does not exist.

**Field labels and link fields differ per object — the same field name can mean different things.**
Measured across one tenant's forms: `ProfileLink` is labelled **"Customer"** on `Incident#` and
**"Contact Link"** on `ServiceReq#`; `Change#` has no `ProfileLink` at all and carries
`RequestorLink`; `FRS_Knowledge#` has **no link fields** while `CI#` has 21. The label "Customer"
exists on exactly one of those objects. "Description" resolves to `Symptom` on incidents and
service requests, `Description` on changes, problems and CIs, and **`Details`** on knowledge
articles.

So nothing may hardcode a mapping, and a tool description that teaches one object's field names as
the general rule is a bug even when the code is right: the model will carry `ProfileLink_RecID`
from an incident to a change, where it does not exist. The rule that *is* general is the shape —
a link is `<Link>_RecID` plus `<Link>_Category` — and `get_link_fields` answers the rest per
object. `Task#Assignment` has no form for an admin role here at all, so it has no answer to give.

**Ivanti's required-field refusals name DISPLAY names, and some of them are not fields.**
`Required field Incident.Description value must be provided` means `Symptom`; `Incident.Customer`
is not a field at all but a link, written as `ProfileLink_RecID` plus `ProfileLink_Category`. The
translation lives on the form — `TableMeta.Fields[].DisplayName` and `LinkIdMap` — and without it
a caller writes a field that does not exist. Measured live 2026-09-11.

**Required-field rules are conditional, and fire on a status change.** An incident accepts `Logged`
with nothing and refuses `Active` until Category, Owner and Team are set — in the same call, with
nothing asking beforehand. See "The form carries required and read-only rules" below.

**The CSDL `validated` flag and the form disagree — in both directions.**
Task's `$metadata` reports **no** validated fields while its form declares **twenty**; a role's
form can equally be narrower than the object. Gating the write path on the CSDL flag therefore
sent a picklist value out unresolved and Ivanti answered **500 with an empty message**. The form
is the authority for a write; the form chain is cached per object, so consulting it costs three
calls once.

**A quick-action "preview" over the grid path RUNS the action.**
`Save.asmx/SaveDataExecuteAction` honours `shouldSave: false` on the **FormParams** path only;
`GridParams` ignores it and executes while answering like a probe. So a preview needs a form the
role can reach, and where there is none this server refuses to preview rather than guessing. The
form path is verified harmless: two previews against a live incident left `LastModDateTime`
unchanged.

**A quick action's failure is in `validationErrors`, not in `status`.**
The shape is `validationErrors[recId].fieldErrors[field].fieldMessages[]`, and those messages name
the field — *"Category: Required field Incident.Category value must be provided"* — while the
top-level status says only that something went wrong. `PreDeleteObject` is worse: a clean preview
answers **status `error`** while carrying nothing but warnings, so only `errorMessages` blocks.

**Seven of 104 quick actions on a stock Incident are `UIAction`.**
They are behaviour of Ivanti's own web client with nothing to execute server-side: running one
answers OK and changes nothing. Both the preview and the run refuse them, because reporting that
as success is worse than refusing.

**Action ids are per-tenant *and* role-scoped.** An id seen under another role, or on another
tenant, does not exist here — so every call re-reads the list rather than trusting an id it was
handed.

**A saved search keeps every key and blanks the values under `$select`.**
Asking for `$select=Subject` returns all 181 keys with nulls in the ones not selected, so it costs
a round trip and saves nothing; the trim is client-side. A search that matches nothing answers
**204 with an empty body**. Thirteen of the 25 saved searches on a stock Incident begin "My" and
resolve against the signed-in account — the API key's, never the caller's.

**Ivanti has no aggregation endpoint.** "How many per status" is one filtered count per value, and
the values come from the field's own validation list. That is why `group_count` is capped at 25
buckets: each one is a round trip.

**A base type cannot be created — its subtypes can.**
`Task#` is a base type with seven subtypes (`Task#Assignment`, `Task#WorkOrder`, …), and `TaskType`
is its type *selector*, not a picklist: `get_pick_list_values` reports no options because there are
none to choose. `POST /Tasks` answers `400 Required field Task.TaskType` and, once a plausible
value is supplied, **500 ISM_5000 with an empty message**. `POST /task__assignments` with nothing
but a Subject succeeds. Reading the base type is fine — `/Tasks` returns all 215 tasks whatever
subtype each one is.

Subtypes are visible in any catalog (`task__assignment` in CSDL, `Task#Assignment` in the admin
console), so `get_object_metadata` reports them and a failed create names them. Detecting them
needs the **widest** catalog: no default metadata graph contains `task__assignment`, so asking
only the graphs reports "no subtypes" and the real cause never surfaces.

**A validated field's values are not in `$metadata`.**
They live on the create form, reached by walking `GetRoleWorkspaces` → `GetWorkspaceData` →
`FindFormViewData` → `GetFormDefaultData` → `GetFormValidationListData`. Calling the last one
without that context fails with a misleading *"You do not have permission to view this item"*.
The reply is columns, not objects: the stored value is at the **lowest** index in `FieldMap`,
`DisplayName` labels it, `RecId` identifies it, and an empty list with `SameAs` means "reuse that
field's options". Measured live: Incident Status has 7 values, Priority 5, Source 13.

**`CentralConfig/RemoveSession` does not end the session, in either spelling of the id.**
Measured live 2026-09-15 by driving `openImpersonatedSession` itself rather than a hand-rolled
handshake — the first two attempts at this measured the wrong thing twice, once by dropping the
`/HEAT` base path and once by using `GetUserData`, which 500s permanently for some accounts and so
reads as "dead" for a session that is fine.

With a fully activated session and `Session.asmx/GetRoleWorkspaces` as the liveness test:

| | workspace call works |
|---|---|
| before `release()` | yes |
| after `release()` (composed `<host>#<id>#1`) | **yes** |
| after `release(<bare middle segment>)` | **yes** |

`RemoveSession` answers **200 with an empty body** every time, which is why nothing ever said so —
and `release()` swallows non-2xx by design on the reasoning that a leaked session expires anyway.
So the composed-vs-bare question the review raised is not the issue: neither form works.

→ Two consequences. Calling `release()` is still right — it is the documented teardown, it costs
one request, and a later Ivanti version may honour it — but it must not be relied on: an
impersonated session lives until the tenant timeout, measured at **18,000 s** via
`GetTenantTimeout`. And a deployment opening many short conversations accumulates sessions on the
tenant for five hours regardless of how carefully it tidies up. If that ever matters, the lever is
the tenant timeout, not this call.

**`/api/rest/Attachment?ID=` accepts a SID cookie, so file bytes can follow the person.**
Measured live 2026-09-14. `requestBinary` was the one transport method that did not go through
`send`, so it ignored the SID it was built with and always sent `Authorization: rest_api_key=` —
fetching file BYTES as the service account while the attachment row read, and the DELETE of that
same attachment, both used the person's SID. Routing it through the same credential branch was
assumed to be safe on the strength of the DELETE; it is not an assumption any more. With the
change in place, `act_as` followed by `download_attachment` returned the file on
`Cookie: SID=<person>` with no `Authorization` header at all.

→ The open question this closes was whether Ivanti's REST-by-id fetch is *stricter* than its OData
row read, which would have meant a person could see an attachment row and not its bytes. It is not.
The remaining honest limit is that both were measured as the same Admin account: a role that can
read the row but not the file would still be invisible here.
*(Solved: `requestBinary` goes through the same credential branch as every other call. The role limit in the last paragraph is still open. Verified in the code 2026-09-28.)*

**A field on a validated list can still be *computed*, and the write is overridden without a word.**
`Incident.Priority` is on the picklist — `get_pick_list_values` returns its five values, and a write
passes every client-side check — but this tenant derives it from `Urgency` × `Impact` and overwrites
whatever was sent. Measured live 2026-09-14, creating five incidents in one batch:

| Urgency | Impact | Priority sent | Priority stored |
|---|---|---|---|
| Medium | Low | 4 | 4 |
| High | Low | 3 | 3 |
| Low | Low | **4** | **5** |
| High | High | **2** | **1** |
| Low | Low | 5 | 5 |

The three that matched were the ones where the guess happened to agree with the matrix, so a smaller
sample reads as "it works". Ivanti answers **201 for all five** and stores `Priority_Valid` pointing
at the option it chose, not the one that was sent — so nothing on the wire says the value was
rejected. `confirmWrite` is the only thing that catches it, and it does: the two divergent writes
were reported as failures naming the field, the value sent and the value stored, while the record
itself exists.

Two consequences. A caller who sets `Priority` alongside `Urgency`/`Impact` should expect to be told
the write did not store, and that is correct behaviour rather than a bug to route around — the fix is
to set the drivers and let the rule decide, or to set `Priority` alone. And the refusal text points
at "a stale option list … or a value that needs a different cascade parent", which is the wrong
advice here: the list was fresh and the value was legal. **A computed field is a third cause that
message does not name.**
*(Solved: the refusal now tells a computed field — one on the form's read-only list — from a stale
list, and names the validated fields that did store as its likely drivers. Code 2026-09-29.)*

**A cascade parent supplied under the wrong name filters nothing, silently.**
`GetFormValidationListData` takes the parents inside the data model, so a key the form does not
have is simply ignored and the answer comes from the unfiltered list — whose values may not be
valid for the record in hand. Nothing in the reply says so, which is why the tool compares the
supplied keys against the form's own fields and reports the ones it ignored.

**An unknown entity set is not an error — Ivanti invents the entity.**
`/api/odata/nonexistents/$metadata` answers **200** with valid CSDL containing
`<EntityType Name="nonexistent" />` and an `EntitySet` to match: no fields, no relationships. Every
real Business Object has at least RecId, so `parseCsdl` drops field-less entity types and the
catalog reports the name as unknown *with suggestions*. Measured live 2026-09-11.

**Only the graph's root entity carries relationships.**
Measured live: in the incidents graph, `task` has 90 fields and **0** relationships; in
`tasks/$metadata` the same entity has 90 fields and **29**. Field counts agree across graphs
(90/90, 127/127, 278/278) — relationships do not. So a relationship-less hit is not an answer, it
is a reason to fetch the entity's own graph, which is what `MetadataCatalog.entity()` does.

**No single document lists the tenant's Business Objects.**
A CSDL graph names only what its root relates to. The incidents graph names 38 entities; eight
well-known graphs together name ~200, in under a second. The full ~1300-entry list lives behind
`/HEAT/AdminUI/`, which an analyst key is refused — so the union of graphs is the widest catalog an
ordinary key can reach, and `list_business_objects` says so rather than implying completeness.
Lookups are not limited to it: `entity()` finds anything real by fetching its own graph.

**A page of whole records is 187,000 characters.**
`list_records` with the default `top=25` and no field list measured **187,278 chars (~47k tokens)**
on a live tenant — an incident carries ~180 fields. The same call projected to a compact set is
9,496. A tool description asking the caller to narrow the fields does not prevent this; the
default has to be narrow, with an explicit `"*"` for the rare case that wants everything.

**`$top` is capped at 100.** 100 returns 100 rows; **101 answers 400** `ISM_4000 "Invalid Request
Payload"`. `$skip` pages without repeating rows, so paging is the way past the cap.

**`@odata.count` arrives unasked, and can contradict its own rows.**
Ivanti includes it on plain queries without `$count=true`. It has been seen smaller than the page
it came with; `readTotal` reports that as a **floor** (`exact: false`) rather than a total, because
reporting a floor as a total is the failure the count tools exist to prevent.

**`$search` is the only substring mechanism, and it works.**
Case-insensitive, composes with `$filter`, and returns a count: `printer` matched 48 incidents on
a live tenant where `contains(Subject,'printer')` returned the full unfiltered 545. `$expand`, by
contrast, is silently ignored under `rest_api_key` — a request that looks like it inlined related
records did not.

**Null and dates in a filter.** An empty field matches only as `Owner eq '$NULL'`. Dates are bare
and unquoted — `CreatedDateTime gt 2026-01-01`; the OData v2 form `datetime'…'` is rejected with a
400 that blames the field rather than the literal.

**Parentheses count only at the start of a `$filter`.** Anywhere else Ivanti answers 200 with
the wrong rows. Measured on `incidents` (2026-10-01): `(P1 or P2) and Status eq 'Active'` counted
16; `Status eq 'Active' and (P1 or P2)` counted 121, the same as dropping the `and` altogether;
`Logged or (Active and P1)` counted 0, where the group-first form counted 30. Two server-built
filters had the group last — `group_count`'s bucket clause, and the directory's first-and-last
name pair, which therefore matched nobody — and both now lead with it. `own-records` wraps the
caller's filter as `(filter) and <person>`, group first, and the person clause held under every
inner shape tried. Build any new filter the same way: one group, first.

Two more, measured the same day. **An `and` after an `or` in one group is misread too:**
`Logged or Active and P1` counted 0, which is neither reading (30 or 6), while `Active and P1 or
P2` counted 60, as written. **`not` is never applied:** `not (Status eq 'Closed')` counted every
incident, `Active and not (P1)` counted all Active, and a bare `not A` is a 400. All three shapes
are now refused before sending (`findMisreadGrouping` in `odata/filter.ts`); over what remains,
the own-records wrap and `group_count`'s bucket counted exactly right.

**The scrubber matched spellings, not the class — for the third time.**
A quote reaches an error body however many layers encoded it: backslash-escaped at any depth,
`&quot;`, `&#34;`, `&#x22;`, `&amp;quot;`. Ivanti's OData 500s are entity-encoded, and
`{&quot;SessionId&quot;:…}` passed through unredacted. Delimiters are a class, and the closing
one must match the opening one.

**A non-CSDL 200 was cached by the parse branch.**
The fetch branch already refused to cache a failure; the parse branch cached anything that would
not parse, so a WAF or maintenance page on the seed `$metadata` URL made `Incidents` unknown until
restart. Only a body that looks like CSDL — Ivanti's own fabricated, field-less answer to a typo —
counts as an answer worth caching.

**`fetch failed` hides the reason in `.cause`.**
undici rejects with `TypeError("fetch failed")` for DNS, refused connections, resets and TLS
interception alike; the code (`ENOTFOUND`, `ECONNRESET`, `CERT_*`, `UND_ERR_*`) is on `.cause`.
`exchange()` now appends it, scrubbed.

**"No answer" was reported as "no" — three times over.** A write this side gives up on is often
committed on Ivanti's: a create runs the tenant's workflow before it answers, and the timeout was a
fixed 10 s (15 s for ASMX). Status 0 fell through to *"Ivanti refused the request (0)"*, which a model reads as
"did not happen" — so it filed the ticket again, approvals and notification emails included. The
same shape elsewhere: a failed journal count became "no other activity", and a 500 or a timeout
during an ownership check became *"No such record is available to you."* → A write with no answer
(status 0, or a gateway's 502 or 504) says it may have been applied and to look before retrying;
writes get their own, longer timeout (`IVANTI_WRITE_TIMEOUT_MS`); an uncounted total is reported
as unknown; only Ivanti's `Invalid key` dialect reads as "not yours". *(Found in the 2026-09-29
review; the 30 s write timeout against a workflow-heavy create is not yet measured.)*

**`SubmitRequestForUser` now gets `serviceReqData.Subject` and `localOffset`.**
Measured 2026-09-29: with `localOffset` the file path stores a date answer correctly. Whether it
honours `Subject` is still open — both offerings tried (Generic Work Order, Data Restore) set their
own subject on either path — so the subject is read back and reported (`subjectNote`) rather than
assumed.

**A `time` parameter is stored as an instant on the day it was submitted.**
`14:30` on a UTC+2 tenant came back as `2026-09-29T12:30:00.0000000Z`. The verifier compared dates
and instants but not a time of day, so a correct submit read as `storedDifferently` — the false
mismatch that sends a caller into a second, non-idempotent submit. It now compares the wall clock
the instant lands on in the tenant's frame. *(Measured and fixed 2026-09-29.)*

**`$filter` does not follow OData's `and`-before-`or`, and an unbalanced filter is a 400.**
Measured 2026-09-29 on the dev tenant, `count_records` on incidents in `enduser` with no
impersonation, so the server sent `(<filter>) and ProfileLink_RecID eq '<me>'`. The person owns 8;
2 are Active; the whole tenant has 66 Active. A caller filter that closes its own parenthesis —
`Status eq 'Active') or (Status ne 'zzz'` — answered **2**, not the 66+ standard precedence would
give. `…') or Status ne 'zzz' or (Status eq 'x'` and `…') or (Status eq 'Closed'` answered **0**,
which no reading of the expression explains. The same filters sent unwrapped in `full` answer
`400 ISM_4000` "No such entry exists". → The own-records scope happened to hold, but on a parser
quirk nobody chose, and the answers were wrong. Refuse an unbalanced filter before sending it; never
reason about a mixed `and`/`or` filter from the OData spec.

**The validation-list endpoint is a POST.**
`/api/rest/ServiceRequest/{paramRecId}/ValidationList` needs `POST` with a constraints body: a GET
answers an empty XML array, which looks like "this list has no values".

**A refused key answers `401 ISM_4001`, not a 404.**
`"Invalid Session key or Authentication token or Host"` — measured with a wrong key and with an
empty one. The startup probe treats a 401/403 on any candidate as "the tenant is reachable, the
credential is wrong" and says so, because "could not reach Ivanti" sends whoever reads it to check
DNS and firewalls for a problem that is one environment variable.

**`Accept: application/json` on `$metadata` turns a 200 into a 500.**
Ivanti tries to content-negotiate CSDL into JSON and throws: the body comes back as
`Unhandled system exception: {&quot;error&quot;…}`, 592 bytes, status 500. The *same URL* with
`Accept: application/xml` (or no Accept at all) answers 200 with 325 KB of CSDL. Measured on a
live tenant 2026-09-11. `requestText` therefore defaults to XML, and the base-path probe asks for
XML explicitly.

**`$metadata` is served per graph, and the obvious forms are the ones that do not exist.**
Measured live: `/HEAT/api/odata/$metadata` and `/HEAT/api/odata/businessobject/$metadata` both
answer `404 ISM_4004 "No service"`, while `/HEAT/api/odata/incidents/$metadata` answers the full
related graph — 38 entity types, 325 KB. Note the path has **no `businessobject` segment** and the
graph name is lowercase plural, unlike the CRUD route (`/api/odata/businessobject/Incidents`).
`overlord-service` arrived at the same three-candidate ladder, so this is not one tenant's quirk.

**Ivanti has three different ways of saying "no rows", and two of them are not arrays.**
Measured live:

| Request | Answer |
|---|---|
| Entity set, `$filter` matches nothing | **200 with a completely empty body** |
| Navigation property with nothing related | `{"value": "No instances found."}` — a **string** |
| Anything with rows | `{"value": [ … ]}` |

The sentinel is the nastier one: `value.length` is 19 and `value[0]` is `"N"`, so a caller that
trusts it reports 19 related records. `readCollection()` in `src/ivanti/odata/response.ts` absorbs
both, and **refuses any other string** rather than reporting prose as an empty result — "Access
denied" must not arrive as "no rows".

**Confirmed live: `$select` on a single-record GET returns nothing at all.**
Not merely a thin record — the body is `{"@odata.context": …}` and no fields whatsoever, while the
same record without `$select` returns 182. Projection is client-side, full stop.

**A 200 from `$metadata` is not proof the base path is right.**
A login page or a WAF interstitial answers 200 with HTML, and taking that as success poisons
everything downstream — the wrong base path is then used for every request and reads like an
authentication failure. The probe checks for an `<Edmx>` root, not just the status.
*(Found while building B1, 2026-09-11.)*

**The startup probe needs its own timeout.**
It runs before the process serves anything, so an unreachable tenant that accepts the connection
and never answers hangs the startup indefinitely — worse than exiting, because a container stuck
part-way through starting looks alive. `PROBE_TIMEOUT_MS`, separate from the request timeout.
*(Found while building B1, 2026-09-11.)* *(Since 2026-09-29 the probe is given `IVANTI_TIMEOUT_MS`,
the read timeout; `PROBE_TIMEOUT_MS` is only the default when none is passed.)*

**`encodeURIComponent` does not escape `'`, and Ivanti keys are single-quoted.**
`Incidents('<RecId>')` breaks out of the key on an apostrophe, so the key builder escapes it
explicitly. RecIds are 32-char hex in practice, but a URL builder should not depend on its
callers being well behaved. *(Found while building B1, 2026-09-11.)*

**Three CSRF conventions on one session, differing only by casing and placement.**
`.asmx` wants `_csrfToken` in the JSON body; `.ashx` handlers want lowercase `_csrftoken` as a
header with a form-urlencoded body and reply with a JavaScript object literal rather than JSON;
multipart uploads want `_csrfToken` as a **header, mixed-case**. Getting any of them wrong looks
like an auth failure. *(All three now have callers; the multipart casing was confirmed
2026-09-12 by the service-request attachment path.)*

**Keyword `search` over-matches, and the extra rows look exactly like real ones.**
`search: "John"` on Employees returns John Smith, John Davis, John M Doe — **and Scott Johnson**,
because it is a substring match across the record's text fields. Anything that asks a human to
pick themselves from a candidate list has to re-filter the result client-side against the fields it
actually meant, or it will offer a stranger as a plausible option.
*(Measured 2026-09-12, while designing `act_as`.)*

**`DisplayName` is assembled and includes the middle name.** "John M Doe", "Katherine M Joseph" —
so the full name a person types for themselves routinely fails to `eq`-match it. Match on
`FirstName` + `LastName`; display `DisplayName`. *(Measured 2026-09-12.)*

**OData `eq` is case-insensitive here.** `FirstName eq 'harold' and LastName eq 'SANDERS'` matches
Harold Sanders. Useful — no normalisation needed on either side — but worth knowing rather than
assuming, since it is the opposite of what `eq` means in several other OData implementations.
*(Measured 2026-09-12.)*

**The field guard ignored case, and everything after it did not.** The guard compared names
case-insensitively, and everything after it — the form's validated fields, the pick-list resolver,
the read-back — looked them up exactly. So `{status: 'Bogus'}` passed the guard, matched no
validated field, went out with no `Status_Valid` and no read-back, and was reported as a success;
`Status: 'Bogus'` was refused. Two checks that disagree about one name fail
open. → `knownFields` settles every written name to the schema's spelling before anything reads
it, and refuses two keys that differ only by case. Measured live afterwards: `subject` is written
as `Subject` and confirmed. *(Fixed 2026-09-29.)*

**`CreatedBy` can be overridden; `LastModBy` cannot.** Ivanti fills both from the session, but a
create that sends `CreatedBy` keeps it — measured on an incident and on a note. `LastModBy` is
stamped by the engine on every write even when sent explicitly, and the write **reports it as
changed** while storing the session account. That split is useful rather than annoying: an end
user's ticket can say they authored it while `LastModBy` records the account that performed it,
which is what actually happened. *(Measured 2026-09-12.)*
*(Solved: every written field is read back, and Ivanti's own stamps come back under
`ignoredByIvanti` rather than as changed — `update_record {LastModBy: …}` answered
`ignoredByIvanti: {LastModBy: "tyrunasj"}`. Verified live 2026-09-29.)*

**A raw field update is not a vote.** Setting an approval vote row's `Status` to `Approved` stored
the status, overwrote `VotedBy` with the **session account** despite being sent the approver's
login, and left the parent approval `Pending` — the workflow never fired. The verbs that work are
the `Approve Vote` / `Deny Vote` quick actions on the **vote row**, not "Approve My Vote" on the
approval, which resolves "my" from the session and would record the wrong person. Because the row
already belongs to a named approver, acting on it records *their* decision.
*(Measured 2026-09-12.)*

**A quick action runs through the form path with an empty form name.** `frs_approvalvotetracking`
has no form for the Admin role, so `run_quick_action` refuses it — but `SaveDataExecuteAction` with
`FormParams` and `formName: ''` executed it correctly (`saved: true, status: OK`) and moved the
row. So the no-form refusal is about not being able to *preview*, not about being unable to run:
where a run is intended and verified afterwards, the empty form name is enough and the grid path
is still never needed. *(Measured 2026-09-12.)*

**A vote that registers does not always advance its approval.** The vote row moved to `Approved`
with a fresh `VotedDateTime`, and the parent `frs_approval` stayed `Pending` — one voter, no
quorum to wait for, and no change after waiting. Whether that is specific to a 16-month-old demo
record or general is not established, so `vote_on_approval` reads **both** rows back and says
plainly when the vote is in but the approval has not moved. *(Measured 2026-09-12.)*

**A service request's attachments are staged before the request exists, and only the ASMX submit
binds them.** Three calls in order: `GetPackageDataSDA` (a session side effect, and the submit
refuses staged ids without it having run again immediately beforehand), `GetUploadTicket`, then a
multipart POST to `SelfService/handlers/UploadAttachmentHandler.ashx` carrying `objectId: ''`,
`objectType: 'ServiceReq#'`, the ticket and `multiplefiles: true`. The handler answers a
JavaScript object literal, not JSON: `{ attachmentIds:[ { filename:"x" ,attachmentId:"CE16…" } ] }`
— unquoted keys, leading commas. `SubmitRequestForUser` then takes `attachmentsToUpload` as
`[[id, filename]]` pairs, and its two location fields are not what they are named:
`strCustomerLocation` carries the form name `ServiceReqHeader.New`. Verified end to end — the file
lands with `ParentLink_Category: 'ServiceReq'` pointing at the new request.
*(Measured 2026-09-12.)*

**Keyword search reaches only what Ivanti INDEXES, and an empty result reads exactly like "none
exist".** Measured: `png` finds none of the tenant's **344 PNG attachments**, and `laptop` finds
neither computer whose `ChassisType` is literally "Laptop". It covers a ticket's subject,
description and notes — not structured fields, and on some objects almost nothing. This was the
single most dangerous sentence in the tool manifest, because it told a model an empty result
"genuinely means no match". *(Found 2026-09-12 by six agents driving the tools blind.)*
*(Solved as far as the wording goes: the sentence is gone from the manifest, and the server instructions call a keyword miss a weaker claim than a filter miss. What Ivanti indexes has not changed, so the trap itself still applies. Verified in the code 2026-09-28.)*

**A grouped count can omit most of the table while every bucket says `exact: true`.** The buckets
come from a create form's validation list; records holding a value that list no longer offers fall
into no bucket. Measured: a change's statuses summed to **12 of 51**, an incident's categories to
*(Solved: `group_count` reports `total` and `unaccounted`. Verified in the code 2026-09-28.)*
**81 of 547**. The per-bucket flag guards the wrong thing — the counts were right, the set of
buckets was short. `group_count` now reports `total` and `unaccounted`. *(Measured 2026-09-12.)*

**An unfiltered picklist is a SUBSET, not the union.** An incident's `Category` answers **5**
values unfiltered, **13** under one Service, and its backing object holds **69**. The unfiltered
answer is the list for the form's default parent, so presenting it as "the categories" understates
by an order of magnitude. *(Measured 2026-09-12.)*

**`ISM_4000` is not only "not found".** It is Ivanti's code for a refused payload generally: a
missing record answers it with `"Invalid key"`, and a **prompt-gated status transition** answers
the same code with `DataLayer.PromptException`. Matching the bare code made every gated transition
report "the record or field does not exist", which sent two independent testers hunting a field
name that was never wrong. *(Found 2026-09-12.)*
*(Solved: a `PromptException` is told apart from a missing record. Verified in the code 2026-09-28.)*

**An unhandled Ivanti exception volunteers session internals — sometimes escaped inside a JSON
string.** A 500 from `PreDeleteObject` carried `SessionId`, `TenantId`, `LoginId`, `Hostname` and
`ServiceName`, and `scrubErrorBody` redacted only the API key. An ASMX 500 nests them in
`LogEntryId` as `\"SessionId\":\"…\"`, and a regex matching only the plain form redacted one field
of six and read as working. *(Found 2026-09-12.)*
*(Solved: `errors.ts` redacts the session fields, plain and escaped. Verified in the code 2026-09-28.)*

**A service-request date is stored at the offset in force ON THAT DATE, not today's.**
`2026-11-01` submitted in September stores as `2026-10-31T23:00:00Z` — local midnight at the
winter offset, after the clocks change. Comparing instants against the offset discovered from a
recent record calls a correct write a mismatch, and a mismatch reported on a correct write is what
sends a caller into a second, non-idempotent submit. A bare date is compared by the day it lands
on, with an hour of tolerance. *(Measured 2026-09-12.)*

**`FRS_Knowledge` is a base type and the article body is not on it.** The base carries title,
status and a summary; an IssueResolution's actual fix lives in `Resolution` on
`frs_knowledge__issueresolution`. `FRS_KnowledgeType` on the base row names the subtype
(`IssueResolution` → `frs_knowledge__issueresolution`). Whatever fields the subtype has that the
base lacks *are* the body, which holds for all six subtypes without naming any of them.
*(Measured 2026-09-12.)*

**A client truncates a long tool description silently, and from the END.** So whatever sits last
is what disappears — which is where warnings go. Measured in `overlord-service` against the Claude
Code harness: two tools cut at ~2040 and ~2044, pointing at a 2 KiB cap that the MCP spec does not
mention. `src/tools/description-budget.test.ts` fails the build at 2000 rather than letting a
warning vanish into a conversation.

**A closed record is read-only everywhere except the update path.** A closed incident carries
`ReadOnly: true` (false for `Resolved`, `Active`, `Logged` — a resolved ticket can still reopen).
A DELETE answers 400 and a reopen answers `saved: true, status: 'error'` while changing nothing —
but a **PATCH answers 200 and stores the change**. So the flag is enforced here or nowhere
(`assertRecordWritable`), and a test record closed in passing cannot be tidied away.
`IsInFinalState` looks like the signal and is not: it is `false` on every record, closed ones
included. *(Measured 2026-09-12.)*

**A file downloads from the same endpoint that deletes it.** `GET /api/rest/Attachment?ID=<recid>`
streams the bytes with a real `content-type` and `content-disposition`; it is the same path as the
`DELETE`, differing only in method. Read it as bytes, never as text — decoding a PNG as UTF-8
produces something that is no longer a PNG. *(Measured 2026-09-12.)*

**An approval step holds no approver.** `frs_approval` has `Owner`/`OwnerTeam` for the step itself;
the people are on its `frs_approvalvotetracking` rows, where `Owner` is the approver's **login**
(`OwnerRecId` is null on this tenant), and `PrimaryParentObject` / `PrimaryParentID` name what is
waiting. So "what needs my approval" is a filter on the vote-tracking object, not on the approval.
*(Measured 2026-09-12.)* *(Corrected 2026-09-29: `Owner` is a login on most rows only — see the next
entry.)*

**`Owner` on a vote row is not one identifier, and a display name is not an identity.**
`Owner` holds a login on most rows, a display name on some — Becky Smith's fourth row stored
`Becky   Smith`, three spaces where no middle name was set — and an email on others (a request this
server had just filed). `Owner_Valid` is the employee RecId and never varies. Ownership was an OR of
all four, so a row whose `Owner_Valid` named someone else still matched on the display name, and
two people called John Smith could each list and cast the other's vote, recorded as the other's
decision. → When `Owner_Valid` is present it decides alone (`vote-owner.ts`); the `Owner` spellings
decide only on a row without one. `list_approvals` keeps its `Owner eq '<display name>'` clause —
it is how such a row is found at all — and drops the namesakes after reading. *(Found in the
2026-09-29 review; fixed in code.)*

**An object allowlist guards the object you NAME, not the object you REACH.** `get_related_records`
gated only its source, so on a tenant whose `ENDUSER_BUSINESS_OBJECTS` refuses `Employees`,
`IncidentOwnerEmployee` from an allowed incident returned the owning analyst's full employee record
— login, email, status. Traversal now checks the relationship's *target* against the same gate.
The same hole exposed staff-internal journal notes on the caller's own ticket, which `list_notes`
filters by `PublishToWeb` and a raw traversal did not.
*(Found 2026-09-12 while wiring notes; a gate that is enforced in one direction only is not a
gate.)*
*(Solved: `get_related_records` checks the relationship's target against the gate. Verified in the code 2026-09-28.)*

**Scoping the record you start from does not scope the rows it leads to.** `get_related_records`
in `enduser` checked that the parent was the caller's and returned whatever hung off it. Right for
children — a task or an attachment belongs to its parent — and wrong for associations:
`IncidentAssociatedServiceReq` led from the caller's own incident to somebody else's service
request, whole. Where `journal` was allowlisted it also returned the internal notes `list_notes`
filters out. → Each row is checked: the caller's own where the target has a person link, else only
rows whose `ParentLink_RecID` is the parent, else refused; the journal is refused in favour of
`list_notes`. *(Found in the 2026-09-29 review, not measured live; fixed in code.)*

**Stamping a record as the caller's does not stop a write un-stamping it.** `create_record` in
`enduser` stamped the customer link and `CreatedBy`, and `update_record` then wrote whatever it was
handed — so an end user could point their own ticket's `ProfileLink` at a colleague, or rewrite who
filed it. The create had the same hole in a quieter shape: the stamp was merged over the caller's
fields by exact key, so `profilelink_recid` rode alongside `ProfileLink_RecID` and Ivanti chose
which to keep. → In `enduser` the customer-link pair, the bare link and `CreatedBy` are refused in
any case, except a create naming the caller themselves. Measured live 2026-09-29: filing for
someone else, handing a ticket over and setting `CreatedBy` are all refused, and the stored
customer is the person.

**A group Business Object's extension name can end in `s`, and the name resolver singularised it
away.** `journal__notes` — the extension a person writes a note to — became `journal__note`, so
`list_business_objects` handed out a name that `list_records` then refused, suggesting the name it
had just been given. The entity set is the CSDL name plus a literal `s` (`journal__notess`), and
the guess that builds it would not add a second `s` either, so the right graph was never fetched.
Both directions now try the name as given before the guess. *(Found 2026-09-12.)*
*(Solved: `catalog.ts` tries the name as given before the singularised guess. Verified in the code 2026-09-28.)*

**`Journal` is a group object; a note is its `journal__notes` extension, and the two behave
differently.** Creating on the group needs `JournalType` by hand and puts the text in `Subject`;
creating on the extension sets the type itself, defaults `Category` to `Memo`, and has a real
`NotesBody` field. Reading through the group relationship returns Ivanti's own email traffic —
**7 of 7** journals on this tenant's incidents are `JournalType: Email` — while querying the
extension returns notes only. `PublishToWeb` is what separates a reply to the customer from an
internal note, and it defaults to **false**. *(Measured 2026-09-12.)*

**A knowledge article has an audience, and it is a row-level rule.** Ivanti's self-service portal
searches only articles whose `Status` is `Published`; Draft, In Review, Reviewed, Expired,
Archived and Rejected are internal. On this tenant that is 27 published against 18 that are not.
An object allowlist cannot express "this object, but only these rows", which is why the knowledge
base is reached through its own tool rather than by allowlisting `FRS_Knowledge`.
*(Measured 2026-09-12; states from the Ivanti admin docs.)*

**The attachment upload does half the job and reports success.** `POST /api/rest/Attachment`
stores the bytes and answers `[{FileName, IsUploaded: true, Message: '<RecId>'}]` — and leaves
`ParentLink_RecID` and `ParentLink_Category` **null**. The file exists, belongs to nothing, and is
reachable only by searching the attachment table for its name. Linking it is a second request, a
PATCH of the pair. Worse, the upload does not check the parent: posting against a RecId of all
zeroes answered 200 and created an attachment, so the parent has to be read *before* the bytes go.
*(Measured 2026-09-12; overlord recorded the same in May.)*

**A delete of an attachment that never existed answers 204.** So does a real one. `deleted: true`
means nothing unless the record was read before and after. *(Measured 2026-09-12.)*

**A service-request submit answers HTTP 200 when it refuses.** The envelope is
`{IsSuccess: false, ErrorText: "...", ServiceRequests: []}` and nothing is created. It names one
missing parameter at a time, by parameter *name*, so fixing one reveals the next.
*(Measured 2026-09-12.)*

**A service-request datetime needs the tenant offset NEGATED, and the sign is destructive.**
Sending `2026-09-30T00:00:00Z` to a UTC+2 tenant stored, by `localOffset`: `-120` →
`2026-09-30T00:00:00Z` (correct), `0` → `2026-09-29T22:00:00Z` (a day early), `+120` →
**`0001-01-01T00:00:00`** — the value destroyed, while the submit still reported `IsSuccess: true`.
The offset in a rendered Ivanti datetime is the one in force *at that instant*, so reading it off
an old row gets a daylight-saving-shifted answer; the newest row is the one to ask.
*(Measured 2026-09-12.)*

**A combo service-request parameter needs its option's RecId as a sibling key.** `par-<id>` holds
the value and `par-<id>-recId` the option; without it the submit is refused with *"'Department'
validation list's value was submitted without it's identifier."* — Ivanti's own apostrophes.
*(Measured 2026-09-12.)*

**`strUserId` on a service request is the person's RecId**, and `Frs_CompositeContract_Contacts`
shares it: the contact row for an employee or an external contact has the *same* RecId as the
person. So the id `act_as` pins is the one the submit wants, with no second lookup.
*(Measured 2026-09-12.)*

**An offering carries two different ids.** `strSubscriptionId` is what a submit takes and
`strRecId` what the parameter tools take. Mixing two offerings' ids creates a request with **none**
of the answers applied, which Ivanti reports as success — the only signal is an empty
`parameterTemplateParameterIds` in the reply. The whole catalog is also 144 KB of JSON for 132
offerings, most of it per-offering rendering hints. *(Measured 2026-09-12.)*

**An attachment's "relationship" to its ticket is just the attachment's own parent fields, so
unlinking one orphans it.** `IncidentContainsAttachment` and
`attachments?$filter=ParentLink_RecID eq '<incident>'` return the same row, because the
relationship is a view over `ParentLink_RecID` + `ParentLink_Category` on the attachment. Measured
live: `unlink_records` leaves the attachment row in place with **both halves null** — a file that
is on no ticket, that no ownership check can match, and that an end user therefore cannot reach or
clean up ever again. `link_records` puts the pair back, but only for someone who still has the
RecId, which after orphaning nothing will hand out. Detaching a file is `delete_attachment`;
attaching one is the multipart upload, which sets the pair itself. Neither is `link_records`.
*(Measured 2026-09-12 on throwaway records, all removed.)*

**CSDL spells an object lowercase; records spell it mixed-case, and a write needs the record's
spelling.** `$metadata` names the entity `employee`, while an incident's `ProfileLink_Category`
holds `Employee`. Deriving one from the other means guessing at capitalisation for every tenant
that renamed something, so `customer-link.ts` reads the spelling off sampled rows instead.
*(Found while building `act_as`, 2026-09-12.)*

**The field tying a record to a person is different on every object, and the familiar name is
sometimes absent.** An incident uses `ProfileLink_RecID`; a service request has that *and*
`AlternateContactLink_RecID`; a change has neither and uses `RequestorLink_RecID`. A name ladder
answers wrongly for the change and ambiguously for the service request, so the field is discovered
from data — sample rows, see which `*_Category` actually holds a person object — with the ladder
kept only as a tie-break and for an object that has no records yet. Verified live: 51 of 51
changes answer `RequestorLink`, and the service request's alternate contact is null on every row.
*(Measured 2026-09-12.)*

---

**A bad `$orderby` answers 204, which reads as "no rows".**
A mistyped *filter* field answers `400 ISM_4000` and can be explained. A mistyped **orderBy**
field — or a mistyped direction — answers **204 No Content**, one of Ivanti's three encodings for
an empty result. Measured on `incidents`: no `$orderby` and `CreatedDateTime asc` both answer 200
with `@odata.count` 548; `CreatedDate asc`, `NotAFieldAtAll asc` and `CreatedDateTime bogus` all
answer 204. So one missing `Time` silently turns 548 records into none, with no error anywhere.
`assertOrderBy` refuses locally before the request, the way `assertSupportedFilter` does. Accepted
forms, all verified: bare field, `asc`/`desc` in either case, several clauses comma-separated.
*(Measured 2026-09-12.)*

**`$search` ANDs on spaces, honours `or`, and matches from the start of a word.**
Four behaviours, none documented by Ivanti. On `incidents`: `projector` → 3, `boardroom` → 2,
`projector boardroom` → 2, `projector printer` → **0**, `projector or printer` → 51,
`projector AND printer` → **0** (the word `AND` is searched for literally),
`"projector remote"` → **0** (quoting matches nothing), `projec` → 3, `rojector` → **0**.
So passing a user's sentence through returns zero about a record that exists, and the only way to
widen is `or`. *(Measured 2026-09-12.)*

**A refused attachment extension arrives as HTTP 300, not a 2xx or a 4xx.**
Ivanti keeps a per-tenant allowlist and decides from the *filename*. The same bytes uploaded as
`.txt` answer 200 with `IsUploaded: true`; as `.log` they answer **300 Multiple Choices** with
`[{"IsUploaded":false,"Message":"Upload Failed, Invalid attachment type."}]`. Because `fetch`
reports 300 as `ok: false`, the transport threw before anything read the body — so the whole
"explain the refusal" path was unreachable and the caller saw a bare `Ivanti POST 300`.
*(Measured 2026-09-12.)*
*(Solved: `attachments/upload.ts` unpacks the 300 and reports Ivanti's reason. Verified in the code 2026-09-28.)*

**`CreatedBy` can be overridden on an attachment; `ParentLink_Category` must be the AdminUI id.**
A PATCH linking a new attachment fails with *"Role Admin does not have rights to update following
fields"* when `ParentLink_Category` is `Incident`, and succeeds with `Incident#`. With the right
spelling, `CreatedBy` set in the same PATCH is accepted **and sticks** — so an uploaded file can be
attributed to the person it came from rather than to the server's service account. `LastModBy`
still does not stick, the same split as on record creation. *(Measured 2026-09-12.)*
*(Solved: `attachments/upload.ts` `linkCategory` writes the AdminUI id in the tenant's casing and
reads the row back. Verified live 2026-09-29: stored `ParentLink_Category: Incident#`, `CreatedBy`
the person, and `AttachmentSize` is in bytes.)*

**No fixed field list identifies a record across tenants.**
A tenant defines its own Business Objects and renames fields on the ones Ivanti ships, so
`COMPACT_ROW_FIELDS` is a preference and never a definition. Measured: `attachment` and
`standarduserteam` share not one name with it and came back as a RecId plus two timestamps; their
identifying fields are `ATTACHNAME` and `Team`. Metadata does not rescue it — CSDL reports
`nullable: false` on almost nothing (`incident` and `change`: zero required fields) and
under-reports validated fields. So the default falls back to the row's own leading fields and says
that it did. *(Measured 2026-09-12.)*

**The tenant's grid columns are not reachable from the ASMX surface.**
`GetWorkspaceData` returns `GridViewData`, but it carries only `viewName`, `objectType`,
`gridName`, `defaultPreviewForm`, `formMap` and `toolbarDef` — no column list.
`FindGridViewData`, `GetGridViewData`, `GetListData` and `Services/Grid.asmx` all fail. So "which
fields does this tenant show in a list" has no cheap answer, which is why the point above falls
back to the row. *(Measured 2026-09-12.)*

**A test fixture that throws synchronously does not exercise a `.catch`.**
`connectionFixture` built its transport as `Promise.resolve(answer(url))`, and `answer` throws —
so the throw escaped before the promise existed and any `.catch()` on the call never ran. The real
transport is async and always rejects. One whole error path (`uploadAttachment` unpacking Ivanti's
300) passed its tests while being unreachable in production.
*(Solved: `connectionFixture` rejects rather than throwing. Verified in the code 2026-09-28.)*

### Impersonation via CentralConfig

**A SID is `<tenantId>#<sessionId>#<n>`, and CentralConfig returns only the middle segment.**
`AuthenticateTenantAPIKey` answers `<tenant-host>#H5IK…#1`, while CentralConfig's
`AuthenticateAPI` answers a bare 32-char `SessionId`. Sent as-is the bare token is not a session:
`InitializeSession` answers **500 `ArgumentNullException: ConnectionParams object is required`**,
which reads like a broken endpoint and is really "no session by that id". Wrapping it as
`<tenantId>#<SessionId>#1` makes the same call answer 200 — with the *impersonated* user's name
and role (`UserName: HSanders`, `ActiveRole: ServiceDeskAnalyst`), not the service account's.
That one string is the entire difference between the feature working and appearing impossible.
*(Measured 2026-09-14.)*

**The SID cookie authenticates OData and REST too — the API key is not required.**
`GET /HEAT/api/odata/businessobject/incidents` with `Cookie: SID=…` and **no**
`Authorization: rest_api_key=` header answers 200 with rows. So a session is a credential for
every surface, not just the ASMX one, and an impersonated session can carry the whole tool set
rather than only the form-and-workflow half. **What is not yet established is whether OData then
*scopes* to that user** — an analyst's session returned the same 551 incidents the admin key
sees, which is consistent with either "he may read them all" or "OData ignores role scoping".
Do not describe the OData half as access-limited until that is measured. *(Measured 2026-09-14.)*
*(Solved: answered below by "OData scopes to the session's role" — it does, and a session with no role reads nothing.)*

**`AuthenticateAPI` requires `Disabled = 0`; `Status` is a different field and lies about it.**
All six users read `Status = Active` throughout, while the call answered `AccessDenied` for the
ones whose `Disabled` bit was set. Flipping `Disabled` on ACope and HSanders turned failure into
success with nothing else changed. Its "can't find user name X" therefore means "no **enabled**
user by that name" — a wording that sends you looking for a typo in the login. *(Measured 2026-09-14.)*

**An impersonated session can start with no role, and the admin surface then refuses.**
`InitializeSession` returned `ActiveRole` **empty** for a user holding three roles, and
`AdminUI/services/AppDesign.asmx` answered `ValidateSessionException` (HTTP 551). That is a
missing *selection*, not missing rights: `FRSHEATIntegration.asmx/GetRolesForUser`
(`sessionKey` + `tenantId`) lists them and `Session.asmx/SelectRole` (`sRole`) picks one — not
`SetRoleForUserSession`, see below.
`sessionKey` is the full `#`-delimited SID. A user with no admin role is refused the same way,
so the two cases are indistinguishable from the response alone — read the role list first.
*(Measured 2026-09-14.)*

**The response carries the tenant's SQL connection string, password included.**
`AuthenticateAPI` returns `ConnectionString` and `ProviderName` beside the session fields. Any
code that logs this response, or echoes it into an error, leaks the database credential. It must
be destructured at the transport boundary and never stored whole. *(Measured 2026-09-14.)*

**Ivanti labels its own self-service roles — do not infer it from workspace counts or names.**
`GetUserData` returns `userRoleList` (lower-case `u`, unlike its siblings), and each entry carries
`SelfServiceRole` and `EnableMobileAnalystUI` alongside `Name`/`DisplayName`. That flag is the
authoritative answer to "is this a portal role", and it arrives on a **non-admin** session:
measured against an impersonated `ServiceDeskAnalyst`, `GetUserData` answered with the role list
while `GetRoleWorkspaces` answered 551 for every role — an un-activated session, as it turned out,
not a permission. The flag remains the right way to find a self-service role either way. *(Measured 2026-09-14.)*

**`GetUserData` needs `tzoffset`, and fails when the session has no active role.**
Called as `{_csrfToken, tzoffset: 0}` it answers; omitting `tzoffset` answers **500
`InvalidOperationException`**, which reads like a broken session and is a missing argument. It
also answers 500 when `InitializeSession` reported an empty `ActiveRole` — so the richer role list
is unavailable in exactly the case that needs a role chosen. `FRSHEATIntegration.asmx/GetRolesForUser`
(`sessionKey` + `tenantId`) is the way out: it carries only `Name`/`DisplayName`, no flags, but it
answers for a session with no role at all. The two are complementary, not alternatives.
*(Measured 2026-09-14.)*

**The in-session role switch is `Session.asmx/SelectRole`, not `SetRoleForUserSession`.**
It takes `sRole` — the same spelling `GetRoleWorkspaces` uses — and re-points the established
session by rewriting Ivanti's `UserSettings` cookie, with no re-authentication and no credentials.
`Account/SelectRole` is the sign-in-time MVC form and needs an anti-forgery token only available
while signed out, so it is not the one to call. *(From `ivanti-mobile`, and measured here
too — see the activation entry below.)*

**A CentralConfig session must be ACTIVATED with `SelectRole`, or the whole form surface answers 551.**
`InitializeSession` reports a role; that is not the same as a role being *selected*. Until
`Session.asmx/SelectRole` has been called — even naming the exact role already reported — every
`Workspace.asmx` method, `ServiceCatalog/services/ServiceSubscription.asmx` (the file-staging
pair) and `AdminUI/services/AppDesign.asmx` answer **551 `ValidateSessionException`**, while OData
and `Session.asmx` itself answer normally. Controlled on a live tenant with one variable — same
role, same CSRF token reused: two `InitializeSession` calls and no `SelectRole` stayed at 551; one
`InitializeSession` plus `SelectRole` answered 200 with 7 workspaces. After activation the full
chain runs as the person — measured by filing a service request *with an attachment* as someone
other than the service account: the request and its file both came back `CreatedBy` that person.

This server once documented those 551s as an Ivanti boundary and built a surface split on it. The
cause was its own optimisation: `SelectRole` was skipped whenever the chosen role already matched
the active one. **Never skip it.** *(Measured 2026-09-14.)*
*(Solved: `impersonated-session.ts` always selects the role, never skipping it. Verified in the code 2026-09-28.)*

**OData scopes to the session's role, and a session with no role reads nothing.**
Counts through the same OData path, varying only the session: service account (Admin) and an
impersonated `ServiceDeskAnalyst` both read 551 incidents, 628 employees, 51 roles — but the same
impersonated user with **no active role** reads **0 of everything**, and after
`SelectRole('SelfService')` reads 0 incidents while still reading 628 employees and 51 roles. Two
conclusions: the role is a real access boundary on OData, and an empty `ActiveRole` is a broken
session rather than a restricted one. Selecting a role is therefore mandatory after impersonating,
not a refinement. Note that admin and analyst coincide on these objects, so comparing those two
alone would suggest — wrongly — that OData ignores the role. *(Measured 2026-09-14.)*

**An impersonated session stamps `CreatedBy`, `LastModBy` and `Owner` with the impersonated person.**
Measured by creating one incident through a CentralConfig session for `HSanders`: the create
response came back `CreatedBy='HSanders'`, `LastModBy='HSanders'`, `Owner='HSanders'`. Ivanti
fills all three from the session, so impersonation makes attribution real rather than asserted and
the `CreatedBy` override `enduser` writes carry becomes redundant. `Owner` following the session
was not anticipated — on a non-impersonated write it would be the service account.
*(Measured 2026-09-14.)*

Measured again 2026-09-17, which settled when and why. `OwnerTeam` follows too — the person's
own team (`IT` for Harold Sanders), not the queue that should handle the record. `Owner` is
stamped only when the record *advances*: a create that lets Ivanti move it to `Active` gets the
session user, because `Active` requires an owner, while one carrying the tenant's initial status
(`Logged` here) stores `Owner` null. The same rule makes it one-way — clearing the owner at
`Active` is refused. So in `enduser` mode every self-raised ticket comes back owned by the person
who raised it, and reaches no queue. `create_record` names every field stamped this way
(`session-stamp.ts`); it reports the assignment and does not correct it.

**`LastModBy` is overwritten by whichever workflow runs, so it records nothing durable about who
acted.** One incident read back moments later said `LastModBy='InternalServices'` rather than the
person — the delete preview named the culprit, `Workflow Instance 'TSS Incident Trigger WF'`.
Timing is not guaranteed and "within seconds" would be too strong: another incident, created the
same way, still read the person across several later reads because no workflow had fired on it
yet. What holds is that nothing stops one firing later.
This matters beyond impersonation: the design's claim that `CreatedBy` (overridable) and
`LastModBy` (not overridable) together say *their decision, this server's hands* holds only until
the first workflow fires, which here is immediately. **`CreatedBy` is the only durable attribution
field.** Do not build an audit argument on `LastModBy`; this server's own audit log is where
provenance survives. *(Measured 2026-09-14.)*

**An impersonated write is refused by ROLE, and Ivanti names the role when it refuses.**
A `DELETE` that answered 400 under one role answered `deleted: true` under another on the same
session, and the body says why in plain words: *"Role SelfService does not have rights to delete
object Incident#."* So impersonated writes are not asymmetric or half-supported — the person's
role simply governs them, which is the point. Read the message before assuming a transport
problem: an earlier pass recorded this 400 as "cause not established" and it was a permission all
along. *(Measured 2026-09-14.)*

**`GetTenantTimeout` validates the CentralConfig key but NOT the tenant — it answers 200 for a
tenant it has never heard of.** Measured: the real tenant answers `18000`, and
`no-such-tenant.example.com` answers **`120`**, a default, with the same HTTP 200. A wrong key
answers 401, so it is a good credential probe and a useless tenant probe. The startup check
therefore proves "CentralConfig is reachable and the key works" and nothing more; a wrong tenant
host passes it and fails at the first `act_as`.

`FindActiveTenantRecord` *would* catch it — an unknown tenant answers an empty body — and is
deliberately not used, because it returns the tenant's **`DBConnectionString` and
`PrimaryEncryptionKey`**. Pulling the database credentials and the encryption key across the wire
on every boot is not worth catching a typo. Note the field is `DBConnectionString` here and
`ConnectionString` on `AuthenticateAPI`: a redaction pattern written for one misses the other,
which is how the first version of the scrubber let it through. *(Measured 2026-09-14.)*

**The two budgets are different kinds of number, and only one of them may move.**
`DESCRIPTION_BUDGET` (2,000 per tool) tracks a real client truncation — text past it never reaches
the model — so raising it buys nothing. `MANIFEST_BUDGET` (38,000 across the manifest) is a
self-imposed cost ceiling, and raising *that* is a decision to argue on cost. The manifest sits
within a few dozen characters of it and has done for weeks, so read the current figures from the
assertion message in `description-budget.test.ts` rather than from any document, this one
included — every figure written down here has gone stale. *(Revised 2026-09-28.)*

**`GetUserData` can refuse for a person permanently, not just while their session has no role.**
The obvious repair for a flagless role list is to select any role and ask again — the session then
has one, and `GetUserData` carries `SelfServiceRole`. It works for most accounts. Measured against
a live tenant it does **not** work for all: one account answers **500** from `GetUserData` both
before and after `SelectRole` succeeded, so its flags are unobtainable rather than
unavailable-yet. Do not treat "no active role" as the explanation for a `GetUserData` failure; it
is one explanation.

Where the flags cannot be had, the role can only come from the order `GetRolesForUser` listed them
— alphabetical, so `Admin` sorts first and an account holding it opens under the most privileged
role it has, by accident rather than policy. The server keeps that fallback (refusing would lock
out the account entirely) but **says so in the response** and warns, and `IVANTI_IMPERSONATION_ROLE`
is the way to decide it explicitly. *(Measured 2026-09-14.)*

**Pinning a person before the work that can fail bricks the conversation.**
`act_as` pinned the resolved person and then opened the Ivanti session. When the open failed it
returned the error — and the pin had already stuck, one-way by design, so the conversation was
bound to someone it could not act as and refused **every other person** for the rest of its life.
One unlucky name ended the session's usefulness. Found on a live tenant, not in tests: the unit
tests all pinned someone who could be impersonated.

The fix is ordering, not a new escape hatch: `SessionPin.check()` asks the rules without applying
them, so `act_as` gates the attempt, opens the session, and commits the pin only once nothing can
still refuse. Checking *before* opening matters on its own — otherwise an injected second name
would mint an Ivanti session for a person the conversation is about to refuse. Anything
irreversible wants the same shape: ask, do the work that can fail, then commit.
*(Measured 2026-09-14.)*
*(Solved: `SessionPin.check()` — ask, open the session, then commit. Verified in the code 2026-09-28.)*

**`AuthenticateWithAPIKeyAndUser` does NOT impersonate — it returns the API key's own session and
echoes your `loginId` back at you.** Its signature (`key`, `userIpAddress`, `userAgent`, `tenant`,
`loginId`, `role`) reads exactly like the impersonation endpoint one would hope for. Measured, it
answers the **same `SessionId` as `AuthenticateTenantAPIKey`** — the service account's — for
`HSanders`, for `ACope`, and for `nobody-at-all`, a login that does not exist. It validates no user
at all. The `LoginId` field in the reply is the string you sent, not the identity of the session.

Everything about it looks like success: HTTP 200, a plausible `LoginId`, and `Workspace.asmx`
answering 200 with 31 workspaces where an un-activated impersonated session gets 551 — because it is the
service account's admin session. Code that trusted this would run every "impersonated" call as the
service account with admin rights and report the person's name while doing it. **Read the session
back from `InitializeSession` (`UserName`), never from the authentication reply.**
*(Measured 2026-09-14.)*

**`ServiceSubscription.asmx` answers 551 for the same reason `Workspace.asmx` does, and stops for
the same reason.** `GetPackageDataSDA` and `GetUploadTicket` refuse an un-activated session and
accept an activated one; the service is not special. Kept because an earlier entry generalised
one service's 551 into "the ASMX boundary" — the wrong lesson from a true measurement.
*(Measured 2026-09-14.)*

**`link_records` reports a link it did not make; `unlink_records` refuses the mirror case.**
Re-linking an already-linked incident answered `{"linked": …}`, identical to a real link; the
relationship read back 4 rows, not 5, so the defect is only the reply. The pair is asymmetric:
`unlink_records` checks membership first, because Ivanti accepts an unlink of nothing and on a
Contains relationship severs a third record. Fix: reuse that membership read to answer
`alreadyLinked: true` — never refuse, since re-running a batch after a partial failure depends on
it. *(Measured 2026-09-28.)* *(Solved: `alreadyLinked: true`, and a Contains link to a child that
already has another parent is refused with the `unlink_records` call that would free it. Code
2026-09-29.)*

**Open question: relationships are where "several at once" is the normal request.** Linking four
incidents to a problem cost four calls, unlinking three cost three, and seeing the result two more.
To settle before building: `targetId` → `targetIds` (no new tool, and the manifest has almost no
room); how a partial failure names what succeeded (`submit_service_request`'s comparison is the
precedent); and whether unlink gets it too — riskier, because its per-target check is the whole
safety argument.

**The form carries required and read-only rules — both conditional.** `FindFormViewData`, already
fetched for validated fields, returns `BusObjectRequiredRules` (13 fields on an incident) and
`BusObjectReadOnlyRules` (20, including `Priority`), plus `RuleMeta`, `FormAllowInsert/Update` and
more. Each is a list of the fields a rule **governs**, never the condition — so it answers "which
can become required" and not "is this one required now". Measured: an incident reaches `Logged`
with no owner, `Active` needs Owner *and* Team, and the owner cannot be cleared at `Active`. A
refusal names only what Ivanti checked before stopping (one field on one create, three on another),
so being told of one is no evidence the rest are satisfied. *(Measured 2026-09-17.)*

**Reading the read-only list as absolute broke a working write.** A guard refused any write naming
one of its fields — and `problem`'s list names `Subject`, `Description` and `Category`, all of which
a create accepts (problem 10230); `Category` is mandatory there. The required list announced its
conditionality; the read-only one did not, which is why it was believed. *(Measured 2026-09-28.)*
*(Solved: both lists are read and reported as `'sometimes'`, never refused on, and a required-field
refusal carries the governed list. Verified in the code 2026-09-28.)*

**A handshake that outlives its conversation must not land in the slot.**
`endConversation` skipped the release when nobody was pinned yet, so a re-initialize during
`act_as` let the handshake store person A's session, and every later `act_as` was refused naming
A's login until restart. `release()` also left `pending`, so `open(B)` could join A's handshake.
The slot now carries a generation: `release()` bumps it, a late handshake gives its session back,
and `open()` joins only a handshake for the same login in the same generation.

**`SessionKeyExpire` has no time zone, and an empty `ActiveRole` is a failure.**
The person's session is re-opened once on a 401 or past its expiry (reads retried, writes reported
as not repeated). `SelectRole` answering with no role now refuses rather than running a session
with none — which reads zero records. Measured 2026-09-29: `act_as` for an account with
`SelfServiceMobile` still succeeds.

**A call still running when its conversation ends must not change hands.** Ending a conversation
empties the impersonation slot, and an empty slot means "use the service account" to everything
that routes a request — so a call in flight at that moment sent the rest of its requests, writes
included, as this server's own account. Its result was discarded afterwards with *"retry"*, which
for a write that had gone through meant doing it twice. → Each call keeps the session it started
on, and a discarded write says the change may already have been made and to check the record
first. *(Fixed 2026-09-29.)*

**With stdio and HTTP both on under `AUTH_MODE=oauth`, the stdio conversation gets the OAuth
instructions.** They are built once per process from `AUTH_MODE`, and under `oauth` they tell the
model the sign-in already names the person — which a stdio connection has no token to do. The gate
still refuses until `act_as` succeeds, so nothing leaks; the model just learns it one refusal
later. Run the two transports as separate processes if that matters. *(Known limit, 2026-09-29.)*

**A cascaded list is complete for its parent only, and "not on the list" is a membership answer.**
Ordering a `Tablet Request` as a person whose `Employee.Department` is empty: `Requester` is
filtered by `Department`, no department listed them, and the model — correctly — said they were not
in the department. It then tried three departments, searched spellings and asked a person to pick a
requester, because nothing said that an empty or short child list is the answer rather than a
failed search.

**A service request form has two kinds of dependency, and only one was visible.** List options
depend on another answer (`ValidationConstraints`), and whether a parameter is shown or required
depends on another answer (`VisibilityExpression` / `RequiredExpression`). `New Employee
On-boarding` is mostly the second: `ComputerRequired` → `ComputerType` → `UltraPortable` /
`PrimaryMonitor` (shown when the type is not `Desktop` / not `Notebook`), `SecondaryMonitor` →
`2ndMonitor`. The server cannot evaluate an expression — only Ivanti can, and a parameter may be
required by a rule over another answer — so it now *points*: `get_service_request_parameters` adds
`filteredBy` (from `FormFieldName`) and `conditionedOn` (every parameter name the two expressions
read, quoted strings dropped) to each parameter, plus a `dependenciesNote` that says how to walk the
form; `get_service_request_parameter_options` echoes `scopedTo` / `scopeNote`;
`get_pick_list_values` adds a `scopeNote` when every parent was supplied; and
`ivanti://reference/picklists` gained "Answers that depend on answers" and "Absent under a parent".
The tool descriptions were NOT touched — the manifest sits 80 characters under its cap. (Code 2026-10-25.)

**Ivanti's portal evaluates show/hide, required and defaults in the browser, from one download.**
A HAR of opening a service request (2026-10-25) shows the whole form arrive in one call —
`GET /api/rest/ServiceRequest/PackageData/{subscriptionId}/Default` (also
`ServiceSubscription.asmx/GetPackageData`) — and then only option lists (`POST …/ValidationList`,
the same calls `get_service_request_parameter_options` makes, with `strCustomerLocation` set to
`Default`). Nothing is sent when a checkbox is ticked, so there is no "evaluate this form" call to
borrow; the rules have to be walked by the caller. That download also carries each expression
pre-parsed (`requiredExpression.FieldRefs` lists the parameters it reads) — the OData template
parameters do not, which is why `conditionedOn` reads names out of the expression text instead.
A default value (`ValueExpression`) is resolved to its option with a `query` of `%<value>`.
**The HAR contains no cascade interaction** (the page was only loaded), so how a child list is
re-queried after its parent changes is still taken from the existing `constraintParams` body.
**A value rule lives only in `ConfigOptions`:** `StartDate` says "Minimum two weeks lead time" in
prose and `{"dateValidation":{"expr":"$(StartDate>=CurrentDate()+14)"}}` in `ConfigOptions`; it is
now lifted into `valueRule`. *(Code 2026-10-25.)*

**`get_service_request_parameters` can now evaluate a form (2026-10-25).** With `subscriptionId` +
`answers` it fetches the package the portal fetches and walks the parsed rules
(`src/ivanti/service-request/form-rules/`): shown, required, read-only, defaults, what is `missing`,
answers to drop, and ready-made `constraints` for each filtered list. The evaluator is a port of
`ivanti-mobile`'s (`utils/form/rule-engine`), which mirrors Ivanti's own client; the function
library came with it. Differences: stored expressions (`$[this]Name()`) are not ported, and an
unknown function or stored expression is *reported* in `cannotTell` where the app degrades to
`null` silently. It informs and never refuses. **Verified live 2026-10-25** over stdio against the
tenant: `PackageData` answers through this server's credential; New Employee Setup and Tablet
Request evaluate correctly (iPad 4 reveals Color, Surface hides it, Requester waits for Department
then gets `queryFieldName: Department`). A parameter with a default (`EmploymentType_1`) is not
`missing`, but its default must be sent. Not covered: auto-fill
(`$([…]PrimaryEmail)`), which needs the picked record, and `valueRule` date checks.

**What a real conversation showed about form evaluation (ChatGPT desktop, 2026-10-25).** The
evaluator and the scope notes did their jobs — the model stopped at "not listed under
Administration" and the final `evaluation` was `missing: []`. Four costs remained, now fixed:
it read all 201 requesters under a department (~25 KB) to confirm one person was absent — option
answers now cap at 100 with `total` / `hasMore` and point at `search`; its first evaluation call
failed because `templateId` was required though the portal's form is keyed by `subscriptionId` —
`answers` now needs only that and returns `evaluation` alone, without repeating the parameter list;
it typed Requester E-Mail by hand — `autoFilled` names what Ivanti fills in; and, finding the
person's `Department` blank, it **edited their Employee record** to make the form accept them —
the options note and `ivanti://reference/picklists` now call that a data fix for an administrator.
The deeper cause was deployment, not wording: `full` mode with the impersonation role unset
(Admin taken from the role list's order) and an unverified `act_as` is a chat that can write
directory data as anyone. `enduser` mode, `IVANTI_IMPERSONATION_ROLE` set to a self-service role and
`AUTH_MODE=oauth` remove it.

**The note saying why a change was made must be written by the key's account, not the person.**
`add_note` stamps the person's name in `enduser` (`authorFields`); a copy of that path for the
audit note would have shown someone as the author of text they never saw. `audit-note.ts` posts on
`deps.connection.transport` with no author override, and `credential-guard.test.ts` lists it as
service-account-by-design with that reason. Verified live 2026-10-25: after `act_as` a person, the
note's `CreatedBy` was the API key's account and its body named the person as the one who asked.
The change is already made when the note is written, so a failed note is `auditWarning` beside a
success, never an error — an error over an updated record invites a retry, and a retry mails people.
A record deleted with no parent has nowhere for a note (its own journal went with it).

### A service request form has two ids per parameter

`PackageData` carries `strRecId` (the template parameter's RecId, which a submit keys its answers
by — `par-<RecId>`) and `strExistingRecId` (the stored answer's id on an existing request). They
differ. Reading the second as the first made every RecId-keyed answer "unknown" to the evaluator
and, once `submit_service_request` started checking keys against the form, would have refused every
valid submit. Found by driving it live; the HAR-derived fixture only had the second.

## Observability

**`/health` must answer without a token, so everything it returns is public.**
A liveness probe cannot authenticate. So the anonymous response is `{"status":"ok"}` and nothing
else, while identity, uptime and session count require the same authorization as any other
request. Status is **always 200** either way — a probe that flaps because a token expired would
restart a healthy container.

**Never report memory or CPU from `/health`.**
An earlier version did. Resource load handed to an anonymous caller turns blind probing into a
guided attack: watch `sessions` against the cap, watch `rssMb` and CPU to see whether load is
landing. Process metrics belong to the container runtime, which is already authenticated. (It
also avoided a second trap — `process.cpuUsage()` legitimately exceeds 100% of wall-clock time
because V8 uses background threads, so an unnormalised figure read as a bug.)
*(Solved: removed — nothing under `src/server/` reads process memory or CPU. Verified in the code 2026-09-28.)*

**`JSON.stringify` writes an `Error` as `{}`, and a subclass as every own field — `url` included.**
`message` and `stack` are not enumerable, so `logger.debug('…', { error })` logged `"error":{}`.
`IvantiApiError` was the opposite trap: its fields *are* enumerable, so the same call wrote the full
URL, `$filter` and the person named in it, into whatever level it was logged at. → The logger
serialises an `Error` itself, and `IvantiApiError.toJSON()` gives the path only. Pass errors as a
field; never flatten them to `error.message` at error level, where the stack is the point.

**Seven copies of fetch-read-check had drifted apart.**
Only the OData transport logged; none logged a timeout, because the log line came after the
`await` that threw; `requestBinary`, the ASMX form and multipart posts, and the impersonated
session let a dropped connection escape as a raw `TypeError`, which `runTool` reported at error
level as a bug in this server. → Every Ivanti request goes through `exchange()`. A new surface
that reaches for `fetch` directly reintroduces all three. *(Solved 2026-09-28.)*

**The SDK's `onerror` fires for client mistakes, not only server faults.**
The streamable-HTTP transport reports a bad `Accept` header, invalid JSON and an unknown session
through it. Logged at error, any client could fill the error log at will — so it is logged at warn,
without a stack.

**A `$metadata` outage is not "no such object".**
The catalog turned a transient failure into "Ivanti has no Business Object named X" and remembered
any unlisted 4xx as absence for the life of the process. → The catalog tells a document, a
missing entity (a 200 with a field-less CSDL, or a 404) and an unavailable read apart; only the
first two are remembered, and the third answers `MetadataUnavailableError` ("not a refusal, nothing
was changed, try again"). Do not bring back a status denylist. *(Solved 2026-10-11.)*

**A `CustomerLink` derived from a failed sample must never be cached.**
A failed sample and an empty one are the same shape and lead to the same fallback, but only the
empty one is a fact about the tenant. `forEntity` evicts on a failed sample. *(Solved 2026-10-11.)*

**Ivanti's `ISM_2000` is never evidence that a link or unlink happened.**
The relationship writes now read the related rows back after the call and answer "NOT linked",
"still linked" or "not confirmed". The tenant's UTC offset is read only from a datetime-shaped
field and only up to 14 hours; anything else is "unknown", and the unknown is not remembered.

**`WWW-Authenticate` truncation is for prose, not for a URL.**
The challenge capped every value the way it capped a message, which cut the `resource_metadata`
URL and the scope list. → The sanitiser (`sanitiseHeaderValue`) is separate from the length cap,
and `validateConfig` refuses a scope or public URL the sanitiser would change. *(Solved 2026-10-11.)*

**An ID token can verify as an access token.**
Where the IdP's ID token carries the client id as `aud`, nothing but `typ` or a scope tells it
from an access token. The verifier now always rejects a token typed `ID` / `id_token` or carrying a
`nonce`; `OAUTH_REQUIRE_TYP=true` additionally demands `typ: at+jwt` (RFC 9068 IdPs only — Entra v2
and stock Keycloak type access tokens `JWT`). The complete controls remain a distinct API audience
or `OAUTH_REQUIRED_SCOPES`.

**The subtype object id was converted twice, and the copies disagreed.**
`form-context` built `Task#Assignment#` where workspaces keep `Task#Assignment`, so no subtype ever
matched its workspace and subtypes got no form. The `Task#Assignment` "no admin form" claim in the
Ivanti section below was probably this bug seen through a tool; re-measure it live before relying on it.

## Testing

**Build a `Config` through `configFixture`, never as a literal.**
Four test files each hand-built one, and adding five `OAUTH_*` keys broke all four at once.
*(Solved: no test builds a `Config` literal any more, and `formFixture` applies the same lesson to `ResolvedForm` since 2026-09-17. Verified in the code 2026-09-28.)*
