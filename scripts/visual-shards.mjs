/**
 * Shard plan for the CI visual sweep (.github/workflows/ci.yml, job `visual-shard`).
 *
 * `node scripts/visual-shards.mjs <n>` prints the Playwright arguments of shard n.
 * `<n> weights` prints its PWTEST_SHARD_WEIGHTS value ('' when it has none).
 * `<n> layout` prints `true` when shard n runs layout tests, else `false`.
 *
 * The plan splits by project, from the measured test time of each project on
 * develop run 43650510835, after the theme filter of tests/visual/projectFilter.ts
 * removed the 3,052 skipped tests:
 *
 * - dark (513 s, 753 tests) in three parts of about 171 s.
 * - layout (355 s, 1,128 tests) in two parts of about 177 s. The layout shards
 *   run with `--no-deps`: no `layout-setup` and no `layout-teardown`. Each
 *   uploads its shard files, and the `visual` job runs the ledger verdict once
 *   over the union of all files (KARST_LAYOUT_MERGE, tests/visual/layoutShards.ts).
 * - the other five projects (191 s) in one shard.
 *
 * So the longest shard runs about 191 s of tests. A seventh shard would only
 * split the 191 s shard, and the layout parts (177 s) would then be the
 * longest: 14 s for one more job.
 *
 * Playwright's `--shard=i/k` cuts the ordered tests by count, and the cost of a
 * test varies along the order (dark 1/3 by count: 146 / 248 / 119 s). The
 * weights are the measured part sizes in tests, so each part gets an equal time.
 * PWTEST_SHARD_WEIGHTS is a Playwright environment variable without public
 * documentation. If a later Playwright ignores it, the parts fall back to an
 * equal count: each test still runs in exactly one shard, only the balance
 * changes. Measure again and update the weights when the sweep changes.
 *
 * The gate compares the merged report with the full listing, so a project
 * that no shard selects fails the job (scripts/visual-sweep-gate.mjs).
 */

/** Projects that the `visual` job runs once, after the shards: the layout verdict. */
export const LAYOUT_BOOKENDS = Object.freeze(['layout-setup', 'layout-teardown']);

/** Measured part sizes (tests) for an equal time per part. */
const DARK_WEIGHTS = Object.freeze([274, 173, 306]);
const LAYOUT_WEIGHTS = Object.freeze([442, 686]);

const part = (projects, i, k, weights) =>
  Object.freeze({ projects: Object.freeze(projects), split: Object.freeze([i, k]), weights });

/** `split: [i, k]` runs part i of k of the projects (`--fully-parallel --shard=i/k`), cut by `weights`. */
export const SHARDS = Object.freeze([
  part(['dark'], 1, 3, DARK_WEIGHTS),
  part(['dark'], 2, 3, DARK_WEIGHTS),
  part(['dark'], 3, 3, DARK_WEIGHTS),
  part(['layout'], 1, 2, LAYOUT_WEIGHTS),
  part(['layout'], 2, 2, LAYOUT_WEIGHTS),
  Object.freeze({
    projects: Object.freeze(['light', 'hc', 'dark-grayscale', 'dark-reduced-motion', 'catalog']),
  }),
]);

function shardAt(n) {
  if (!Number.isInteger(n) || n < 1 || n > SHARDS.length) {
    throw new Error(`visual-shards: shard number must be 1..${SHARDS.length}, got ${n}`);
  }
  return SHARDS[n - 1];
}

/** True when shard `n` (1-based) runs layout tests. Throws for a number outside the plan. */
export function isLayoutShard(n) {
  return shardAt(n).projects.includes('layout');
}

/** The Playwright arguments of shard `n` (1-based). Throws for a number outside the plan. */
export function shardArgs(n) {
  const shard = shardAt(n);
  const noDeps = isLayoutShard(n) ? ['--no-deps'] : [];
  const split = shard.split ? ['--fully-parallel', `--shard=${shard.split[0]}/${shard.split[1]}`] : [];
  return [...shard.projects.map((p) => `--project=${p}`), ...noDeps, ...split];
}

/** The PWTEST_SHARD_WEIGHTS value of shard `n`, or '' for an unsplit shard. */
export function shardWeights(n) {
  const shard = shardAt(n);
  return shard.weights ? shard.weights.join(':') : '';
}

const FIELDS = Object.freeze({
  args: (n) => shardArgs(n).join(' '),
  weights: shardWeights,
  layout: (n) => String(isLayoutShard(n)),
});

/** CLI body: exit code and the text to print. */
export function cli(argv) {
  try {
    const field = argv[1] ?? 'args';
    if (!Object.hasOwn(FIELDS, field)) {
      throw new Error(`visual-shards: field must be one of ${Object.keys(FIELDS).join(', ')}, got ${field}`);
    }
    return { code: 0, out: FIELDS[field](Number(argv[0])) };
  } catch (err) {
    return { code: 2, out: err.message };
  }
}

if (process.argv[1] && process.argv[1].endsWith('visual-shards.mjs')) {
  const { code, out } = cli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
