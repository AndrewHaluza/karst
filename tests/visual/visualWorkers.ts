/**
 * Worker count for the visual sweep (PERF-MEASURE-2-3-PLAYWRIGHT).
 *
 * `KARST_VISUAL_WORKERS` raises it for the local docker gate. The default is 1.
 * CI and baseline-update runs are always 1: CI keeps its measured behaviour, and
 * baseline authoring must not change. A bad value falls back to 1.
 * The layout chain is one spec file, so it stays on one worker at any count.
 */
export function resolveVisualWorkers(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): number {
  if (env['CI'] || argv.includes('--update-snapshots')) return 1;
  const raw = env['KARST_VISUAL_WORKERS'];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return 1;
  return Number(raw);
}
