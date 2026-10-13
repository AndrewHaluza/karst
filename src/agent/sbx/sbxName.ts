import { createHash } from 'node:crypto';

const MAX_LEN = 63;
const SAFE = /^[a-z0-9-]+$/;

export interface SbxNameInput {
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly core: string;
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
  const hash = createHash('sha256').update(input.projectRoot).digest('hex').slice(0, 8);
  const name = `karst-${hash}-${input.ticketId}-${input.core}`;
  if (!SAFE.test(input.core) || name.length > MAX_LEN) {
    throw new Error(`sbx name: unsafe name ${JSON.stringify(name)}`);
  }
  return name;
}
