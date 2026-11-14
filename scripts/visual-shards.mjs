/**
 * Shard plan for the CI visual sweep (.github/workflows/ci.yml, job `visual-shard`).
 *
 * `node scripts/visual-shards.mjs <n>` prints the Playwright arguments of shard n.
 *
 * Playwright's own `--shard=i/N` splits by test count. A skipped test costs
 * almost no time, and the `dark` project holds most of the executed
 * screenshots, so a count split put about 650 s of the 1,170 s sweep on one
 * shard (develop run 43596873718). This plan splits by project, from the
 * measured time of each project:
 *
 * - dark (about 550 s) is split in two with `--fully-parallel --shard=i/2`.
 *   `pages.visual.ts` is one file, so the split needs `--fully-parallel`. It
 *   is a CLI flag only, so the config and the local docker gate do not change.
 * - The layout chain (about 310 s) runs whole in one shard. `--project=layout`
 *   adds `layout-setup` and `layout-teardown`, so the ledger verdict sees every
 *   route. Never split it: a part of the routes cannot judge the whole ledger.
 * - The other five projects (about 310 s together) share one shard.
 *
 * The gate compares the merged report with the full listing, so a project
 * that no shard selects fails the job (scripts/visual-sweep-gate.mjs).
 */

/** Projects that Playwright adds to a run of `layout`: its dependency and its teardown. */
export const LAYOUT_BOOKENDS = Object.freeze(['layout-setup', 'layout-teardown']);

/** `split: [i, k]` runs part i of k of the projects (`--fully-parallel --shard=i/k`). */
export const SHARDS = Object.freeze([
  Object.freeze({ projects: Object.freeze(['dark']), split: Object.freeze([1, 2]) }),
  Object.freeze({ projects: Object.freeze(['dark']), split: Object.freeze([2, 2]) }),
  Object.freeze({ projects: Object.freeze(['layout']) }),
  Object.freeze({
    projects: Object.freeze(['light', 'hc', 'dark-grayscale', 'dark-reduced-motion', 'catalog']),
  }),
]);

/** The Playwright arguments of shard `n` (1-based). Throws for a number outside the plan. */
export function shardArgs(n) {
  if (!Number.isInteger(n) || n < 1 || n > SHARDS.length) {
    throw new Error(`visual-shards: shard number must be 1..${SHARDS.length}, got ${n}`);
  }
  const shard = SHARDS[n - 1];
  const split = shard.split ? ['--fully-parallel', `--shard=${shard.split[0]}/${shard.split[1]}`] : [];
  return [...shard.projects.map((p) => `--project=${p}`), ...split];
}

/** CLI body: exit code and the text to print. */
export function cli(argv) {
  try {
    return { code: 0, out: shardArgs(Number(argv[0])).join(' ') };
  } catch (err) {
    return { code: 2, out: err.message };
  }
}

if (process.argv[1] && process.argv[1].endsWith('visual-shards.mjs')) {
  const { code, out } = cli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
