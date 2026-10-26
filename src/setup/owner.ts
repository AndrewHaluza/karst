import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Which window launched a setup scratch. `globalStorage` is shared by every
 * window of an IDE, so without this each window would scan, show and apply every
 * other window's proposals. The marker is written before the terminal starts;
 * a scratch with no readable marker (legacy) has no owner and is never scanned.
 */

export const SETUP_OWNER_FILE = 'owner.json';

export interface SetupOwner {
  workspaceRoot: string;
  manifestPath?: string;
}

export function writeSetupOwner(scratch: string, owner: SetupOwner): void {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, SETUP_OWNER_FILE), JSON.stringify(owner));
}

export function readSetupOwner(scratch: string): SetupOwner | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(scratch, SETUP_OWNER_FILE), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { workspaceRoot, manifestPath } = raw as Record<string, unknown>;
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined;
    return {
      workspaceRoot,
      ...(typeof manifestPath === 'string' && manifestPath !== '' ? { manifestPath } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The scratch dirs under `setupRoot` that `workspaceRoot` launched. Foreign ones are not read beyond their marker. */
export function ownedScratches(
  setupRoot: string,
  workspaceRoot: string | undefined,
  debug?: (message: string) => void,
): string[] {
  let ids: string[];
  try {
    ids = readdirSync(setupRoot);
  } catch {
    return [];
  }
  const mine = workspaceRoot === undefined ? undefined : resolve(workspaceRoot);
  const owned: string[] = [];
  for (const id of ids) {
    const scratch = join(setupRoot, id);
    const owner = readSetupOwner(scratch);
    if (!owner) {
      debug?.(`[setup] skipped scratch ${id}: no readable owner marker`);
      continue;
    }
    if (mine !== undefined && resolve(owner.workspaceRoot) === mine) owned.push(scratch);
  }
  return owned;
}
