import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * A setup `change` proposal must never write under `.karst/`: the host is the
 * only writer of karst.yml, and only through a consented manifest proposal
 * (validation, protected fields, backup). This module is the guard for both
 * change forms. A patch is checked before it applies; a command is checked
 * after it runs, against a byte copy taken before.
 */

const KARST_DIR = '.karst';
/** Files under `.karst/` that a change must never write. */
const GUARDED_FILES: readonly string[] = ['karst.yml'];
const REASON = 'use `manifest propose` to change karst.yml';

/** Paths named by the patch headers: `---`, `+++`, `rename to`/`from`, `copy to`/`from`. */
export function patchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    // A binary, mode-only or header-only patch has no ---/+++ lines: the `diff --git` header names both paths.
    const g = /^diff --git (?:a\/(.+) b\/(.+)|"(.+)" "(.+)"|(\S+) (\S+))$/.exec(line);
    if (g !== null) {
      for (const part of g.slice(1)) if (part !== undefined) out.add(part);
      continue;
    }
    const m = /^(?:---|\+\+\+) (.+)$/.exec(line) ?? /^(?:rename|copy) (?:to|from) (.+)$/.exec(line);
    if (m === null) continue;
    let p = m[1]!.split('\t')[0]!.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
    if (p === '' || p === '/dev/null') continue;
    out.add(p);
  }
  return [...out];
}

/** realpath of the longest existing ancestor, plus the rest: resolves symlinks for a path that may not exist. */
function realResolve(path: string): string {
  const rest: string[] = [];
  let cur = resolve(path);
  while (!existsSync(cur) && dirname(cur) !== cur) {
    rest.unshift(basename(cur));
    cur = dirname(cur);
  }
  let real = cur;
  try {
    real = realpathSync(cur);
  } catch {
    /* keep the lexical path */
  }
  return join(real, ...rest);
}

function isUnder(path: string, dir: string): boolean {
  const p = path.toLowerCase();
  const d = dir.toLowerCase();
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * The first patch target that lands under `.karst/` of any root (the case of
 * every name ignored, symlinks resolved), as a refusal reason; else undefined.
 * Each header path is checked as written and with its `a/`/`b/` prefix cut.
 */
export function karstWriteViolation(patch: string, cwd: string, roots: readonly string[]): string | undefined {
  const karstDirs = roots.map((r) => realResolve(join(r, KARST_DIR)));
  for (const target of patchTargets(patch)) {
    const candidates = new Set([target]);
    if (/^[ab]\//.test(target)) candidates.add(target.slice(2));
    for (const c of candidates) {
      const full = realResolve(isAbsolute(c) ? c : join(cwd, c));
      if (karstDirs.some((d) => isUnder(full, d))) {
        return `the patch writes ${c} under ${KARST_DIR}/; ${REASON}`;
      }
    }
  }
  return undefined;
}

export interface KarstSnapshot {
  file: string;
  /** Display name, relative to its root. */
  label: string;
  /** The bytes before the change; null when the file did not exist. */
  bytes: Buffer | null;
}

/** Keep a byte copy of each guarded file under `.karst/` of each root. */
export function snapshotKarstFiles(roots: readonly string[]): KarstSnapshot[] {
  const seen = new Set<string>();
  const out: KarstSnapshot[] = [];
  for (const root of roots) {
    for (const name of GUARDED_FILES) {
      const file = join(root, KARST_DIR, name);
      const key = realResolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, label: `${KARST_DIR}/${name}`, bytes: existsSync(file) ? readFileSync(file) : null });
    }
  }
  return out;
}

/** Compare each file with its copy; restore every file that changed. Returns the labels restored. */
export function restoreKarstFiles(snapshots: readonly KarstSnapshot[]): string[] {
  const restored: string[] = [];
  for (const s of snapshots) {
    const now = existsSync(s.file) ? readFileSync(s.file) : null;
    const same = s.bytes === null ? now === null : now !== null && s.bytes.equals(now);
    if (same) continue;
    if (s.bytes === null) rmSync(s.file, { force: true });
    else {
      // A command may have removed `.karst/` itself.
      mkdirSync(dirname(s.file), { recursive: true });
      writeFileSync(s.file, s.bytes);
    }
    restored.push(s.label);
  }
  return restored;
}
