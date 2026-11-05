# ivanti-mcp

MCP server for Ivanti Neurons for ITSM. **One release serves one tenant and one
audience** — staging, UAT and production are three releases; `full` and `enduser` are
two more.

Source: [syn-con/ivanti-mcp](https://github.com/syn-con/ivanti-mcp). For a release published from
this repository after the transfer, set `VERSION` to its version and run:

```bash
helm install ivanti-mcp oci://ghcr.io/syn-con/charts/ivanti-mcp \
  --version "$VERSION" \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

Versions through **0.3.9** remain at `oci://ghcr.io/tyrunasj/charts/ivanti-mcp`; use that address
for those versions. That package is public, so no registry login is needed. After the first
release under `syn-con`, make the new chart package public to preserve anonymous installation.
The [release notes](https://github.com/syn-con/ivanti-mcp/releases) give the chart address for each
version. The Docker image remains `tyrunas/ivanti-mcp`.

The chart forces HTTP (stdio is meaningless in a pod) and refuses to render on a
configuration the server would reject at boot (`check-chart.mjs` feeds every rendered
configuration to the server's own `loadConfig`). It also refuses `replicaCount > 1`:
HTTP sessions are held in memory, and the pod that answers `initialize` mints the
session id, so nothing in the request that opens a session can route it back to that
pod. **One replica; a rollout ends every open session** and clients reconnect.
`authMode=none` is refused with an ingress, a `LoadBalancer` or a `NodePort`, and gets
a NetworkPolicy by default.

`node scripts/check-chart.mjs` lints the chart and renders every guard; CI runs it.

Full notes, including the secret-ownership and DNS traps, are in
[`docs/deployment.md`](../../docs/deployment.md).

## Values worth knowing

| Key | Default | Notes |
|---|---|---|
| `server.publicUrl` | — | **Required.** Verbatim match against the token audience; no trailing slash. |
| `server.trustedOrigins` | — | **Required.** Origin validation; what stops DNS rebinding. |
| `server.mode` | `full` | `full` or `enduser`. Never mix audiences in one release. |
| `server.authMode` | `bearer` | `none`, `bearer`, `oauth`. |
| `server.enduser.businessObjects` | `[]` | Required for `enduser`. A gate, not a hint. |
| `server.enduser.quickActions` | `[]` | The tenant's own quick-action names an end user may run, on their own open records. Empty means none. |
| `ivanti.baseUrl` | — | **Required.** Tenant origin; the `/HEAT` prefix is probed. |
| `ivanti.maxTier` | — | `odata`, `session` or `admin` — caps the server below what the key can do. |
| `secrets.existingSecret` | — | Keys `ivanti-api-key`, `licence-key` (always: the Synergy Hub licence key), `bearer-token`, `ivanti-central-config-api-key` when `ivanti.configUrl` is set, and `metrics-token` when `metrics.token` is. Mounted `0400`. |
| `ivanti.configUrl` | — | The ConfigDB tenant. With its key in the secret, `act_as` signs in to Ivanti AS the person and every surface follows them. |
| `ivanti.impersonationRole` | — | `full` only. Pins the role an impersonated session opens under; refused when the person does not hold it. |
| `server.enduser.role` | — | The self-service role an impersonated `enduser` session opens under; empty means the server default, `SelfServiceMobile`. |
| `license.installId` | — | This installation's identity to the Synergy Hub. Empty: derived from the namespace and release name, the same on every upgrade, sync and `helm template`. Set it to keep the seat when moving the release; a change takes a new seat. |
| `license.keepState` | `true` | Keeps the last licence the Hub confirmed in the `<fullname>-licence-state` Secret, so a restart during a Hub outage keeps its 30 days. Renders that Secret, a Role that may `get` and `update` it alone, and mounts the pod's service-account token. `false` renders none of it. |
| `replicaCount` | `1` | Refused above 1 — sessions are in memory. `0` parks the release. |
| `rolloutToken` | — | Change it to roll the pod after rotating a key in `existingSecret`; the key is read once, at startup. |
| `networkPolicy.enabled` | `auto` | `auto` = on exactly when `authMode=none`. Admits `networkPolicy.from`, by default pods in the release namespace. |
| `metrics.enabled` | `false` | `METRICS_ON`. Prometheus metrics on a port and a ClusterIP Service of their own, `<fullname>-metrics` — never the main Service, so the Ingress cannot route to them. Leave off on an internet-facing release unless something in-cluster scrapes it. |
| `server.port` / `service.port` | `3000` | `MCP_PORT` in the pod / the Service's port. Keep them equal; `publicUrl` and any port-forward follow. |
| `metrics.port` | `9464` | `METRICS_PORT`. Refused when equal to `server.port`. |
| `metrics.token` | `false` | Mounts key `metrics-token` from the secret as `METRICS_TOKEN_FILE`: a scrape-only token, at least 32 characters, never one of the other keys. |
| `metrics.from` | `[]` | NetworkPolicy peers admitted to the metrics port, and only to it; empty = pods in the release namespace. Applies only while the NetworkPolicy renders — `auto` still follows `authMode`. |
| `metrics.serviceMonitor.enabled` | `false` | Needs the Prometheus Operator CRDs and `metrics.enabled`. Sends the token when `metrics.token` is set; `labels` for your Prometheus's selector. |
| `server.maxSessionsPerSubject` | — | `MCP_MAX_SESSIONS_PER_SUBJECT`, `oauth` only and at most `server.maxSessions`. Past it, that person's least recently used session closes. |
| `ivanti.timeoutMs` / `ivanti.writeTimeoutMs` | — | `IVANTI_TIMEOUT_MS` / `IVANTI_WRITE_TIMEOUT_MS`; empty = the server defaults, 10000 and 30000. |
| `ivanti.maxConcurrentRequests` | — | `IVANTI_MAX_CONCURRENT_REQUESTS`: requests in flight to the tenant at once; empty = the server default (16) |
| `server.maxCallsPerMinute` | — | `MCP_MAX_CALLS_PER_MINUTE`: tool calls per conversation per minute; empty = the server default (120) |
| `ivanti.impersonationRequired` | `false` | `IVANTI_IMPERSONATION_REQUIRED`, with `ivanti.configUrl`: exit rather than run as the service account when impersonation is unavailable. |
| `server.identityIdleTtlSeconds` | `1800` | `MCP_IDENTITY_IDLE_TTL_SECONDS`: how long a conversation may go quiet before the pinned person is forgotten. Not the session TTL. |
| `oauth.audience` | — | Accepted `aud` values: a string or a list; empty = `server.publicUrl`. |
| `hostAliases` | `[]` | For tenants behind split-horizon DNS. |
| `image.digest` | — | Pin this in production instead of a tag. |

Everything else — probes, resources, ingress, service account — is in `values.yaml`
with the reasoning inline.
