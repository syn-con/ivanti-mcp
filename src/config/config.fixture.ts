// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from './env-schema.js';

/**
 * Test-only Config builder. Kept in one place so that adding a setting does not require
 * editing every test that happens to need a Config.
 */
export const configFixture = (overrides: Partial<Config> = {}): Config => ({
  STDIO_TRANSPORT_ON: true,
  HTTP_TRANSPORT_ON: false,
  AUTH_MODE: undefined,
  MCP_MODE: 'full',
  MCP_BIND: '127.0.0.1',
  MCP_PORT: 3000,
  MCP_PUBLIC_URL: undefined,
  TRUSTED_ORIGINS: [],
  MCP_SESSION_IDLE_TTL_SECONDS: 1800,
  MCP_IDENTITY_IDLE_TTL_SECONDS: 1800,
  MCP_MAX_SESSIONS: 100,
  MCP_MAX_SESSIONS_PER_SUBJECT: undefined,
  IVANTI_IMPERSONATION_REQUIRED: false,
  BEARER_TOKEN: undefined,
  OAUTH_ISSUER: undefined,
  OAUTH_AUDIENCE: [],
  OAUTH_JWKS_URI: undefined,
  OAUTH_SCOPES_SUPPORTED: [],
  OAUTH_REQUIRED_SCOPES: [],
  OAUTH_REQUIRE_TYP: undefined,
  IVANTI_BASE_URL: undefined,
  IVANTI_API_KEY: undefined,
  IVANTI_MAX_TIER: undefined,
  IVANTI_TIMEOUT_MS: 10_000,
  IVANTI_WRITE_TIMEOUT_MS: 30_000,
  IVANTI_MAX_CONCURRENT_REQUESTS: 16,
  MCP_MAX_CALLS_PER_MINUTE: 120,
  IVANTI_CONFIG_URL: undefined,
  IVANTI_CENTRAL_CONFIG_API_KEY: undefined,
  IVANTI_IMPERSONATION_ROLE: undefined,
  ENDUSER_BUSINESS_OBJECTS: [],
  ENDUSER_QUICK_ACTIONS: [],
  // Mirrors the schema default, so a test that does not care about the role still gets the one a
  // real enduser deployment would run under.
  ENDUSER_ROLE: 'SelfServiceMobile',
  WRITE_AUDIT_NOTE: 'required',
  LOG_LEVEL: 'info',
  METRICS_ON: false,
  METRICS_BIND: '127.0.0.1',
  METRICS_PORT: 9464,
  METRICS_TOKEN: undefined,
  LICENSE_KEY: 'test-licence-key',
  LICENSE_INSTALL_ID: '00000000-0000-4000-8000-000000000001',
  LICENSE_MACHINE_ID: undefined,
  LICENSE_STATE_DIR: undefined,
  LICENSE_STATE_SECRET: undefined,
  ...overrides,
});
