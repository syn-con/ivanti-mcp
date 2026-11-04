# Deployment

Four shapes, one build. A release publishes a multi-arch image, a Helm chart and a self-contained
tarball from the same commit.

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Linux host** | a systemd service | stdio or HTTP | the release tarball |
| **Windows host** | a Windows service, run by WinSW | stdio or HTTP | the same release tarball |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` on Docker Hub |
| **Kubernetes** | a Deployment | HTTP only | `oci://ghcr.io/syn-con/charts/ivanti-mcp` for releases after the transfer; see below for older versions |

Source and releases live at [syn-con/ivanti-mcp](https://github.com/syn-con/ivanti-mcp), and the
[Handbook](https://syn-con.github.io/ivanti-mcp/) is published from this repository.
**Chart versions through 0.3.9 remain at `oci://ghcr.io/tyrunasj/charts/ivanti-mcp`.** The repository
transfer did not move those packages. Releases made from `syn-con` publish to the new namespace;
use the chart address in the release notes for the version you are installing. Docker images
continue to use `tyrunas/ivanti-mcp`.

**The image and the chart live in different registries on purpose.** `helm push` derives the
repository from the chart name, so pushing `ivanti-mcp` to Docker Hub's `tyrunas` namespace would
overwrite the image; ghcr.io nests, so the chart lives under `charts/`.

**The existing `tyrunasj` chart package is public**, like the Docker Hub image, so installing those
versions needs no credential. After the first release to `syn-con`, set the new package's
visibility under *Packages → the package → Package settings → Change visibility → Public* and
confirm this repository has Actions access. Visibility is a per-package setting; the repository
transfer does not make the new package public.

Everywhere: **one instance serves one tenant** (staging, UAT and production are three deployments)
and **one audience** (`full` and `enduser` are different products — mixing them hands an employee
an analyst's tools). Every setting is in `.env.example`; an incomplete configuration exits **78**
and lists every problem at once.

**Prometheus metrics are off by default in every shape** (`METRICS_ON`). On, they are served on a
port of their own (`METRICS_PORT`, required when on; 9464 throughout these examples), never the MCP one — every credential guarding the MCP port reaches the
tools, and whatever fronts it must never route to metrics ([design](./initial-design.md#9e-metrics-on-a-port-of-their-own-decided-2026-10-01)).
Leave them off on an internet-facing deployment unless something private scrapes them; when on,
keep the port close (loopback, or a NetworkPolicy) and set `METRICS_TOKEN` once it is reachable from
beyond the machine. Each shape's settings are below; the Handbook's configurator writes them.

In the commands below, set `VERSION` to a release from
<https://github.com/syn-con/ivanti-mcp/releases>.

## 1. Linux host

Node 22 and nothing else — no pnpm, no compiler, no registry access.

Tested end to end on Ubuntu 26.04 with Node 22.22 (Ubuntu's `nodejs` package) and 0.3.0, on
2026-09-30: the Handbook's steps verbatim; bearer auth, a 401 without it and a 403 for a foreign
Origin; `act_as` and a tenant read; a clean stop; a restart after `kill -9`; and exit 78 left
stopped rather than restarted.

Install Node 22 or later first — from the distribution (Ubuntu 26.04's `nodejs` is Node 22) or
nodejs.org. Then, with the `.env` and `ivanti-mcp.service` the Handbook's configurator writes for
**Linux** in one folder:

1. **Edit `.env`:** `IVANTI_BASE_URL`, and for HTTP `MCP_PUBLIC_URL` and `TRUSTED_ORIGINS`.
2. **Install the release:**

   ```bash
   curl -fsSLO https://github.com/syn-con/ivanti-mcp/releases/download/v$VERSION/ivanti-mcp-$VERSION.tar.gz
   sudo useradd --system --home /opt/ivanti-mcp --shell /usr/sbin/nologin ivanti-mcp
   sudo install -d -o ivanti-mcp -g ivanti-mcp /opt/ivanti-mcp
   sudo tar xzf ivanti-mcp-$VERSION.tar.gz --strip-components=1 -C /opt/ivanti-mcp
   ```

3. **Install the settings and secrets**, readable by root and the service only:

   ```bash
   sudo install -d -m 0750 -o root -g ivanti-mcp /etc/ivanti-mcp /etc/ivanti-mcp/secrets
   sudo install -m 0640 -o root -g ivanti-mcp .env /etc/ivanti-mcp/env
   read -rs -p 'Ivanti API key: ' k; printf %s "$k" | sudo install -m 0640 -o root -g ivanti-mcp /dev/stdin /etc/ivanti-mcp/secrets/ivanti-api-key; unset k
   openssl rand -hex 32 | tr -d '\n' | sudo install -m 0640 -o root -g ivanti-mcp /dev/stdin /etc/ivanti-mcp/secrets/bearer-token   # bearer only
   openssl rand -hex 32 | tr -d '\n' | sudo install -m 0640 -o root -g ivanti-mcp /dev/stdin /etc/ivanti-mcp/secrets/metrics-token  # metrics with a token only
   ```

4. **Install and start the service:**

   ```bash
   sudo install -m 0644 ivanti-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now ivanti-mcp
   ```

5. **Check it:** `systemctl status ivanti-mcp`, `journalctl -u ivanti-mcp -n 20`, and
   `curl -s http://127.0.0.1:3000/ready` for HTTP.

The tarball carries its production dependencies as real directories — pnpm's symlink store does not
survive moving machines. The unit (`deploy/systemd/ivanti-mcp.service`) runs unprivileged,
read-only, with no capabilities and a syscall filter.

- **Set `STDIO_TRANSPORT_ON=false` for a service** — a service's stdin is `/dev/null`, so the stdio
  transport reads EOF at once: beside HTTP that is noise in the journal, and on its own it is a
  service nothing can talk to.
- **Prefer `LoadCredential=` for the keys.** The unit carries it commented out:
  `LoadCredential=ivanti-api-key:/etc/ivanti-mcp/ivanti-api-key` with
  `Environment=IVANTI_API_KEY_FILE=%d/ivanti-api-key`. systemd copies the file into a private
  in-memory directory only this service can read, so the source stays `root:root 0600` and the key
  is never in an environment `/proc` can show. Remove that secret's lines from the env file when you
  enable it — `IVANTI_API_KEY` or `IVANTI_API_KEY_FILE`: the env file overrides `Environment=`, and
  both forms is exit 78. Needs systemd 248+.
- **`MemoryDenyWriteExecute` is deliberately not set** — Node's JIT needs writable-then-executable
  pages, and the failure looks like a segfault.
- **`RestartPreventExitStatus=78`** — a configuration error will still be one in five seconds.
- **Metrics:** `METRICS_ON=true` with `METRICS_PORT=9464` in the env file serves `127.0.0.1:9464`, for a Prometheus or agent
  on the same host. For one elsewhere: `METRICS_BIND=0.0.0.0` (or one of the host's addresses),
  `METRICS_TOKEN_FILE=/etc/ivanti-mcp/secrets/metrics-token`, and a firewall rule that admits that
  Prometheus alone to 9464.

From source: `pnpm install --frozen-lockfile && pnpm build && pnpm start`.

## 2. Container

Tested end to end on Ubuntu 26.04 with Docker 29, Compose 2.40 and 0.3.0, on 2026-09-30: the
Handbook's steps with the generated `compose.yaml`; healthy, uid 65532, a read-only root and all
capabilities dropped, published on `127.0.0.1` only; bearer auth, 401 and 403 as on the host;
`act_as` and a tenant read; a clean stop; a restart after the process was killed. A configuration
error restart-loops with back-off — `restart: unless-stopped` cannot spare exit 78 — and
`docker compose logs` names it. **Compose knows a deployment by its `name:`, not its folder**:
`up` from a new folder replaces an existing `ivanti-mcp` project on the same host.

```bash
docker run -d --name ivanti-mcp --restart unless-stopped \
  --env-file .env -e MCP_BIND=0.0.0.0 -p 127.0.0.1:3000:3000 \
  -v "$PWD/secrets:/run/secrets:ro" \
  -v ivanti-mcp-licence:/var/lib/ivanti-mcp -e LICENSE_STATE_DIR=/var/lib/ivanti-mcp \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:$VERSION
```

**The `-p` address decides who reaches it, not `MCP_BIND`.** Inside the container the server must
listen on `0.0.0.0`; a bare `-p 3000:3000` then publishes it on every host interface, and Docker
writes its own iptables rules ahead of ufw and firewalld — the host firewall does not narrow it.
Publish on `127.0.0.1` and put a TLS proxy in front, or publish wider only with `bearer` or `oauth`.
`docker/compose.yaml` publishes on `127.0.0.1` unless `MCP_PUBLISH_ADDR` (compose interpolation, not
a server setting) says otherwise, on `MCP_PORT` read from the same `.env` — run it with
`--env-file .env`; there is no default port, so without one compose refuses to start. The image's
`HEALTHCHECK` reads `MCP_PORT` too, and waits `HEALTHCHECK_TIMEOUT_MS` (default 4000, a number of
milliseconds) for `/health`; like `MCP_PUBLISH_ADDR`, the server never reads it.

**Metrics publish the same way.** With `METRICS_ON=true` the server must bind `METRICS_BIND=0.0.0.0`
inside the container, which `docker/compose.yaml` sets, and the publish address decides who reaches
`METRICS_PORT` (required with `METRICS_ON=true`; no default). Its ports line is
commented out: `${METRICS_PUBLISH_ADDR:-127.0.0.1}:${METRICS_PORT:?…}:${METRICS_PORT:?…}` keeps it
on the host's loopback; a Prometheus container on the same Docker network scrapes `ivanti-mcp:9464` without
publishing at all. Publish wider only with `METRICS_TOKEN_FILE=/run/secrets/metrics-token`. The
startup warning `metrics listen beyond this machine with no token` is expected here: the server sees
the `0.0.0.0` bind, not the publish address that decides.

Multi-arch (`amd64`, `arm64`), distroless, uid 65532, no shell and no package manager. **~55 MB to
pull**, of which 52.6 MB is the distroless Node base; the ~235 MB `docker images` prints is the
uncompressed size. Images are signed keylessly with cosign. For a version published from
`syn-con/ivanti-mcp`, set `VERSION` to that version and verify with:

```bash
cosign verify tyrunas/ivanti-mcp:$VERSION \
  --certificate-identity='https://github.com/syn-con/ivanti-mcp/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

**Versions through 0.3.9 retain their original signing identity.** For those images, use the exact
verification command in that version's [release notes](https://github.com/syn-con/ivanti-mcp/releases).
Renaming the repository does not change an existing signature; the command above applies to
releases published from the new repository address.

It needs cosign 3, or 2.6 with `--new-bundle-format` added; 2.5 and older cannot verify releases
after 0.3.1. Those are signed as a Sigstore bundle stored as an OCI 1.1 referrer, so there is no
`sha256-….sig` tag beside the image — `cosign tree tyrunas/ivanti-mcp:$VERSION` lists it.

The identity is exact on purpose. The old `--certificate-identity-regexp='^https://github.com/<repo>/'`
accepted a signature from **any** workflow in the repository, on **any** branch — including one
nobody reviewed.

Tags: `1.2.3`, `1.2`, `1` and `latest` for a release; a prerelease publishes its exact version only.
CI builds every commit for both architectures and pushes nothing. Pin a digest in production.

Four things that bite, all recorded in `notes.md`:

- **`MCP_BIND=0.0.0.0` inside a container** — its loopback is its own. Exposure is then the `-p`
  address, above.
- **A mounted secret keeps its host ownership**, and the image runs as 65532: a mode-600 file you
  own is unreadable inside, and the exit-78 `EACCES` reads like a missing file.
- **The tenant hostname must resolve inside the container** — split-horizon DNS has handed one a LAN
  address it could not route to. Pin it with `--add-host`.
- **Mount the `licence-state` volume**, which compose does, or every `docker run -i` is a new
  machine to the Synergy Hub — see [Licensing](#licensing).

### How the image is built

Everything is in `docker/` (`Dockerfile`, `compose.yaml`, `healthcheck.mjs`), but the **build
context is the repository root**, and `.dockerignore` stays there:

```bash
docker build -f docker/Dockerfile -t ivanti-mcp .
docker compose --env-file .env -f docker/compose.yaml up
```

Three stages: build → production dependencies → distroless runtime. Alpine is not smaller —
`node:22-alpine` is 57.7 MB compressed and brings a shell and a package manager. `compose.yaml`
builds from source and is for working on the server; to run a published build with compose, the
Handbook's configurator emits one pinned to the image.

- **Base images are pinned by digest**, the tag kept beside it, and pnpm by `ARG PNPM_VERSION`,
  which `pnpm check:docker` holds equal to `packageManager` and fails on any unpinned `FROM`.
  Dependabot proposes new digests weekly (below).
- **Dependencies install with `--node-linker=hoisted`**, because pnpm's symlinked `node_modules`
  does not survive a `COPY` between stages.
- **The dependency stage prunes `*.d.ts`, `*.md` and `*.map`** (10 MB of 28) — nothing a running
  process reads, since this image does not pass `--enable-source-maps`. Licence files stay.
  `scripts/release-tarball.sh` mirrors the prune, which is why the tarball is ~3 MB.
- **`package.json` ships next to `dist/`** — the server reads its version from it and refuses to
  start without it.
- **The health check is a Node script**, since there is no shell or curl. It exits 0 when HTTP is
  off: reporting a stdio deployment unhealthy for running as configured would be worse than not
  checking. It reads `HTTP_TRANSPORT_ON` exactly as the server's `z.stringbool()` does — `y` and
  `enabled` too; it once accepted fewer, and `HTTP_TRANSPORT_ON=y` ran unpolled.
- Verified on Docker Desktop on macOS (arm64) and Docker 29.1.3 on Ubuntu 26.04 (x86_64).

## 3. Kubernetes

```bash
helm install ivanti-mcp oci://ghcr.io/syn-con/charts/ivanti-mcp \
  --version $VERSION \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

For `VERSION=0.3.9` or an earlier release, replace the chart address with
`oci://ghcr.io/tyrunasj/charts/ivanti-mcp`. Anonymous access to the new namespace needs the new chart
package made public — see the top of this page.

The chart forces `STDIO_TRANSPORT_ON=false`, `HTTP_TRANSPORT_ON=true` and `MCP_BIND=0.0.0.0` — none
is a choice in a pod. **It refuses to render** what the server would refuse to start with, moving
the failure to `helm install`:

| Refused | Because |
|---|---|
| no `server.publicUrl`, or one with a trailing slash | compared verbatim against the token audience |
| no `server.trustedOrigins` | origin validation stops DNS rebinding |
| `replicaCount > 1`, or `sessionAffinity.enabled` | sessions are in memory — below |
| `mode=enduser` with an empty allowlist | fail-closed, but almost certainly not meant |
| any `server.enduser.*` under `mode=full` | a gate that gates nothing; the server refuses `ENDUSER_*` there too |
| `authMode=oauth` with no issuer | discovery happens at boot |
| `http://` for `ivanti.baseUrl`, `ivanti.configUrl`, `oauth.issuer` or `oauth.jwksUri`, except loopback | the server refuses them: anyone on the path reads the key, or swaps the keys tokens are verified against |
| `secrets.bearerToken` under 32 characters | the server refuses it |
| `authMode=none` with an ingress, a `LoadBalancer` or a `NodePort` | publishes the tool surface unauthenticated |
| `metrics.port` equal to `server.port` | whatever fronts the MCP port must never reach the metrics |
| `metrics.token` with `secrets.create` and a `secrets.metricsToken` that is empty, under 32 characters, or equal to another chart secret | the server refuses it — whatever scrapes holds it |
| `metrics.serviceMonitor.enabled` while `metrics.enabled` is false | it would scrape a port nothing serves |
| `secrets.create` without `secrets.licenceKey` | the server cannot start without a licence key |
| `license.installId` that is not a UUID, or `license.hubUrl` that is not https | the server refuses both; the licence key travels with every heartbeat |

`node scripts/check-chart.mjs` lints the chart and renders the defaults and every guard — a refusal
that renders fails it, and so does a valid configuration that does not. It is in the shared check
list, so CI and the release gate both run it.

- **One replica, and a rollout ends every open session.** Sessions live in memory, one `McpServer`
  per `Mcp-Session-Id`, and the pod that answers `initialize` *mints* that id — so the request that
  opens a session carries nothing a load balancer can route back by. The `sessionAffinity` option
  this chart used to offer hashed `$http_mcp_session_id`: `initialize` (no header) went to one pod,
  every later request to wherever its new id hashed, and a second pod answered part of every
  conversation with "unknown session". It could not work and is now refused. An upgrade, a key
  rotation or a node drain drops every conversation's session; clients reconnect with a new one.
  More than one replica needs a shared session store, which does not exist.
- **`authMode=none` gets a NetworkPolicy** (`networkPolicy.enabled: auto`): only pods in the release
  namespace reach the port, or the peers in `networkPolicy.from`. `kubectl port-forward` and the
  kubelet's probes are not subject to it, and it is inert on a CNI that does not enforce policy
  (k3s, Calico and Cilium do; flannel alone does not). `true` turns it on under any mode — with an
  ingress, add the controller's namespace to `from`.
- **Secrets:** `secrets.existingSecret` with keys `ivanti-api-key`, `licence-key` (always), `bearer-token` for bearer auth,
  and `metrics-token` with `metrics.token: true` — every key is mounted, at `/run/secrets` (`0400`) with `fsGroup: 65532` so the image's user can
  read them. `secrets.create=true` is for development — it puts the values in Helm history. They
  are read once, at startup: see *Rotating a key*. The chart can measure only
  `secrets.bearerToken` and `secrets.metricsToken`; a `bearer-token` or `metrics-token` under 32
  characters in an existing Secret passes the render and exits 78 at boot.
- **Probes:** plain `httpGet`, since the image has no shell. Startup and liveness ask `/health`,
  which is unauthenticated and 200 while the process is alive; readiness asks `/ready`, which
  answers 503 once the tenant has failed two checks in a row, a minute apart — the Service stops
  routing here without the pod being restarted. The startup probe allows two minutes, because boot
  probes the tenant and opens the ASMX session.
- **Metrics** (`metrics.enabled: true`, port `metrics.port`, 9464): the pod binds
  `METRICS_BIND=0.0.0.0`, and the chart renders a ClusterIP Service of their own,
  `<release>-metrics`, which the Ingress never names. `metrics.token: true` mounts the Secret's
  `metrics-token` as `METRICS_TOKEN_FILE`. `metrics.serviceMonitor.enabled` (with `interval` and
  `labels`) renders a ServiceMonitor — it needs the Prometheus Operator's CRDs — that sends the token
  as `authorization: { type: Bearer, credentials: { name: <secret>, key: metrics-token } }`.
  **Under `bearer`, the default, and `oauth`, no NetworkPolicy renders** (`enabled: auto` means
  `authMode=none`), so `metrics.from` does nothing and every pod in the cluster reaches the metrics
  port — unless `metrics.token: true`, or `networkPolicy.enabled: true` with `metrics.from` set. Set
  one whenever metrics are on; the chart's notes warn when neither is. Once the policy renders, the
  metrics port has a rule of its own: peers from `metrics.from` (empty means the release's own
  namespace) reach it and nothing else, so the ingress controller in `networkPolicy.from` cannot
  read metrics and a scraper cannot reach the MCP port.

## 4. Windows host

The same tarball, run as a Windows service by [WinSW](https://github.com/winsw/winsw) 2.12 — Windows
cannot run `node` as a service by itself. The Handbook's configurator, with **Windows** selected,
writes the whole install as one PowerShell script (Windows PowerShell 5.1 or PowerShell 7, Windows
Server 2019 or later, Node 22 or later): it downloads the release and checks it against the digest
GitHub publishes, downloads WinSW and checks its pinned SHA-256 (it is not code-signed), locks down
the settings, then installs and starts the service.

| Where | What |
|---|---|
| `C:\Program Files\ivanti-mcp` | the release, and WinSW as `ivanti-mcp.exe` with `ivanti-mcp.xml` |
| `C:\ProgramData\ivanti-mcp` | `env`, `secrets\`, `logs\` — Administrators, SYSTEM and the service only |

The service runs `node --env-file="%ProgramData%\ivanti-mcp\env" "%ProgramFiles%\ivanti-mcp\dist\index.js"`
as **LocalService**, so it reads its settings and writes nothing but its logs and its licence state
([Licensing](#licensing)).

Tested on Windows Server 2025 with Node 24.4 and WinSW 2.12.0 (2026-09-30): the generated script
on a clean machine under Windows PowerShell 5.1; start as LocalService; a CRLF `env` file and
`_FILE` secrets on Windows paths; bearer auth, and a 401 without it; stop via Ctrl+C, which the
server logs as a clean `SIGINT` shutdown; and a restart about 10 s after the process was killed.

- **A configuration error restarts every 10 s.** WinSW has no `RestartPreventExitStatus`; the
  reason is in `logs\ivanti-mcp.err.log`.
- **Write secrets as ASCII or UTF-8.** Windows PowerShell 5.1's `>` writes UTF-16, which the server
  reads as a different value. `Set-Content -NoNewline -Encoding ascii` is safe in both shells.
- **A tenant certificate from an internal CA** needs `--use-system-ca` in the service's arguments
  (Node 22.15 or later) — Node does not read the Windows certificate store otherwise.
- **On the Ivanti application server itself**, keep `MCP_BIND=127.0.0.1` and put IIS in front for
  TLS if clients on other machines need it.
- **Metrics:** `METRICS_ON=true` with `METRICS_PORT=9464` in the `env` file serves `127.0.0.1:9464`. For a Prometheus on
  another machine, `METRICS_BIND=0.0.0.0`, a token in `secrets\metrics-token` (the generated script
  writes one), and a Windows Firewall rule naming that Prometheus:
  `New-NetFirewallRule -DisplayName 'Ivanti MCP metrics' -Direction Inbound -Protocol TCP -LocalPort 9464 -RemoteAddress <prometheus> -Action Allow`.

## Licensing

Every deployment needs a **Synergy Hub licence key** (`LICENSE_KEY`, or `LICENSE_KEY_FILE`), and
**outbound HTTPS to the Hub**, `https://hub.itsmcloud.lt` unless `LICENSE_HUB_URL` says otherwise.
There is no offline activation. Without a key the server exits 78. With one, it starts, activates
in the background, and confirms the licence every 4 minutes. The design is in
[§9f](./initial-design.md#9f-licensing-through-the-synergy-hub-decided-2026-11-04).

**When the licence is not confirmed, the server stays up and refuses every tool**, and each refusal
says why. It answers again as soon as the Hub confirms the licence, with no restart. While the Hub
cannot be reached, the server keeps working on the last licence the Hub confirmed, for up to 30 days
from when the Hub signed it. A refusal from the Hub (a revoked key, an ended entitlement, no free
seat) closes it at once, whatever is left of the 30 days. `get_version` reports the licence state,
and the log has one line each time it changes:

| Log line | Means |
|---|---|
| `licence: confirmed by the Synergy Hub` (info) | licensed |
| `licence: the Synergy Hub cannot be reached; running on grace` (warn) | still working; `graceEndsAt` says until when |
| `licence: running on the stored licence until the Synergy Hub answers` (info) | restarted during an outage, and reopened from the kept licence |
| `licence: not licensed — tools are refused until the Synergy Hub confirms it` (error) | `reason` says why: the Hub's refusal, or that it has not answered and nothing usable was kept |

**Two settings decide what the Hub sees, and both must stay the same for the life of the
installation:**

- **`LICENSE_INSTALL_ID`**, a UUID, is the installation's identity. **A new one is a new machine
  to the Hub and takes another seat.** It is required over HTTP. Generate it once with
  `node -e "console.log(crypto.randomUUID())"` and keep it with the other settings. Under stdio it
  is generated once, into `LICENSE_STATE_DIR` when that is set, otherwise into the user's config
  folder (`%APPDATA%\ivanti-mcp` on Windows, `~/.config/ivanti-mcp` elsewhere).
- **Where the last confirmed licence is kept**, so a restart during a Hub outage keeps what is left
  of the 30 days. Without it, the 30 days last only while the process runs, and a restart during an
  outage starts unlicensed.

| Shape | Install ID | Kept licence |
|---|---|---|
| Linux host | in `/etc/ivanti-mcp/env` | the unit's `StateDirectory`, `/var/lib/ivanti-mcp` |
| Windows host | in `C:\ProgramData\ivanti-mcp\env` | `C:\ProgramData\ivanti-mcp\state`, the one folder besides `logs` the service may write |
| Container | in `.env` | the `licence-state` volume, mounted at `/var/lib/ivanti-mcp` with `LICENSE_STATE_DIR` pointing at it |
| Kubernetes | derived by the chart (below) | the `<release>-licence-state` Secret |

**Under `docker run -i` (stdio), mount the volume**, `-v ivanti-mcp-licence:/var/lib/ivanti-mcp`,
or set `LICENSE_INSTALL_ID`. A container started fresh each time otherwise has nowhere to keep its
install ID: with a read-only root it refuses to start and says so, and with a writable one every
run would take a new seat. The image owns `/var/lib/ivanti-mcp` as uid 65532, and a named volume
takes that ownership the first time it is mounted. A bind mount keeps the host folder's ownership,
like the secrets do: `chown 65532:65532` it.

**Under Kubernetes the chart handles both.** The install ID is derived from the namespace and the
release name, so it is the same on every `helm upgrade`, Argo CD sync and `helm template`. Set
`license.installId` to keep the seat when moving a release to another name or namespace. The kept
licence goes in a Secret of its own, `<release>-licence-state`, which the chart creates empty. A
Role lets the pod's service account `get` and `update` **that one Secret and nothing else**, and the
pod mounts its service-account token for that alone (`automountServiceAccountToken: true` on the
pod; the account itself keeps it off). `license.keepState: false` drops the Secret, the Role and the
token, and with them the offline restart. The chart never writes the Secret's data, so an upgrade or
a sync leaves what the server wrote alone. The kept token is signed by the Hub and bound to this
installation, so a copy is no use to another one.

**Upgrading from 0.3.x:** add the key `licence-key` to the existing Secret before upgrading.
Without it the pod cannot read `LICENSE_KEY_FILE` and exits 78.

## Rotating a key

Every secret — the Ivanti API key, the bearer token, the ConfigDB key, the metrics token — is read
**once, at startup**. Changing it where it lives does nothing until the process restarts, and nothing restarts
it for you. Rotate without an outage by overlapping: issue the new Ivanti key, deploy and restart
on it, confirm the startup log reaches the tenant, *then* revoke the old one. A bearer token has no
overlap — every client holding the old one fails once the server restarts, so change them together;
the metrics token likewise, with Prometheus's copy.

| Shape | Replace the secret | Then |
|---|---|---|
| Kubernetes, `existingSecret` | update the Secret (your secret manager, or `kubectl create secret generic … --dry-run=client -o yaml \| kubectl apply -f -`) | `kubectl rollout restart deploy/<release>` — or change `rolloutToken` in the values, which rolls it declaratively (the GitOps path) |
| Kubernetes, `secrets.create` | change the value in the values file | `helm upgrade`; the `checksum/config` annotation rolls the pod |
| systemd | the env file, or the `LoadCredential=` source file | `sudo systemctl restart ivanti-mcp` |
| compose | `secrets/…`, or `.env` | `docker compose up -d --force-recreate` — `restart` re-reads neither `env_file` nor a replaced secret file |
| `docker run` | the mounted file, or `.env` | `docker rm -f ivanti-mcp`, then the same `docker run` |
| Windows service | the file in `C:\ProgramData\ivanti-mcp\secrets`, or `env` | `& "$env:ProgramFiles\ivanti-mcp\ivanti-mcp.exe" restart` |

A restart ends every open session, in every shape; clients reconnect with a new one, and the person
is established again — by the token under `oauth`, by `act_as` otherwise.

## Releasing

**Releasing and deploying are separate buttons.** Releasing publishes an image to Docker Hub, a
chart to ghcr.io and a tarball to the GitHub release; nothing reaches a cluster until it is deployed.

`package.json` is the only place a version is written. `pnpm version:sync` mirrors it into
`Chart.yaml` (`version` and `appVersion`), and `pnpm version:check`, run on every CI build, fails if
the three disagree. **The tag is an output of the release** — pushing one by hand triggers nothing.

```bash
/ship --release                 # bumps the patch, syncs the chart, PR, merge to main
# Actions → Release             (this repo)        image + chart + tarball, then the tag
# Actions → deploy-ivanti-mcp   (k3s-home-lab)     moves targetRevision; ArgoCD syncs
```

The **Release** workflow (`workflow_dispatch` only, **on `main` only** — any other ref fails at the
first step) reads `package.json`, refuses a version already released, runs the same checks as CI,
publishes, and **creates the tag last**, at the commit it built and signed — so a run that dies
halfway retries by pressing the button again instead of leaving an orphan tag.

It is **two jobs**. *Gate* runs the checks — every devDependency, installed and executed — with
`contents: read` and nothing else, and builds the tarball. *Publish* holds the write token, the OIDC
token that signs as `release.yml@refs/heads/main`, and the Docker Hub credentials, installs no npm
package, and downloads the gate's tarball rather than rebuilding it. One job used to do both, which
put the signing identity within reach of any package in the dependency tree. No checkout in either
job keeps its credentials.

Every `docker/metadata-action` tag carries an explicit `value=`: its semver patterns read
`github.ref_name`, which on a manual run is the branch, and the image would publish as `main`. Its
labels restate the Dockerfile's (title, url, `LicenseRef-SYNERGY-Commercial`), because the action's
defaults overwrite them — the licence label used to read `UNLICENSED`. A prerelease (`0.3.0-rc.1`)
publishes its exact version only.

| Artifact | Version from |
|---|---|
| `tyrunas/ivanti-mcp:<v>` (+ `<major.minor>`, `<major>`, `latest`) | `package.json` |
| the chart, pushed OCI | `Chart.yaml`, kept in step by `version:sync` |
| `ivanti-mcp-<v>.tar.gz` on the release | `package.json`, via `release-tarball.sh` |
| the tag `v<v>` and the GitHub release | `package.json` |

**CI and Release share one check list**, `.github/actions/checks`. It used to be written twice, and
the release ran a subset that skipped `check:examples` and `check:licenses` — which validate two
files the tarball ships. It is a composite action, not a reusable workflow, because the gate
packages the `dist/` the checks leave behind. Every check runs even after one fails. It includes
the chart's lint and guard renders.

**The supply chain moves only by pull request.** Every third-party action is pinned by commit SHA
(the version in a comment beside it), the base images by digest, npm packages by the lockfile.
`.github/dependabot.yml` proposes updates weekly — npm, the Dockerfile's images and the actions,
grouped, with a cooldown of a few days after a version is published — and each goes through
`Checks` and `Image` like any other change. A new Node or TypeScript major, and anything that
moves `@modelcontextprotocol/sdk`, arrives on its own.

**One step is CI's alone: the manifest size.** On a pull request, `ci.yml` measures the manifest
of the base branch and of the PR (`pnpm manifest:size`) and writes the difference to the run's
summary, with a one-line annotation. It informs and never blocks — `continue-on-error` — and it is
not in the shared list because a release has no base to compare with. See
[`usage.md`](./usage.md).

**`main` is protected, admins included.** A PR is required; `Checks` and `Image` must be green; the
branch must be up to date; force-pushes and deletions are refused; there is no bypass.

Repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Read/Write on `tyrunas/ivanti-mcp`).

## Deploying to k3s-home-lab

The cluster runs this through ArgoCD, and **releasing does not touch it**. `argocd-apps/ivanti-mcp.yaml`
in `tyrunasj/k3s-home-lab` is a multi-source Application: the chart from this repo at a release
**tag** (from git — which predates the ghcr package going public), the values from that repo at `main`.
Its chart source `repoURL`, and any workflow that looks up this project's releases, should use
`https://github.com/syn-con/ivanti-mcp`. The home-lab repository keeps its own owner and name.

Deploying is **Actions → deploy-ivanti-mcp → Run workflow** there, with a tag or empty for the
latest. It checks that `Chart.yaml` at that tag agrees with the tag — `appVersion` *is* the deployed
image tag, since `values.yaml` leaves `image.tag` empty, and drift would run an image nobody chose
while ArgoCD reports Synced — then moves `targetRevision` and commits. ArgoCD (automated, `selfHeal`,
`prune`) does the rest. Values-only changes skip all of this: edit
`infrastructure/ivanti-mcp/values.yaml` and merge.
