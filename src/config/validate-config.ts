// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { metadataUrl } from '../auth/oauth/protected-resource-metadata.js';
import { MAX_CHALLENGE_CHARS, sanitiseHeaderValue } from '../auth/oauth/www-authenticate.js';
import { envSchema, type Config } from './env-schema.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

/** As `URL.hostname` spells it: IPv6 keeps its brackets. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Every `ENDUSER_*` setting the schema knows. Derived rather than listed, so a new one is covered
 * by the full-mode rule without anyone remembering to add it there.
 */
const ENDUSER_SETTINGS = Object.keys(envSchema.shape).filter((key) => key.startsWith('ENDUSER_'));

/** A shared static token is the whole door; shorter than this, it is guessable. */
export const MIN_BEARER_TOKEN_LENGTH = 32;

/**
 * Bounds for both Ivanti timeouts. Under a second, every busy moment is an outage; over five
 * minutes a hung request holds its tool call — and whoever is waiting on it — past the point any
 * client is still waiting.
 */
export const TIMEOUT_BOUNDS_MS = { min: 1_000, max: 300_000 } as const;

/** Zero would send nothing; past a few hundred it no longer protects the tenant. */
export const CONCURRENCY_BOUNDS = { min: 1, max: 256 } as const;

/** Zero would refuse every call; past the top it limits nothing a model could do. */
export const CALLS_PER_MINUTE_BOUNDS = { min: 1, max: 10_000 } as const;

/** Every `OAUTH_*` setting the schema knows — read only under `AUTH_MODE=oauth`. */
const OAUTH_SETTINGS = Object.keys(envSchema.shape).filter((key) => key.startsWith('OAUTH_'));

/**
 * Whether the operator wrote this setting. For settings with no default: a defaulted scalar is
 * always "set", and an empty list is the default of the list ones.
 */
function isWritten(config: Config, provided: ReadonlySet<string>, key: string): boolean {
  const value: unknown = config[key as keyof Config];
  if (Array.isArray(value)) return provided.has(key) || value.length > 0;
  return provided.has(key) || value !== undefined;
}

/**
 * Why a URL is not acceptable as a place to send a credential or fetch a trust decision from, or
 * nothing when it is. `https:` anywhere; `http:` only to a loopback host, where there is no
 * network in between — a local mock, a port-forward, a sidecar.
 */
export function insecureUrlProblem(setting: string, value: string, risk: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL at all is the schema's to report.
    return undefined;
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname)) return undefined;
  return (
    `${setting} must use https:// (got ${url.protocol}//${url.host}). ${risk} Plain http is ` +
    'accepted only for a loopback host: localhost, 127.0.0.0/8 or ::1.'
  );
}

/**
 * A type predicate rather than a boolean: `validateConfig` has already refused the half-configured
 * case, but the compiler does not know that, and the alternative is a non-null assertion at every
 * call site.
 */
export function isIvantiConfigured(
  config: Config,
): config is Config & { IVANTI_BASE_URL: string; IVANTI_API_KEY: string } {
  return config.IVANTI_BASE_URL !== undefined && config.IVANTI_API_KEY !== undefined;
}

/**
 * Whether this deployment may impersonate — the same predicate shape, for the same reason.
 *
 * Configured is not the same as *able*: CentralConfig still has to answer, which the startup
 * probe decides. This says only that the operator asked for it.
 */
export function isImpersonationConfigured(
  config: Config,
): config is Config & { IVANTI_CONFIG_URL: string; IVANTI_CENTRAL_CONFIG_API_KEY: string } {
  return (
    config.IVANTI_CONFIG_URL !== undefined && config.IVANTI_CENTRAL_CONFIG_API_KEY !== undefined
  );
}

export function isHttpTransport(config: Config): boolean {
  return config.HTTP_TRANSPORT_ON;
}

/**
 * What the 401 challenge advertises verbatim — the scope list and the metadata URL — must survive
 * the header sanitiser unchanged and fit in one header. A quote, a backslash or a non-ASCII
 * character becomes a space there, which splits a scope token or alters a URL, and the client
 * then requests or fetches something else.
 */
function challengeProblems(config: Config): string[] {
  const problems: string[] = [];
  const advertised: [string, string][] = config.OAUTH_REQUIRED_SCOPES.map((scope) => [
    'OAUTH_REQUIRED_SCOPES',
    scope,
  ]);
  if (config.MCP_PUBLIC_URL !== undefined) {
    try {
      advertised.push(['MCP_PUBLIC_URL (the metadata URL derived from it)', metadataUrl(config.MCP_PUBLIC_URL)]);
    } catch {
      // Not a URL: `canonicalUriProblems` already says so.
    }
  }
  for (const [setting, value] of advertised) {
    if (sanitiseHeaderValue(value) !== value) {
      problems.push(
        `${setting} carries "${value}", which cannot appear in a WWW-Authenticate header ` +
          '(printable ASCII only, no quote or backslash), so the challenge ' +
          'would advertise a different value than the one configured.',
      );
    }
  }
  const length = advertised.reduce((total, [, value]) => total + value.length + 1, 0);
  if (length > MAX_CHALLENGE_CHARS) {
    problems.push(
      `The 401 challenge would be about ${String(length)} characters (OAUTH_REQUIRED_SCOPES and ` +
        `MCP_PUBLIC_URL), past the ${String(MAX_CHALLENGE_CHARS)} a proxy in front will pass.`,
    );
  }
  return problems;
}

export function isStdioTransport(config: Config): boolean {
  return config.STDIO_TRANSPORT_ON;
}

/**
 * The audiences a token may name. Defaults to the resource identifier, which is what the spec
 * assumes, but real IdPs mint their own — so it is overridable, and is a list because a
 * deployment routinely has more than one legitimate client.
 */
export function expectedAudiences(config: Config): string[] {
  if (config.OAUTH_AUDIENCE.length > 0) return config.OAUTH_AUDIENCE;
  return config.MCP_PUBLIC_URL === undefined ? [] : [config.MCP_PUBLIC_URL];
}

export function isExposedToNetwork(config: Config): boolean {
  return !LOOPBACK_ADDRESSES.has(config.MCP_BIND);
}

/** Whether the metrics listener answers beyond this machine. */
export function isMetricsExposedToNetwork(config: Config): boolean {
  return !LOOPBACK_ADDRESSES.has(config.METRICS_BIND);
}

/**
 * MCP_PUBLIC_URL doubles as the OAuth resource identifier, which the spec requires to be a
 * canonical URI (RFC 8707 §2). A client sends this exact string as its `resource` parameter
 * and the token's audience is compared against it, so a fragment or a stray trailing slash
 * produces an audience mismatch that reads like a client bug.
 */
export function canonicalUriProblems(url: string): string[] {
  const problems: string[] = [];

  if (url.includes('#')) {
    problems.push(`MCP_PUBLIC_URL must not contain a fragment: ${url}`);
  }

  if (url.endsWith('/')) {
    problems.push(
      `MCP_PUBLIC_URL must not end with a trailing slash: ${url}. The resource identifier ` +
        'is compared verbatim against the token audience.',
    );
  }

  return problems;
}

/**
 * Cross-field rules the server refuses to start without.
 *
 * Every rule here fails closed: a container will be run by people who have not read the
 * README, so an incomplete configuration must stop the process rather than quietly
 * degrade into something less protected than intended.
 *
 * `provided` is the names the environment actually set. A setting with a default cannot be told
 * apart from one the operator wrote without it — and "set, but ignored in this mode" is exactly
 * the mistake worth refusing.
 */
export function validateConfig(config: Config, provided: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];

  if (!config.STDIO_TRANSPORT_ON && !config.HTTP_TRANSPORT_ON) {
    problems.push(
      'Both STDIO_TRANSPORT_ON and HTTP_TRANSPORT_ON are off; the server would serve nobody.',
    );
  }

  if (isHttpTransport(config) && config.AUTH_MODE === undefined) {
    problems.push(
      'HTTP_TRANSPORT_ON=true requires AUTH_MODE (none | bearer | oauth). Refusing to serve ' +
        'on a socket without an explicit decision about who may connect.',
    );
  }

  if (!isHttpTransport(config) && config.AUTH_MODE !== undefined) {
    problems.push(
      `AUTH_MODE=${config.AUTH_MODE} has no effect with HTTP_TRANSPORT_ON=false, where the ` +
        'credential is the ability to run the process. Remove it rather than rely on it.',
    );
  }

  if (isHttpTransport(config)) {
    if (config.MCP_PORT === undefined) {
      problems.push(
        'MCP_PORT is required for HTTP transports. There is no built-in port: it has to agree ' +
          'with MCP_PUBLIC_URL and with whatever publishes or proxies it, so it is set once, here.',
      );
    }

    if (config.MCP_PUBLIC_URL !== undefined) {
      problems.push(...canonicalUriProblems(config.MCP_PUBLIC_URL));
    }

    if (config.MCP_PUBLIC_URL === undefined) {
      problems.push(
        'MCP_PUBLIC_URL is required for HTTP transports. It must be the externally visible ' +
          'URL and is never derived from the request, because a reverse proxy rewrites Host ' +
          'and scheme while token audiences must still match exactly.',
      );
    }

    if (config.TRUSTED_ORIGINS.length === 0) {
      problems.push(
        'TRUSTED_ORIGINS is required for HTTP transports. Origin validation is mandatory ' +
          'and is what prevents DNS rebinding from a page the user merely visits.',
      );
    }
  }

  // A per-subject limit needs a subject. Under `none` and `bearer` every caller is the same
  // anonymous one, so the limit would either do nothing or cap the whole deployment at it.
  const perSubject = config.MCP_MAX_SESSIONS_PER_SUBJECT;
  if (perSubject !== undefined && config.AUTH_MODE !== 'oauth') {
    problems.push(
      'MCP_MAX_SESSIONS_PER_SUBJECT needs AUTH_MODE=oauth: only a verified token names a ' +
        'subject, and without one every caller would count as the same person.',
    );
  }
  if (perSubject !== undefined && perSubject > config.MCP_MAX_SESSIONS) {
    problems.push(
      `MCP_MAX_SESSIONS_PER_SUBJECT=${String(perSubject)} is above MCP_MAX_SESSIONS=` +
        `${String(config.MCP_MAX_SESSIONS)}, so it could never apply.`,
    );
  }

  // Requiring what was never configured would start and then refuse at the probe, or — read the
  // other way — look like a guarantee that nothing enforces.
  if (config.IVANTI_IMPERSONATION_REQUIRED && !isImpersonationConfigured(config)) {
    problems.push(
      'IVANTI_IMPERSONATION_REQUIRED=true needs IVANTI_CONFIG_URL and ' +
        'IVANTI_CENTRAL_CONFIG_API_KEY (or IVANTI_CENTRAL_CONFIG_API_KEY_FILE).',
    );
  }

  // Settings of an axis that is not in use are refused, not ignored: a leftover from the mode
  // an operator moved away from is dead config, and a deployment that believes it is in force
  // is worse off than one that failed to start.
  if (config.AUTH_MODE !== 'bearer' && isWritten(config, provided, 'BEARER_TOKEN')) {
    problems.push(
      `BEARER_TOKEN (or BEARER_TOKEN_FILE) is set, but AUTH_MODE is ${config.AUTH_MODE ?? 'not set'}, ` +
        'which never reads it. Set AUTH_MODE=bearer, or remove it.',
    );
  }
  if (config.AUTH_MODE !== 'oauth') {
    const stray = OAUTH_SETTINGS.filter((key) => isWritten(config, provided, key));
    if (stray.length > 0) {
      problems.push(
        `${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} set, but AUTH_MODE is ` +
          `${config.AUTH_MODE ?? 'not set'}, which never reads ${stray.length === 1 ? 'it' : 'them'}. ` +
          `Set AUTH_MODE=oauth, or remove ${stray.length === 1 ? 'it' : 'them'}.`,
      );
    }
  }

  if (config.AUTH_MODE === 'bearer' && config.BEARER_TOKEN === undefined) {
    problems.push('AUTH_MODE=bearer requires BEARER_TOKEN or BEARER_TOKEN_FILE.');
  }

  // The token is the whole door in bearer mode, and the examples a deployment is copied from have
  // carried a placeholder (`change-me`) that the old `min(1)` accepted.
  if (
    config.AUTH_MODE === 'bearer' &&
    config.BEARER_TOKEN !== undefined &&
    config.BEARER_TOKEN.length < MIN_BEARER_TOKEN_LENGTH
  ) {
    problems.push(
      `BEARER_TOKEN is ${String(config.BEARER_TOKEN.length)} characters; it must be at least ` +
        `${String(MIN_BEARER_TOKEN_LENGTH)}. It is the only thing between the network and the ` +
        'whole tool surface, and a short one can be guessed. Generate one with ' +
        '`openssl rand -base64 32`.',
    );
  }

  // Each of these carries a credential or decides which tokens are trusted. Over plain http
  // anyone on the path reads the key, or swaps the keys a token is checked against. The
  // discovered `jwks_uri` is checked where it is discovered, in `src/auth/oauth`.
  const secured: [keyof Config, string][] = [
    [
      'IVANTI_BASE_URL',
      'The tenant API key travels with every request and would cross the network readable.',
    ],
    [
      'IVANTI_CONFIG_URL',
      'The CentralConfig key travels with every call, and CentralConfig answers with the ' +
        "tenant's database credentials.",
    ],
    [
      'OAUTH_ISSUER',
      'The metadata and signing keys that decide which tokens this server accepts would be ' +
        'fetched over a connection anyone on the path can rewrite.',
    ],
    [
      'OAUTH_JWKS_URI',
      'The signing keys that decide which tokens this server accepts would be fetched over a ' +
        'connection anyone on the path can rewrite.',
    ],
    [
      'LICENSE_HUB_URL',
      'The licence key travels with every heartbeat, and the keys that decide whether this ' +
        'server is licensed would be fetched over a connection anyone on the path can rewrite.',
    ],
  ];
  for (const [setting, risk] of secured) {
    const value = config[setting];
    if (typeof value !== 'string') continue;
    const problem = insecureUrlProblem(setting, value, risk);
    if (problem !== undefined) problems.push(problem);
  }

  for (const setting of ['IVANTI_TIMEOUT_MS', 'IVANTI_WRITE_TIMEOUT_MS'] as const) {
    const value = config[setting];
    if (value < TIMEOUT_BOUNDS_MS.min || value > TIMEOUT_BOUNDS_MS.max) {
      problems.push(
        `${setting}=${String(value)} is outside ${String(TIMEOUT_BOUNDS_MS.min)}–` +
          `${String(TIMEOUT_BOUNDS_MS.max)} ms. Under a second, every busy moment on the tenant ` +
          'is an outage; over five minutes, a hung request outlasts any client waiting on it.',
      );
    }
  }

  if (
    config.IVANTI_MAX_CONCURRENT_REQUESTS < CONCURRENCY_BOUNDS.min ||
    config.IVANTI_MAX_CONCURRENT_REQUESTS > CONCURRENCY_BOUNDS.max
  ) {
    problems.push(
      `IVANTI_MAX_CONCURRENT_REQUESTS=${String(config.IVANTI_MAX_CONCURRENT_REQUESTS)} is outside ` +
        `${String(CONCURRENCY_BOUNDS.min)}–${String(CONCURRENCY_BOUNDS.max)}. Zero would send ` +
        'nothing; past a few hundred it no longer protects the tenant.',
    );
  }
  if (
    config.MCP_MAX_CALLS_PER_MINUTE < CALLS_PER_MINUTE_BOUNDS.min ||
    config.MCP_MAX_CALLS_PER_MINUTE > CALLS_PER_MINUTE_BOUNDS.max
  ) {
    problems.push(
      `MCP_MAX_CALLS_PER_MINUTE=${String(config.MCP_MAX_CALLS_PER_MINUTE)} is outside ` +
        `${String(CALLS_PER_MINUTE_BOUNDS.min)}–${String(CALLS_PER_MINUTE_BOUNDS.max)}. Zero ` +
        'would refuse every call; past that it limits nothing a model could do.',
    );
  }

  // Judged only while on. Off, the other METRICS_* settings may stay where they are — flipping the
  // one toggle is the whole of turning metrics off, which is the safe direction.
  if (config.METRICS_ON) problems.push(...metricsProblems(config));

  problems.push(...licenceProblems(config));

  // A write cut off early is the costliest failure there is — it may have been applied — so it
  // must never be the one given less time.
  if (config.IVANTI_WRITE_TIMEOUT_MS < config.IVANTI_TIMEOUT_MS) {
    problems.push(
      `IVANTI_WRITE_TIMEOUT_MS (${String(config.IVANTI_WRITE_TIMEOUT_MS)}) is shorter than ` +
        `IVANTI_TIMEOUT_MS (${String(config.IVANTI_TIMEOUT_MS)}). A write runs the tenant's ` +
        'workflow before it answers, and one cut off may still have been applied.',
    );
  }

  if (config.AUTH_MODE === 'oauth' && config.OAUTH_ISSUER === undefined) {
    problems.push('AUTH_MODE=oauth requires OAUTH_ISSUER.');
  }
  if (config.AUTH_MODE === 'oauth') problems.push(...challengeProblems(config));

  // Half a connection is a misconfiguration, not a degraded mode: it would start, look healthy,
  // and fail on the first Ivanti call.
  const hasBaseUrl = config.IVANTI_BASE_URL !== undefined;
  const hasKey = config.IVANTI_API_KEY !== undefined;
  if (hasBaseUrl !== hasKey) {
    problems.push(
      hasBaseUrl
        ? 'IVANTI_BASE_URL is set without IVANTI_API_KEY (or IVANTI_API_KEY_FILE).'
        : 'IVANTI_API_KEY is set without IVANTI_BASE_URL.',
    );
  }

  // The impersonation pair, on the same principle: half of it would start and then refuse every
  // `act_as`, which reads as the feature being broken rather than unconfigured.
  const hasConfigUrl = config.IVANTI_CONFIG_URL !== undefined;
  const hasConfigKey = config.IVANTI_CENTRAL_CONFIG_API_KEY !== undefined;
  if (hasConfigUrl !== hasConfigKey) {
    problems.push(
      hasConfigUrl
        ? 'IVANTI_CONFIG_URL is set without IVANTI_CENTRAL_CONFIG_API_KEY (or ' +
            'IVANTI_CENTRAL_CONFIG_API_KEY_FILE).'
        : 'IVANTI_CENTRAL_CONFIG_API_KEY is set without IVANTI_CONFIG_URL.',
    );
  }

  // Every Ivanti setting needs the tenant. A cap on a tier nobody probes is dead config that reads
  // as if it were in force.
  if (isWritten(config, provided, 'IVANTI_MAX_TIER') && !hasBaseUrl && !hasKey) {
    problems.push(
      'IVANTI_MAX_TIER is set, but no tenant is configured (IVANTI_BASE_URL and IVANTI_API_KEY), ' +
        'so there is no tier to cap.',
    );
  }

  // Impersonation acts on the tenant. Without one there is nothing to impersonate against, and
  // the setting would sit there looking as though it did something.
  if (hasConfigUrl && hasConfigKey && !hasBaseUrl) {
    problems.push(
      'IVANTI_CONFIG_URL and IVANTI_CENTRAL_CONFIG_API_KEY configure impersonation against a ' +
        'tenant, so IVANTI_BASE_URL and IVANTI_API_KEY must be set too.',
    );
  }

  // The pinned role is applied when `act_as` opens the person's own session, which needs the
  // ConfigDB pair. Without it sessions run under the service account's role, while the operator
  // believes they were narrowed.
  if (config.IVANTI_IMPERSONATION_ROLE !== undefined && !(hasConfigUrl && hasConfigKey)) {
    problems.push(
      'IVANTI_IMPERSONATION_ROLE is set, but impersonation is not configured: it needs ' +
        'IVANTI_CONFIG_URL and IVANTI_CENTRAL_CONFIG_API_KEY (or IVANTI_CENTRAL_CONFIG_API_KEY_FILE). ' +
        "Without them nothing is pinned and sessions run under the service account's own role.",
    );
  }

  // `enduser` chooses a self-service role; pinning an arbitrary one is a `full` mode decision.
  // Ignoring it silently would hand a deployment a different session than it asked for.
  if (config.MCP_MODE === 'enduser' && config.IVANTI_IMPERSONATION_ROLE !== undefined) {
    problems.push(
      'IVANTI_IMPERSONATION_ROLE applies to MCP_MODE=full. In enduser mode the session opens ' +
        'under ENDUSER_ROLE, which must name a self-service role.',
    );
  }

  if (config.MCP_MODE === 'enduser' && config.ENDUSER_BUSINESS_OBJECTS.length === 0) {
    problems.push(
      'MCP_MODE=enduser requires ENDUSER_BUSINESS_OBJECTS, listing the technical Business ' +
        'Object names end users may create.',
    );
  }

  // An employee deployment whose operator forgot to flip the mode — `full` is the default — would
  // start, look configured, and hand every employee the whole IT-staff surface, with the
  // allowlist that was meant to narrow it silently ignored.
  if (config.MCP_MODE === 'full') {
    const stray = ENDUSER_SETTINGS.filter((setting) => {
      const value: unknown = config[setting as keyof Config];
      return provided.has(setting) || (Array.isArray(value) && value.length > 0);
    });
    if (stray.length > 0) {
      problems.push(
        `${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} set, but MCP_MODE is full` +
          `${provided.has('MCP_MODE') ? '' : ' (the default — MCP_MODE is not set)'}, which ` +
          'ignores every ENDUSER_* setting and serves the whole IT-staff tool surface. For an ' +
          `employee deployment set MCP_MODE=enduser; otherwise remove ${stray.length === 1 ? 'it' : 'them'}.`,
      );
    }
  }

  return problems;
}

/**
 * The licence settings (design §9f). Every one fails closed: a deployment with no key, or no
 * stable identity to hold its seat by, is refused at startup rather than discovered later as a
 * server that refuses every tool for a reason nobody reads.
 */
function licenceProblems(config: Config): string[] {
  const problems: string[] = [];

  if (config.LICENSE_KEY === undefined) {
    problems.push(
      'LICENSE_KEY (or LICENSE_KEY_FILE) is required: the Synergy Hub licence key this ' +
        'installation activates with.',
    );
  }

  // Under stdio the config folder is the identity's home, so one can be generated there. Over
  // HTTP the process is a pod or a container that loses whatever it writes, and a fresh identity
  // on every start would take a fresh seat on every start.
  if (isHttpTransport(config) && config.LICENSE_INSTALL_ID === undefined) {
    problems.push(
      'LICENSE_INSTALL_ID (or LICENSE_INSTALL_ID_FILE) is required over HTTP: a UUID generated ' +
        'once for this installation and never changed, or every start takes a new licence seat. ' +
        'Generate one with `node -e "console.log(crypto.randomUUID())"`; the Helm chart makes ' +
        'and keeps one itself.',
    );
  }

  if (config.LICENSE_STATE_DIR !== undefined && config.LICENSE_STATE_SECRET !== undefined) {
    problems.push(
      'LICENSE_STATE_DIR and LICENSE_STATE_SECRET are both set; the last licence token is kept ' +
        'in one place. Set LICENSE_STATE_SECRET under Kubernetes, LICENSE_STATE_DIR elsewhere.',
    );
  }

  return problems;
}

function metricsProblems(config: Config): string[] {
  const problems: string[] = [];

  if (config.METRICS_PORT === undefined) {
    problems.push(
      'METRICS_PORT is required with METRICS_ON=true. There is no built-in port, for the same ' +
        'reason as MCP_PORT: it has to agree with whatever scrapes it.',
    );
  }

  if (
    config.HTTP_TRANSPORT_ON &&
    config.METRICS_PORT !== undefined &&
    config.METRICS_PORT === config.MCP_PORT
  ) {
    problems.push(
      `METRICS_PORT and MCP_PORT are both ${String(config.MCP_PORT)}. Metrics have a port of ` +
        'their own so that nothing in front of the MCP port — an ingress, a tunnel — reaches ' +
        'them; give METRICS_PORT another one.',
    );
  }

  const token = config.METRICS_TOKEN;
  if (token !== undefined && token.length < MIN_BEARER_TOKEN_LENGTH) {
    problems.push(
      `METRICS_TOKEN is ${String(token.length)} characters; it must be at least ` +
        `${String(MIN_BEARER_TOKEN_LENGTH)}. Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  // The point of a scrape token is that leaking it leaks counters. One that is also a key to the
  // tools or the tenant would hand those to everything that scrapes.
  const reused = (
    [
      ['BEARER_TOKEN', config.BEARER_TOKEN],
      ['IVANTI_API_KEY', config.IVANTI_API_KEY],
      ['IVANTI_CENTRAL_CONFIG_API_KEY', config.IVANTI_CENTRAL_CONFIG_API_KEY],
    ] as const
  ).find(([, secret]) => token !== undefined && secret === token);
  if (reused !== undefined) {
    problems.push(
      `METRICS_TOKEN is the same as ${reused[0]}. A scraper must hold a secret that reaches ` +
        'nothing but the metrics; generate one of its own.',
    );
  }

  return problems;
}

/**
 * The startup probe's answer, held against `IVANTI_IMPERSONATION_REQUIRED`.
 *
 * Separate from `validateConfig` because it cannot run until the tenant has answered, like the
 * allowlist check. Without the setting an unreachable ConfigDB is a warning and `act_as` decides
 * scope only; with it, running as the service account is the one outcome the operator ruled out.
 */
export function requiredImpersonationProblems(
  config: Config,
  probe: { canImpersonate: boolean; impersonationReason?: string },
): string[] {
  if (!config.IVANTI_IMPERSONATION_REQUIRED || probe.canImpersonate) return [];
  return [
    'IVANTI_IMPERSONATION_REQUIRED=true, but impersonation is unavailable' +
      (probe.impersonationReason === undefined
        ? ''
        : `: ${probe.impersonationReason.slice(0, 200)}`) +
      '. Refusing to run as the service account; check IVANTI_CONFIG_URL and ' +
      'IVANTI_CENTRAL_CONFIG_API_KEY, or unset IVANTI_IMPERSONATION_REQUIRED.',
  ];
}
