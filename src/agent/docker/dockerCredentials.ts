import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from '../opencode2Auth.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import { CONTAINER_REPO, containerXdgEnv, type LinuxUser, userArgs, volumeMounts } from './dockerRunArgs.js';
import { mergeAntigravityTrust } from '../workspaceTrust.js';

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

export const AGY_CREDENTIAL_FILES = ['antigravity-oauth-token', 'jetski_state.pbtxt', 'installation_id'] as const;

export interface SeedAgyInput {
  readonly bridgeDir: string;
  readonly hostHome?: string;
  readonly debug?: (message: string) => void;
}

/**
 * Copies host ~/.gemini/antigravity-cli tokens into the bridge dir so the container's
 * /home/node/.gemini mount has credentials. Verifies each directory segment with lstat
 * so planted symlinks are refused, and preserves newer credentials refreshed inside
 * the container (mtime check).
 */
export async function seedAgyCredentials(input: SeedAgyInput): Promise<SeedResult> {
  const debug = input.debug ?? (() => undefined);
  const bridgeDir = input.bridgeDir;
  const segments = [
    join(bridgeDir, 'antigravity'),
    join(bridgeDir, 'antigravity', 'gemini'),
    join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli'),
    join(bridgeDir, 'antigravity', 'gemini', 'config'),
  ];

  for (const seg of segments) {
    try {
      const st = await lstat(seg);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { ok: false, reason: `antigravity seed: ${seg} is not a plain directory or is a symbolic link` };
      }
      if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) {
        await chmod(seg, 0o700);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(seg, { mode: 0o700, recursive: false });
        if (process.platform !== 'win32') {
          await chmod(seg, 0o700);
        }
      } else {
        return { ok: false, reason: `antigravity seed: cannot access ${seg}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const hostHome = input.hostHome ?? process.env.HOME ?? homedir();
  const srcDir = join(hostHome, '.gemini', 'antigravity-cli');
  const destDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');

  for (const filename of AGY_CREDENTIAL_FILES) {
    const srcPath = join(srcDir, filename);
    const destPath = join(destDir, filename);

    let srcStat;
    try {
      srcStat = await stat(srcPath);
    } catch {
      debug(`[docker] agy credential: ${filename} missing on host, skipping`);
      continue;
    }

    try {
      const destStat = await stat(destPath);
      if (destStat.mtimeMs >= srcStat.mtimeMs) {
        debug(`[docker] agy credential: ${filename} destination is up to date or newer, skipping`);
        continue;
      }
    } catch {
      // Destination is missing, proceed to copy
    }

    const tmpPath = join(destDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
    try {
      const content = await readFile(srcPath);
      await writeFile(tmpPath, content, { flag: 'wx', mode: 0o600 });
      await rename(tmpPath, destPath);
      debug(`[docker] agy credential: copied ${filename}`);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      return { ok: false, reason: `antigravity seed: failed to write ${filename}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { ok: true };
}

/** Settings karst forces on a sandboxed agy: the sandbox is the boundary (@arch:AC-31), so no prompts. */
export const AGY_SANDBOX_SETTINGS = {
  toolPermission: 'always-proceed',
  agentMode: 'auto',
  artifactReviewPolicy: 'agent-decides',
  allowNonWorkspaceAccess: true,
} as const;

/** onboarding.json flags that skip agy's first-run wizard. */
export const AGY_ONBOARDING_DONE = { onboardingComplete: true, consumerOnboardingComplete: true } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonObject(path: string, debug: (m: string) => void): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') debug(`[docker] agy autonomous seed: cannot read ${path}, replacing`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through to replace
  }
  debug(`[docker] agy autonomous seed: ${path} is not a JSON object, replacing`);
  return {};
}

async function assertPlainTarget(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function ensurePlainDir(dir: string): Promise<void> {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory or is a symbolic link`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(dir, { mode: 0o700, recursive: true });
  }
}

/**
 * Rewrites, every launch, the agy state that makes a sandboxed session start with no
 * prompts: onboarding done, autonomous settings, and the container repo trusted. Other keys
 * agy wrote are kept. Host files are never read or touched (@arch:AC-51).
 */
export async function seedAgyAutonomousState(input: { readonly bridgeDir: string; readonly debug?: (message: string) => void }): Promise<SeedResult> {
  const debug = input.debug ?? (() => undefined);
  const cliDir = join(input.bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');
  const cacheDir = join(cliDir, 'cache');
  try {
    await ensurePlainDir(cliDir);
    await ensurePlainDir(cacheDir);
    const onboardingPath = join(cacheDir, 'onboarding.json');
    const settingsPath = join(cliDir, 'settings.json');
    await assertPlainTarget(onboardingPath);
    await assertPlainTarget(settingsPath);
    const onboarding = await readJsonObject(onboardingPath, debug);
    await writeJsonAtomic(onboardingPath, { enterpriseOnboardingComplete: false, ...onboarding, ...AGY_ONBOARDING_DONE });
    const settings = await readJsonObject(settingsPath, debug);
    const trusted = mergeAntigravityTrust(settings, CONTAINER_REPO).next;
    await writeJsonAtomic(settingsPath, { ...(isRecord(trusted) ? trusted : settings), ...AGY_SANDBOX_SETTINGS });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `antigravity autonomous seed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
