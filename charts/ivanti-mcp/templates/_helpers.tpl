{{- define "ivanti-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Resource name. A release whose name already carries the chart name is used as-is,
so `helm install ivanti-mcp` yields `ivanti-mcp` rather than `ivanti-mcp-ivanti-mcp`
and `ivanti-mcp-selfservice` stays itself — one release is one audience, and the
audience belongs in the release name. Anything else is prefixed as usual.
*/}}
{{- define "ivanti-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "ivanti-mcp.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ivanti-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "ivanti-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ivanti-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ivanti-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ivanti-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ivanti-mcp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
  The metrics Service and ServiceMonitor. The base is cut to 55 so the suffix always
  survives: truncating "-metrics" away instead would give the metrics Service the
  main Service's name — the one the Ingress routes to.
*/}}
{{- define "ivanti-mcp.metricsName" -}}
{{- printf "%s-metrics" (include "ivanti-mcp.fullname" . | trunc 55 | trimSuffix "-") -}}
{{- end -}}

{{- define "ivanti-mcp.metricsLabels" -}}
{{ include "ivanti-mcp.selectorLabels" . }}
app.kubernetes.io/component: metrics
{{- end -}}

{{/*
  This installation's identity to the Synergy Hub (design §9f): license.installId when given,
  otherwise a UUID derived from the namespace and release name. Derived, never generated: Helm's
  `lookup` answers nothing under `helm template` and Argo CD, so a random value kept in a Secret
  would be a new one on every such render, and a new licence seat with it. The version and
  variant digits are forced so the server's UUID check accepts it.
*/}}
{{- define "ivanti-mcp.installId" -}}
{{- if .Values.license.installId -}}
{{- .Values.license.installId -}}
{{- else -}}
{{- $h := sha256sum (printf "ivanti-mcp-standalone/%s/%s" .Release.Namespace .Release.Name) -}}
{{- printf "%s-%s-4%s-8%s-%s" (substr 0 8 $h) (substr 8 12 $h) (substr 13 16 $h) (substr 17 20 $h) (substr 20 32 $h) -}}
{{- end -}}
{{- end -}}

{{/*
  The Secret that keeps the last licence token, and its Role and RoleBinding. Cut to 49 so the
  suffix always survives, as for the metrics Service.
*/}}
{{- define "ivanti-mcp.licenceStateName" -}}
{{- printf "%s-licence-state" (include "ivanti-mcp.fullname" . | trunc 49 | trimSuffix "-") -}}
{{- end -}}

{{- define "ivanti-mcp.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "ivanti-mcp.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
  Whether the NetworkPolicy renders: "true" or "false". `auto` means exactly when
  authMode is none — the one mode where nothing else stands in front of the pod.
*/}}
{{- define "ivanti-mcp.networkPolicyEnabled" -}}
{{- $v := toString .Values.networkPolicy.enabled -}}
{{- if eq $v "auto" -}}
{{- eq .Values.server.authMode "none" -}}
{{- else if or (eq $v "true") (eq $v "false") -}}
{{- $v -}}
{{- else -}}
{{- fail (printf "networkPolicy.enabled must be auto, true or false (got %q)." $v) -}}
{{- end -}}
{{- end -}}

{{/*
  A URL the server will only fetch over TLS. Plain http is refused except to
  loopback — which in a pod means a sidecar, the one case it can be right.
  Called with (list "<value name>" <url>); empty passes, other guards own "required".
*/}}
{{- define "ivanti-mcp.requireHttps" -}}
{{- $name := index . 0 -}}
{{- $url := index . 1 | default "" | toString -}}
{{- if and $url (not (regexMatch "^https://" $url)) (not (regexMatch "^http://(localhost|127\\.[0-9]+\\.[0-9]+\\.[0-9]+|\\[::1\\])(:[0-9]+)?(/|$)" $url)) -}}
{{- fail (printf "%s must be an https:// URL (got %q). The server refuses plain http to anything but loopback: anyone on the path could read the API key, or swap the keys every token is verified against." $name $url) -}}
{{- end -}}
{{- end -}}

{{/*
  Whether an optional value was given: "true" or "" (empty). Helm's `with` and `if` treat a
  numeric 0 as unset, so `--set x=0` silently fell back to the server default and no range
  rule could see it; this tests for absence, not falsiness.
*/}}
{{- define "ivanti-mcp.isSet" -}}
{{- if and (not (kindIs "invalid" .)) (ne (toString .) "") -}}true{{- end -}}
{{- end -}}

{{/*
  A whole number inside [min, max] when given. Called with (list "<value name>" <value> <min> <max>);
  the bounds are the server's own (validate-config.ts), and scripts/check-chart.mjs holds the
  chart to the server's verdict at both edges.
*/}}
{{- define "ivanti-mcp.requireRange" -}}
{{- $name := index . 0 -}}
{{- $v := index . 1 -}}
{{- if include "ivanti-mcp.isSet" $v -}}
{{- if or (not (regexMatch "^[0-9]+$" (toString $v))) (lt (int64 $v) (int64 (index . 2))) (gt (int64 $v) (int64 (index . 3))) -}}
{{- fail (printf "%s=%s is outside %d-%d. The server refuses the same at boot." $name (toString $v) (int64 (index . 2)) (int64 (index . 3))) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
  Refusals, evaluated before anything renders.

  The server itself fails closed and exits 78 on an incomplete configuration. Doing
  the same here moves the failure from a pod crash-looping at 03:00 to `helm install`
  answering immediately — which is the whole point of a chart having opinions.
*/}}
{{- define "ivanti-mcp.validate" -}}
{{- if not .Values.server.publicUrl -}}
{{- fail "server.publicUrl is required: it is matched verbatim against the OAuth token audience and the RFC 9728 metadata document, and is never derived from the request." -}}
{{- end -}}
{{- if contains "#" .Values.server.publicUrl -}}
{{- fail "server.publicUrl must not contain a fragment — it is the OAuth resource identifier, compared verbatim." -}}
{{- end -}}
{{- if hasSuffix "/" .Values.server.publicUrl -}}
{{- fail "server.publicUrl must not end with a trailing slash — the resource identifier is compared verbatim, and a stray slash surfaces as a client bug." -}}
{{- end -}}
{{- if not .Values.server.trustedOrigins -}}
{{- fail "server.trustedOrigins is required: origin validation is mandatory on every HTTP mode and is what stops DNS rebinding." -}}
{{- end -}}
{{- if not .Values.ivanti.baseUrl -}}
{{- fail "ivanti.baseUrl is required." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.create) -}}
{{- fail "Set secrets.existingSecret (recommended), or secrets.create=true with secrets.ivantiApiKey for development." -}}
{{- end -}}
{{- if and .Values.secrets.create (not .Values.secrets.ivantiApiKey) -}}
{{- fail "secrets.create=true needs secrets.ivantiApiKey." -}}
{{- end -}}
{{- if and .Values.secrets.create (not .Values.secrets.licenceKey) -}}
{{- fail "secrets.create=true needs secrets.licenceKey: the Synergy Hub licence key. (With secrets.existingSecret, the Secret needs the key licence-key.)" -}}
{{- end -}}
{{- with .Values.license.installId -}}
{{- if not (regexMatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" (toString .)) -}}
{{- fail (printf "license.installId must be a UUID (got %q). Generate one: node -e \"console.log(crypto.randomUUID())\"" (toString .)) -}}
{{- end -}}
{{- end -}}
{{- with .Values.license.hubUrl -}}
{{- if not (hasPrefix "https://" (toString .)) -}}
{{- fail (printf "license.hubUrl must be https (got %q): the licence key travels with every heartbeat. The server refuses the same." (toString .)) -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.server.authMode (list "none" "bearer" "oauth")) -}}
{{- fail (printf "server.authMode must be none, bearer or oauth (got %q)." (toString .Values.server.authMode)) -}}
{{- end -}}
{{- if not (has .Values.server.mode (list "full" "enduser")) -}}
{{- fail (printf "server.mode must be full or enduser (got %q)." (toString .Values.server.mode)) -}}
{{- end -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail "replicaCount must be 1. HTTP sessions are held in memory, one server per Mcp-Session-Id, and the pod that answers `initialize` mints the id — so the request that opens a session carries nothing a load balancer can route back by, and a second pod answers part of every conversation with \"unknown session\". See docs/deployment.md, Kubernetes." -}}
{{- end -}}
{{- if (.Values.sessionAffinity | default dict).enabled -}}
{{- fail "sessionAffinity is gone: hashing on Mcp-Session-Id cannot route a session back to the pod that created it, because `initialize` carries no id yet. Remove it; the chart runs one replica. See docs/deployment.md, Kubernetes." -}}
{{- end -}}
{{- if eq .Values.server.mode "enduser" -}}
{{- if not .Values.server.enduser.businessObjects -}}
{{- fail "server.mode=enduser needs server.enduser.businessObjects. Empty is a gate that allows nothing, which is fail-closed but almost certainly not what you meant." -}}
{{- end -}}
{{- else -}}
{{- with .Values.server.enduser -}}
{{- if or .businessObjects .quickActions .role -}}
{{- fail "server.enduser.* applies to mode=enduser only. In a full deployment it would be a gate that gates nothing — the server refuses ENDUSER_* settings under MCP_MODE=full for the same reason. Remove them, or set server.mode=enduser." -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- include "ivanti-mcp.requireHttps" (list "ivanti.baseUrl" .Values.ivanti.baseUrl) -}}
{{- include "ivanti-mcp.requireHttps" (list "ivanti.configUrl" .Values.ivanti.configUrl) -}}
{{- if eq .Values.server.authMode "oauth" -}}
{{- include "ivanti-mcp.requireHttps" (list "oauth.issuer" .Values.oauth.issuer) -}}
{{- include "ivanti-mcp.requireHttps" (list "oauth.jwksUri" .Values.oauth.jwksUri) -}}
{{- end -}}
{{- if eq .Values.server.authMode "oauth" -}}
{{- if not .Values.oauth.issuer -}}
{{- fail "server.authMode=oauth needs oauth.issuer." -}}
{{- end -}}
{{- end -}}
{{- if and .Values.ivanti.configUrl (not .Values.secrets.existingSecret) (not .Values.secrets.centralConfigApiKey) -}}
{{- fail "ivanti.configUrl needs the ConfigDB key: set secrets.centralConfigApiKey, or provide it in secrets.existingSecret under the key ivanti-central-config-api-key." -}}
{{- end -}}
{{- if and .Values.ivanti.impersonationRole (eq .Values.server.mode "enduser") -}}
{{- fail "ivanti.impersonationRole applies to server.mode=full; an enduser deployment opens the role server.enduser.role names." -}}
{{- end -}}
{{- if and (eq .Values.server.authMode "bearer") (not .Values.secrets.existingSecret) (not .Values.secrets.bearerToken) -}}
{{- fail "server.authMode=bearer needs a bearer token: set secrets.bearerToken, or provide it in secrets.existingSecret under the key bearer-token." -}}
{{- end -}}
{{- if and (eq .Values.server.authMode "bearer") (not .Values.secrets.existingSecret) .Values.secrets.bearerToken (lt (len (toString .Values.secrets.bearerToken)) 32) -}}
{{- fail "secrets.bearerToken must be at least 32 characters — the server refuses a shorter one. Generate it: openssl rand -hex 32" -}}
{{- end -}}
{{- if eq .Values.server.authMode "none" -}}
{{- if .Values.ingress.enabled -}}
{{- fail "server.authMode=none with an ingress publishes the entire tool surface unauthenticated. If that is genuinely intended, put the authentication in front of it and leave the ingress off here." -}}
{{- end -}}
{{- if has .Values.service.type (list "LoadBalancer" "NodePort") -}}
{{- fail (printf "server.authMode=none with service.type=%s publishes the entire tool surface unauthenticated beyond the cluster, just as an ingress would. Keep service.type=ClusterIP, or choose bearer or oauth." .Values.service.type) -}}
{{- end -}}
{{- end -}}
{{- $sub := .Values.server.maxSessionsPerSubject -}}
{{- if include "ivanti-mcp.isSet" $sub -}}
{{- if ne .Values.server.authMode "oauth" -}}
{{- fail "server.maxSessionsPerSubject needs server.authMode=oauth: only a verified token names a subject, and without one every caller counts as the same person. The server refuses the same." -}}
{{- end -}}
{{- if gt (int64 $sub) (int64 .Values.server.maxSessions) -}}
{{- fail (printf "server.maxSessionsPerSubject=%s is above server.maxSessions=%v, so it could never apply. The server refuses the same." (toString $sub) .Values.server.maxSessions) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.ivanti.impersonationRequired (not .Values.ivanti.configUrl) -}}
{{- fail "ivanti.impersonationRequired=true needs ivanti.configUrl (and its key): requiring what was never configured would start, then refuse at the probe. The server refuses the same." -}}
{{- end -}}
{{- /* The bounds are validate-config.ts's TIMEOUT_BOUNDS_MS and its two inline ranges. */ -}}
{{- include "ivanti-mcp.requireRange" (list "ivanti.timeoutMs" .Values.ivanti.timeoutMs 1000 300000) -}}
{{- include "ivanti-mcp.requireRange" (list "ivanti.writeTimeoutMs" .Values.ivanti.writeTimeoutMs 1000 300000) -}}
{{- include "ivanti-mcp.requireRange" (list "ivanti.maxConcurrentRequests" .Values.ivanti.maxConcurrentRequests 1 256) -}}
{{- include "ivanti-mcp.requireRange" (list "server.maxCallsPerMinute" .Values.server.maxCallsPerMinute 1 10000) -}}
{{- /* Effective values: an unset one is the server default, and a write must never get less time than a read. */ -}}
{{- $readMs := ternary (int64 .Values.ivanti.timeoutMs) (int64 10000) (eq (include "ivanti-mcp.isSet" .Values.ivanti.timeoutMs) "true") -}}
{{- $writeMs := ternary (int64 .Values.ivanti.writeTimeoutMs) (int64 30000) (eq (include "ivanti-mcp.isSet" .Values.ivanti.writeTimeoutMs) "true") -}}
{{- if lt $writeMs $readMs -}}
{{- fail (printf "ivanti.writeTimeoutMs (%d) is shorter than ivanti.timeoutMs (%d). A write runs the tenant's workflow before it answers, and one cut off may still have been applied; leave the one you did not mean to change unset only if its default (10000 read, 30000 write) fits. The server refuses the same." $writeMs $readMs) -}}
{{- end -}}
{{- $_ := include "ivanti-mcp.networkPolicyEnabled" . -}}
{{- include "ivanti-mcp.validateMetrics" . -}}
{{- end -}}

{{/*
  Metrics refusals. Off, the other metrics.* values are ignored rather than refused,
  as the server ignores METRICS_* under METRICS_ON=false — turning metrics off is the
  one toggle. The ServiceMonitor is the exception: it is a separate object, and one
  that scrapes nothing would sit there looking like monitoring.
*/}}
{{- define "ivanti-mcp.validateMetrics" -}}
{{- $m := .Values.metrics -}}
{{- if and $m.serviceMonitor.enabled (not $m.enabled) -}}
{{- fail "metrics.serviceMonitor.enabled needs metrics.enabled: with metrics off there is no listener and no Service for it to scrape." -}}
{{- end -}}
{{- if $m.enabled -}}
{{- if eq (int $m.port) (int .Values.server.port) -}}
{{- fail (printf "metrics.port and server.port are both %d. Metrics have a port of their own so that nothing in front of the MCP port — the ingress, a tunnel — reaches them; give metrics.port another one. The server refuses the same." (int $m.port)) -}}
{{- end -}}
{{- if and $m.token (not .Values.secrets.existingSecret) -}}
{{- $t := toString (.Values.secrets.metricsToken | default "") -}}
{{- if not $t -}}
{{- fail "metrics.token=true needs a scrape token: set secrets.metricsToken, or provide it in secrets.existingSecret under the key metrics-token." -}}
{{- end -}}
{{- if lt (len $t) 32 -}}
{{- fail "secrets.metricsToken must be at least 32 characters — the server refuses a shorter one. Generate it: openssl rand -hex 32" -}}
{{- end -}}
{{- range $k := list "ivantiApiKey" "bearerToken" "centralConfigApiKey" -}}
{{- if eq $t (toString (index $.Values.secrets $k | default "")) -}}
{{- fail (printf "secrets.metricsToken is the same as secrets.%s. Whatever scrapes holds the metrics token, so it must reach nothing but the metrics; generate one of its own. The server refuses the same." $k) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
