// Upstream instance → internal task, and internal patch → upstream prediction line.
// One small normalizer + one prediction writer per supported set; no custom task schema.
// Internal shape: {id, repoUrl, baseSha, brief, testPatch, f2p, p2p}. `brief` is the issue text ONLY:
// the test patch and the F2P/P2P lists never reach the agent (see snapshot.mjs / run.mjs).

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON: fall through */ }
  }
  return [];
};

const need = (cond, what, id) => {
  if (!cond) throw new Error(`instance ${id}: missing ${what}`);
};

/** Multi-SWE-bench row: org/repo/number, base.sha, resolved_issues[].title+body, test_patch, f2p_tests/p2p_tests. */
function multiSweBench(row) {
  const id = `${row.org}/${row.repo}:pr-${row.number}`;
  need(row.base?.sha, 'base.sha', id);
  const issues = Array.isArray(row.resolved_issues) ? row.resolved_issues : [];
  const brief = issues
    .map((i) => `${i.title ?? ''}\n\n${i.body ?? ''}`.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
  need(brief, 'resolved_issues title/body', id);
  need(typeof row.test_patch === 'string', 'test_patch', id);
  return {
    id,
    repoUrl: `https://github.com/${row.org}/${row.repo}.git`,
    baseSha: row.base.sha,
    brief,
    testPatch: row.test_patch,
    f2p: Object.keys(row.f2p_tests ?? {}),
    p2p: Object.keys(row.p2p_tests ?? {}),
  };
}

/**
 * SWE-PolyBench row: instance_id, repo, base_commit, problem_statement, patch, test_patch, F2P/P2P.
 * F2P/P2P are the dataset columns (the upstream evaluator names the attributes f2p/p2p); both spellings
 * and JSON-encoded strings are accepted. Prediction keys `instance_id` + `model_patch` are from the
 * upstream README. The F2P/P2P column spelling could not be checked against the dataset card here.
 */
function swePolyBench(row) {
  const id = row.instance_id;
  need(id, 'instance_id', id);
  need(row.base_commit, 'base_commit', id);
  need(row.problem_statement, 'problem_statement', id);
  need(typeof row.test_patch === 'string', 'test_patch', id);
  return {
    id,
    repoUrl: `https://github.com/${row.repo}.git`,
    baseSha: row.base_commit,
    brief: row.problem_statement,
    testPatch: row.test_patch,
    f2p: asList(row.F2P ?? row.f2p),
    p2p: asList(row.P2P ?? row.p2p),
  };
}

export const SETS = {
  'multi-swe-bench': {
    detect: (row) => typeof row.org === 'string' && typeof row.repo === 'string' && typeof row.number === 'number',
    normalize: multiSweBench,
    /** Harness id (matches final_report.json ids). */
    harnessId: (row) => `${row.org}/${row.repo}:pr-${row.number}`,
    predictionLine: (row, patch) => ({ org: row.org, repo: row.repo, number: row.number, fix_patch: patch }),
  },
  'swe-polybench': {
    detect: (row) => typeof row.instance_id === 'string' && typeof row.base_commit === 'string',
    normalize: swePolyBench,
    harnessId: (row) => row.instance_id,
    predictionLine: (row, patch) => ({ instance_id: row.instance_id, model_patch: patch }),
  },
};

export function detectSet(row) {
  const name = Object.keys(SETS).find((n) => SETS[n].detect(row));
  if (!name) throw new Error('instance row matches no supported set (multi-swe-bench, swe-polybench)');
  return name;
}

/** Parses a jsonl file into [{set, row, task}]; a file must hold ONE set. */
export function loadInstances(text) {
  const rows = text.split('\n').filter((l) => l.trim() !== '').map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`instances line ${i + 1}: not JSON`);
    }
  });
  if (rows.length === 0) throw new Error('instances file is empty');
  const sets = new Set(rows.map(detectSet));
  if (sets.size !== 1) throw new Error(`instances file mixes sets: ${[...sets].join(', ')}`);
  const set = [...sets][0];
  const ids = new Set();
  return rows.map((row) => {
    const task = SETS[set].normalize(row);
    if (ids.has(task.id)) throw new Error(`duplicate instance ${task.id}`);
    ids.add(task.id);
    return { set, row, task };
  });
}
