# Configuration guide

`.env.example` is the reference — every setting, with its default. This is the guide: how to
set the server up against a real identity provider, and what goes wrong.

## Four decisions, in order

| Decision | Settings | Question it answers |
|---|---|---|
| **Transport** | `STDIO_TRANSPORT_ON`, `HTTP_TRANSPORT_ON` | How is the server reached? |
| **Access** | `AUTH_MODE` and its credentials | Who may connect? |
| **Audience** | `MCP_MODE`, `ENDUSER_BUSINESS_OBJECTS`, `ENDUSER_QUICK_ACTIONS` | What may they do? |
| **Ivanti identity** *(optional)* | `IVANTI_CONFIG_URL` + `IVANTI_CENTRAL_CONFIG_API_KEY`, and `IVANTI_IMPERSONATION_REQUIRED` | Does Ivanti see the service account, or the person? |

They are independent. `AUTH_MODE` is a **door**, not an identity: it decides whether a client may
connect. Who an operation is *for* is decided per conversation by `act_as` — and with the ConfigDB
pair set, Ivanti signs in as that person and applies their own access
([`impersonation-plan.md`](./impersonation-plan.md)). A ConfigDB that does not answer at startup
is a warning, and the server then runs as the service account; `IVANTI_IMPERSONATION_REQUIRED=true`
makes it exit `78` instead, for a deployment whose promise is that Ivanti scopes every answer.

The server **fails closed**. An incomplete configuration exits `78` (`EX_CONFIG`) and prints every
problem at once — not just the first.

Every secret also takes a `_FILE` form (`IVANTI_API_KEY_FILE`, `BEARER_TOKEN_FILE`, …); giving
both forms is an error, not a precedence question. To start from something that runs, copy one of
the configurations in [`examples/env/`](../examples/env) — CI loads each through the real
`loadConfig` and fails if any would exit `78`.

---

## The audience problem — read this before configuring OAuth

The MCP spec has clients send `resource=<canonical MCP URL>` (RFC 8707), and servers validate that
the token was issued for them. A reasonable reading is that `aud` will contain your MCP URL.

**It will not. No mainstream identity provider works that way.**

| IdP | What lands in `aud` |
|---|---|
| Entra ID | **depends on the token version.** v2.0: the API's client id, a bare GUID. v1.0: the Application ID URI, e.g. `api://<app-guid>`. `requestedAccessTokenVersion` on the app registration decides which |
| Zitadel | a numeric project or client id |
| Okta | the authorization server's audience setting |
| Keycloak | typically the client id |
| Auth0 | the `audience` parameter the client passed |

So `OAUTH_AUDIENCE` is configured **independently** of `MCP_PUBLIC_URL`. It is a comma-separated
list, and a token is accepted when its `aud` contains **any** entry — the token's own `aud` may
itself be an array, so this is a set intersection, not an equality check.

A verifier written to the spec's literal wording rejects every real token. This is the single most
common reason OAuth "doesn't work" here.

---

## Redirect URIs — whose are they?

| URL | Belongs to | Production value |
|---|---|---|
| `MCP_PUBLIC_URL` | **this server** | always an FQDN behind TLS: `https://mcp.example.com/mcp` |
| the redirect URI | **the client** | loopback for a native client; the client's own HTTPS URL for a web one |

The redirect URI is where the IdP sends the user back after login — a property of the client,
which this server neither hosts nor sees.

- **A loopback redirect is production, not dev mode.** A CLI or desktop client (Claude Code) opens
  a browser and listens on `http://localhost:<port>/callback`; the client *is* the endpoint. RFC 8252
  prescribes it and the MCP spec allows it: *"All redirect URIs MUST be either `localhost` or use
  HTTPS."* Every provider special-cases loopback, which is why plain `http` is allowed there only.
- **A web-hosted client** (e.g. `https://claude.ai/api/mcp/auth_callback`) registers its own HTTPS
  URL, and there is no `--callback-port`.
- **What is genuinely dev-only** is a toggle like Zitadel's *Dev Mode*, which allows plain `http`
  on a *non*-loopback host. Do not ship that.

---

## Microsoft Entra ID

The majority deployment. Always issues JWTs, so there is no opaque-token trap — but four settings
decide whether it works, and three of them default wrong for this use.

> ### Prerequisite: a public HTTPS hostname on a tenant-verified domain
>
> **This is not optional and cannot be worked around.** Two requirements meet:
>
> - the **client** validates that the RFC 9728 `resource` equals the endpoint it connected to;
> - **Entra** requires `resource` to be a registered Application ID URI. Under the `api://`
>   scheme a GUID must match the app id or the tenant id, and an arbitrary string must sit on a
>   verified custom domain or the tenant's initial domain; `api://<appId>` is the recommended
>   form. HTTPS is permitted on a domain in the tenant's verified list.
>
> So the MCP server's own URL must *be* the Application ID URI. `http://localhost:3000/mcp` can
> never be one, which means **Entra cannot be tested against a local server** — no override
> helps, because a conforming client rejects any `resource` that is not its endpoint.
>
> Deploy at e.g. `https://mcp.example.com/mcp` on a verified domain first. Then the App ID URI,
> `MCP_PUBLIC_URL`, `OAUTH_AUDIENCE` and the endpoint are one identical string, and the rest of
> this section is straightforward.
>
> If *Custom domain names* refuses to verify while your DNS is demonstrably correct, the domain
> is almost certainly claimed by another Microsoft tenant — often an unmanaged one created when
> someone signed up for a free service with an address at that domain. That is an admin-takeover
> or support case, not a DNS problem; check from the command line before spending time on it:
> `dig +short @8.8.8.8 <domain> TXT`.

### One app registration is enough

It can both expose the API and act as the client, which is simpler than wiring two.

**1. Expose an API**

*App registration → Expose an API*
- **Application ID URI**: `api://<app-guid>` (the default) or a friendly name
- **Add a scope**: e.g. `mcp.access`, *Admins and users* can consent

**2. Authentication — the platform choice matters more than it looks**

*App registration → Authentication → Add a platform → **Mobile and desktop applications***
- Redirect URI: `http://localhost/callback` — **omit the port**. Microsoft ignores the port
  component for localhost URIs, matching on path alone, so one entry covers whatever port the
  client happens to pick. Registering a specific port works too but pins you to it.
  Loopback is correct for a CLI client in production, not just development; see *Redirect URIs*
  above. Use the client's own HTTPS URL instead if the client is web-hosted.

  Two related rules from the same page: **do not register URIs differing only by port** — since
  the port is ignored, the login server picks one arbitrarily; differentiate by *path*. And the
  **IPv6 loopback `::1` is not supported**, so use `localhost`.

  The three checkboxes the portal offers — `.../oauth2/nativeclient`, LiveSDK, and
  `msal<guid>://auth` — are broker and custom-scheme defaults. None apply to a client that uses
  a plain loopback listener.
- **Allow public client flows: Yes**

Adding the redirect under *Web* instead puts it in a different manifest array and Entra then
treats the app as a confidential client that must present a secret — which a CLI cannot do. In the
manifest the difference is visible:

```jsonc
"publicClient": { "redirectUris": ["http://localhost:55266/callback"] },  // correct
"web":          { "redirectUris": [] },                                   // must be empty
"allowPublicClient": true          // defaults to false, i.e. confidential
```

**3. Manifest — the access token version**

```jsonc
"api": {
  "requestedAccessTokenVersion": 2
}
```

**This is the one people miss.** It defaults to `null`, meaning v1, and v1 changes the issuer to
`https://sts.windows.net/<tid>/` while v2 issues `https://login.microsoftonline.com/<tid>/v2.0`.
`OAUTH_ISSUER` is matched exactly, so a v1 token is rejected with a message about the issuer that
looks nothing like "you forgot a manifest field".

**4. API permissions**

*Delegated* → *My APIs* → this app → `mcp.access`, plus the usual `openid`, `profile`,
`offline_access`.

**No Microsoft Graph permissions beyond OIDC basics, and no application permissions at all.** The
server never calls Microsoft. It fetches the public JWKS document unauthenticated and verifies a
signature locally — the token is evidence, not an access key.

**Optional: skip the consent prompt.** If the client and API are the same registration, or you
want to pre-approve a known client, add it to `preAuthorizedApplications`:

```jsonc
"api": {
  "requestedAccessTokenVersion": 2,
  "preAuthorizedApplications": [
    { "appId": "<client-app-guid>", "permissionIds": ["<scope-guid>"] }
  ]
}
```

### Single-tenant only

Set `signInAudience` to **`AzureADMyOrg`**.

Our verifier matches `iss` **exactly** against `OAUTH_ISSUER`. That is correct and simple for a
single-tenant app, where the issuer is a fixed string. A **multi-tenant** app is different:
Microsoft's tenant-independent metadata returns an issuer containing a `{tenantid}` placeholder
which a validator is expected to substitute with the token's own `tid` claim before comparing.

We do not implement that substitution, so **multi-tenant Entra apps are not supported** — a token
from any tenant would fail the issuer check. A separate deployment per tenant is the supported
shape, and matches the one-instance-one-tenant decision anyway (design §2).

Also note: if `signInAudience` is `AzureADandPersonalMicrosoftAccount`, `requestedAccessTokenVersion`
**must** be 2 — Entra enforces that pairing.

### Server settings

```bash
AUTH_MODE=oauth
MCP_PUBLIC_URL=https://mcp.example.com/mcp
TRUSTED_ORIGINS=https://claude.ai
OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OAUTH_AUDIENCE=api://<app-guid>
```

`OAUTH_AUDIENCE` is the **Application ID URI**, not `MCP_PUBLIC_URL`. Entra may also emit the bare
client GUID as the audience depending on how the token was requested — if verification fails,
decode the token and read its real `aud` rather than guessing. The setting takes a list, so both
values can be accepted at once.

### Client registration

**Entra supports no Dynamic Client Registration**, so the client must be pre-registered and pinned:

```bash
claude mcp add --transport http ivanti https://mcp.example.com/mcp \
  --client-id <app-guid> --callback-port <port>
```

The public URL, never a local one — see the prerequisite above. The port must match the redirect
URI you registered, unless you registered it without one.

### Two Entra quirks worth knowing

**Discovery resolves only on the third probe.** Its issuer carries a path, and both
path-insertion forms return 404 — only `{issuer}/.well-known/openid-configuration` answers.
Verified against live tenants; an implementation that tries fewer candidates cannot reach Entra.

**Entra publishes no `code_challenge_methods_supported`.** The spec says a client **MUST refuse to
proceed** when it is absent, and Entra is the only provider of ten surveyed that omits it — while
supporting PKCE S256 in practice. Whether a given client is strict about this cannot be fixed from
the server side. See design §12.

---

## Zitadel

Supports DCR, but **do not rely on it** — see the token-type trap below.

**Create**
1. *Projects* → your project (or create one)
2. *Applications* → **New** → type **Native** (a CLI client is a public client)
3. Authentication method: **None** — PKCE, no client secret
4. Redirect URI: `http://localhost:<port>/callback`
5. Copy the **Client ID** shown after creation

**The setting that decides whether any of this works**

*Application → Token Settings → **Auth Token Type: JWT***

Zitadel's default is **Bearer**, which is an opaque reference token. A JWKS verifier cannot
inspect one at all — there is no header, no signature, nothing to check — and the server will
reject it with *"Access token is opaque, not a JWT"*.

**Why pinning the client matters here specifically:** Zitadel supports Dynamic Client
Registration, so a client that registers itself gets a brand-new application which inherits the
instance default — Bearer. Flipping one app to JWT therefore lasts only until the next
re-authentication creates another. Pin the client id and the problem disappears.

**Server config**
```bash
OAUTH_ISSUER=https://your-instance.zitadel.cloud
OAUTH_AUDIENCE=<client-id>        # Zitadel always puts the requesting client id in aud
OAUTH_SCOPES_SUPPORTED=openid,profile
```

**Client**
```bash
claude mcp add --transport http ivanti http://127.0.0.1:3000/mcp \
  --client-id <client-id> --callback-port <port>
```

**Not needed:** the proprietary scope `urn:zitadel:iam:org:project:id:<projectId>:aud`, which adds
a *project* to the audience. The client id is always in `aud` anyway, so target that and skip the
Zitadel-specific coupling entirely.

---

## Okta

**Create**
1. *Security → API → Authorization Servers* → **Add Authorization Server**
   - Set an **Audience** value — this is literally what lands in `aud`
   - Add a scope, e.g. `mcp.access`
   - *Access Policies* → add a policy and rule allowing your client
2. *Applications* → **Create App Integration** → **OIDC** → **Native Application**
   - Grant types: *Authorization Code* + *Refresh Token*
   - Sign-in redirect URI: `http://localhost:<port>/callback`
   - PKCE is required for native apps by default — leave it on
3. Assign the app to the authorization server's access policy

**The trap:** *use the custom authorization server you just created, not the **org** one.* Okta's
org authorization server (`https://<org>.okta.com` with no `/oauth2/<id>`) issues **opaque**
tokens. Only a custom authorization server issues JWTs.

**Server config**
```bash
OAUTH_ISSUER=https://<org>.okta.com/oauth2/<authServerId>
OAUTH_AUDIENCE=<the Audience value from step 1>
```

DCR is supported, but pinning `--client-id` is still simpler and avoids policy-assignment
surprises for self-registered clients.

---

## Keycloak

The least troublesome of the mainstream providers: JWTs by default, DCR supported, PKCE advertised.

**Create**
1. *Clients* → **Create client** → OpenID Connect
   - Client authentication: **Off** (public client)
   - Standard flow: **on**; Direct access grants: off
   - Valid redirect URIs: `http://localhost:<port>/callback`
2. *Advanced* → **Proof Key for Code Exchange Code Challenge Method: S256**

**The one non-obvious step — the audience mapper.** By default Keycloak puts `account` in `aud`,
not your client id, so audience validation fails with an otherwise perfect token. Add a mapper:

*Client scopes* → `<your-client>-dedicated` → **Add mapper** → **By configuration** → **Audience**
→ set *Included Client Audience* to your client → ensure **Add to access token** is on.

**Server config**
```bash
OAUTH_ISSUER=https://<host>/realms/<realm>
OAUTH_AUDIENCE=<client-id>
```

---

## Auth0

**Create**
1. *Applications → APIs* → **Create API**
   - **Identifier** — e.g. `https://ivanti-mcp`. This string is the audience; it never has to
     resolve to anything.
2. *Applications* → **Create Application** → **Native**
   - Allowed Callback URLs: `http://localhost:<port>/callback`

**The trap:** Auth0 issues an **opaque** token unless the client passes an `audience` parameter —
and an MCP client will not, because nothing in the protocol tells it to.

The fix is tenant-side, not client-side: *Settings → API Authorization Settings → **Default
Audience*** → set it to your API identifier. Every token then carries that audience and is issued
as a JWT.

**Server config**
```bash
OAUTH_ISSUER=https://<tenant>.auth0.com/     # note the trailing slash — Auth0 issues it that way
OAUTH_AUDIENCE=https://ivanti-mcp
```

`OAUTH_ISSUER` must match the `iss` claim byte for byte, and Auth0's includes a trailing slash.
This is the one place where a trailing slash is correct.

---

## Others

**JumpCloud** — JWTs, no DCR, PKCE advertised. Pre-register a client and pin `--client-id`.
Issuer `https://oauth.id.jumpcloud.com`.

**Google** — not recommended. Access tokens are opaque (`ya29.…`), there is no introspection
endpoint, and no DCR. Nothing to configure your way out of.

**Anything else** — if it publishes a `jwks_uri` and issues JWTs, it will work. Point
`OAUTH_ISSUER` at it, set `OAUTH_AUDIENCE` to whatever the token actually carries in `aud`
(decode one and look), and pre-register a client if it has no `registration_endpoint`.

---

## Discovery, and how to skip it

There are exactly two ways the server learns where the signing keys are.

### 1. Discovery (default) — set `OAUTH_ISSUER` only

At **startup**, the server probes the well-known URLs in the order the spec defines, takes the
first document that parses, and reads `jwks_uri` from it.

The candidate list depends on whether the issuer has a path component:

| Issuer shape | Probes, in order |
|---|---|
| **With a path**<br>`https://host/tenant/v2.0`<br>*(Entra, Okta, Keycloak)* | 1. `https://host/.well-known/oauth-authorization-server/tenant/v2.0`<br>2. `https://host/.well-known/openid-configuration/tenant/v2.0`<br>3. `https://host/tenant/v2.0/.well-known/openid-configuration` |
| **Without a path**<br>`https://host`<br>*(Zitadel, Auth0)* | 1. `https://host/.well-known/oauth-authorization-server`<br>2. `https://host/.well-known/openid-configuration` |

**All three candidates matter.** Entra 404s on the first two and answers only on the third;
Zitadel answers on the first. An implementation that tries fewer cannot reach one or the other.

The document's `issuer` must equal `OAUTH_ISSUER` **exactly**, or it is rejected — that check is
the mitigation for a metadata document served from one host claiming to be another. Its `jwks_uri`
must be `https://` (a loopback host excepted), like a configured one: whoever answers that URL
decides which tokens are genuine. A provider that publishes an `http://` key URL fails the startup;
set `OAUTH_JWKS_URI` to the https address of its keys.

Discovery runs **once, at boot**. A wrong issuer therefore fails immediately with the list of URLs
tried, rather than turning into a puzzling 401 on the first real request hours later.

```
Could not discover authorization server metadata for "https://…". Tried:
  https://…/.well-known/oauth-authorization-server
  https://…/.well-known/openid-configuration
Set OAUTH_JWKS_URI to skip discovery.
```

### 2. Explicit — set `OAUTH_JWKS_URI` as well

Discovery is skipped entirely; the URL is used as given. Reach for this when:

- the IdP publishes metadata somewhere the probe order does not look;
- a proxy or firewall blocks the `.well-known` path but not the keys endpoint;
- you want no startup dependency on the discovery endpoint being reachable;
- you are pinning to a specific keys URL for change control.

**Security is unchanged.** The token's `iss` claim is still validated against `OAUTH_ISSUER`, and
its `aud` against `OAUTH_AUDIENCE`. Skipping discovery skips *finding* the keys, not *checking*
the token — the only thing lost is the metadata document's own issuer cross-check, which is
irrelevant when you supplied the URL yourself.

| | Discovery | Explicit `OAUTH_JWKS_URI` |
|---|---|---|
| Config | issuer only | issuer + keys URL |
| Startup | one network call, fails fast | no network call |
| IdP moves its keys | picked up on restart | breaks until you update it |
| Unusual metadata layout | may fail | works |

### JWKS URLs, if you are setting them explicitly

| IdP | `OAUTH_JWKS_URI` |
|---|---|
| Entra ID | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys` |
| Zitadel | `https://<instance>/oauth/v2/keys` |
| Okta | `https://<org>.okta.com/oauth2/<authServerId>/v1/keys` |
| Keycloak | `https://<host>/realms/<realm>/protocol/openid-connect/certs` |
| Auth0 | `https://<tenant>.auth0.com/.well-known/jwks.json` |

In both modes the key set is **fetched lazily on the first token and cached**, and refetched when a
token arrives with an unknown `kid` — which is what makes signing-key rotation at the IdP a
non-event rather than an outage. An **IdP outage** is not one either: a refresh that fails falls
back to the last key set that loaded, and is retried with a backoff (30 s, doubling to 5 min) rather
than on every request. Only a token signed by a key that set does not hold is refused meanwhile —
with a 503 rather than a 401, so clients do not start re-authenticating.

---

## Which claim names the person

A signed-in conversation pins itself from the token, so the token has to name somebody Ivanti
knows. By default the server tries `email` — **only when the token also carries
`email_verified: true`** — then `preferred_username`, then `upn`, and looks the value up against
Ivanti's employees and external contacts. An unverified `email` is skipped because on some IdPs
(Keycloak's account console, Auth0 with self-signup, Entra optional claims for guests) a user can
set it to a colleague's address and be signed in as them — and, with impersonation, be given
Ivanti's own session as them.

Entra and Zitadel access tokens often carry no `email_verified`, so they fall through to the next
claim. When the provider puts the person's identifier somewhere else, set `OAUTH_IDENTITY_CLAIM`.
It is used as-is, so it must be a claim users **cannot edit** in their own profile. Never `sub`:
it names the token, and Entra's is an opaque pairwise id that appears nowhere in Ivanti.

---

## Deployment shapes

**Local desktop client** — the default; needs nothing else.
```bash
STDIO_TRANSPORT_ON=true
```

**Internal HTTP service, shared token**
```bash
STDIO_TRANSPORT_ON=false
HTTP_TRANSPORT_ON=true
AUTH_MODE=bearer
BEARER_TOKEN_FILE=/run/secrets/bearer-token
MCP_PORT=3000                                    # no default; keep it equal to the port in MCP_PUBLIC_URL and the publish
MCP_PUBLIC_URL=https://mcp.example.com/mcp
TRUSTED_ORIGINS=https://claude.ai
```
Size the token's audience to the tool surface behind it. A token given to a multi-user client
grants that surface to **everyone** who can use the connector — pair a widely shared token with
`MCP_MODE=enduser`. The token must be at least 32 characters, or the server refuses to start;
`openssl rand -base64 32` makes one.

**Trusted network, no authentication**
```bash
AUTH_MODE=none
MCP_BIND=0.0.0.0        # loopback by default; exposing it is a second, deliberate act
TRUSTED_ORIGINS=https://claude.ai
```
`TRUSTED_ORIGINS` still matters here — it is the *only* control left. Origin validation is what
stops a page the user merely visits from driving this server from inside the network.

`AUTH_MODE=none` on a non-loopback bind starts, with a warning at startup: inside a container
`0.0.0.0` is the ordinary bind, and whether it reaches a network is decided by how the port is
published — `-p 127.0.0.1:3000:3000` keeps it on the host.

**Behind a reverse proxy** — set `MCP_PUBLIC_URL` to the externally visible URL. It is never
derived from the request, because the proxy rewrites Host and scheme while the OAuth token audience
and RFC 9728 metadata must still match exactly. The server keeps an idle connection open for 65 s,
longer than the 60 s an AWS ALB or the nginx ingress keeps one upstream; a proxy set to keep
upstream connections idle for longer than that will reuse closed ones and answer a sporadic 502.

**Many people over HTTP** — `MCP_MAX_SESSIONS` (default 100) caps the sessions held at once.
Clients routinely abandon a session without closing it, so at the cap a new one closes the least
recently used session that has had no traffic for 60 s and nothing in flight; it is refused with
`503` and a `Retry-After` only when every session is busy. Under `AUTH_MODE=oauth`,
`MCP_MAX_SESSIONS_PER_SUBJECT` also caps what one signed-in person holds, closing their own least
recently used session rather than refusing the new one. It is refused under `none` and `bearer`, where every
caller is the same subject, and above `MCP_MAX_SESSIONS`. Sessions live in the process, so a
deployment is **one instance**.

**Employees, not IT staff** — set `MCP_MODE=enduser` along with the `ENDUSER_*` settings. `full` is
the default and ignores every `ENDUSER_*` setting, so any of them set while the mode is `full`
refuses to start: the alternative is an employee deployment that serves the whole IT-staff surface
because one line was forgotten.

**Scraped by Prometheus** — off by default; a port of its own, never the MCP one.
```bash
METRICS_ON=true
METRICS_BIND=0.0.0.0                              # loopback by default; 0.0.0.0 in a container or pod
METRICS_PORT=9464
METRICS_TOKEN_FILE=/run/secrets/metrics-token     # optional; set it once the port is reachable from beyond the machine
```
Leave it off on an internet-facing deployment unless something private scrapes it, and never route
the metrics port through the proxy or ingress in front of MCP. `METRICS_ON=false` ignores every
other `METRICS_*` setting, so the one line turns metrics off. What each shape publishes, and what
is served, is in [`deployment.md`](./deployment.md) and the Handbook's *Watching it*.

---

## The licence

Every configuration also needs **`LICENSE_KEY`** (or `LICENSE_KEY_FILE`), the Synergy Hub licence
key, and over HTTP **`LICENSE_INSTALL_ID`**, a UUID made once for the installation and never
changed. The server activates with the Hub at `https://hub.itsmcloud.lt` and confirms the licence
every 4 minutes, so it needs outbound HTTPS to it, through the same proxy settings as the tenant
([Reaching Ivanti](#reaching-ivanti)). Unlicensed, it starts and refuses every tool, each refusal
saying why. Where to keep the install ID and the last confirmed licence, shape by shape, is in
[`deployment.md`](./deployment.md#licensing).

## Reaching Ivanti

**Over https.** `IVANTI_BASE_URL` and `IVANTI_CONFIG_URL` carry an API key with every request;
`OAUTH_ISSUER` and `OAUTH_JWKS_URI` decide which tokens are trusted. All four must be `https://`.
Plain `http://` is accepted only for a loopback host — `localhost`, `127.0.0.0/8`, `::1` — which is
what a local mock or a `kubectl port-forward` looks like.

**Through an egress proxy.** Node's built-in `fetch` **ignores `HTTPS_PROXY`** unless
`NODE_USE_ENV_PROXY=1` is set as well (Node 22.21 or later). Without it the server tries to reach
the tenant directly, and the startup fails with a DNS or connection error that reads like a wrong
URL:

```bash
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://proxy.corp.example:3128
NO_PROXY=localhost,127.0.0.1
```

`NO_PROXY` matters with `AUTH_MODE=oauth` when the IdP is internal, and for the container's own
health check.

**Through a TLS-intercepting proxy.** A proxy that re-signs traffic with a corporate root CA makes
every request fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`. Add the
root to Node's trust store rather than turning verification off:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-root-ca.pem   # PEM; mount it into the container
```

It is read once, at process start. Never reach for `NODE_TLS_REJECT_UNAUTHORIZED=0` instead: it
makes the error go away along with the only thing that proves the other end is the tenant, for the
API key and every record that crosses.

**Timeouts.** Two, because reads and writes fail differently:

| Setting | Default | Covers |
|---|---|---|
| `IVANTI_TIMEOUT_MS` | `10000` | every OData/REST GET, `$metadata`, the startup probe |
| `IVANTI_WRITE_TIMEOUT_MS` | `30000` | every create, update, delete, link and upload — and the whole ASMX session (forms, pick lists, quick actions), which POSTs whether it reads or writes, and CentralConfig |

A create runs the tenant's workflow before it answers, which on a workflow-heavy object takes
longer than a read ever should. A write that times out **may still have been applied** — the model
is told exactly that, and to check before retrying rather than file it twice. If
`no answer within 30000 ms` appears on writes that did take effect, raise the write timeout. Both
must be within 1000–300000, and the write timeout may not be the shorter of the two.

**The schema is read once.** Each `$metadata` graph is cached for the life of the process, with no
expiry — so a field or a Business Object added in Ivanti after the server started is unknown to it
(`no Business Object named …`, or a field refused by name) until it **restarts**. A failure to read
the schema is *not* cached: a timeout, a 5xx, a refused key, or a login or WAF page answering in
Ivanti's place is asked again on the next call.

**A note on every change.** `WRITE_AUDIT_NOTE` is `required` unless set to `off`. With it, the five
tools that change a record (`update_record`, `delete_record`, `link_records`, `unlink_records`,
`run_quick_action`) take a `justification`, and the server writes it onto the record as an
**internal** journal note once the change is confirmed. The note is authored by the account the
Ivanti API key was issued for — never by the person `act_as` named, who appears in its body as the
one who asked. Turning it off removes the argument from the tools. A model client that cached the
tool list before the change will be refused until it reconnects, because the argument is required.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Access token is opaque, not a JWT` | The IdP is issuing reference tokens. Zitadel per-app default, Okta org authorization server, or Auth0 without an `audience` parameter. |
| `Access token was not issued for this server` | `OAUTH_AUDIENCE` mismatch — almost always the first thing to check. Decode the token and read its real `aud`. |
| `Access token was signed by an unknown key` | JWKS problem, or the issuer is not who you configured. |
| `Could not discover authorization server metadata` | Wrong `OAUTH_ISSUER`, or the IdP publishes metadata somewhere the spec's probe order does not look — set `OAUTH_JWKS_URI` to skip discovery. |
| Startup exits `78` | Incomplete configuration. Every problem is listed; fix them all. |
| `LICENSE_KEY (or LICENSE_KEY_FILE) is required`, exit `78` | Every installation needs its Synergy Hub licence key. Under the chart, the Secret needs the key `licence-key`. Upgrading from 0.3.x, add it first. |
| `LICENSE_INSTALL_ID (or LICENSE_INSTALL_ID_FILE) is required over HTTP`, exit `78` | Over HTTP the server cannot keep an identity of its own, and a new one every start would take a new seat every start. Generate one once (`node -e "console.log(crypto.randomUUID())"`) and keep it with the other settings. The chart derives one itself. |
| `LICENSE_INSTALL_ID is not set, and none could be kept in …`, exit `78` | Under stdio, the server generates its install ID into `LICENSE_STATE_DIR` or the config folder, and could write neither — typically `docker run -i` with a read-only root. Mount a volume at `LICENSE_STATE_DIR`, or set `LICENSE_INSTALL_ID`. |
| Every tool answers *"This server is not licensed, so it cannot run …"* | The licence is not confirmed; the rest of the sentence is the reason, and the log line `licence: not licensed` carries it too. `does not recognise the licence key`: check `LICENSE_KEY`. `every seat of this licence is in use`: a seat is taken by another installation, or by this one under an earlier install ID — free it in the Hub. `Could not reach the Synergy Hub …`: outbound HTTPS to `hub.itsmcloud.lt`, or the proxy. |
| `licence: the Synergy Hub cannot be reached; running on grace` at **warn** | Nothing is refused yet. The server keeps working on the last confirmed licence until `graceEndsAt`, 30 days from when the Hub last signed it. Restore the route to the Hub before then. |
| `licence: no LICENSE_STATE_DIR; the 30 days … last only while this process runs` at **warn** | HTTP outside Kubernetes with nowhere to keep the licence: a restart during a Hub outage would start unlicensed. Set `LICENSE_STATE_DIR` to a writable folder (a volume, in a container). |
| `LICENSE_STATE_SECRET is set but no Kubernetes service-account token is mounted` at **warn** | The chart turns the pod's token on with `license.keepState`; something (a policy, a mutating webhook, a hand-written manifest) turned it off. Offline restart is off until it is mounted. |
| Each `docker run -i` takes another licence seat | A fresh container each time, with nowhere to keep the generated install ID. Mount `-v ivanti-mcp-licence:/var/lib/ivanti-mcp` with `LICENSE_STATE_DIR=/var/lib/ivanti-mcp`, or set `LICENSE_INSTALL_ID`. |
| `… is set, but MCP_MODE is full` | An `ENDUSER_*` setting in a `full` deployment, which would ignore it. Set `MCP_MODE=enduser` if the deployment is for employees; otherwise remove the setting. |
| `… must use https://` | A URL that carries a key or decides which tokens are trusted was given as `http://`. Only a loopback host may use plain http. |
| `BEARER_TOKEN is N characters` | Under 32. Generate one with `openssl rand -base64 32`. |
| `MCP_PORT is required for HTTP transports`, exit `78` | There is no default port. Set `MCP_PORT`, and keep it equal to the port in `MCP_PUBLIC_URL`, the client's URL and whatever publishes or proxies it. Under `pnpm dev`, `.env` is read once at start: restart after editing it. |
| `METRICS_PORT is required with METRICS_ON=true`, exit `78` | No default here either. Set `METRICS_PORT` to the port your scraper targets, or `METRICS_ON=false`. |
| `METRICS_PORT and MCP_PORT are both N` | Metrics have a port of their own so nothing in front of the MCP port reaches them. Give `METRICS_PORT` another one — or `METRICS_ON=false`, which ignores every other `METRICS_*` setting. |
| `METRICS_TOKEN is N characters` / `METRICS_TOKEN is the same as …` | The scrape token must be at least 32 characters and a secret of its own — never `BEARER_TOKEN` or an Ivanti key, which whatever scrapes would then hold. `openssl rand -base64 32`. |
| `cannot listen for metrics`, exit `1` | `METRICS_PORT` is taken — under stdio, often by another client's copy of the server, each claiming the same port — or `METRICS_BIND` is not an address of this host. |
| `metrics listen beyond this machine with no token` at **warn** | `METRICS_BIND` is not loopback and no `METRICS_TOKEN` is set. Expected in a container published on the host's `127.0.0.1`, or a pod behind a NetworkPolicy: the server sees only its own bind. Otherwise set a token. |
| `/metrics` answers `403` in a browser | By design: a request with `Origin` or `Sec-Fetch-Site` is a browser's, refused so a web page cannot read metrics through DNS rebinding. Use `curl` or Prometheus. |
| `/metrics` answers `401` | `METRICS_TOKEN` is set and the scraper sent none, or another. Prometheus: `authorization: { credentials_file: … }` pointing at a copy of the same token. |
| `<setting> is set, but AUTH_MODE is …, which never reads it` | `BEARER_TOKEN` outside `AUTH_MODE=bearer`, or any `OAUTH_*` outside `oauth`: a leftover from the mode you moved away from. Remove it, or set the mode that reads it. |
| `IVANTI_MAX_TIER is set, but no tenant is configured` / `IVANTI_IMPERSONATION_ROLE is set, but impersonation is not configured` | The setting would sit there looking as though it did something. Configure the tenant, or the ConfigDB pair, or remove it. |
| `<KEY>_FILE points at …, which could not be read` | The path is unreadable (permissions, mount); the message names the setting that pointed at it. |
| `IVANTI_MAX_CONCURRENT_REQUESTS … is outside 1–256` / `MCP_MAX_CALLS_PER_MINUTE … is outside 1–10000` | Out of the range that protects the tenant without stopping it. |
| `OAUTH_REQUIRED_SCOPES carries …, which cannot appear in a WWW-Authenticate header` | A quote, backslash or non-ASCII character in a scope or in `MCP_PUBLIC_URL`; the 401 challenge would advertise another value than configured. |
| The tenant refused the API key at startup, exit `78` | A 401/403 from the base-path probe is a setting to correct (`IVANTI_API_KEY`), not an outage, so a supervisor does not retry it forever. |
| `Ivanti's $metadata could not be read just now` | A transient outage: nothing was changed and the answer says nothing about the object's name. Try again. |
| `MCP_MAX_SESSIONS_PER_SUBJECT needs AUTH_MODE=oauth` | Only a verified token names a subject; under `none` and `bearer` every caller is the same one. Remove it, or use `oauth`. |
| `Authorization server metadata at … names the signing keys at "http://…"` | The IdP's discovery document publishes its keys over plain http. Set `OAUTH_JWKS_URI` to their https address. |
| `the IdP signing keys could not be refreshed; verifying with the last good set` at **warn** | The IdP is unreachable. Tokens keep verifying against the keys already loaded; one signed by a key those lack answers 503 until the IdP is back. |
| `Could not reach Ivanti … (fetch failed: getaddrinfo ENOTFOUND …)` | The hostname does not resolve from where the server runs — a typo in `IVANTI_BASE_URL`, or an egress proxy that `fetch` is not using: set `NODE_USE_ENV_PROXY=1` ([Reaching Ivanti](#reaching-ivanti)). |
| `fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | A TLS-intercepting proxy. Mount its root CA and point `NODE_EXTRA_CA_CERTS` at it. |
| `ivanti unavailable` at **warn** | Ivanti did not answer (`status` 0), answered 5xx, or refused the key (401). When it did not answer, the line's `code` — `ENOTFOUND`, `ECONNRESET`, `TimeoutError`, a certificate code — says why; `LOG_LEVEL=debug` adds the full reason. |
| Writes report `no answer within 30000 ms`, yet took effect | The tenant's workflow outlasts `IVANTI_WRITE_TIMEOUT_MS`. Raise it. |
| A field or object added in Ivanti is unknown to the server | The schema is cached for the life of the process. Restart it. |
| New connections get `503 Too many active sessions` with a `Retry-After` | Every one of `MCP_MAX_SESSIONS` sessions has had traffic in the last 60 s or has a request running, so none could be closed to make room. Raise `MCP_MAX_SESSIONS`. |
| A client reconnects after a short pause and the conversation starts over, and the log shows `session evicted` | The server was at `MCP_MAX_SESSIONS` and closed the least recently used idle session for a newcomer (`reason: cap`), or the person went over `MCP_MAX_SESSIONS_PER_SUBJECT` (`reason: subject limit`). Raise the limit. |
| Sporadic 502 from the load balancer, with nothing in the server's log | The proxy keeps idle upstream connections open longer than the server's 65 s and reuses one the server has closed. Set the proxy's upstream keep-alive below 65 s. |
| `MCP_PUBLIC_URL must not end with a trailing slash` | The resource identifier is compared verbatim against the token audience. |
| Client keeps registering new apps | It is using DCR. Pin it with `--client-id`, and remember a **running client reads its config at startup** — restart it. |
| Everything looks right, still 401 | Cached credentials from before the fix. Clear the client's stored authentication and re-authenticate. |
| Container starts, then exits | `package.json` is missing next to `dist/`. The server refuses to report a placeholder version. |
| Every tool answers *"I do not know who you are yet"* | Working as configured: `act_as` gates every other tool, in both modes. Call it with the name, email or login of the person being helped. |
| Tools that worked start refusing on identity mid-session | The conversation went quiet for longer than `MCP_IDENTITY_IDLE_TTL_SECONDS` (default 1800) and ended, which is how a stdio process ends one at all. Call `act_as` again; the log line is `conversation ended; identity forgotten`. Raise the setting if the window is too short for how people work. |
| Signing in works, but every tool still refuses on identity | The token is valid and Ivanti holds no record for that person. The server logs `the signed-in account matches nobody in ivanti` at **warn**, with the claim it looked up — create that employee record, or point `OAUTH_IDENTITY_CLAIM` at the claim that does match. |
| Signed in, but `act_as` says the token names nobody | The token's `email` is not marked `email_verified: true`, so the default claim order skipped it (an unverified email can be set by the user). Set `OAUTH_IDENTITY_CLAIM` to an immutable, admin-controlled claim. |
| A reference document reads *"Not yet"* | The same gate: `ivanti://reference/…` answers what the tools answer, so it serves the document once somebody is pinned. |
| `Ivanti has no enabled user named X` from `act_as` | **Not a typo in the login.** CentralConfig only opens a session for an account whose `Disabled` bit is clear, and `Disabled` is a *different field from* `Status` — every account here read `Status: Active` while disabled. Enable the account in Ivanti. |
| `impersonation configured but unavailable` at startup | The ConfigDB answered 401 (wrong `IVANTI_CENTRAL_CONFIG_API_KEY` — it comes from Configure → Security Controls → API Keys, `CentralConfigApiKey` group, and is **not** the tenant API key) or could not be reached. The server keeps running with `act_as` in its ordinary meaning. |
| `IVANTI_IMPERSONATION_REQUIRED=true, but impersonation is unavailable`, exit `78` | The same failure as the row above, with the setting that makes it fatal. Fix the ConfigDB pair, or unset the setting to run as the service account. Without the pair configured at all it is refused as `IVANTI_IMPERSONATION_REQUIRED=true needs IVANTI_CONFIG_URL …`. |
| `the person's ivanti session could not be re-opened` at **warn** | The person's Ivanti session ended (a 401, or past its `SessionKeyExpire`) and CentralConfig would not open another. Nothing is sent as the service account instead; the next call tries again. |
| Impersonation is on, but every `act_as` fails | The startup probe validates the key, **not** the tenant: `GetTenantTimeout` answers 200 with a default for a tenant it has never heard of. Check `IVANTI_BASE_URL`'s hostname is the tenant CentralConfig knows. |
| A form, pick-list or quick-action call answers **551** while impersonating | The session was never activated: `Session.asmx/SelectRole` must be called after `InitializeSession` — even naming the role it already reported — or every `Workspace.asmx` and service-catalog method refuses. The server always calls it, so a 551 here means that changed. |

At `LOG_LEVEL=debug` every MCP request logs its method, tool, session and authenticated subject,
and every Ivanti request logs its path, query, status and duration — with Ivanti's own error body
when it fails, stamped with the `tool`, `sessionId` and `rpcId` that caused it. That answers most of
the above directly. **Debug carries personal data** (a `$filter` names people), so turn it on to
diagnose rather than leaving it on. Tool arguments and the values of a write are never logged; the
one exception is what a write touched — its object, relationship and `…Id` arguments — on its
`tool called` audit line at `info`, so "who deleted incident X" has an answer.
