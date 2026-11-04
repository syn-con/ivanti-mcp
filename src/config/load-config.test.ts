// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { EnvRecord, FileReader } from './read-secret-file.js';
import { ConfigError, loadConfig as loadConfigAsGiven } from './load-config.js';

/** A licence key and install ID every test may assume, so each one is about its own setting. */
const LICENSED: EnvRecord = {
  LICENSE_KEY: 'test-licence-key',
  LICENSE_INSTALL_ID: '00000000-0000-4000-8000-000000000001',
};

const loadConfig = (env: EnvRecord, readFile?: FileReader) =>
  loadConfigAsGiven({ ...LICENSED, ...env }, readFile);

/** Long enough to be accepted: a bearer token is refused under 32 characters. */
const FILE_TOKEN = 'token-from-file-long-enough-to-be-accepted';

describe('loadConfig', () => {
  it('loads with no environment at all, defaulting to stdio', () => {
    const config = loadConfig({});

    expect(config.STDIO_TRANSPORT_ON).toBe(true);
    expect(config.HTTP_TRANSPORT_ON).toBe(false);
    expect(config.AUTH_MODE).toBeUndefined();
    expect(config.MCP_MODE).toBe('full');
  });

  it('expires an identity on its own clock, not the HTTP session\'s', () => {
    // The identity TTL borrowed MCP_SESSION_IDLE_TTL_SECONDS for one release. They answer
    // different questions — one bounds memory held by a dead HTTP session, the other decides how
    // long a person\'s records stay reachable to whoever is at the keyboard, and on stdio it is
    // the only thing that ends a conversation at all. Tuning one must not move the other.
    const config = loadConfig({ MCP_SESSION_IDLE_TTL_SECONDS: '60' });

    expect(config.MCP_SESSION_IDLE_TTL_SECONDS).toBe(60);
    expect(config.MCP_IDENTITY_IDLE_TTL_SECONDS).toBe(1800);

    const tuned = loadConfig({ MCP_IDENTITY_IDLE_TTL_SECONDS: '300' });

    expect(tuned.MCP_IDENTITY_IDLE_TTL_SECONDS).toBe(300);
    expect(tuned.MCP_SESSION_IDLE_TTL_SECONDS).toBe(1800);
  });

  it('resolves a file-backed secret before validating rules that depend on it', () => {
    const readFile = vi.fn().mockReturnValue(`${FILE_TOKEN}\n`);

    const config = loadConfig(
      {
        HTTP_TRANSPORT_ON: 'true',
        AUTH_MODE: 'bearer',
        BEARER_TOKEN_FILE: '/run/secrets/bearer',
        MCP_PORT: '3000',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
        TRUSTED_ORIGINS: 'https://claude.ai',
      },
      readFile,
    );

    expect(config.BEARER_TOKEN).toBe(FILE_TOKEN);
  });

  it('reads the metrics token from a file, like the other secrets', () => {
    const readFile = vi.fn().mockReturnValue(`${FILE_TOKEN}\n`);

    const config = loadConfig(
      { METRICS_ON: 'true', METRICS_PORT: '9464', METRICS_TOKEN_FILE: '/run/secrets/metrics-token' },
      readFile,
    );

    expect(config.METRICS_TOKEN).toBe(FILE_TOKEN);
    expect(config.METRICS_ON).toBe(true);
  });

  it('keeps metrics off unless asked', () => {
    expect(loadConfig({}).METRICS_ON).toBe(false);
  });

  it('reports schema problems as a ConfigError', () => {
    expect(() => loadConfig({ AUTH_MODE: 'nonsense' })).toThrow(ConfigError);
  });

  it('refuses an HTTP transport with no auth mode chosen', () => {
    try {
      loadConfig({ HTTP_TRANSPORT_ON: 'true' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect((error as ConfigError).problems.join(' ')).toContain('requires AUTH_MODE');
    }
  });

  it('reports cross-field problems as a ConfigError', () => {
    try {
      loadConfig({ HTTP_TRANSPORT_ON: 'true', AUTH_MODE: 'bearer', BEARER_TOKEN: 't' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join(' ')).toContain('MCP_PUBLIC_URL');
    }
  });

  // No default port: one built in had to be repeated by hand in MCP_PUBLIC_URL, the client and
  // the published ports, and changing one copy left the server answering where nobody looked.
  it.each([
    ['unset', {}],
    ['set to nothing', { MCP_PORT: '' }],
  ])('refuses HTTP with MCP_PORT %s', (_, port) => {
    expect(() =>
      loadConfig({
        HTTP_TRANSPORT_ON: 'true',
        AUTH_MODE: 'none',
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
        TRUSTED_ORIGINS: 'http://localhost',
        ...port,
      }),
    ).toThrow(/MCP_PORT is required for HTTP transports/);
  });

  it('collects every schema problem rather than only the first', () => {
    try {
      loadConfig({ MCP_PORT: 'not-a-port', LOG_LEVEL: 'chatty' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect((error as ConfigError).problems.length).toBeGreaterThan(1);
    }
  });

  it('surfaces a conflicting inline/file secret', () => {
    expect(() =>
      loadConfig(
        { HTTP_TRANSPORT_ON: 'true', AUTH_MODE: 'bearer', BEARER_TOKEN: 'a', BEARER_TOKEN_FILE: '/x' },
        () => 'b',
      ),
    ).toThrow(/provide exactly one/);
  });

  it('resolves IVANTI_API_KEY_FILE the same way as the bearer token', () => {
    const config = loadConfig(
      { IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY_FILE: '/run/secrets/ivanti' },
      () => 'key-from-file',
    );

    expect(config.IVANTI_API_KEY).toBe('key-from-file');
  });

  it('treats a variable set to nothing as unset', () => {
    // `docker run -e AUTH_MODE=` clears a value inherited from an --env-file; so does a bare
    // `AUTH_MODE=` line in .env. Neither should read as an invalid option.
    const config = loadConfig({ AUTH_MODE: '', MCP_BIND: '   ', MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: 'Incident' });

    expect(config.AUTH_MODE).toBeUndefined();
    expect(config.MCP_BIND).toBe('127.0.0.1');
  });

  it('still refuses a value that is wrong rather than empty', () => {
    expect(() => loadConfig({ AUTH_MODE: 'nonsense' })).toThrow(/Invalid option/);
  });

  // The secrets resolve in their own loop, and it used to read the RAW record — so the rule above
  // stopped at their doorstep. Clearing the inline form is the documented way to move to a mounted
  // file, and it reported the opposite of what the operator had just done.
  describe('a secret set to nothing is unset too', () => {
    it('lets an emptied inline token hand over to its _FILE partner', () => {
      const config = loadConfig(
        {
          AUTH_MODE: 'bearer',
          HTTP_TRANSPORT_ON: 'true',
          MCP_PORT: '3000',
          MCP_PUBLIC_URL: 'https://mcp.example.com',
          TRUSTED_ORIGINS: 'https://mcp.example.com',
          BEARER_TOKEN: '',
          BEARER_TOKEN_FILE: '/run/secrets/bearer-token',
        },
        () => FILE_TOKEN,
      );

      expect(config.BEARER_TOKEN).toBe(FILE_TOKEN);
    });

    it('lets an emptied _FILE path hand back to the inline form', () => {
      const config = loadConfig({
        IVANTI_BASE_URL: 'https://t.ivanticloud.com',
        IVANTI_API_KEY: 'inline-key',
        IVANTI_API_KEY_FILE: '',
      });

      expect(config.IVANTI_API_KEY).toBe('inline-key');
    });

    // The one direction this failed OPEN: without the normalisation a whitespace-only token was a
    // token, and `bearer` mode started with it.
    it('refuses to start on a whitespace-only bearer token', () => {
      expect(() =>
        loadConfig({
          AUTH_MODE: 'bearer',
          HTTP_TRANSPORT_ON: 'true',
          MCP_PUBLIC_URL: 'https://mcp.example.com',
          TRUSTED_ORIGINS: 'https://mcp.example.com',
          BEARER_TOKEN: '   ',
        }),
      ).toThrow(/BEARER_TOKEN/);
    });

    it('refuses a placeholder bearer token, and says how to make a real one', () => {
      expect(() =>
        loadConfig({
          AUTH_MODE: 'bearer',
          HTTP_TRANSPORT_ON: 'true',
          MCP_PUBLIC_URL: 'https://mcp.example.com',
          TRUSTED_ORIGINS: 'https://mcp.example.com',
          BEARER_TOKEN: 'change-me',
        }),
      ).toThrow(/at least 32[\s\S]*openssl rand -base64 32/);
    });

    // Narrowing check: a genuine both-set collision must still be refused.
    it('still refuses a token that really is set both ways', () => {
      expect(() =>
        loadConfig(
          { BEARER_TOKEN: 'inline', BEARER_TOKEN_FILE: '/run/secrets/bearer-token' },
          () => 'from-file',
        ),
      ).toThrow(/provide exactly one/);
    });
  });

  /**
   * `full` is the default, and every `ENDUSER_*` setting is ignored in it. An employee deployment
   * whose operator forgot to flip the mode started, looked configured, and handed every employee
   * the whole IT-staff surface with the allowlist silently unused.
   */
  describe('an enduser setting in full mode', () => {
    it.each([
      ['ENDUSER_BUSINESS_OBJECTS', 'Incident,ServiceReq'],
      ['ENDUSER_QUICK_ACTIONS', 'Close From Self Service'],
      // Has a default, so only the environment can say it was set.
      ['ENDUSER_ROLE', 'SelfServiceMobile'],
    ])('refuses %s when MCP_MODE was left at its default', (setting, value) => {
      expect(() => loadConfig({ [setting]: value })).toThrow(
        new RegExp(`${setting} is set, but MCP_MODE is full \\(the default`),
      );
    });

    it('refuses them when full was chosen explicitly too', () => {
      expect(() => loadConfig({ MCP_MODE: 'full', ENDUSER_ROLE: 'SelfService' })).toThrow(
        /ENDUSER_ROLE is set, but MCP_MODE is full, which/,
      );
    });

    it('accepts them in enduser mode', () => {
      expect(
        loadConfig({
          MCP_MODE: 'enduser',
          ENDUSER_BUSINESS_OBJECTS: 'Incident',
          ENDUSER_ROLE: 'SelfServiceMobile',
        }).ENDUSER_ROLE,
      ).toBe('SelfServiceMobile');
    });

    it('does not count one set to nothing', () => {
      expect(loadConfig({ ENDUSER_ROLE: '' }).MCP_MODE).toBe('full');
    });
  });

  describe('Ivanti timeouts', () => {
    it('defaults a read to 10 s and a write to 30 s', () => {
      const config = loadConfig({});

      expect(config.IVANTI_TIMEOUT_MS).toBe(10_000);
      expect(config.IVANTI_WRITE_TIMEOUT_MS).toBe(30_000);
    });

    it.each([
      ['IVANTI_TIMEOUT_MS', '10'],
      ['IVANTI_TIMEOUT_MS', '600000'],
      ['IVANTI_WRITE_TIMEOUT_MS', '999'],
      ['IVANTI_WRITE_TIMEOUT_MS', '300001'],
    ])('refuses %s=%s, outside 1000–300000', (setting, value) => {
      expect(() => loadConfig({ [setting]: value })).toThrow(new RegExp(`${setting}=${value} is outside`));
    });

    it('refuses a write timeout shorter than the read timeout', () => {
      expect(() =>
        loadConfig({ IVANTI_TIMEOUT_MS: '20000', IVANTI_WRITE_TIMEOUT_MS: '15000' }),
      ).toThrow(/IVANTI_WRITE_TIMEOUT_MS \(15000\) is shorter/);
    });

    it('refuses a value that is not a whole number of milliseconds', () => {
      expect(() => loadConfig({ IVANTI_TIMEOUT_MS: '10s' })).toThrow(ConfigError);
    });
  });
});

describe('loadConfig: licence settings', () => {
  it('refuses a configuration with no licence key', () => {
    expect(() => loadConfigAsGiven({})).toThrow(/LICENSE_KEY \(or LICENSE_KEY_FILE\) is required/);
  });

  it('reads the licence key and the install ID from files', () => {
    const files: Record<string, string> = {
      '/run/secrets/licence-key': 'key-from-file\n',
      '/run/secrets/install-id': '00000000-0000-4000-8000-000000000002\n',
    };
    const config = loadConfigAsGiven(
      { LICENSE_KEY_FILE: '/run/secrets/licence-key', LICENSE_INSTALL_ID_FILE: '/run/secrets/install-id' },
      (path) => files[path] ?? '',
    );

    expect(config.LICENSE_KEY).toBe('key-from-file');
    expect(config.LICENSE_INSTALL_ID).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('refuses an install or machine ID that is not a UUID', () => {
    expect(() => loadConfig({ LICENSE_INSTALL_ID: 'my-server' })).toThrow(/LICENSE_INSTALL_ID/);
    expect(() => loadConfig({ LICENSE_MACHINE_ID: 'node-1' })).toThrow(/LICENSE_MACHINE_ID/);
  });

  it('treats an empty Hub address as unset, leaving the built-in one', () => {
    expect(loadConfig({ LICENSE_HUB_URL: '' }).LICENSE_HUB_URL).toBeUndefined();
  });
});
