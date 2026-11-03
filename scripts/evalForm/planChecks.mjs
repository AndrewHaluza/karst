// Static checks for a planner draft: required parts, known repo, named paths exist at the base sha or come from the gold patch.
const PATH = /(?:src|packages|lib|test|tests|scripts|docs)\/[\w./@-]*\w/g;
export const PLAN_DEFECT_KINDS = ['empty-part', 'unknown-repo', 'invented-path', 'planner-edited-files'];

export const extractPaths = (text) => [...new Set(String(text ?? '').match(PATH) ?? [])];

/** Paths the gold patch creates: `--- /dev/null` then `+++ b/<path>`. */
export function createdPaths(patch) {
  const out = new Set();
  const lines = String(patch ?? '').split('\n');
  lines.forEach((l, i) => {
    const m = l === '--- /dev/null' ? /^\+\+\+ b\/(.+)$/.exec(lines[i + 1] ?? '') : null;
    if (m) out.add(m[1]);
  });
  return out;
}

const existsAt = (git, sha, path) => { try { git(['cat-file', '-e', `${sha}:${path}`]); return true; } catch { return false; } };

/** -> `{defects:[{kind,item}], pathRatio (null when no path named), invented:[]}`. */
export function planStaticChecks({ git, baseSha, created, draft, knownRepos }) {
  const defects = [];
  for (const k of ['title', 'description', 'summary']) {
    if (typeof draft[k] !== 'string' || draft[k].trim() === '') defects.push({ kind: 'empty-part', item: k });
  }
  for (const r of draft.repos ?? []) if (!knownRepos.includes(r)) defects.push({ kind: 'unknown-repo', item: r });
  const paths = extractPaths(draft.description);
  const invented = paths.filter((p) => !created.has(p) && !existsAt(git, baseSha, p));
  for (const p of invented) defects.push({ kind: 'invented-path', item: p });
  return { defects, pathRatio: paths.length === 0 ? null : (paths.length - invented.length) / paths.length, invented };
}

/** A planner must not edit files: any `git status --porcelain` output flags the run. */
export function dirtyDefect(git) {
  const out = git(['status', '--porcelain']).trim();
  return out ? { kind: 'planner-edited-files', item: out.split('\n').slice(0, 5).join('; ') } : null;
}
