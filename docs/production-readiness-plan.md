# Production readiness — the plan to 9 in every area

Written 2026-09-30, after 0.3.0 and the end-to-end tests on Linux, Docker and Windows. The scores
are a judgement, not a measurement; each area says what would move it and when it counts as done.
Estimates assume one developer. Decisions and rejected alternatives still live in
[`initial-design.md`](./initial-design.md) — anything architectural below is recorded there when
it is decided.

| Area | Now | Target | What gets it there | Effort |
|---|---|---|---|---|
| Correctness and safety | 9 | 9 | Hold: every fix with a test that fails on the old code; one full review before 1.0 | — |
| Security | 8 | 9 | 0.3.1 base-image fix, image scanning and SBOM in CI, threat model, one known limit | ~2.5 wk |
| Deployment | 9 | 9 | Hold: a CHANGELOG with upgrade notes per release — done (`CHANGELOG.md`) | — |
| Operations and monitoring | 5 | 9 | Tenant-aware readiness, metrics, rate limits, runbook and alerts | ~7 wk |
| Scale and availability | 4 | 9 | Replicas under OAuth, PodDisruptionBudget, load and soak tests | ~4 wk |
| Validation breadth | 7 | 9 | A pilot on a production-like tenant with a real IdP, a client matrix, the unmeasured list closed | ~2 wk + pilot |

## First: 0.3.1, the image scan of 2026-09-30

A container scan of the published image (`CS_Image_Vuln_List_20260930.csv`, first detected a
minute after 0.2.5 was published) flagged OpenSSL and glibc in the base image, and two npm
packages. Measured on the sandbox the same day:

| | Runtime base | Node | Trivy: critical / high | Findings with a fix |
|---|---|---|---|---|
| 0.2.5 and 0.3.0 | `nodejs22-debian12` — `libssl3 3.0.18-1~deb12u2`, `libc6 2.36-9+deb12u13` | 22.22.0 | 1 / 6, all `libssl3` | 31 |
| candidate | `nodejs22-debian13` — `libssl3 3.5.7-1~deb13u2`, `libc6 2.41-12+deb13u4` | 22.23.3 | 0 / 1, no fix published | 0 |

- **The Debian 12 image is no longer rebuilt.** Debian fixed every flagged CVE in bookworm
  (`openssl 3.0.20-1~deb12u2`, `glibc 2.36-9+deb12u14`), but the newest
  `gcr.io/distroless/nodejs22-debian12:nonroot` is the digest the Dockerfile already pins, still on
  Node 22.22.0. Pinning by digest was right; what was missing is a scan that notices a base
  going stale. Move the runtime stage to `gcr.io/distroless/nodejs22-debian13:nonroot`, pinned by
  digest (`sha256:5ef534d3…34d8a` on 2026-09-30); the Node path `/nodejs/bin/node` is unchanged.
- **Node does not use Debian's `libssl3` for TLS** — it carries its own OpenSSL (3.5.4 in 0.3.0,
  3.5.8 on the Debian 13 base). The flagged package is present, scanners count it, and it goes.
- **npm:** `proxy-addr` 2.0.7 → 2.0.8 (CVE-2026-90711, IP spoofing through an IPv4-mapped IPv6
  trusted subnet; 2.0.8 is exactly the fix commit) and `fast-uri` 3.1.7 → 3.1.8
  (GHSA-hrr3-gc8f-f4qj). Both are transitive — `express` and `ajv` under the MCP SDK — and both
  ranges already allow the fix, so it is a lockfile update. The server never sets `trust proxy`
  or reads `req.ip`, so the `proxy-addr` path is not reached; it is updated anyway.
- **Found on the rebuilt image:** `ip-address` 10.7.0 → 10.7.2 (CVE-2026-101911, unbounded IPv6
  parsing; CVE-2026-101912, cross-family subnet comparison), under the SDK's `express-rate-limit`.
- **Informational:** "MCP SDK detected" (severity 1) needs nothing.

**Done in 0.3.1.** The three npm fixes were published 15 days before, past Dependabot's 7-day
cooldown; the lockfile changes those three packages and nothing else. The image built from it
scanned with Trivy at none critical, one high with no fix published (`libssl3t64`), and **no
finding with a fix available**, and passed the end-to-end MCP check against the tenant.

## Security, 8 → 9

**Progress (2026-11-05):** 1 — Docker builds run only during release. The scan runs in the release
Gate before anything is pushed, and weekly over the published `latest` without rebuilding it;
SBOM and provenance were already attached to every image, and
are now documented. 2 — the Handbook's *Hardening* section. 3 — fixed: every Ivanti error now
carries the credential it was sent with, and only a 401 on the person's own re-opens their
session. Left: 4.

1. **Scan every release image** — Trivy or Grype on the built image in the release
   Gate; fail on a fixable critical or high. Attach an SBOM and build provenance to each image,
   verifiable with `cosign`. This is the check that would have caught the stale base.
2. **Threat model and a hardening checklist** in the Handbook: what the API key and the
   CentralConfig key reach, the trust boundaries, and the recommended production profile — OAuth,
   TLS in front, impersonation.
3. **Fix a known limit from the review:** a 401 re-opens the person's session even when it came
   from the service account's own call ([`review/STATUS-2026-09-29.md`](./review/STATUS-2026-09-29.md)).
4. **Review what the full review left out:** the reference documents' correctness about Ivanti,
   and `scripts/`.

**Done when:** the release Gate refuses fixable critical or high findings, every release carries
an SBOM and provenance, and the threat model is published.

## Operations and monitoring, 5 → 9

**Progress (2026-09-30):** 1 — `/ready`, from a background check of the tenant every minute, 503
after two failures in a row; the chart's readiness probe uses it. 4, in part — the log lines worth
an alert are in the Handbook's *Watching it*. 3 — `IVANTI_MAX_CONCURRENT_REQUESTS` caps requests in
flight to the tenant (a request held back is never sent, and says so), and
`MCP_MAX_CALLS_PER_MINUTE` limits each conversation (2026-10-01). 2 — Prometheus metrics on a
port of their own, off by default behind `METRICS_ON`, loopback by default with an optional scrape
token; the chart renders a metrics Service, an optional ServiceMonitor and a NetworkPolicy rule of
their own (2026-10-01). 4, further — example alert rules in PromQL, in the Handbook's *Watching it*.
Left: dashboards, and the rest of the runbook.

1. **Readiness that reflects the tenant (~2 wk):** `/ready` checks that the tenant answers and the
   session is valid, cached for a few seconds; `/health` stays liveness only. The chart's
   readiness probe moves to `/ready`.
2. **Metrics (~2 wk):** tool calls by tool and outcome, refusals, Ivanti latency and status,
   sessions active, evictions and 503s, in Prometheus format. Decision 2 below: a separate port.
   **Done 2026-10-01.**
3. **Rate limits and concurrency caps (~2 wk):** per person, and a global cap on concurrent Ivanti
   requests so the server cannot overload the tenant; `429` with `Retry-After`.
4. **Runbook and alerts (~1 wk):** example alert rules — tenant down, error rate, 503s, restarts —
   a dashboard, and an "Operating it" section in the Handbook.

**Done when:** a tenant outage turns the pod not-ready and fires an alert within a minute, and a
dashboard shows calls, errors and latency.

## Scale and availability, 4 → 9

**Deferred 2026-10-01** — see `initial-design.md`, *More than one replica — deferred*, for why and
for what would reopen it. What follows is the plan if it is reopened.

1. **Decide the model** (decision 1), and record it in `initial-design.md`. §10 rejects routing by
   `Mcp-Session-Id` at the ingress; it does not reject either of these:
   - **Stateless HTTP under OAuth (recommended).** The token names the person on every request,
     so any pod serves any request — the MCP SDK supports it (`sessionIdGenerator: undefined`).
     Each pod keeps its own Ivanti session per person; `switch_role` needs its choice kept per
     person, or turning off in this mode. `bearer` and `none` carry no identity per request, so
     they stay one replica. No new infrastructure.
   - **A shared session store (Redis) for every mode.** Covers `bearer` too; adds a dependency to
     run and secure. ~3 weeks.
2. **Implement (~3 wk):** more than one replica allowed under OAuth, a PodDisruptionBudget, and
   rolling updates that drop no conversation.
3. **Load and soak (~1 wk):** concurrent sessions with real tool calls, capped against the tenant;
   a 24-hour soak for leaks; memory re-measured on Linux, replacing the macOS figures in the
   Handbook.

**Done when:** three replicas survive a rolling update mid-conversation with nothing dropped, the
load test meets the target, and memory is flat through the soak.

## Validation breadth, 7 → 9

**Progress (2026-09-30):** the Windows Ivanti connection passed end to end on 0.3.1, after an
upgrade by the documented steps; memory was re-measured on Linux (~104 MiB idle, ~64 KiB per
session); Claude Code verified as a client over stdio and HTTP; `enduser` ownership held on Change,
whose customer link is `RequestorLink`, with impersonation on and off (2026-10-01). Left: the
pilot, Entra, Claude Desktop, the claude.ai and ChatGPT connectors, and the rest of the unmeasured
list.

1. **A pilot** on a production-like tenant with real users, two weeks, with `usage:report` as the
   baseline.
2. **A real IdP end to end:** Entra with a claude.ai connector — A4 in
   [`implementation-plan.md`](./implementation-plan.md), which needs a public HTTPS hostname. It
   also settles whether tokens carry `email_verified`.
3. **A client matrix:** Claude Desktop, Claude Code, a claude.ai connector and a ChatGPT
   connector, each verified connecting and working.
4. **Close the unmeasured list** in the review status: the write timeout under a workflow-heavy
   create, a failed vote, `enduser` on an object whose customer link is not `ProfileLink`,
   keep-alive behind a real ingress, and the Windows Ivanti connection. SIGTERM is closed — the
   Linux test on 2026-09-30 stopped cleanly under systemd.

**Done when:** the pilot runs two weeks without a serious incident, every client is verified, and
the unmeasured list is empty.

## Order

| Weeks | Work | Areas at the end |
|---|---|---|
| 0 | 0.3.1: Debian 13 runtime base, `proxy-addr`, `fast-uri`, `ip-address` — done | — |
| 1–2 | Security items, CHANGELOG, client matrix, unmeasured items; the pilot starts | Security 9, Validation 8 |
| 3–5 | Readiness, metrics, rate limits, runbook | Operations 9 |
| 5–8 | Replicas under OAuth, PodDisruptionBudget, load and soak | Scale 9 |
| 8–10 | Pilot review, Entra end to end | Validation 9 |

## Decisions still open

1. **Scale:** deferred 2026-10-01 — one replica; stateless under OAuth if it is reopened.
2. **Metrics:** decided 2026-10-01 — a separate port, off by default behind one switch
   (`METRICS_ON`), loopback by default, with an optional scrape-only token; never the main port,
   whose every credential reaches the tools. Recorded in `initial-design.md` §9e and §10.
3. **Pilot:** which tenant — and can a public HTTPS hostname be arranged for Entra?
4. **Load target:** how many concurrent users, and what latency is acceptable?
