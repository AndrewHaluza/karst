/** Protection as data (@arch:FIELDCHK): a change is protected when its top-level key's section is. */

import { SECTION_OF, SECTION_PROTECTED } from '../../manifest/sectionTable.js';
import type { Manifest } from '../../manifest/types.js';
import { topKey } from './pathDiff.js';
import type { PathChange } from './pathDiff.js';

export function isProtectedPath(path: string): boolean {
  const section = SECTION_OF[topKey(path) as keyof Manifest];
  // An unknown key is protected: nothing outside the table is ever waved through.
  return section === undefined || SECTION_PROTECTED[section];
}

export function splitProtected(changes: readonly PathChange[]): { protectedChanges: PathChange[]; otherChanges: PathChange[] } {
  const protectedChanges: PathChange[] = [];
  const otherChanges: PathChange[] = [];
  for (const change of changes) (isProtectedPath(change.path) ? protectedChanges : otherChanges).push(change);
  return { protectedChanges, otherChanges };
}
