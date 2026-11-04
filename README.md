# Ivanti MCP

An [MCP](https://modelcontextprotocol.io) server for **Ivanti Neurons for ITSM** — reading
records, filing tickets, running the tenant's own quick actions, handling approvals — over stdio, or
over HTTP with no authentication, a bearer token or OAuth. **41 tools in `full` mode, 34 in
`enduser`**, plus six reference documents served as MCP resources. Ships as a container image, a
Helm chart and a tarball, all built from one commit.

Source and releases: [syn-con/ivanti-mcp](https://github.com/syn-con/ivanti-mcp).

The server signs in to Ivanti as **one API user**. `act_as` is how a conversation says who it is
helping, and every other tool refuses until it has. Given a ConfigDB key, `act_as` opens a real
Ivanti session *as* that person, so Ivanti applies their own access.

**Running a published build?** Start with the
**[Handbook](https://syn-con.github.io/ivanti-mcp/)** — every setting, every tool, and
a configurator that writes the `.env`, `docker run`, compose file, Helm values and systemd unit.
Its source is [`docs/handbook.html`](docs/handbook.html); the `Pages` workflow publishes it from
`main`.

## Development

Node 22 or later and pnpm (the version is pinned in `package.json`). `helm` is needed only for the
chart check, Docker only for the image.

```bash
pnpm install
cp .env.example .env      # set IVANTI_BASE_URL, IVANTI_API_KEY and LICENSE_KEY
pnpm dev                  # tsx watch; or pnpm build && pnpm start
```

The server **fails closed**: an incomplete or contradictory configuration exits `78` and lists
every problem at once. `.env.example` documents every setting; [`examples/env/`](examples/env)
holds working configurations to start from.

**Before a PR:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — all four. Changed a tool
description, an argument or the server `instructions`? Run `pnpm handbook:sync` too. CI runs more
checks than these; [`docs/development.md`](docs/development.md) lists them and says when to run
each locally.

**`main` is protected**, admins included: every change goes through a PR with `Checks` and `Image`
green. A change to the tool surface is verified by driving it against the live tenant, not only by
tests — the loop is in [`docs/development.md`](docs/development.md#testing-against-the-live-tenant).

**Read first, depending on the change:**

- [`CLAUDE.md`](CLAUDE.md) — the source layout, the invariants and the budgets, in one page.
- [`docs/initial-design.md`](docs/initial-design.md) — before any architectural change; §10 lists
  the alternatives already rejected, and why.
- [`docs/architecture.md`](docs/architecture.md) — how each part works, and why.
- [`docs/notes.md`](docs/notes.md) — when Ivanti behaves unexpectedly. Add to it when you hit a
  trap.

## Documentation

| | |
|---|---|
| [Handbook](https://syn-con.github.io/ivanti-mcp/) ([source](docs/handbook.html)) | interactive reference and configurator; start here to run it |
| [`examples/env/`](examples/env) | working configurations — CI proves they load |
| [`docs/configuration.md`](docs/configuration.md) | configuring against a real IdP, with a symptom → cause table |
| [`docs/deployment.md`](docs/deployment.md) | the four shapes, the chart's guards, the image build, releasing |
| [`docs/architecture.md`](docs/architecture.md) | how the server works and why — capability tiers, audience modes, identity, writes |
| [`docs/development.md`](docs/development.md) | commands, checks, testing against the live tenant |
| [`docs/usage.md`](docs/usage.md) | what the tool descriptions and results cost a conversation, the failed turns they cause, and how to tune them |
| [`docs/initial-design.md`](docs/initial-design.md) | decisions — and, in §10, what was rejected and why |
| [`docs/impersonation-plan.md`](docs/impersonation-plan.md) | signing in as the person, through CentralConfig |
| [`docs/notes.md`](docs/notes.md) | traps: things that pass locally and fail elsewhere |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | what was built, in what order, and what remains |
| [`docs/production-readiness-plan.md`](docs/production-readiness-plan.md) | the plan to production readiness, area by area, with what counts as done |
| [`CHANGELOG.md`](CHANGELOG.md) | what each release changed for someone running it, and what to check before upgrading |
| [`docs/review/`](docs/review) | the full-codebase reviews — what was found and fixed, what was refuted, and what nobody looked at |
| [`charts/ivanti-mcp/README.md`](charts/ivanti-mcp/README.md) | the chart's values and what it refuses to render |
| [`CLAUDE.md`](CLAUDE.md) | orientation for agents working in this repository |
| [`LICENSE`](LICENSE) · [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | the commercial terms, and the components distributed with it |

## Licence

**Every deployment needs a Synergy Hub licence key** (`LICENSE_KEY`) and outbound HTTPS to the
Hub; unlicensed, the server starts and refuses its tools, saying why. How to set it up, shape by
shape: [`docs/deployment.md`](docs/deployment.md#licensing).

Copyright © 2026 SYNERGY. All rights reserved. **This software is licensed, not sold** — see
[`LICENSE`](LICENSE), which also grants a thirty-day internal evaluation. Third-party components
keep their own terms, listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
