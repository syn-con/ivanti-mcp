/**
 * The Helm chart lints, renders, and refuses what it claims to refuse.
 *
 * The chart's guards are its main feature — they move a crash-looping pod at 03:00
 * to `helm install` answering at once — and nothing exercised them: a guard that
 * stopped firing, or a template that stopped rendering, was found by whoever
 * installed the release. This renders the default values, then every guard, and
 * fails if a refusal renders or a valid configuration does not.
 *
 * Two further checks tie the chart to the server rather than to itself: every configuration
 * that renders is fed to the server's own `loadConfig` (a chart that renders what the server
 * refuses at boot crash-loops the pod), and every `envSchema` key is wired in the Deployment.
 * Both read `dist/`, so this runs after the build.
 *
 * Needs `helm` on the PATH (GitHub's ubuntu runners carry it).
 *
 *   node scripts/check-chart.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHART = fileURLToPath(new URL('../charts/ivanti-mcp', import.meta.url));

/** The four values without which nothing renders; each case starts from these. */
const BASE = {
  'server.publicUrl': 'https://mcp.example.com/mcp',
  'server.trustedOrigins[0]': 'https://mcp-client.example.com',
  'ivanti.baseUrl': 'https://tenant.example.com',
  'secrets.existingSecret': 'ivanti-mcp-secrets',
};

const DIST = fileURLToPath(new URL('../dist/config/', import.meta.url));
if (!existsSync(`${DIST}load-config.js`)) {
  console.error('dist/ is missing: the chart is checked against the server\'s own loadConfig. Run `pnpm build` first.');
  process.exit(2);
}
const { loadConfig } = await import(`${DIST}load-config.js`);
const { envSchema } = await import(`${DIST}env-schema.js`);
const { TIMEOUT_BOUNDS_MS } = await import(`${DIST}validate-config.js`);

// The server's defaults are read from the schema, not restated: a chart default that drifts from
// them is then a failing case instead of a stale comment.
const READ_MS = envSchema.shape.IVANTI_TIMEOUT_MS.parse(undefined);
const WRITE_MS = envSchema.shape.IVANTI_WRITE_TIMEOUT_MS.parse(undefined);
const OAUTH = { 'server.authMode': 'oauth', 'oauth.issuer': 'https://sso.example.com' };

const LONG_TOKEN = 'x'.repeat(32);

/** The development-secret path, valid as it stands: `secrets.create` with every key it needs. */
const DEV_SECRET = { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.bearerToken': LONG_TOKEN, 'secrets.licenceKey': 'l' };
const METRICS_TOKEN = 'm'.repeat(32);

/**
 * `set`: values over BASE (`null` drops a BASE value). `refuses`: the guard's message
 * must match. `has` / `lacks`: strings the rendered manifests must / must not contain.
 */
const CASES = [
  { name: 'defaults (bearer, existing secret)', has: ['kind: Deployment', 'replicas: 1', 'BEARER_TOKEN_FILE'],
    lacks: ['kind: NetworkPolicy', 'rollout-token', 'kind: Ingress', 'ENDUSER_'] },
  { name: 'no publicUrl', set: { 'server.publicUrl': null }, refuses: /server\.publicUrl is required/ },
  { name: 'publicUrl with a trailing slash', set: { 'server.publicUrl': 'https://mcp.example.com/mcp/' }, refuses: /trailing slash/ },
  { name: 'no trustedOrigins', set: { 'server.trustedOrigins[0]': null }, refuses: /trustedOrigins is required/ },
  { name: 'no ivanti.baseUrl', set: { 'ivanti.baseUrl': null }, refuses: /ivanti\.baseUrl is required/ },
  { name: 'no secret at all', set: { 'secrets.existingSecret': null }, refuses: /Set secrets\.existingSecret/ },
  { name: 'authMode not one of three', set: { 'server.authMode': 'None' }, refuses: /authMode must be none, bearer or oauth/ },
  { name: 'mode not one of two', set: { 'server.mode': 'admin' }, refuses: /mode must be full or enduser/ },

  // Sessions are in memory, and nothing routes a new session back to its pod.
  { name: 'replicaCount 2', set: { replicaCount: '2' }, refuses: /replicaCount must be 1/ },
  { name: 'replicaCount 0 (parked)', set: { replicaCount: '0' }, has: ['replicas: 0'] },
  { name: 'sessionAffinity enabled', set: { 'sessionAffinity.enabled': 'true' }, refuses: /sessionAffinity is gone/ },

  { name: 'enduser, empty allowlist', set: { 'server.mode': 'enduser' }, refuses: /needs server\.enduser\.businessObjects/ },
  { name: 'enduser with a role', set: { 'server.mode': 'enduser', 'server.enduser.businessObjects[0]': 'Incident', 'server.enduser.role': 'SelfService' },
    has: ['ENDUSER_BUSINESS_OBJECTS', 'ENDUSER_ROLE'] },
  { name: 'full with an enduser setting', set: { 'server.enduser.role': 'SelfService' }, refuses: /server\.enduser\.\* applies to mode=enduser/ },
  { name: 'impersonationRole under enduser', set: { 'server.mode': 'enduser', 'server.enduser.businessObjects[0]': 'Incident', 'ivanti.impersonationRole': 'Admin' },
    refuses: /impersonationRole applies to server\.mode=full/ },

  { name: 'oauth without an issuer', set: { 'server.authMode': 'oauth' }, refuses: /needs oauth\.issuer/ },
  { name: 'oauth over plain http', set: { 'server.authMode': 'oauth', 'oauth.issuer': 'http://sso.example.com/realms/corp' }, refuses: /oauth\.issuer must be an https/ },
  { name: 'oauth jwksUri over plain http', set: { 'server.authMode': 'oauth', 'oauth.issuer': 'https://sso.example.com', 'oauth.jwksUri': 'http://sso.example.com/certs' },
    refuses: /oauth\.jwksUri must be an https/ },
  { name: 'tenant over plain http', set: { 'ivanti.baseUrl': 'http://tenant.example.com' }, refuses: /ivanti\.baseUrl must be an https/ },
  { name: 'tenant through a loopback sidecar', set: { 'ivanti.baseUrl': 'http://127.0.0.1:8080' }, has: ['http://127.0.0.1:8080'] },
  { name: 'ConfigDB over plain http', set: { 'ivanti.configUrl': 'http://config.example.com' }, refuses: /ivanti\.configUrl must be an https/ },

  { name: 'dev secret, no API key', set: { 'secrets.existingSecret': null, 'secrets.create': 'true' }, refuses: /needs secrets\.ivantiApiKey/ },
  { name: 'dev secret, short bearer token', set: { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.licenceKey': 'l', 'secrets.bearerToken': 'change-me' },
    refuses: /at least 32 characters/ },
  { name: 'dev secret, 32-character bearer token', set: { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.licenceKey': 'l', 'secrets.bearerToken': LONG_TOKEN },
    has: ['kind: Secret', 'checksum/config'] },

  // authMode=none: nothing may publish it, and a NetworkPolicy fences it by default.
  { name: 'none with an ingress', set: { 'server.authMode': 'none', 'ingress.enabled': 'true' }, refuses: /none with an ingress/ },
  { name: 'none with a LoadBalancer', set: { 'server.authMode': 'none', 'service.type': 'LoadBalancer' }, refuses: /service\.type=LoadBalancer/ },
  { name: 'none with a NodePort', set: { 'server.authMode': 'none', 'service.type': 'NodePort' }, refuses: /service\.type=NodePort/ },
  { name: 'none, ClusterIP', set: { 'server.authMode': 'none' }, has: ['kind: NetworkPolicy', 'podSelector: {}', 'port: 3000'], lacks: ['BEARER_TOKEN_FILE'] },
  { name: 'none, NetworkPolicy switched off', set: { 'server.authMode': 'none', 'networkPolicy.enabled': 'false' }, lacks: ['kind: NetworkPolicy'] },
  { name: 'bearer, NetworkPolicy with peers', set: { 'networkPolicy.enabled': 'true', 'networkPolicy.from[0].namespaceSelector.matchLabels.team': 'agents' },
    has: ['kind: NetworkPolicy', 'team: agents'], lacks: ['podSelector: {}'] },
  { name: 'NetworkPolicy switch misspelt', set: { 'networkPolicy.enabled': 'maybe' }, refuses: /networkPolicy\.enabled must be auto, true or false/ },

  { name: 'rolloutToken rolls the pod', set: { rolloutToken: '2026-09-29' }, has: ['ivanti-mcp/rollout-token: "2026-09-29"'] },
  { name: 'optional server settings', set: { ...OAUTH, 'server.maxSessionsPerSubject': '5', 'ivanti.timeoutMs': '15000', 'ivanti.writeTimeoutMs': '45000',
    'ivanti.configUrl': 'https://config.example.com', 'ivanti.impersonationRequired': 'true' },
  has: ['MCP_MAX_SESSIONS_PER_SUBJECT', 'IVANTI_TIMEOUT_MS', 'IVANTI_WRITE_TIMEOUT_MS', 'IVANTI_IMPERSONATION_REQUIRED', 'IVANTI_CENTRAL_CONFIG_API_KEY_FILE'] },
  { name: 'identity TTL is a value', has: ['MCP_IDENTITY_IDLE_TTL_SECONDS, value: "1800"'] },
  { name: 'identity TTL set', set: { 'server.identityIdleTtlSeconds': '60' }, has: ['MCP_IDENTITY_IDLE_TTL_SECONDS, value: "60"'] },

  // What the server refuses at boot (validate-config.ts), refused at install. The parity step
  // below holds the renders to the server; these hold the refusals.
  { name: 'impersonationRequired without a ConfigDB', set: { 'ivanti.impersonationRequired': 'true' }, refuses: /impersonationRequired=true needs ivanti\.configUrl/ },
  { name: 'maxSessionsPerSubject under bearer', set: { 'server.maxSessionsPerSubject': '5' }, refuses: /maxSessionsPerSubject needs server\.authMode=oauth/ },
  { name: 'maxSessionsPerSubject above maxSessions', set: { ...OAUTH, 'server.maxSessionsPerSubject': '500', 'server.maxSessions': '100' }, refuses: /above server\.maxSessions=100/ },
  { name: 'maxSessionsPerSubject at maxSessions', set: { ...OAUTH, 'server.maxSessionsPerSubject': '100', 'server.maxSessions': '100' }, has: ['MCP_MAX_SESSIONS_PER_SUBJECT'] },
  { name: 'publicUrl with a fragment', set: { 'server.publicUrl': 'https://mcp.example.com/mcp#x' }, refuses: /must not contain a fragment/ },
  { name: 'write timeout shorter than read', set: { 'ivanti.timeoutMs': '60000', 'ivanti.writeTimeoutMs': '5000' }, refuses: /writeTimeoutMs \(5000\) is shorter/ },
  { name: 'read timeout alone above the write default', set: { 'ivanti.timeoutMs': String(WRITE_MS + 1000) }, refuses: /is shorter than ivanti\.timeoutMs/ },
  { name: 'write timeout alone below the read default', set: { 'ivanti.writeTimeoutMs': String(READ_MS - 1000) }, refuses: /is shorter than ivanti\.timeoutMs/ },
  { name: 'read timeout alone at the write default', set: { 'ivanti.timeoutMs': String(WRITE_MS) }, has: ['IVANTI_TIMEOUT_MS'] },
  { name: 'timeoutMs under the floor', set: { 'ivanti.timeoutMs': String(TIMEOUT_BOUNDS_MS.min - 1) }, refuses: /ivanti\.timeoutMs=\d+ is outside/ },
  { name: 'timeoutMs at the floor', set: { 'ivanti.timeoutMs': String(TIMEOUT_BOUNDS_MS.min) }, has: ['IVANTI_TIMEOUT_MS'] },
  { name: 'writeTimeoutMs over the ceiling', set: { 'ivanti.writeTimeoutMs': String(TIMEOUT_BOUNDS_MS.max + 1) }, refuses: /ivanti\.writeTimeoutMs=\d+ is outside/ },
  { name: 'timeouts at the ceiling', set: { 'ivanti.timeoutMs': String(TIMEOUT_BOUNDS_MS.max), 'ivanti.writeTimeoutMs': String(TIMEOUT_BOUNDS_MS.max) },
    has: ['IVANTI_WRITE_TIMEOUT_MS'] },
  { name: 'timeoutMs not a number', set: { 'ivanti.timeoutMs': 'soon' }, refuses: /ivanti\.timeoutMs=soon is outside/ },
  { name: 'maxConcurrentRequests 0 (string)', set: { 'ivanti.maxConcurrentRequests': '0' }, refuses: /maxConcurrentRequests=0 is outside/ },
  { name: 'maxConcurrentRequests 0 (--set number)', setRaw: { 'ivanti.maxConcurrentRequests': '0' }, refuses: /maxConcurrentRequests=0 is outside/ },
  { name: 'maxConcurrentRequests 257', set: { 'ivanti.maxConcurrentRequests': '257' }, refuses: /maxConcurrentRequests=257 is outside/ },
  { name: 'maxConcurrentRequests 256', set: { 'ivanti.maxConcurrentRequests': '256' }, has: ['IVANTI_MAX_CONCURRENT_REQUESTS, value: "256"'] },
  { name: 'maxConcurrentRequests 1', set: { 'ivanti.maxConcurrentRequests': '1' }, has: ['IVANTI_MAX_CONCURRENT_REQUESTS, value: "1"'] },
  { name: 'maxCallsPerMinute 0 (string)', set: { 'server.maxCallsPerMinute': '0' }, refuses: /maxCallsPerMinute=0 is outside/ },
  { name: 'maxCallsPerMinute 0 (--set number)', setRaw: { 'server.maxCallsPerMinute': '0' }, refuses: /maxCallsPerMinute=0 is outside/ },
  { name: 'maxCallsPerMinute 10001', set: { 'server.maxCallsPerMinute': '10001' }, refuses: /maxCallsPerMinute=10001 is outside/ },
  { name: 'maxCallsPerMinute 10000', set: { 'server.maxCallsPerMinute': '10000' }, has: ['MCP_MAX_CALLS_PER_MINUTE, value: "10000"'] },

  // The guards the suite once did not exercise.
  { name: 'configUrl without the ConfigDB key', set: { 'ivanti.configUrl': 'https://config.example.com', 'secrets.existingSecret': null, ...{ 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.licenceKey': 'l', 'secrets.bearerToken': LONG_TOKEN } },
    refuses: /ivanti\.configUrl needs the ConfigDB key/ },
  { name: 'configUrl with the ConfigDB key', set: { 'ivanti.configUrl': 'https://config.example.com', ...DEV_SECRET, 'secrets.centralConfigApiKey': 'c' }, has: ['IVANTI_CENTRAL_CONFIG_API_KEY_FILE'] },
  { name: 'bearer without a bearer token', set: { 'secrets.existingSecret': null, 'secrets.create': 'true', 'secrets.ivantiApiKey': 'k', 'secrets.licenceKey': 'l' }, refuses: /authMode=bearer needs a bearer token/ },
  { name: 'dev secret, metrics token is the Ivanti API key', set: { ...DEV_SECRET, 'secrets.ivantiApiKey': METRICS_TOKEN, 'metrics.enabled': 'true', 'metrics.token': 'true', 'secrets.metricsToken': METRICS_TOKEN },
    refuses: /metricsToken is the same as secrets\.ivantiApiKey/ },
  { name: 'dev secret, metrics token is the ConfigDB key', set: { ...DEV_SECRET, 'secrets.centralConfigApiKey': METRICS_TOKEN, 'metrics.enabled': 'true', 'metrics.token': 'true', 'secrets.metricsToken': METRICS_TOKEN },
    refuses: /metricsToken is the same as secrets\.centralConfigApiKey/ },

  // OAUTH_AUDIENCE is a list on the server: a YAML list must arrive joined, not as Go's "[a b]".
  { name: 'oauth audience as a string', set: { ...OAUTH, 'oauth.audience': 'api://a' }, has: ['OAUTH_AUDIENCE, value: "api://a"'] },
  { name: 'oauth audience as a list', set: { ...OAUTH, 'oauth.audience[0]': 'api://a', 'oauth.audience[1]': 'api://b' },
    has: ['OAUTH_AUDIENCE, value: "api://a,api://b"'], lacks: ['[api://a'] },

  // Metrics: a port, a Service and a NetworkPolicy rule of their own — never the MCP ones,
  // since every credential guarding that port reaches the tools. Off, nothing renders and
  // the other metrics.* values are ignored, as the server ignores METRICS_* when off.
  { name: 'metrics off: nothing renders, other metrics values ignored',
    set: { 'metrics.port': '3000', 'metrics.token': 'true', 'metrics.from[0].podSelector.matchLabels.app': 'prometheus' },
    lacks: ['METRICS_', 'name: metrics', 'ivanti-mcp-metrics', 'kind: ServiceMonitor', 'metrics-token', 'app: prometheus'] },
  { name: 'metrics on (bearer: the NetworkPolicy stays off, as auto says)', set: { 'metrics.enabled': 'true' },
    has: ['METRICS_ON', 'METRICS_BIND', 'METRICS_PORT', '- name: metrics\n              containerPort: 9464', 'name: ivanti-mcp-metrics',
      'app.kubernetes.io/component: metrics', 'targetPort: metrics'],
    lacks: ['METRICS_TOKEN_FILE', 'kind: ServiceMonitor', 'kind: NetworkPolicy'] },
  { name: 'metrics token from the existing secret', set: { 'metrics.enabled': 'true', 'metrics.token': 'true' },
    has: ['METRICS_TOKEN_FILE, value: "/run/secrets/metrics-token"'] },
  { name: 'metrics on the MCP port', set: { 'metrics.enabled': 'true', 'metrics.port': '3000' }, refuses: /metrics\.port and server\.port are both 3000/ },
  { name: 'ServiceMonitor with metrics off', set: { 'metrics.serviceMonitor.enabled': 'true' }, refuses: /serviceMonitor\.enabled needs metrics\.enabled/ },
  { name: 'ServiceMonitor with a token', set: { 'metrics.enabled': 'true', 'metrics.token': 'true', 'metrics.serviceMonitor.enabled': 'true',
    'metrics.serviceMonitor.labels.release': 'kube-prometheus-stack' },
  has: ['kind: ServiceMonitor', 'path: /metrics', 'interval: 30s', 'release: kube-prometheus-stack', 'type: Bearer',
    'credentials:\n          name: ivanti-mcp-secrets\n          key: metrics-token'] },
  { name: 'ServiceMonitor without a token', set: { 'metrics.enabled': 'true', 'metrics.serviceMonitor.enabled': 'true' },
    has: ['kind: ServiceMonitor'], lacks: ['authorization:', 'metrics-token'] },

  { name: 'dev secret, metrics token missing', set: { ...DEV_SECRET, 'metrics.enabled': 'true', 'metrics.token': 'true' },
    refuses: /metrics\.token=true needs a scrape token/ },
  { name: 'dev secret, short metrics token', set: { ...DEV_SECRET, 'metrics.enabled': 'true', 'metrics.token': 'true', 'secrets.metricsToken': 'change-me' },
    refuses: /secrets\.metricsToken must be at least 32 characters/ },
  { name: 'dev secret, metrics token is the bearer token', set: { ...DEV_SECRET, 'metrics.enabled': 'true', 'metrics.token': 'true', 'secrets.metricsToken': LONG_TOKEN },
    refuses: /metricsToken is the same as secrets\.bearerToken/ },
  { name: 'dev secret, metrics token', set: { ...DEV_SECRET, 'metrics.enabled': 'true', 'metrics.token': 'true', 'secrets.metricsToken': METRICS_TOKEN },
    has: [`metrics-token: "${METRICS_TOKEN}"`, 'METRICS_TOKEN_FILE'] },

  // Each rule pairs its own peers with its own port: whoever is admitted to the MCP port
  // (the ingress controller) never reaches /metrics, and a scraper never reaches the tools.
  { name: 'none + metrics: the metrics port has a rule of its own', set: { 'server.authMode': 'none', 'metrics.enabled': 'true',
    'metrics.from[0].namespaceSelector.matchLabels.purpose': 'monitoring' },
  has: ['kind: NetworkPolicy', '- podSelector: {}\n      ports:\n        - { protocol: TCP, port: 3000 }',
    'purpose: monitoring\n      ports:\n        - { protocol: TCP, port: 9464 }'] },
  { name: 'NetworkPolicy peers do not reach metrics', set: { 'networkPolicy.enabled': 'true', 'networkPolicy.from[0].namespaceSelector.matchLabels.team': 'agents',
    'metrics.enabled': 'true' },
  has: ['team: agents\n      ports:\n        - { protocol: TCP, port: 3000 }', '- podSelector: {}\n      ports:\n        - { protocol: TCP, port: 9464 }'] },
  // Licensing (design §9f).
  { name: 'licence key and install ID always wired', has: ['LICENSE_KEY_FILE', 'LICENSE_INSTALL_ID'], lacks: ['LICENSE_HUB_URL'] },
  { name: 'dev secret carries the licence key', set: DEV_SECRET, has: ['licence-key: "l"'] },
  { name: 'dev secret without a licence key', set: { ...DEV_SECRET, 'secrets.licenceKey': null },
    refuses: /secrets\.create=true needs secrets\.licenceKey/ },
  { name: 'a given install ID is used as it is', set: { 'license.installId': '3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03' },
    has: ['value: "3f6b2a9e-1c4d-4e8a-9b7f-2d5e8c1a6f03"'] },
  { name: 'an install ID that is not a UUID', set: { 'license.installId': 'my-server' }, refuses: /license\.installId must be a UUID/ },
  { name: 'the licence token is kept in its own Secret, reachable by that Secret only', has: [
    'name: LICENSE_STATE_SECRET, value: "ivanti-mcp-licence-state"', 'automountServiceAccountToken: true', 'kind: Role',
    'resourceNames: [ivanti-mcp-licence-state]', 'verbs: [get, update]', 'kind: RoleBinding', 'namespace: ivanti'] },
  { name: 'keepState=false: no Secret, no Role, no token', set: { 'license.keepState': 'false' },
    has: ['automountServiceAccountToken: false'], lacks: ['LICENSE_STATE_SECRET', 'kind: Role', 'licence-state'] },
  { name: 'a long release name keeps the licence-state suffix', set: { fullnameOverride: 'x'.repeat(70) },
    has: [`name: ${'x'.repeat(49)}-licence-state`] },
];

function args(set = {}, setRaw = {}) {
  const values = { ...BASE, ...set };
  return [
    ...Object.entries(values)
      .filter(([, v]) => v !== null)
      .flatMap(([k, v]) => ['--set-string', `${k}=${v}`]),
    // `--set` types a number as a number, which Helm's `with` then reads as unset when it is 0.
    ...Object.entries(setRaw).flatMap(([k, v]) => ['--set', `${k}=${v}`]),
  ];
}

/** The Deployment's literal `- { name: X, value: "…" }` env lines, as an env object. */
function deploymentEnv(manifests) {
  const doc = manifests.split(/^---$/m).find((d) => /^kind: Deployment$/m.test(d)) ?? '';
  const env = {};
  for (const m of doc.matchAll(/^\s+- \{ name: (\w+),\s+value: ("(?:[^"\\]|\\.)*") \}$/gm)) env[m[1]] = JSON.parse(m[2]);
  return env;
}

/**
 * The server's own verdict on a rendered Deployment. `*_FILE` secrets are stubbed (and padded:
 * a bearer token must be 32 characters) — the mount is not what is under test.
 */
function serverVerdict(env) {
  try {
    loadConfig(env, (p) => `stub-secret-for:${p}`.padEnd(48, '.'));
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

function helm(...argv) {
  const r = spawnSync('helm', argv, { encoding: 'utf8' });
  if (r.error) {
    console.error(`helm could not be run (${r.error.message}). Install Helm 3.8+ to check the chart.`);
    process.exit(2);
  }
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

let failed = 0;
const lint = helm('lint', '--strict', CHART, ...args());
if (!lint.ok) {
  failed += 1;
  console.error(`  FAIL  helm lint --strict\n${lint.out}`);
} else {
  console.log('  ok    helm lint --strict');
}

for (const c of CASES) {
  const r = helm('template', 'ivanti-mcp', CHART, '--namespace', 'ivanti', ...args(c.set, c.setRaw));
  const problems = [];
  if (c.refuses) {
    if (r.ok) problems.push('rendered, but a guard should have refused it');
    else if (!c.refuses.test(r.out)) problems.push(`refused for another reason:\n${r.out.trim()}`);
  } else if (!r.ok) {
    problems.push(`did not render:\n${r.out.trim()}`);
  } else {
    for (const s of c.has ?? []) if (!r.out.includes(s)) problems.push(`missing ${JSON.stringify(s)}`);
    for (const s of c.lacks ?? []) if (r.out.includes(s)) problems.push(`unexpected ${JSON.stringify(s)}`);
    // Whatever renders, the server must start with. A parked release has no pod to start.
    if (c.set?.replicaCount !== '0') {
      const refusal = serverVerdict(deploymentEnv(r.out));
      if (refusal !== null) problems.push(`renders, but the server would exit 78 on it:\n${refusal}`);
    }
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`  FAIL  ${c.name}`);
    for (const p of problems) console.error(`        ${p.split('\n').join('\n        ')}`);
  } else {
    console.log(`  ok    ${c.refuses ? 'refuses' : 'renders'}  ${c.name}`);
  }
}

// Every setting the server reads is a value of the chart, or is named here as deliberately not.
// `_FILE` secrets count under their own name: the chart mounts them, it never sets the plain key.
const NOT_A_VALUE = {
  // The chart keeps the last verified licence token in a Secret, never a folder.
  LICENSE_STATE_DIR: 'The chart keeps the licence token in a Secret (LICENSE_STATE_SECRET), not a folder.',
  // Binding to the namespace UID needs a cluster-scoped lookup that namespace-scoped installers
  // are not allowed; derived from the install ID instead until that is a deliberate opt-in.
  LICENSE_MACHINE_ID: 'Derived from LICENSE_INSTALL_ID under the chart; see design §9f.',
};
const deploymentSource = readFileSync(`${CHART}/templates/deployment.yaml`, 'utf8');
for (const key of Object.keys(envSchema.shape)) {
  if (key in NOT_A_VALUE) continue;
  if (!new RegExp(`name: ${key}(_FILE)?,`).test(deploymentSource)) {
    failed += 1;
    console.error(`  FAIL  ${key} is read by the server (env-schema.ts) but the Deployment never sets it. Wire a value, or list it in NOT_A_VALUE with the reason.`);
  }
}
for (const key of Object.keys(NOT_A_VALUE)) {
  if (!(key in envSchema.shape)) {
    failed += 1;
    console.error(`  FAIL  NOT_A_VALUE names ${key}, which env-schema.ts no longer has.`);
  }
}
console.log(`  ok    ${Object.keys(envSchema.shape).length} envSchema keys checked against deployment.yaml`);

if (failed > 0) {
  console.error(`\n${failed} chart check(s) failed.`);
  process.exit(1);
}
console.log(`\nThe chart lints, and all ${CASES.length} cases render or refuse as they should.`);
