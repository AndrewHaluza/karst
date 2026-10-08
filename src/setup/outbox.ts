import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { MAX_SETUP_PROPOSAL_BYTES } from './proposal.js';

/**
 * Shared plumbing for the setup session's outbox: resolve `KARST_SETUP_OUTBOX`,
 * write one proposal atomically, and report its path. The host watches the same
 * directory and ingests what lands. Kept separate from the planning outbox so
 * the two file contracts cannot be confused by a scanner.
 */

/** Resolve `KARST_SETUP_OUTBOX` to a real directory, or throw a clear error. */
export function resolveSetupOutboxDir(env: string | undefined): string {
  if (!env) {
    throw new Error('KARST_SETUP_OUTBOX is not set (run this inside a setup session)');
  }
  try {
    const real = realpathSync(env);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // fall through to the shared error
  }
  throw new Error(`KARST_SETUP_OUTBOX (${env}) is not a directory`);
}

/** The session's outbox: inside its scratch dir (the agent's cwd). */
export function setupOutboxDir(scratch: string): string {
  return join(scratch, 'outbox');
}

/**
 * Write one proposal object as `<uuid>.json` atomically (tmp + rename, mode
 * 0600). Returns the final path. Bounded: an oversize value is refused before
 * anything touches disk.
 */
export function writeSetupProposal(
  dir: string,
  value: unknown,
  uuid: () => string = randomUUID,
): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_SETUP_PROPOSAL_BYTES) {
    throw new Error(`proposal is too large (max ${MAX_SETUP_PROPOSAL_BYTES} bytes)`);
  }
  const id = uuid();
  const tmp = join(dir, `.tmp-${id}`);
  const file = join(dir, `${id}.json`);
  writeFileSync(tmp, json, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  return file;
}
