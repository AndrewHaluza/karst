import { createHash } from 'node:crypto';
import { DOCKER_CORES, SBX_CORES } from '../sandboxCores.js';

const MAX_LEN = 63;
/** Every core a sandbox may be named for (sbx + docker); a null or unknown core never names an object. */
const ALLOWED_CORES: readonly string[] = [...SBX_CORES, ...DOCKER_CORES];
const SAFE = /^[a-z0-9-]+$/;

export interface SbxNameInput {
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly core: string;
  /**
   * A remote install id (`@arch:AC-39`): hashed together with the project
   * root, so two hosts that use the SAME absolute project path on one shared
   * VM never collide. Local docker omits it and the hash input stays the bare
   * project root, so every local name is byte-identical to before.
   */
  readonly installId?: string;
}

/**
 * The one sandbox name for a (project, ticket, core): `karst-<hash8>-<id>-<core>`.
 * The project hash keeps two projects with the same ticket id apart; the name is
 * the only handle `sbx rm` ever gets, so anything outside `[a-z0-9-]` throws.
 */
export function sbxName(input: SbxNameInput): string {
  if (!Number.isInteger(input.ticketId) || input.ticketId <= 0) {
    throw new Error(`sbx name: invalid ticket id ${String(input.ticketId)}`);
  }
  if (!(ALLOWED_CORES as readonly string[]).includes(input.core)) {
    throw new Error(`sbx name: core ${JSON.stringify(input.core)} is not a sandbox core`);
  }
  const core = input.core === 'agy' ? 'antigravity' : input.core;
  const hashInput = input.installId !== undefined ? `${input.projectRoot}\0${input.installId}` : input.projectRoot;
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  const name = `karst-${hash}-${input.ticketId}-${core}`;
  if (!SAFE.test(core) || name.length > MAX_LEN) {
    throw new Error(`sbx name: unsafe name ${JSON.stringify(name)}`);
  }
  return name;
}
