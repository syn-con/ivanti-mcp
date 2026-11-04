// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from '../config/env-schema.js';
import { ConfigError } from '../config/load-config.js';
import { isHttpTransport } from '../config/validate-config.js';
import type { Logger } from '../logger.js';
import { fingerprintFor } from './fingerprint.js';
import type { Licensing } from './heartbeat.js';
import { startLicensing } from './heartbeat.js';
import { createHubClient, DEFAULT_HUB_URL } from './hub-client.js';
import { ensureInstallId } from './install-id.js';
import type { LicenceState } from './licence-state.js';
import { createLicenceState } from './licence-state.js';
import type { KubernetesAccess, LicenceStore } from './state-store.js';
import { createFileStore, createSecretStore, NO_STORE } from './state-store.js';

/** What `index.ts` reads about the machine, so nothing in here reads the environment. */
export interface LicensingPlatform {
  /** This user's config folder: the stdio install ID, and the stored licence under stdio, unless LICENSE_STATE_DIR is set. */
  readonly configDir: string;
  /** The pod's Kubernetes API access; `undefined` outside a pod or when its token is not mounted. */
  readonly kubernetes: () => KubernetesAccess | undefined;
}

export interface LicensingSetup {
  readonly state: LicenceState;
  readonly licensing: Licensing;
}

export function setUpLicensing(config: Config, platform: LicensingPlatform, logger: Logger): LicensingSetup {
  // validateConfig has refused a missing key, and a missing install ID over HTTP.
  const licenceKey = config.LICENSE_KEY ?? '';
  // Kept beside the stored licence when there is a state folder: a container's volume outlives the
  // container, its config folder does not.
  const installId = config.LICENSE_INSTALL_ID ?? stdioInstallId(config.LICENSE_STATE_DIR ?? platform.configDir);
  const fingerprint = fingerprintFor({ installId, machineId: config.LICENSE_MACHINE_ID });
  const store = storeFor(config, platform, logger);
  const state = createLicenceState();

  logger.info('licence: activating with the Synergy Hub', {
    hub: config.LICENSE_HUB_URL ?? DEFAULT_HUB_URL,
    installId: fingerprint.installGuid,
    machineId: fingerprint.machineGuid,
    store: store.describe,
  });

  const licensing = startLicensing({
    hub: createHubClient({ baseUrl: config.LICENSE_HUB_URL, licenceKey }),
    fingerprint,
    state,
    store,
    logger,
  });
  return { state, licensing };
}

/**
 * Under stdio with no LICENSE_INSTALL_ID: the one kept in the config folder. A folder that cannot be
 * written — a read-only container — is a configuration problem with one answer, so it says that.
 */
function stdioInstallId(dir: string): string {
  try {
    return ensureInstallId(dir);
  } catch (error) {
    throw new ConfigError([
      `LICENSE_INSTALL_ID is not set, and none could be kept in ${dir} (${error instanceof Error ? error.message : String(error)}). ` +
        'Set LICENSE_INSTALL_ID to a UUID generated once for this installation, or LICENSE_STATE_DIR to a writable folder ' +
        'that outlives the process — in a container started fresh each time (docker run -i), a volume — or every run takes a new licence seat.',
    ]);
  }
}

function storeFor(config: Config, platform: LicensingPlatform, logger: Logger): LicenceStore {
  if (config.LICENSE_STATE_SECRET !== undefined) {
    const access = platform.kubernetes();
    if (access !== undefined) return createSecretStore(config.LICENSE_STATE_SECRET, access);
    logger.warn(
      'licence: LICENSE_STATE_SECRET is set but no Kubernetes service-account token is mounted; ' +
        'offline restart is off',
      { secret: config.LICENSE_STATE_SECRET },
    );
    return NO_STORE;
  }
  if (config.LICENSE_STATE_DIR !== undefined) return createFileStore(config.LICENSE_STATE_DIR);
  // Under stdio alone the user's config folder is always there and always theirs.
  if (!isHttpTransport(config)) return createFileStore(platform.configDir);
  logger.warn(
    'licence: no LICENSE_STATE_DIR; the 30 days without the Synergy Hub last only while this ' +
      'process runs, and a restart during an outage starts unlicensed',
  );
  return NO_STORE;
}
