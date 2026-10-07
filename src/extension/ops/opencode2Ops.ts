import { join } from 'node:path';
import {
  configureOpencode2,
  opencode2Availability,
  opencode2BinaryPath,
  opencode2Config,
  opencode2IsolationEnv,
  OPENCODE2_FIXTURE_VERSION,
} from '../../agent/opencode2Binary.js';
import type { OutputProbe } from '../../runtime/deps.js';

/**
 * The host-side opencode2 wiring, kept out of `extension.ts` (which is under a
 * line ratchet and must stay a thin binding). `vscode` is never imported here:
 * every side effect — reading the setting, probing `--version`, logging,
 * creating the login terminal — is injected by the caller.
 */

export interface Opencode2ConfigHost {
  /** Raw `karst.opencode2.binaryPath` setting value. */
  binaryPathSetting: string;
  /** `context.globalStorageUri.fsPath`; the isolated dirs live under it. */
  globalStoragePath: string;
}

/** Point the process-wide opencode2 resolver at the configured path + home. */
export function applyOpencode2Config(host: Opencode2ConfigHost): void {
  configureOpencode2({
    binaryPath: host.binaryPathSetting,
    home: join(host.globalStoragePath, 'opencode2'),
  });
}

export interface Opencode2CheckHost {
  /** Captures `<binary> --version` (real: `readCommandOutput`). */
  readVersion: OutputProbe;
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Accept `>=2.0.24 <3`; refuse v1 (the same launcher name) and warn when the
 * binary is newer than the version this core was live-verified against.
 */
export function checkOpencode2Binary(host: Opencode2CheckHost): void {
  const binaryPath = opencode2BinaryPath();
  if (!binaryPath) return;
  // Even this `--version` is a v2 process: run it under the karst-owned dirs so
  // it cannot touch the user's real opencode state (criterion 2).
  const { stdout, exitCode } = host.readVersion(
    binaryPath,
    ['--version'],
    opencode2IsolationEnv(opencode2Config().home),
  );
  const availability = opencode2Availability(binaryPath, stdout, exitCode);
  if (availability.state !== 'ok') {
    host.warn(`[agent:opencode2] ${availability.reason}`);
    return;
  }
  if (availability.newerThanFixture) {
    host.warn(
      `[agent:opencode2] ${binaryPath} reports ${availability.version}, newer than the ` +
        `verified ${OPENCODE2_FIXTURE_VERSION}`,
    );
  } else {
    host.info(`[agent:opencode2] binary ok (${availability.version})`);
  }
}

export interface Opencode2Login {
  name: string;
  env: Record<string, string>;
  text: string;
}

/**
 * The login terminal description, or null when no binary is configured. Runs
 * `<binaryPath> auth login` under the SAME isolated XDG env every spawn uses,
 * so credentials land in karst's store and never the user's real dirs.
 */
export function opencode2LoginCommand(): Opencode2Login | null {
  const binaryPath = opencode2BinaryPath();
  if (!binaryPath) return null;
  return {
    name: 'Karst: OpenCode v2 login',
    env: opencode2IsolationEnv(opencode2Config().home),
    text: `"${binaryPath}" auth login`,
  };
}
