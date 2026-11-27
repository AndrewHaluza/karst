import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';
import type { StepResult } from '../docker/dockerClone.js';
import { OPENCODE_IMAGE_REVISION } from '../docker/dockerImage.js';
import { sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The proxy bundle on the remote host (D822, edit 3).
 *
 * The sidecar mounts `allowlist-proxy.mjs` from a HOST path locally; a remote
 * daemon cannot see that path, so the bundle is uploaded once per image
 * revision to `<remoteDir>/.karst-assets/<revision>` and mounted from there.
 *
 * The upload is verified, not trusted: every file's sha256 on the remote must
 * equal the host's, or the resolve fails closed. A silent half-upload would
 * leave the sandbox with no egress policy at all — strictly worse than running
 * prompted on the host (`@arch:AC-31`).
 *
 * A checksum that already matches skips the upload entirely, so a second launch
 * of the same revision is one ssh round trip.
 */

/** The remote assets dir of one image revision (the trailing `/` of `remoteDir` is tolerated). */
export function remoteAssetsDir(remoteDir: string, revision: string = OPENCODE_IMAGE_REVISION): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(revision)) {
    throw new Error(`ssh docker: invalid asset revision ${JSON.stringify(revision)}`);
  }
  return `${remoteDir.replace(/\/+$/, '')}/.karst-assets/${revision}`;
}

/** The bundle file the sidecar mounts; the launch cannot run without it. */
export const PROXY_BUNDLE = 'allowlist-proxy.mjs';

/** A plain file name only: a name is interpolated into a remote path, so nothing exotic may ride along. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bound of the checksum read: one short line per asset. */
const HASH_STDOUT_BYTES = 16 * 1024;

export interface EnsureRemoteDockerAssetsInput {
  readonly ssh: SshProcess;
  /** The ssh executable for `pipe` (`sshBin`); the fake's path in an integration test. */
  readonly sshBin: string;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh <name>: …`). */
  readonly remoteName: string;
  readonly controlDir: string;
  /** The host dir the image build reads (`DOCKER_ASSETS_DIR`), also the tar root. */
  readonly hostAssetsDir: string;
  /** Image revision (`OPENCODE_IMAGE_REVISION`); the dir is replaced when it changes. */
  readonly revision?: string;
  readonly debug?: (message: string) => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `name=sha256` lines; a missing file prints an empty hash, so it never matches. */
function hashProbeScript(destDir: string, files: readonly string[]): string {
  return [
    '# karst-ssh-docker-assets',
    `d=${sshQuote(destDir)}`,
    'for f in ' + files.map(sshQuote).join(' ') + '; do',
    '  h=$(sha256sum -- "$d/$f" 2>/dev/null | awk \'NR == 1 { print $1 }\')',
    '  printf \'%s=%s\\n\' "$f" "$h"',
    'done',
  ].join('\n');
}

function parseHashes(stdout: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    hashes.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return hashes;
}

async function remoteHashes(input: EnsureRemoteDockerAssetsInput, destDir: string, files: readonly string[]): Promise<Map<string, string> | undefined> {
  const out = await input.ssh.run(sshArgv(input.remote, input.controlDir, hashProbeScript(destDir, files)), {
    maxStdoutBytes: HASH_STDOUT_BYTES,
  });
  if (out.transport === true || out.code !== 0) return undefined;
  return parseHashes(out.stdout);
}

/** The first file whose remote hash is not the host's; `undefined` when every one matches. */
function firstMismatch(files: readonly string[], host: ReadonlyMap<string, string>, remote: ReadonlyMap<string, string> | undefined): string | undefined {
  for (const file of files) {
    if (remote === undefined || remote.get(file) !== host.get(file)) return file;
  }
  return undefined;
}

function mismatch(input: EnsureRemoteDockerAssetsInput, file: string): StepResult {
  return { ok: false, reason: `ssh ${input.remoteName}: remote asset checksum mismatch for ${file}` };
}

function uploadFailure(input: EnsureRemoteDockerAssetsInput, fromCode: number, toCode: number): StepResult | undefined {
  if (fromCode !== 0) return { ok: false, reason: `ssh ${input.remoteName}: tar of the docker assets failed (exit ${String(fromCode)})` };
  if (toCode === 255) return { ok: false, reason: `ssh ${input.remoteName}: transport failed during the docker asset upload` };
  if (toCode !== 0) return { ok: false, reason: `ssh ${input.remoteName}: docker asset upload failed (exit ${String(toCode)})` };
  return undefined;
}

/**
 * Make `<remoteDir>/.karst-assets/<revision>` hold exactly the host bundle.
 * Reads the host dir, skips a verified match, otherwise uploads `tar -c .`
 * through `ssh.pipe` into `mkdir -p -m 700 … && tar -x -C …` and re-verifies
 * every file. Never throws: a failure is the resolve's reason.
 */
export async function ensureRemoteDockerAssets(input: EnsureRemoteDockerAssetsInput): Promise<StepResult> {
  let files: string[];
  try {
    const entries = await readdir(input.hostAssetsDir, { withFileTypes: true });
    files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (err) {
    return { ok: false, reason: `ssh ${input.remoteName}: cannot read the docker assets dir ${input.hostAssetsDir} (${message(err)})` };
  }
  if (files.length === 0) {
    return { ok: false, reason: `ssh ${input.remoteName}: the docker assets dir ${input.hostAssetsDir} holds no files` };
  }
  for (const file of files) {
    if (!ASSET_NAME.test(file)) {
      return { ok: false, reason: `ssh ${input.remoteName}: refusing docker asset ${JSON.stringify(file)} (not a plain file name)` };
    }
  }
  if (!files.includes(PROXY_BUNDLE)) {
    return { ok: false, reason: `ssh ${input.remoteName}: ${input.hostAssetsDir} has no ${PROXY_BUNDLE}` };
  }
  const host = new Map<string, string>();
  for (const file of files) {
    try {
      host.set(file, createHash('sha256').update(await readFile(join(input.hostAssetsDir, file))).digest('hex'));
    } catch (err) {
      return { ok: false, reason: `ssh ${input.remoteName}: cannot read the docker asset ${file} (${message(err)})` };
    }
  }
  let destDir: string;
  try {
    destDir = remoteAssetsDir(input.remote.remoteDir, input.revision);
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
  const before = await remoteHashes(input, destDir, files);
  const stale = firstMismatch(files, host, before);
  if (stale === undefined) {
    input.debug?.(`[ssh ${input.remoteName}] docker assets: ${destDir} is up to date (${String(files.length)} files)`);
    return { ok: true };
  }
  input.debug?.(`[ssh ${input.remoteName}] docker assets: uploading ${String(files.length)} files to ${destDir}`);
  const uploaded = await input.ssh.pipe(
    { command: 'tar', args: ['-c', '-C', input.hostAssetsDir, '.'] },
    {
      command: input.sshBin,
      args: sshArgv(input.remote, input.controlDir, `mkdir -p -m 700 ${sshQuote(destDir)} && tar -x -C ${sshQuote(destDir)}`),
    },
  );
  const failed = uploadFailure(input, uploaded.fromCode, uploaded.toCode);
  if (failed) return failed;
  const after = await remoteHashes(input, destDir, files);
  const bad = firstMismatch(files, host, after);
  if (bad !== undefined) return mismatch(input, bad);
  input.debug?.(`[ssh ${input.remoteName}] docker assets: verified ${String(files.length)} files in ${destDir}`);
  return { ok: true };
}
