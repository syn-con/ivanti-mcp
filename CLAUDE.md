# CLAUDE.md

Guidance for Claude Code in this repository. It holds only what every turn needs; everything else
lives in `docs/`, and each section below says where.

## What this is

An MCP server for Ivanti Neurons for ITSM — 41 tools in `full` mode, 34 in `enduser`,
and six reference documents served as MCP resources. Shipped as a Docker image, also runnable
locally; separate from the Overlord-hosted Ivanti MCP.

What a deployment exposes is decided by independent axes, all fixed at startup:

| Axis | Values | Decides |
|---|---|---|
| Mode | `full` (IT staff) · `enduser` | which tools register — narrowing happens in `selectTools()`, never in a handler |
| Capability tier | `odata` → `session` → `admin` | what the credential reaches; probed once, higher tiers only add, a lower one is not a failure |
| Transport | `STDIO_TRANSPORT_ON` · `HTTP_TRANSPORT_ON` | independent toggles; both may be on |
| Auth | `none` · `bearer` · `oauth` | who may connect over HTTP; setting it with HTTP off is refused |
| Impersonation | the ConfigDB pair, set or not | whether `act_as` opens Ivanti's own session as the person |

## Where things are written down

| Document | Read it when |
|---|---|
| [`docs/initial-design.md`](docs/initial-design.md) | **Before proposing any architectural change.** The source of truth for decisions; §10 lists alternatives already rejected, and why. |
| [`docs/architecture.md`](docs/architecture.md) | Working on a tool, the identity gate, writes, the manifest or the Ivanti surface — how each part works, and why. |
| [`docs/notes.md`](docs/notes.md) | Something behaves unexpectedly. **Add to it whenever you hit a trap**, rather than fixing it silently. |
| [`docs/development.md`](docs/development.md) | Building, checking, or running against the live tenant. |
| [`docs/usage.md`](docs/usage.md) | Tuning a description or the `instructions`: what they cost, and the failed turns they cause. |
| [`docs/deployment.md`](docs/deployment.md) | The image, the chart, releasing, deploying. |
| [`docs/configuration.md`](docs/configuration.md) | Configuring against a real IdP; symptom → cause table. `.env.example` is the reference. |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | The order the work was done in. |

## Every change

- **Checks:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — all four. `typecheck` is
  the only one that type-checks the tests.
- **Changed a tool description, argument or the `instructions`?** Run `pnpm handbook:sync` — the
  handbook embeds the manifest, and CI's `handbook:check` fails when it differs.
- **Changed the chart?** Run `node scripts/check-chart.mjs` (needs `helm`) — CI renders every
  guard and fails when a refusal renders or a valid configuration does not.
- **`main` is protected, admins included:** an up-to-date PR, `Checks` green and one approving
  review. Only `tyrunasj` may bypass the review when merging a PR; direct pushes and CI bypass
  remain blocked. `/ship` runs the whole flow.
- **A tool-surface change is verified by driving it** against the live tenant through
  `ivanti-http`, the k3s deployment, once it is released and deployed — unit tests have passed
  while the manifest misled a model.
- **When driving the tools, verify names first.** Fields, objects, relationships and picklist
  values come from metadata or the form, never from memory.

## Invariants worth not breaking

One line each; the reasoning is in [`docs/architecture.md`](docs/architecture.md#invariants-in-full).

- **Never write to stdout** — under stdio it is the JSON-RPC stream. Log to stderr via `createLogger`.
- **Never report success from a 200.** Ivanti refuses inside 200s, drops `$filter` functions,
  answers a bad `$orderby` with 204, and accepts writes it then ignores — so every write is read back.
- **The identity gate lives in `registerTools`** and covers every tool but `act_as`. Never gate
  tool by tool: a tool that forgot would not fail, it would answer.
- **Tool arguments are closed** by `strictInput` in `defineTool`; `get_version` is the one open
  shape. Read arguments with `declaredArguments`, never by enumerating `inputSchema`.
- **A write's field names are checked and settled to the schema's spelling before it is sent**
  (`knownFields`) — everything after looks names up exactly.
- **The form's required and read-only rules are conditional** — report them, never refuse on them.
- **Annotate every tool explicitly.** Unannotated means destructive and open-world; additive
  writes need `destructiveHint: false`; tools returning ticket text keep `openWorldHint: true`.
- **New config keys fail closed** in `validateConfig`, and a setting its axis never reads is
  refused, not ignored. `ENDUSER_BUSINESS_OBJECTS` is also checked against the tenant at startup.
- **`MCP_PUBLIC_URL` is required and never derived from the request**, and Origin validation
  applies to every HTTP mode.
- **The API key and session internals are scrubbed from every Ivanti error body**; only `debug`
  carries a request's query, and a write's values are logged at no level.
- **Every Ivanti request goes through `exchange()`** — never a bare `fetch`. It is the one place
  that times out, scrubs, logs and turns every failure into an `IvantiApiError`.
- **Allowlists key on the technical Business Object name**, never the display name.
- **Nothing may depend on the Business Objects Ivanti ships.** A fixed field list is a preference
  with a fallback, never a definition.
- **Tool definitions are built once; servers are per connection.** Never call `selectTools()`
  per session.

## Budgets

`pnpm budget` prints the current figures. Never quote them from a document — every figure
written down so far has gone stale.

| Budget | Cap | Why |
|---|---|---|
| One tool description | 2,000 chars | clients truncate the **end** silently — which is where the warnings are |
| Whole manifest | 38,000 chars | re-sent every session, and it sits within a few dozen of the cap |
| Server `instructions` | 2,000 chars | the widest deployment is `full` / `odata`, not the obvious one |

Past a cap, move material into an `ivanti://reference/` resource. Descriptions carry what is
dangerous not to know; resources carry what is expensive to repeat.

The caps count description characters only; the argument schemas cost about as much again.
**`pnpm manifest:size`** measures the whole manifest (`--compare` shows what an edit moved; CI
posts the difference on every PR), and **`pnpm usage:report`** reads each call's size and
refusals out of the server log. Both count characters — the server is vendor-agnostic, and
tokenizers are not — see [`docs/usage.md`](docs/usage.md).

## Toolchain constraints

- **TypeScript is pinned to 6.x** — `typescript-eslint` still requires `<6.1.0`.
- **Zod v4 only; never import `zod/v3`** — the SDK's schema shim silently takes its legacy path.
- **MCP SDK 1.31.0 implements protocol `2025-11-25`**, not `2026-07-28`.
- **`express` is not a dependency** — it arrives transitively; declare it before importing it.

## Architecture at a glance

Composition runs one way: `index.ts` loads config, builds the server, then picks a transport.
Nothing lower in the stack reads `process.env`.

```
src/
  index.ts         load config → build server → pick transport
  config/          env-schema (shape) → read-secret-file (*_FILE) → validate-config (rules) → load-config
  server/          create-server, instructions, start-stdio | start-http
    http/          pure request policy: origin, authorisation, routing, sessions, health
  auth/            identity, identity-pin, impersonation
    oauth/         JWKS verification, AS discovery, RFC 9728 metadata, WWW-Authenticate
  ivanti/          connect (probe → transport → catalog) — knows nothing about MCP
    http/          transport (rest_api_key or SID), errors + scrubbing, base-path probe
    odata/         url, filter, query, projection, response, compact-fields — all pure
    metadata/      csdl, catalog, entity-names, subtypes, suggest-names
    session/       ASMX session, capability tier, forms, pick-lists, workspaces, roles, impersonation
    write/         validated-write — resolve picklists, confirm by reading back
    people/        directory (act_as matching), customer-link discovery
    service-request/ (form-rules/: the portal's show/required/default rules, evaluated), attachments/, quick-actions/
  tools/           defineTool → strictInput → register-tools (mode, identity gate, audit)
    shared/        gates, resolve-object, field and refusal explanations, session-stamp
    schema/ records/ search/ relationships/ notes/ knowledge/ attachments/
    service-request/ quick-actions/ approvals/ identity/
  resources/       the six ivanti://reference/ documents
  usage/           what one tool call cost — requests, rows, outcome — for its usage line
```

- `tools/` is the surface that gets tuned — descriptions, arguments, annotations. Nothing under it
  builds a URL or parses a response; that belongs to `ivanti/`, which knows nothing about MCP.
- One reason to change per file, and tests beside the file they cover (`foo.ts` / `foo.test.ts`).
- Config loads in three phases — secrets, shape, rules — and the order is load-bearing.

Everything else about how it works is in [`docs/architecture.md`](docs/architecture.md).
