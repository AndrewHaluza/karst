import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from '../opencode2Auth.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import { containerXdgEnv, type LinuxUser, userArgs, volumeMounts } from './dockerRunArgs.js';

export interface SeedInput {
  readonly proc: DockerProcess;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  /** The host opencode2 launcher and the isolated env whose store holds karst's credentials. */
  readonly hostCommand: string;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly debug?: (message: string) => void;
}

export type SeedResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function inContainer(input: SeedInput, interactive: boolean, args: readonly string[]): string[] {
  const xdg = Object.entries(containerXdgEnv()).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  return [
    'run', '--rm', ...(interactive ? ['--interactive'] : []), '--network', 'none',
    ...userArgs(input.user), ...volumeMounts(input.names), ...xdg,
    OPENCODE_IMAGE, 'opencode2', ...args,
  ];
}

/**
 * opencode2 keeps credentials in its own store, not `auth.json` (ST2B
 * blocker 2). When the data volume's store is empty, stream the host's
 * `auth export` straight into `auth import` inside an offline container. The
 * export prints secrets: it only ever runs through `pipe`, whose bytes never
 * become a JS string, and only exit codes reach `debug` or the reason.
 */
export async function seedOpencode2Credentials(input: SeedInput): Promise<SeedResult> {
  const debug = input.debug ?? (() => undefined);
  const list = await input.proc.run(DOCKER_BIN, inContainer(input, false, OPENCODE2_AUTH_LIST_ARGS));
  if (list.code === 0 && opencode2HasCredentials(list.stdout)) {
    debug('[docker] opencode2 store already has credentials');
    return { ok: true };
  }
  const piped = await input.proc.pipe(
    { command: input.hostCommand, args: ['auth', 'export', '--standalone'], env: input.hostEnv },
    { command: DOCKER_BIN, args: inContainer(input, true, ['auth', 'import', '--standalone']) },
  );
  debug(`[docker] opencode2 credential seed: export exit ${piped.fromCode}, import exit ${piped.toCode}`);
  if (piped.fromCode !== 0) return { ok: false, reason: `opencode2 auth export failed (exit ${piped.fromCode}); sign in on the host first` };
  if (piped.toCode !== 0) return { ok: false, reason: `opencode2 auth import in the sandbox failed (exit ${piped.toCode})` };
  return { ok: true };
}
