// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from './env-schema.js';
import { describe, expect, it } from 'vitest';
import { configFixture } from './config.fixture.js';
import {
  canonicalUriProblems,
  isExposedToNetwork,
  isHttpTransport,
  isImpersonationConfigured,
  isIvantiConfigured,
  requiredImpersonationProblems,
  CALLS_PER_MINUTE_BOUNDS,
  CONCURRENCY_BOUNDS,
  validateConfig,
} from './validate-config.js';

const config = configFixture;

describe('isHttpTransport', () => {
  it('is decided by the transport, not by the auth mode', () => {
    expect(isHttpTransport(config({ STDIO_TRANSPORT_ON: true }))).toBe(false);
    expect(isHttpTransport(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'none' }))).toBe(true);
    expect(isHttpTransport(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'oauth' }))).toBe(true);
  });
});

describe('isExposedToNetwork', () => {
  it('recognises loopback addresses', () => {
    expect(isExposedToNetwork(config({ MCP_BIND: '127.0.0.1' }))).toBe(false);
    expect(isExposedToNetwork(config({ MCP_BIND: '::1' }))).toBe(false);
  });

  it('treats anything else as exposed', () => {
    expect(isExposedToNetwork(config({ MCP_BIND: '0.0.0.0' }))).toBe(true);
  });
});

describe('canonicalUriProblems', () => {
  it('accepts a canonical resource URI', () => {
    expect(canonicalUriProblems('https://mcp.example.com/mcp')).toEqual([]);
    expect(canonicalUriProblems('https://mcp.example.com')).toEqual([]);
    expect(canonicalUriProblems('https://mcp.example.com:8443')).toEqual([]);
  });

  it('rejects a fragment, which RFC 8707 forbids in a resource identifier', () => {
    expect(canonicalUriProblems('https://mcp.example.com/mcp#x')).toHaveLength(1);
  });

  it('rejects a trailing slash, which would not match the token audience verbatim', () => {
    expect(canonicalUriProblems('https://mcp.example.com/')).toHaveLength(1);
  });
});

describe('validateConfig', () => {
  it('accepts a minimal stdio configuration', () => {
    expect(validateConfig(config())).toEqual([]);
  });

  describe('metrics', () => {
    const LONG = 'a'.repeat(40);
    const http: Partial<Config> = {
      HTTP_TRANSPORT_ON: true,
      AUTH_MODE: 'none',
      MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
      TRUSTED_ORIGINS: ['http://127.0.0.1:3000'],
    };

    it('refuses the MCP port, which whatever fronts the MCP listener would reach', () => {
      const problems = validateConfig(config({ ...http, METRICS_ON: true, METRICS_PORT: 3000 }));

      expect(problems).toEqual([expect.stringContaining('METRICS_PORT and MCP_PORT are both 3000')]);
    });

    it('requires a port while on, having no default to fall back on', () => {
      expect(validateConfig(config({ METRICS_ON: true, METRICS_PORT: undefined }))).toEqual([
        expect.stringContaining('METRICS_PORT is required with METRICS_ON=true'),
      ]);
    });

    it('refuses a short token, and one that is also a key to the tools or the tenant', () => {
      expect(validateConfig(config({ METRICS_ON: true, METRICS_TOKEN: 'short' }))).toEqual([
        expect.stringContaining('METRICS_TOKEN is 5 characters'),
      ]);
      expect(
        validateConfig(config({ METRICS_ON: true, METRICS_TOKEN: LONG, BEARER_TOKEN: LONG })),
      ).toContainEqual(expect.stringContaining('METRICS_TOKEN is the same as BEARER_TOKEN'));
    });

    // Turning metrics off is one setting: the rest may stay where it is.
    it('judges nothing while off', () => {
      expect(
        validateConfig(config({ ...http, METRICS_ON: false, METRICS_PORT: 3000, METRICS_TOKEN: 'short' })),
      ).toEqual([]);
    });
  });

  it.each([
    ['IVANTI_MAX_CONCURRENT_REQUESTS', 0],
    ['IVANTI_MAX_CONCURRENT_REQUESTS', 257],
    ['MCP_MAX_CALLS_PER_MINUTE', 0],
    ['MCP_MAX_CALLS_PER_MINUTE', 10_001],
  ] as const)('refuses %s=%i, outside what protects the tenant without stopping it', (setting, value) => {
    const problems = validateConfig(config({ [setting]: value }));

    expect(problems).toEqual([expect.stringContaining(`${setting}=${String(value)} is outside`)]);
  });

  it('refuses a configuration that serves nobody', () => {
    const problems = validateConfig(config({ STDIO_TRANSPORT_ON: false }));

    expect(problems.some((problem) => problem.includes('would serve nobody'))).toBe(true);
  });

  it('allows both transports at once', () => {
    const problems = validateConfig(
      config({
        STDIO_TRANSPORT_ON: true,
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('requires MCP_PORT for HTTP, having no default to fall back on', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_PORT: undefined,
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems).toEqual([expect.stringContaining('MCP_PORT is required for HTTP transports')]);
  });

  it('needs no port under stdio alone, which listens on none', () => {
    expect(validateConfig(config({ MCP_PORT: undefined, METRICS_PORT: undefined }))).toEqual([]);
  });

  it('requires an explicit auth mode before serving on a socket', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true }));

    expect(problems.some((problem) => problem.includes('requires AUTH_MODE'))).toBe(true);
  });

  it('rejects an auth mode under stdio rather than letting it look protective', () => {
    const problems = validateConfig(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 't' }));

    expect(
      problems.some((problem) => problem.includes('no effect with HTTP_TRANSPORT_ON=false')),
    ).toBe(true);
  });

  it('requires MCP_PUBLIC_URL for HTTP transports', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'bearer', BEARER_TOKEN: 't' }));

    expect(problems.some((problem) => problem.includes('MCP_PUBLIC_URL'))).toBe(true);
  });

  it('surfaces a non-canonical public URL', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'bearer',
        BEARER_TOKEN: 't',
        MCP_PUBLIC_URL: 'https://mcp.example.com/',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems.some((problem) => problem.includes('trailing slash'))).toBe(true);
  });

  it('requires TRUSTED_ORIGINS for HTTP transports', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'bearer',
        BEARER_TOKEN: 't',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
      }),
    );

    expect(problems.some((problem) => problem.includes('TRUSTED_ORIGINS'))).toBe(true);
  });

  it('requires a token in bearer mode', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'bearer' }));

    expect(problems.some((problem) => problem.includes('BEARER_TOKEN'))).toBe(true);
  });

  it('permits open mode on a non-loopback bind, since MCP_BIND is a second explicit key', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_BIND: '0.0.0.0',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('still requires an origin allowlist when open mode is exposed', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_BIND: '0.0.0.0',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
      }),
    );

    expect(problems.some((problem) => problem.includes('TRUSTED_ORIGINS'))).toBe(true);
  });

  it('allows open mode on loopback', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000',
        TRUSTED_ORIGINS: ['http://localhost:3000'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('requires a Business Object allowlist in enduser mode', () => {
    const problems = validateConfig(config({ MCP_MODE: 'enduser' }));

    expect(problems.some((problem) => problem.includes('ENDUSER_BUSINESS_OBJECTS'))).toBe(true);
  });

  it('accepts enduser mode once the allowlist is present', () => {
    const problems = validateConfig(
      config({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['Incident'] }),
    );

    expect(problems).toEqual([]);
  });

  it('refuses an Ivanti base URL without a key', () => {
    const problems = validateConfig(config({ IVANTI_BASE_URL: 'https://t.ivanticloud.com' }));

    expect(problems.some((problem) => problem.includes('IVANTI_API_KEY'))).toBe(true);
  });

  it('refuses an Ivanti key without a base URL', () => {
    const problems = validateConfig(config({ IVANTI_API_KEY: 'k' }));

    expect(problems.some((problem) => problem.includes('IVANTI_BASE_URL'))).toBe(true);
  });

  it('accepts both together, and neither at all', () => {
    expect(
      validateConfig(config({ IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY: 'k' })),
    ).toEqual([]);
    expect(validateConfig(config({}))).toEqual([]);
  });
});

/**
 * Each of these carries a credential or decides which tokens are trusted. Over plain http anyone on
 * the path reads the API key, or swaps the signing keys a token is checked against.
 */
describe('settings that must not travel in clear text', () => {
  /** The OAUTH_* settings are only legal under oauth. */
  const OAUTH_MODE = {
    HTTP_TRANSPORT_ON: true,
    AUTH_MODE: 'oauth' as const,
    MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    TRUSTED_ORIGINS: ['https://mcp.example.com'],
  };

  /** What each setting needs alongside it, so the only problem left is the scheme. */
  const PAIRS = {
    IVANTI_BASE_URL: { IVANTI_API_KEY: 'k' },
    IVANTI_CONFIG_URL: {
      IVANTI_BASE_URL: 'https://t.ivanticloud.com',
      IVANTI_API_KEY: 'k',
      IVANTI_CENTRAL_CONFIG_API_KEY: 'c',
    },
    OAUTH_ISSUER: { ...OAUTH_MODE },
    OAUTH_JWKS_URI: { ...OAUTH_MODE, OAUTH_ISSUER: 'https://idp.example.com' },
  } as const;

  it.each(Object.keys(PAIRS) as (keyof typeof PAIRS)[])('refuses http:// for %s', (setting) => {
    const problems = validateConfig(
      config({ ...PAIRS[setting], [setting]: 'http://idp.example.com/realms/corp' }),
    );

    expect(problems).toEqual([expect.stringMatching(new RegExp(`^${setting} must use https://`))]);
  });

  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.12.0.3',
    'http://[::1]:8443',
  ])('allows http:// to a loopback host (%s), where there is no network to cross', (url) => {
    expect(validateConfig(config({ IVANTI_BASE_URL: url, IVANTI_API_KEY: 'k' }))).toEqual([]);
    expect(validateConfig(config({ ...OAUTH_MODE, OAUTH_ISSUER: url }))).toEqual([]);
  });

  it.each(['http://127.0.0.1.example.com', 'http://localhost.example.com', 'http://10.0.0.5'])(
    'does not take %s for loopback',
    (url) => {
      expect(
        validateConfig(config({ ...OAUTH_MODE, OAUTH_ISSUER: 'https://idp.example.com', OAUTH_JWKS_URI: url })),
      ).toHaveLength(1);
    },
  );

  it('refuses a scheme that is not http at all', () => {
    expect(
      validateConfig(config({ ...OAUTH_MODE, OAUTH_ISSUER: 'ftp://idp.example.com' })),
    ).toHaveLength(1);
  });
});

describe('bearer token strength', () => {
  const bearer = (token: string) =>
    config({
      HTTP_TRANSPORT_ON: true,
      AUTH_MODE: 'bearer',
      BEARER_TOKEN: token,
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      TRUSTED_ORIGINS: ['https://claude.ai'],
    });

  it('refuses a token under 32 characters — the old placeholder among them', () => {
    expect(validateConfig(bearer('change-me'))).toEqual([
      expect.stringMatching(/BEARER_TOKEN is 9 characters; it must be at least 32/),
    ]);
    expect(validateConfig(bearer('x'.repeat(31)))).toHaveLength(1);
  });

  it('accepts one of 32 or more', () => {
    expect(validateConfig(bearer('x'.repeat(32)))).toEqual([]);
  });
});

describe('isIvantiConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(isIvantiConfigured(config({}))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_BASE_URL: 'https://t' }))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_API_KEY: 'k' }))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_BASE_URL: 'https://t', IVANTI_API_KEY: 'k' }))).toBe(
      true,
    );
  });
});

const TENANT = { IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY: 'k' } as const;
const CONFIG_DB = {
  IVANTI_CONFIG_URL: 'https://config-t.ivanticloud.com',
  IVANTI_CENTRAL_CONFIG_API_KEY: 'c',
} as const;

describe('impersonation configuration', () => {
  it('refuses a ConfigDB URL without its key', () => {
    const problems = validateConfig(config({ ...TENANT, IVANTI_CONFIG_URL: CONFIG_DB.IVANTI_CONFIG_URL }));

    expect(problems.some((problem) => problem.includes('IVANTI_CENTRAL_CONFIG_API_KEY'))).toBe(true);
  });

  it('refuses a ConfigDB key without its URL', () => {
    const problems = validateConfig(config({ ...TENANT, IVANTI_CENTRAL_CONFIG_API_KEY: 'c' }));

    expect(problems.some((problem) => problem.includes('IVANTI_CONFIG_URL'))).toBe(true);
  });

  // Impersonation acts on a tenant; configured without one it would look enabled and refuse every
  // act_as, which reads as broken rather than unconfigured.
  it('refuses impersonation without a tenant to impersonate against', () => {
    const problems = validateConfig(config({ ...CONFIG_DB }));

    expect(problems.some((problem) => problem.includes('IVANTI_BASE_URL'))).toBe(true);
  });

  it('accepts the pair alongside a tenant, and neither at all', () => {
    expect(validateConfig(config({ ...TENANT, ...CONFIG_DB }))).toEqual([]);
    expect(validateConfig(config({ ...TENANT }))).toEqual([]);
  });

  // Pinning an arbitrary role is a full-mode decision: enduser opens a self-service role, so the
  // setting would be silently ignored — and a deployment that asked for a role and got a
  // different one should be told at startup, not left to find out.
  it('refuses a pinned impersonation role in enduser mode', () => {
    const problems = validateConfig(
      config({
        ...TENANT,
        MCP_MODE: 'enduser',
        ENDUSER_BUSINESS_OBJECTS: ['incident'],
        IVANTI_IMPERSONATION_ROLE: 'Admin',
      }),
    );

    expect(problems.some((problem) => problem.includes('IVANTI_IMPERSONATION_ROLE'))).toBe(true);
  });

  it('allows a pinned impersonation role in full mode', () => {
    expect(
      validateConfig(config({ ...TENANT, ...CONFIG_DB, IVANTI_IMPERSONATION_ROLE: 'Admin' })),
    ).toEqual([]);
  });
});

describe('isImpersonationConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(isImpersonationConfigured(config({}))).toBe(false);
    expect(isImpersonationConfigured(config({ IVANTI_CONFIG_URL: 'https://c' }))).toBe(false);
    expect(isImpersonationConfigured(config({ IVANTI_CENTRAL_CONFIG_API_KEY: 'c' }))).toBe(false);
    expect(isImpersonationConfigured(config({ ...CONFIG_DB }))).toBe(true);
  });
});

const OAUTH = {
  HTTP_TRANSPORT_ON: true,
  AUTH_MODE: 'oauth' as const,
  OAUTH_ISSUER: 'https://id.example.com',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  TRUSTED_ORIGINS: ['https://mcp.example.com'],
};

describe('MCP_MAX_SESSIONS_PER_SUBJECT', () => {
  it('is accepted under oauth, where a token names the subject', () => {
    expect(validateConfig(config({ ...OAUTH, MCP_MAX_SESSIONS_PER_SUBJECT: 3 }))).toEqual([]);
  });

  // Under `none` and `bearer` every caller is one anonymous subject: the limit would either do
  // nothing or cap the whole deployment at it.
  it.each(['none', 'bearer'] as const)('is refused under AUTH_MODE=%s', (mode) => {
    const problems = validateConfig(
      config({
        ...OAUTH,
        AUTH_MODE: mode,
        BEARER_TOKEN: 't',
        MCP_MAX_SESSIONS_PER_SUBJECT: 3,
      }),
    );

    expect(problems.some((problem) => problem.includes('MCP_MAX_SESSIONS_PER_SUBJECT'))).toBe(true);
  });

  it('is refused above the global cap, which it could never reach', () => {
    const problems = validateConfig(
      config({ ...OAUTH, MCP_MAX_SESSIONS: 5, MCP_MAX_SESSIONS_PER_SUBJECT: 6 }),
    );

    expect(problems.some((problem) => problem.includes('could never apply'))).toBe(true);
  });
});

describe('IVANTI_IMPERSONATION_REQUIRED', () => {
  it('is refused without the ConfigDB pair it requires', () => {
    const problems = validateConfig(config({ ...TENANT, IVANTI_IMPERSONATION_REQUIRED: true }));

    expect(problems.some((problem) => problem.includes('IVANTI_IMPERSONATION_REQUIRED'))).toBe(
      true,
    );
  });

  it('is accepted alongside the pair', () => {
    expect(
      validateConfig(config({ ...TENANT, ...CONFIG_DB, IVANTI_IMPERSONATION_REQUIRED: true })),
    ).toEqual([]);
  });
});

describe('requiredImpersonationProblems', () => {
  const required = config({ ...TENANT, ...CONFIG_DB, IVANTI_IMPERSONATION_REQUIRED: true });

  // The one outcome the setting exists to rule out: a probe that failed, and a server that then
  // carried on as the service account.
  it('refuses to run when the probe could not impersonate, naming why', () => {
    const problems = requiredImpersonationProblems(required, {
      canImpersonate: false,
      impersonationReason: 'ConfigDB answered 401',
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ConfigDB answered 401');
    expect(problems[0]).toContain('service account');
  });

  it('is satisfied when the probe could', () => {
    expect(requiredImpersonationProblems(required, { canImpersonate: true })).toEqual([]);
  });

  // Unchanged default: a failed probe degrades with a warning rather than stopping the server.
  it('says nothing when impersonation is not required', () => {
    expect(
      requiredImpersonationProblems(config({ ...TENANT, ...CONFIG_DB }), { canImpersonate: false }),
    ).toEqual([]);
  });
});

describe('settings of an axis that is not in use', () => {
  const HTTP = {
    HTTP_TRANSPORT_ON: true,
    MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    TRUSTED_ORIGINS: ['https://mcp.example.com'],
  };
  const TENANT_ONLY = { IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY: 'k' };

  it('refuses IVANTI_IMPERSONATION_ROLE without the ConfigDB pair, where nothing would pin it', () => {
    const problems = validateConfig(config({ ...TENANT_ONLY, IVANTI_IMPERSONATION_ROLE: 'Admin' }));

    expect(problems).toEqual([expect.stringContaining('IVANTI_IMPERSONATION_ROLE is set')]);
  });

  it.each(['none', 'bearer'] as const)('refuses OAUTH_* settings under AUTH_MODE=%s', (mode) => {
    const problems = validateConfig(
      config({
        ...HTTP,
        AUTH_MODE: mode,
        BEARER_TOKEN: 'b'.repeat(32),
        OAUTH_ISSUER: 'https://id.example.com',
        OAUTH_REQUIRED_SCOPES: ['mcp'],
      }),
      new Set(['OAUTH_ISSUER']),
    );

    const oauth = problems.filter((problem) => problem.includes('OAUTH_ISSUER'));
    expect(oauth).toHaveLength(1);
    expect(oauth[0]).toContain('OAUTH_REQUIRED_SCOPES');
  });

  it('refuses a provided OAUTH_* setting even when its value is the default', () => {
    const problems = validateConfig(
      config({ ...HTTP, AUTH_MODE: 'none' }),
      new Set(['OAUTH_AUDIENCE']),
    );

    expect(problems).toEqual([expect.stringContaining('OAUTH_AUDIENCE is set')]);
  });

  it.each(['none', 'oauth'] as const)('refuses BEARER_TOKEN under AUTH_MODE=%s', (mode) => {
    const problems = validateConfig(
      config({
        ...HTTP,
        AUTH_MODE: mode,
        BEARER_TOKEN: 'b'.repeat(32),
        ...(mode === 'oauth' ? { OAUTH_ISSUER: 'https://id.example.com' } : {}),
      }),
    );

    expect(problems).toEqual([expect.stringContaining('BEARER_TOKEN')]);
  });

  it('refuses IVANTI_MAX_TIER with no tenant', () => {
    const problems = validateConfig(config({ IVANTI_MAX_TIER: 'odata' }));

    expect(problems).toEqual([expect.stringContaining('IVANTI_MAX_TIER is set')]);
    expect(validateConfig(config({ ...TENANT_ONLY, IVANTI_MAX_TIER: 'odata' }))).toEqual([]);
  });

  it('accepts the settings under the mode that reads them', () => {
    expect(
      validateConfig(
        config({ ...HTTP, AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://id.example.com' }),
      ),
    ).toEqual([]);
    expect(
      validateConfig(config({ ...HTTP, AUTH_MODE: 'bearer', BEARER_TOKEN: 'b'.repeat(32) })),
    ).toEqual([]);
  });
});

describe('AUTH_MODE=oauth', () => {
  it('requires OAUTH_ISSUER, refused at configuration time with the rest', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'oauth',
        MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
        TRUSTED_ORIGINS: ['https://mcp.example.com'],
      }),
    );

    expect(problems).toEqual(['AUTH_MODE=oauth requires OAUTH_ISSUER.']);
  });
});

describe('numeric bounds', () => {
  it('states the same range it checks, for both limits', () => {
    for (const [setting, bounds] of [
      ['IVANTI_MAX_CONCURRENT_REQUESTS', CONCURRENCY_BOUNDS],
      ['MCP_MAX_CALLS_PER_MINUTE', CALLS_PER_MINUTE_BOUNDS],
    ] as const) {
      const range = `${String(bounds.min)}–${String(bounds.max)}`;
      for (const value of [bounds.min - 1, bounds.max + 1]) {
        expect(validateConfig(config({ [setting]: value }))).toEqual([
          expect.stringContaining(`is outside ${range}`),
        ]);
      }
      for (const value of [bounds.min, bounds.max]) {
        expect(validateConfig(config({ [setting]: value }))).toEqual([]);
      }
    }
  });
});

describe('licence settings (design §9f)', () => {
  const licenceProblems = (overrides: Partial<Config>) =>
    validateConfig(config(overrides)).filter((problem) => problem.includes('LICENSE_'));
  const http = { HTTP_TRANSPORT_ON: true, AUTH_MODE: 'none', MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp' } as const;

  it('accepts the fixture: a key and an install ID', () => {
    expect(licenceProblems({})).toEqual([]);
  });

  it('refuses a missing licence key, in every transport', () => {
    expect(licenceProblems({ LICENSE_KEY: undefined })).toEqual([
      expect.stringMatching(/^LICENSE_KEY \(or LICENSE_KEY_FILE\) is required/),
    ]);
    expect(licenceProblems({ ...http, LICENSE_KEY: undefined })).toEqual([
      expect.stringMatching(/^LICENSE_KEY \(or LICENSE_KEY_FILE\) is required/),
    ]);
  });

  it('lets stdio go without an install ID, which it generates itself', () => {
    expect(licenceProblems({ LICENSE_INSTALL_ID: undefined })).toEqual([]);
  });

  it('refuses HTTP without an install ID, since every start would take a new seat', () => {
    expect(licenceProblems({ ...http, LICENSE_INSTALL_ID: undefined })).toEqual([
      expect.stringMatching(/^LICENSE_INSTALL_ID \(or LICENSE_INSTALL_ID_FILE\) is required over HTTP/),
    ]);
  });

  it('refuses keeping the token in two places', () => {
    expect(
      licenceProblems({ LICENSE_STATE_DIR: '/var/lib/ivanti-mcp', LICENSE_STATE_SECRET: 'licence-state' }),
    ).toEqual([expect.stringMatching(/^LICENSE_STATE_DIR and LICENSE_STATE_SECRET are both set/)]);
  });
});
