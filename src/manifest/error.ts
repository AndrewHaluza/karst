/**
 * The manifest's single error type.
 *
 * Lives in its own module so the validators, the migrator, and the loader can
 * all throw it without importing each other — `schema.ts` re-exports it, so
 * every existing `import { ManifestError } from './schema.js'` keeps working.
 *
 * The message must be actionable on its own: it is shown verbatim in a VS Code
 * error toast, where the user has no stack trace and no context. That means it
 * names the field, and — once the loader has attached it — the file.
 */

/** Thrown for any manifest that fails validation. Message names the exact fault. */
export class ManifestError extends Error {
  /** The fault alone, without the `Invalid karst.yml` prefix or the path. */
  readonly detail: string;
  /** The file the fault was found in, once the loader knows it. */
  readonly path?: string;

  constructor(detail: string, path?: string) {
    super(path ? `Invalid karst.yml (${path}): ${detail}` : `Invalid karst.yml: ${detail}`);
    this.name = 'ManifestError';
    this.detail = detail;
    this.path = path;
  }

  /**
   * A NEW error carrying the same fault plus the file it came from. Immutable —
   * validators throw without knowing the path, and `loadManifest` re-throws with
   * it attached, so the user always learns WHICH karst.yml is wrong (they may
   * have several: one per project, plus the example).
   */
  withPath(path: string): ManifestError {
    return new ManifestError(this.detail, path);
  }
}
