# Changelog

What changed for someone running the server, newest first. **Upgrading** says what to check
before moving to a release; a release with nothing under it upgrades by swapping the version. The
full list of merged changes is on each [GitHub release](https://github.com/syn-con/ivanti-mcp/releases).

## 0.4.0 — unreleased

The server is licensed through the Synergy Hub, as product `ivanti-mcp`.

**Upgrading.** Every deployment now needs a **Synergy Hub licence key**, and outbound HTTPS to
`https://hub.itsmcloud.lt`. Before moving to 0.4.0:

- **Kubernetes:** add the key `licence-key` to the Secret named by `secrets.existingSecret` (or set
  `secrets.licenceKey` with `secrets.create`). Without it the pod exits 78. The chart derives the
  install ID and creates everything else, including a `<release>-licence-state` Secret and a Role
  that reaches only it, and it turns the pod's service-account token on.
- **Everywhere else:** set `LICENSE_KEY` or `LICENSE_KEY_FILE`, and over HTTP `LICENSE_INSTALL_ID`,
  a UUID made once (`node -e "console.log(crypto.randomUUID())"`). Set `LICENSE_STATE_DIR` too, so
  a restart during a Hub outage keeps working: the image, compose file and systemd unit use
  `/var/lib/ivanti-mcp`, and compose mounts a volume there.
- **Under `docker run -i`,** mount `-v ivanti-mcp-licence:/var/lib/ivanti-mcp` with
  `LICENSE_STATE_DIR=/var/lib/ivanti-mcp`, or set `LICENSE_INSTALL_ID`. Otherwise every run takes
  a new licence seat.

Changes:

- **Licensed through the Synergy Hub.** The server activates at startup and confirms the licence
  every 4 minutes. Startup never waits for the Hub.
- **Unlicensed, it refuses every tool and says why.** It keeps running and opens again as soon as
  the Hub confirms the licence, with no restart. The reason is in every refusal and in the log.
- **30 days without the Hub.** While the Hub cannot be reached, it keeps working on the last licence
  the Hub signed, for 30 days from then. That licence is kept across restarts, in
  `LICENSE_STATE_DIR` or, under the chart, a Secret. A refusal from the Hub (a revoked key, no free
  seat) closes it at once.
- **`get_version` reports the licence:** its status, why, when it ends, and when the 30 days run
  out.
- **Two metrics:** `ivanti_mcp_licence_state{state}` and
  `ivanti_mcp_licence_confirmed_timestamp_seconds`.

## 0.3.10 — 2026-11-05

Repository migration, refreshed dependencies and a leaner release pipeline. No MCP tool names,
arguments or configuration keys change in this release.

**Upgrading.** The Docker image stays at `tyrunas/ivanti-mcp`; update its tag to `0.3.10`.
Helm charts from this release publish at `oci://ghcr.io/syn-con/charts/ivanti-mcp`. When verifying
the image, use the signing identity
`https://github.com/syn-con/ivanti-mcp/.github/workflows/release.yml@refs/heads/main`.
Charts and signatures for versions through 0.3.9 retain their original locations and identities;
their release notes contain the matching verification commands.

- **The project now lives at [syn-con/ivanti-mcp](https://github.com/syn-con/ivanti-mcp).**
  Repository links, clone and download examples, chart and image metadata, Postman examples,
  service instructions and historical documentation use the current project name and address.
  Legacy project naming was removed throughout the repository.
- **The [Handbook and configurator](https://syn-con.github.io/ivanti-mcp/) are on GitHub Pages.**
  Generated install commands now use version 0.3.10, the new chart namespace and current release
  links. Documentation distinguishes new artifacts from those published before the transfer.
- **Docker images build only during Release.** PRs and merges to `main` retain code, chart,
  Dockerfile/context and relocatable tarball checks, without repeated image builds. Release
  retains its vulnerability gate, amd64/arm64 publication, signing, SBOM and provenance, and now
  saves its own build cache. The weekly scan pulls the published image without rebuilding it.
  All workflows run on GitHub-hosted runners.
- **Production dependencies are refreshed.** `@modelcontextprotocol/sdk` moves from 1.32.1 to
  1.32.2 and `jose` from 6.2.12 to 6.2.13. Transitive updates include `@hono/node-server`
  2.1.1 → 2.1.5, Express 5.2.1 → 5.3.0, `content-disposition` 1.1.0 → 2.0.1,
  `express-rate-limit` 8.7.0 → 8.7.1 and `on-finished` 2.4.1 → 2.4.2; the redundant `qs`
  6.16.0 entry is removed. Third-party notices are regenerated for the resulting dependency tree.
- **The container base is refreshed.** The pinned Node 22 / Debian 13 distroless image moves
  from digest `ec231376…` to `8ad9cc93…`, retaining the non-root runtime and both architectures.
- **Development dependencies are refreshed.** `typescript-eslint` and its packages move from
  8.72.0 to 8.72.1, `ignore` from 7.0.10 to 7.0.14, and PostCSS from 8.5.31 to 8.5.32.
- **GitHub Actions are updated and remain pinned by commit.** `actions/checkout` 4.4.0 → 7.0.1,
  `actions/download-artifact` 4.3.0 → 8.0.2, `actions/upload-artifact` 7.0.1 → 7.0.2,
  `actions/setup-node` 4.4.0 → 7.1.0, `pnpm/action-setup` 4.3.0 → 6.1.0,
  `docker/setup-buildx-action` 3.12.0 → 4.4.1, and `docker/login-action` 4.6.0 → 4.7.0.
  The project still uses Node 22 and pnpm 10.20.0.
- **Merging to `main` requires one approving review.** Only `tyrunasj` may bypass that review
  when merging a PR. Direct pushes stay blocked, CI must pass on an up-to-date branch, and new
  reviewable commits dismiss earlier approvals. Force-pushes and branch deletion stay blocked.
- **Release notes lead with the version's changelog.** The Release workflow now includes this
  summary before GitHub's complete merged-PR list and the deployment and verification commands.

## 0.3.9 — 2026-10-27

Found by reading a model file two onboarding requests.

- **A mistyped parameter id is traced back.** When a submit's key is one or two characters from a
  parameter's RecId, the refusal says which parameter it was probably meant for.
- **A filed request says its status is not final.** `submit_service_request` returns a
  `statusNote`: workflows and escalations run after the answer, and one request on the tenant was
  cancelled by the escalation engine an hour after it was filed.
- **Look-alike offerings are flagged.** `list_request_offerings` returns `lookAlikes` when
  offerings share a description, so a model asks which one instead of choosing.

## 0.3.8 — 2026-10-27

- **`submit_service_request` accepts a parameter Name as an answer key.** The form evaluator takes
  names and a submit takes RecIds, so a model that carried names across was refused with "Required
  parameter Department is not defined". A name is now settled to its RecId (reported as
  `keysSettled`), and a key that is neither is refused by name, before anything is sent, with the
  offering's parameter names.
- **`get_service_request_parameter_options` refuses an id that matches no parameter.** A model
  retyping a 32-character id dropped two characters, got an empty list with a note that the
  tenant's list "holds no rows", and told the person the form was broken. An id that is not 32 hex
  characters, or that no parameter has, is now refused by name instead of answered as empty.
- **The form's parameter RecId was read from the wrong field**, so answers keyed by RecId to
  `get_service_request_parameters` were reported as unknown answers. It now reads `strRecId`.

## 0.3.7 — 2026-10-25

**Upgrading.** `WRITE_AUDIT_NOTE` defaults to `required`, which adds a **required** `justification`
argument to `update_record`, `delete_record`, `link_records`, `unlink_records` and
`run_quick_action`. A client holding the old tool list is refused until it reconnects. Set
`WRITE_AUDIT_NOTE=off` (chart: `server.writeAuditNote: off`) to keep the tools as they were.

- **A change leaves a note saying why.** The server writes the justification onto the record as an
  internal journal note once the change is confirmed, listing what changed (`Status: Open →
  Resolved`). The note is authored by the account the API key was issued for — not by the person
  the conversation is acting as, who is named in the body as the one who asked.
- **A note that cannot be left never turns a made change into a failure.** The result carries
  `auditNote` and, when a note was owed and not written, an `auditWarning`. A record whose object
  has no journal gets neither a note nor a warning; a deleted record's note goes on its parent.

## 0.3.6 — 2026-10-25

**Upgrading.** Nothing to check; swap the version. No setting or tool name changed, and the one
argument that became optional (`templateId` when evaluating answers) only loosens a requirement.

Follow-ups to 0.3.5's form evaluation, from watching it used in a real conversation:

- **Evaluating answers needs only `subscriptionId`.** `get_service_request_parameters` with
  `subscriptionId` and `answers` returns `evaluation` alone — no template read, and no repeat of
  the parameter list on every call.
- **`autoFilled` names what Ivanti fills in itself** (a picked person's email, say). Those
  parameters are never `missing`, so nobody types a value that disagrees with Ivanti's.
- **Long option lists are capped at 100 rows.** The answer carries `total`, `hasMore` and a pointer
  to `search`; a department's requester list is around 200 rows and was being read in full to find
  one person.
- **A blank field in the person's own record is a data fix for their administrator.** The option
  notes and `ivanti://reference/picklists` now say not to edit someone's record to make a form
  accept them unless they ask for exactly that.

Worth checking in your own deployment, though nothing here changes it: `full` mode with
`IVANTI_IMPERSONATION_ROLE` unset and `AUTH_MODE` not `oauth` lets a chat act as anyone it is told
the name of, with Admin rights. `enduser` mode, a self-service impersonation role and `oauth`
remove that. See `docs/configuration.md`.

## 0.3.5 — 2026-10-25

**Upgrading.** Nothing to check; swap the version. No setting, tool name or required argument changed.

- **`get_service_request_parameters` can evaluate a form.** Pass `subscriptionId` and `answers` and it
  returns `evaluation`: what is shown, hidden, required and still missing, which answers to drop,
  the defaults to send, and the exact `constraints` for each filtered list. Ivanti's portal does
  this in the browser and no call exists for anyone else; this reads the same parsed rules. It
  informs and never refuses, and rules it cannot read are named in `cannotTell`. Not covered:
  auto-fill fields, date-rule checks, and `BeginningOfWeek`.
- **Each parameter says what it depends on.** `filteredBy` (its options depend on those answers),
  `conditionedOn` (whether it is shown or required depends on them) and `valueRule` (a date's lower
  bound, which Ivanti keeps only in `ConfigOptions`).
- **A filtered list is complete for its parent only.** Option answers now say so, so a person missing
  from a list prompts a question instead of a retry loop. `ivanti://reference/picklists` covers
  both kinds of dependency.
- **Dependencies are current, and `pnpm audit --prod` is clean.** The MCP SDK moves to 1.32.1, `zod`
  to 4.6.7 and `fast-xml-parser` to 5.11.2. The lockfile also takes patched versions of four
  transitive packages that carried advisories — `body-parser` (denial of service, high), `hono`,
  `fast-uri` and `ip-address` — and the container's `node:22-slim` base image is refreshed. Build
  and release tooling (vitest, eslint, typescript-eslint, and the upload-artifact, metadata-action
  and action-gh-release GitHub Actions) is updated too; none of it changes runtime behaviour.

## 0.3.4 — 2026-10-11

**Upgrading.** A full code review ([`docs/review/2026-10-11-full-review.md`](docs/review/2026-10-11-full-review.md))
is fixed in this release. Several settings an axis never reads are now refused at start-up instead
of ignored, so check these before moving:

- `BEARER_TOKEN` (or `_FILE`) outside `AUTH_MODE=bearer`, and any `OAUTH_*` outside `oauth`;
- `IVANTI_MAX_TIER` with no tenant, and `IVANTI_IMPERSONATION_ROLE` without the ConfigDB pair;
- a refused API key at start-up now exits 78 (it was 1), and a `$metadata` outage at start-up
  reports itself as one.

The Helm chart gains `server.identityIdleTtlSeconds` and `oauth.requireTyp`; `oauth.audience` takes
a string or a list. It now refuses values that rendered a pod which then exited 78 (for example
`ivanti.impersonationRequired` without `configUrl`).

- **Subtypes get their forms.** One object-id conversion replaces two that disagreed, so
  validated fields, pick lists, link fields and quick-action forms work for `Task#Assignment`,
  `CI#Computer` and every other subtype.
- **Writes say what they know.** A read-back that fails after an accepted write answers "the write
  was accepted; read the record, do not repeat it", never "nothing was changed". An enduser create
  reports `filedFor` only when the stored link confirms it. `link_records` and `unlink_records`
  read the related rows back; `run_quick_action` refuses answers that match no prompt and reports
  the fields that changed. A garbled base64 argument is refused instead of uploading a truncated file.
- **Reads say what they know.** A `$metadata` outage is "could not be read, try again", not
  "no such object", and is not remembered. A failed customer-link sample is not remembered. One
  pre-flight filter check, one compact default and one empty-result caveat serve every read tool.
- **OAuth.** An ID token no longer verifies as an access token; `OAUTH_REQUIRE_TYP=true` also
  demands `typ: at+jwt`. The 401 challenge keeps the metadata URL and scope list whole.
- **HTTP limits.** An initialize body over 64 KiB gets 413; the bodies buffered at once are
  capped, answering 503 with `Retry-After` beyond it; quadratic regexes on filter text are linear.
- **Configurator and handbook.** The settings reference lists every setting the server reads
  (`MCP_PUBLISH_ADDR`, `METRICS_PUBLISH_ADDR`, `HEALTHCHECK_TIMEOUT_MS` and `OAUTH_REQUIRE_TYP`
  were missing), the configurator takes each port from one place and writes every optional
  setting as a commented line with its default, and `pnpm handbook:check` fails when either drifts
  from the schema.
- **Internals.** `register-tools.ts` is split by reason to change, `runTool` maps failures through
  one table, `ivanti/` no longer imports upward, dead exports are gone, and the dev-only
  `source-map-js` advisory is overridden.

## 0.3.3 — 2026-10-09

**Upgrading.** `MCP_PORT` no longer defaults to 3000, nor `METRICS_PORT` to 9464. A deployment
with HTTP on and no `MCP_PORT`, or with `METRICS_ON=true` and no `METRICS_PORT`, now refuses to
start (exit 78) and names the setting. Set it to the port you were using. The Helm chart always
sets both, so a chart deployment needs nothing.

- **MCP SDK 1.31.0**, from 1.30.0, for CVE-2026-104850 (high). The protocol version is
  unchanged, `2025-11-25`, so clients see no difference.
- **No built-in ports.** Every port comes from configuration: the server, the container health
  check and `docker/compose.yaml`, which now reads `MCP_PORT` from the same `.env` as the container
  (`docker compose --env-file .env -f docker/compose.yaml up`) and refuses to start without it.
  A default port had to be repeated by hand in `MCP_PUBLIC_URL`, the client and the published
  ports, and changing one copy left the server answering where nothing was looking.

## 0.3.2 — 2026-10-05

**Upgrading.** Nothing needs setting, but three things behave differently:

- the Helm chart's readiness probe is now `/ready`, so a pod whose tenant stops answering leaves
  rotation instead of taking traffic it cannot serve;
- filters Ivanti misreads are refused with how to rewrite them — anything that sent a group after
  the start, an `and` after an `or`, or `not` got wrong rows before and gets an error now;
- requests to the tenant are capped at 16 in flight and tool calls at 120 a minute per
  conversation; raise `IVANTI_MAX_CONCURRENT_REQUESTS` or `MCP_MAX_CALLS_PER_MINUTE` if a busy
  deployment hits them (the `ivanti request cap reached` and `tool call rate limited` warnings).

- **Runtime base rebuilt:** `gcr.io/distroless/nodejs22-debian13` now carries `libssl3t64`
  `3.5.7-1~deb13u3`, for CVE-2026-75804 and CVE-2026-84782. A scan of the image finds nothing
  critical or high.
- **`/ready`**, beside `/health`: 503 once the tenant has failed two checks in a row, a minute
  apart, and 200 again on the first that passes. The Helm chart's readiness probe uses it; startup
  and liveness stay on `/health`, so a tenant outage takes a pod out of rotation without
  restarting it. Point a load balancer's health check at it.
- **A 401 on the service account's own calls no longer re-opens the person's Ivanti session.**
  Only a 401 on the person's session does; before, a refused key threw away a session that was
  fine.
- **Every image is scanned before it is published** — the release refuses one with a critical or
  high finding that has a fix — and the published `latest` is scanned every week.
- **`IVANTI_MAX_CONCURRENT_REQUESTS`** (default 16): a cap on requests in flight to the tenant at
  once. Past it a request waits its turn, and one that waits out its timeout fails as never sent.
- **`MCP_MAX_CALLS_PER_MINUTE`** (default 120): tool calls per conversation per minute; past it a
  call is refused with how long to wait. Both are new defaults rather than new requirements —
  nothing needs setting on upgrade.
- **Three known limits closed:** two initializes from one person at the same instant no longer
  leave them above `MCP_MAX_SESSIONS_PER_SUBJECT`; shutdown waits for the release a client's own
  DELETE started; with stdio beside an `oauth` HTTP transport, the stdio conversation is told to
  ask who it is helping rather than that its sign-in already says.
- **`group_count` with a filter counted wrong.** Ivanti honours parentheses only at the start of a
  `$filter`, and each bucket put the caller's filter last — so buckets could add up to many times
  the total. The same cause made `act_as` miss on a person's full name at the exact lookup. Both
  now put the group first.
- **Filters Ivanti would misread are refused before sending**, with how to rewrite them: a group
  anywhere but the start, an `and` after an `or` in the same group, and `not`. Ivanti answers each
  with a 200 and the wrong rows — `not` with every row.
- **Prometheus metrics, off by default.** `METRICS_ON=true` serves `GET /metrics` on a port of its
  own (`METRICS_PORT`, 9464), never the MCP port, bound to `METRICS_BIND` (`127.0.0.1`), with an
  optional scrape-only `METRICS_TOKEN` / `_FILE`. Tool calls by tool and outcome, Ivanti requests by
  method and status, latencies, sessions, evictions and refusals, readiness, memory — never a
  person, filter, record or ticket text. A browser's request is refused (403). Startup refuses a
  metrics port equal to `MCP_PORT`, a token under 32 characters, and a token equal to another
  secret, only while metrics are on. The chart gains `metrics.*`: a Service of its own the Ingress
  never routes to, an optional ServiceMonitor, and a NetworkPolicy rule. Nothing changes on upgrade
  unless you turn it on; leave it off on an internet-facing deployment unless something private
  scrapes it.
- `create_record` in `enduser` no longer credits Ivanti's session with the `CreatedBy` the server
  stamped itself. The third-party notices now include nested dependencies.

## 0.3.1 — 2026-09-30

A security patch.

- **Runtime base: `gcr.io/distroless/nodejs22-debian13`.** The Debian 12 image had stopped being
  rebuilt, so it still carried OpenSSL and glibc that Debian had fixed. Node 22.22.0 → 22.23.3.
- **`proxy-addr` 2.0.8, `fast-uri` 3.1.8, `ip-address` 10.7.2**, for CVE-2026-90711,
  GHSA-hrr3-gc8f-f4qj, CVE-2026-101911 and CVE-2026-101912.
- A scan of the image finds nothing critical, and nothing high that has a fix.

## 0.3.0 — 2026-09-30

The 50 fixes from the full review of 2026-09-29, and Windows as a fourth way to run it.

**Upgrading.** The server now refuses settings 0.2.x accepted, and exits `78` naming them:

- any `ENDUSER_*` setting with `MCP_MODE=full` (or `MCP_MODE` unset) — remove it, or set
  `MCP_MODE=enduser` if that was the intent;
- a bearer token under 32 characters — `openssl rand -hex 32` makes one;
- a plain `http://` for `IVANTI_BASE_URL`, `IVANTI_CONFIG_URL`, `OAUTH_ISSUER` or
  `OAUTH_JWKS_URI` anywhere but loopback;
- under `oauth`, an `email` claim names the person only with `email_verified: true` — a provider
  that leaves the flag out needs `OAUTH_IDENTITY_CLAIM` (`preferred_username`, say);
- the Helm chart refuses `replicaCount` above 1, `sessionAffinity`, and `authMode: none` behind a
  `LoadBalancer` or `NodePort`.

Also: `IVANTI_TIMEOUT_MS` and `IVANTI_WRITE_TIMEOUT_MS`; `MCP_MAX_SESSIONS_PER_SUBJECT`;
`IVANTI_IMPERSONATION_REQUIRED`; idle sessions are closed at the session cap rather than new ones
refused; a write that got no answer says it may have been applied; the chart ships a
NetworkPolicy and a `rolloutToken`.

## Earlier

See the [GitHub releases](https://github.com/syn-con/ivanti-mcp/releases).
