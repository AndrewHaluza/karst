/**
 * Signed-in probe of an account folder (@arch:AC-55). It looks for the credential
 * file of the core and answers only yes/no; it never reads or returns a secret.
 * `undefined` means "cannot tell": the core keeps its login elsewhere (for example the
 * macOS keychain for the default claude account), so a missing file proves nothing.
 */
import { access, constants, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountCore } from './types.js';

export interface SignedInProbeDeps {
  readonly home: string;
  /** The default account folder of a core. */
  readonly defaultDir: (core: AccountCore) => string;
  readonly exists: (path: string) => Promise<boolean>;
  /** Read a small JSON file; `undefined` when it is missing or not valid JSON. */
  readonly readJson: (path: string) => Promise<unknown>;
}

const CREDENTIAL_FILES: Readonly<Partial<Record<AccountCore, readonly string[]>>> = {
  claude: ['.credentials.json'],
  codex: ['auth.json'],
  // The account folder is XDG_DATA_HOME, so the file is one level down; the default folder is the opencode folder itself.
  opencode: ['auth.json', join('opencode', 'auth.json')],
};

async function claudeLoggedIn(deps: SignedInProbeDeps, dir: string, isDefault: boolean): Promise<boolean> {
  // The default account keeps .claude.json in the home folder; a CLAUDE_CONFIG_DIR account keeps it inside.
  const file = isDefault ? join(deps.home, '.claude.json') : join(dir, '.claude.json');
  const json = await deps.readJson(file);
  return typeof json === 'object' && json !== null && 'oauthAccount' in json;
}

export function createSignedInProbe(deps: SignedInProbeDeps): (core: AccountCore, dir: string | undefined) => Promise<boolean | undefined> {
  return async (core, dir) => {
    const files = CREDENTIAL_FILES[core];
    // antigravity and opencode2 have no known credential file.
    if (!files || dir === undefined) return undefined;
    const isDefault = dir === deps.defaultDir(core);
    for (const f of files) if (await deps.exists(join(dir, f))) return true;
    if (core === 'claude' && (await claudeLoggedIn(deps, dir, isDefault))) return true;
    // The default login may live in a keychain; a stored account folder holds its own files.
    return isDefault ? undefined : false;
  };
}

const SMALL_JSON_MAX_BYTES = 8 * 1024 * 1024;

/** The probe over the real file system. Unreadable or oversized files read as absent. */
export function createFileSignedInProbe(home: string, defaultDir: (core: AccountCore) => string) {
  return createSignedInProbe({
    home,
    defaultDir,
    exists: (file) => access(file, constants.R_OK).then(() => true, () => false),
    readJson: async (file) => {
      try {
        if ((await stat(file)).size > SMALL_JSON_MAX_BYTES) return undefined;
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
  });
}
