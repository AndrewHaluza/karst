import { existsSync, readFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { droppedProtectedFields } from '../setup/manifestApply.js';
import { isFirstSetup, readScaffoldManifest } from '../setup/scaffoldManifest.js';

/**
 * `karst manifest validate --file <path>` and `karst manifest show --active`.
 *
 * `validate` runs the SAME loader + schema the extension uses, so a draft the
 * agent believes is valid cannot fail later at the host boundary; it prints the
 * parsed identity and repository count as JSON. Both commands are read-only.
 * The setup agent changes the manifest only through the typed `setup` tools.
 *
 * Its own parse path (handled before structured input in `main.ts`) because
 * `--file` here names a YAML file, not a JSON structured-input payload.
 */

export interface ManifestCommandDeps {
  /** `KARST_SETUP_OUTBOX` from the session env, read and injected by main.ts. */
  outboxEnv?: string;
  /** The `--manifest` global; `show` reads it. */
  manifestPath?: string;
  /** The bundled template, for the first-setup test. Defaults to the shipped `karst.example.yml`. */
  scaffold?: () => Manifest | undefined;
}

const USAGE = 'usage: karst manifest validate --file <path> | karst manifest show --active';

interface Parsed {
  sub: 'validate';
  file: string;
}

export function parseManifestArgs(argv: readonly string[]): Parsed {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'manifest') throw new Error(`karst manifest: unknown command '${cmd ?? ''}'`);
  if (sub !== 'validate') {
    throw new Error(`karst manifest: unknown subcommand '${sub ?? ''}' (want 'validate' or 'show')`);
  }
  let file: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      file = rest[++i];
      if (file === undefined) throw new Error(`karst manifest ${sub}: --file needs a path (${USAGE})`);
    } else {
      throw new Error(`karst manifest ${sub}: unknown argument '${token}' (${USAGE})`);
    }
  }
  if (file === undefined) throw new Error(`karst manifest ${sub}: missing --file <path> (${USAGE})`);
  return { sub, file };
}

function validateFile(file: string) {
  // Throws a ManifestError carrying the path on any malformed input — the same
  // failure the extension would hit, surfaced once, clearly.
  return loadManifestWithDiagnostics(file);
}

/**
 * The protected fields of a draft that the host would discard, compared with
 * the file at `--manifest` under the same first-setup rule. With no readable
 * current manifest nothing is compared.
 */
function wouldDrop(draft: Manifest, deps: ManifestCommandDeps): string[] {
  if (deps.manifestPath === undefined || !existsSync(deps.manifestPath)) return [];
  let current: Manifest;
  try {
    current = loadManifestWithDiagnostics(deps.manifestPath).manifest;
  } catch {
    // Same as the host: an unreadable current manifest counts as absent (first setup).
    return [];
  }
  const template = (deps.scaffold ?? readScaffoldManifest)();
  return droppedProtectedFields(current, draft, isFirstSetup(current, template));
}

function runValidate(file: string, deps: ManifestCommandDeps): string {
  const { manifest, warnings, notices } = validateFile(file);
  return JSON.stringify({
    ok: true,
    id: manifest.id ?? null,
    repositories: Object.keys(manifest.repositories),
    wouldDrop: wouldDrop(manifest, deps),
    warnings,
    notices,
  });
}

/**
 * `manifest show --active`: the active karst.yml re-dumped without comments.
 * A fresh scaffold is a long annotated template; this is the compact view the
 * setup agent reads instead (the annotated file stays a cookbook).
 */
function runShow(rest: readonly string[], deps: ManifestCommandDeps): string {
  if (rest.length !== 1 || rest[0] !== '--active') {
    throw new Error(`karst manifest show: needs --active (${USAGE})`);
  }
  if (deps.manifestPath === undefined) {
    throw new Error('karst manifest show: no manifest path (pass --manifest "$KARST_MANIFEST")');
  }
  if (!existsSync(deps.manifestPath)) {
    throw new Error(`karst manifest show: no active manifest at ${deps.manifestPath}`);
  }
  return dump(load(readFileSync(deps.manifestPath, 'utf8')), { lineWidth: -1, noRefs: true });
}

export function runManifestCommand(argv: readonly string[], deps: ManifestCommandDeps = {}): string {
  if (argv[1] === 'show') return runShow(argv.slice(2), deps);
  const { file } = parseManifestArgs(argv);
  return runValidate(file, deps);
}
