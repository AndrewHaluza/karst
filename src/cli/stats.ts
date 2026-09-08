import type { Store } from '../store/db.js';
import { collectMetrics, type EffectivenessMetrics } from '../store/metrics/index.js';

/**
 * `karst stats [--project <slug>] [--since <iso>] [--json]` — the orchestration
 * effectiveness report.
 *
 * READ-ONLY, and that is a property the build enforces rather than a promise:
 * `statsNonInterference.test.ts` asserts the module set reachable from here
 * issues no write SQL and cannot reach a process or a socket. Parsing lives at
 * the argv boundary (never trust argv — the invoking agent reads ticket content
 * it did not author); rendering takes an injected `Store` so it is testable
 * independent of the DB driver.
 */

export type StatsFormat = 'text' | 'json';

export interface ParsedStats {
  readonly format: StatsFormat;
  /** `--project`; absent = fall back to the manifest's project, else unscoped. */
  readonly projectSlug?: string;
  readonly since?: string;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

/** Parse `['stats', ('--json')?, ('--project' <slug>)?, ('--since' <iso>)?]`. */
export function parseStatsArgs(argv: string[]): ParsedStats {
  const [cmd, ...rest] = argv;
  if (cmd !== 'stats') throw new Error(`expected 'stats' command, got '${cmd ?? ''}'`);
  let format: StatsFormat = 'text';
  let projectSlug: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json') format = 'json';
    else if (flag === '--text') format = 'text';
    else if (flag === '--project') projectSlug = requireValue('--project', rest[++i]);
    else if (flag === '--since') since = requireValue('--since', rest[++i]);
    else throw new Error(`unknown flag '${flag}' (want --json, --project <slug> or --since <iso>)`);
  }
  return {
    format,
    ...(projectSlug === undefined ? {} : { projectSlug }),
    ...(since === undefined ? {} : { since }),
  };
}

const number = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const rate = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const amount = (value: number | null, unit: string): string =>
  value === null ? 'n/a' : `${number(value)}${unit}`;

/** `name: count` pairs on one line, or `none`. */
function inline(entries: readonly (readonly [string, number])[]): string {
  if (entries.length === 0) return 'none';
  return entries.map(([name, count]) => `${name}=${count}`).join(', ');
}

function renderText(m: EffectivenessMetrics): string {
  const scope = [
    m.scope.projectSlug === null ? 'all projects' : `project ${m.scope.projectSlug}`,
    m.scope.since === null ? 'all time' : `since ${m.scope.since}`,
  ].join(', ');
  const lines: string[] = [`karst effectiveness — ${scope}`, ''];

  lines.push(`First-pass rate: ${rate(m.firstPass.overall.rate)} (${m.firstPass.overall.firstAttemptAdvanced}/${m.firstPass.overall.firstAttempts} first attempts advanced)`);
  for (const s of m.firstPass.byStage) {
    lines.push(`  ${s.stageKey}: ${rate(s.rate)} — advanced=${s.advanced}, blocked=${s.blocked}, stopped=${s.stopped}`);
  }

  lines.push('');
  lines.push(`Rework loops: ${m.rework.rounds} rounds over ${m.rework.episodes} episodes (mean ${amount(m.rework.meanRoundsPerEpisode, '')}, deepest round ${m.rework.maxRoundReached}, exhausted ${m.rework.exhaustedEpisodes})`);
  lines.push(`  by status: ${inline(m.rework.byStatus.map((r) => [r.status, r.count] as const))}`);
  lines.push(`  by trigger: ${inline(m.rework.byTriggerKind.map((r) => [r.triggerKind, r.count] as const))}`);

  lines.push('');
  lines.push(`Gate kill distribution: ${m.gates.runs} runs — failed=${m.gates.failed}, passed=${m.gates.passed}, skipped=${m.gates.skipped}, no-script=${m.gates.noScript}`);
  for (const g of m.gates.byGate) {
    lines.push(`  ${g.gateName}: failed=${g.failed}, passed=${g.passed}, skipped=${g.skipped}, no-script=${g.noScript}`);
  }
  lines.push(`  exit codes: ${inline(m.gates.byExitCode.map((r) => [String(r.exitCode), r.count] as const))}`);

  lines.push('');
  lines.push(`Cycle time (created → last repo merge): median ${amount(m.cycleTime.medianHours, 'h')}, mean ${amount(m.cycleTime.meanHours, 'h')}, p90 ${amount(m.cycleTime.p90Hours, 'h')} over ${m.cycleTime.mergedTickets} merged tickets`);

  lines.push('');
  lines.push(`Agent-active time: process runs ${amount(m.agentActiveTime.processRunHours, 'h')}, implementation runs ${amount(m.agentActiveTime.implementationRunHours, 'h')} (${m.agentActiveTime.openRuns} runs never closed)`);

  lines.push('');
  lines.push(`Cost per merged ticket: ${amount(m.tokens.perMergedTicket, ' reported tokens')} over ${m.tokens.mergedTickets} merged tickets`);
  lines.push(`  totals: reported=${m.tokens.reportedTokens}, estimated=${m.tokens.estimatedTokens} (reported separately — an estimate is never presented as measured)`);
  lines.push(`  by provider: ${inline(m.tokens.byProvider.map((r) => [r.provider ?? 'unknown', r.reportedTokens] as const))}`);
  lines.push(`  by model: ${inline(m.tokens.byModel.map((r) => [r.model ?? 'unknown', r.reportedTokens] as const))}`);

  lines.push('');
  lines.push('Token burn by call site:');
  if (m.tokens.byCallSite.length === 0) lines.push('  none');
  for (const c of m.tokens.byCallSite) {
    lines.push(`  ${c.callSite}: reported=${c.reportedTokens}, estimated=${c.estimatedTokens}, calls=${c.calls}`);
  }

  lines.push('');
  lines.push(`Escaped defects: ${m.escapedDefects.followUps} follow-up tickets of ${m.escapedDefects.tickets} (${rate(m.escapedDefects.rate)}), from ${m.escapedDefects.parentsWithFollowUps} parents`);

  lines.push('');
  lines.push(`Finding density: review ${m.findings.review.total}, uat ${m.findings.uat.total}, per merged ticket ${amount(m.findings.perMergedTicket, '')}`);
  lines.push(`  review severity: ${inline(m.findings.review.bySeverity.map((r) => [r.severity, r.count] as const))}`);
  lines.push(`  uat severity: ${inline(m.findings.uat.bySeverity.map((r) => [r.severity, r.count] as const))}`);

  lines.push('');
  lines.push(`Agent-vs-human findings: agent=${m.findingSource.agent}, human=${m.findingSource.human}, human share ${rate(m.findingSource.humanShare)}`);

  lines.push('');
  lines.push(`Merge friction: ${rate(m.mergeFriction.conflictRate)} conflicted (${m.mergeFriction.conflicted}/${m.mergeFriction.checks}) — ${inline(m.mergeFriction.byState.map((r) => [r.state, r.count] as const))}`);

  lines.push('');
  lines.push(`Ship failures: ${m.shipFailures.failed} of ${m.shipFailures.steps} steps (${rate(m.shipFailures.failureRate)}) — ${inline(m.shipFailures.byStep.map((r) => [r.step, r.failed] as const))}`);

  lines.push('');
  lines.push(`Graph approach efficiency: ${m.graph.replans} replans over ${m.graph.nodeRuns} node runs (${amount(m.graph.replansPerNodeRun, '')} per node run) across ${m.graph.graphRuns} graph runs`);
  lines.push(`  node failures: ${inline(m.graph.byFailureCategory.map((r) => [r.failureCategory, r.count] as const))}`);

  lines.push('');
  lines.push(`Interruption rate: ${rate(m.interruptions.interruptRate)} (${m.interruptions.interruptedProcessRuns}/${m.interruptions.processRuns} process runs), ${m.interruptions.recoveryInterrupts} interrupts inside recovery rounds`);

  lines.push('');
  lines.push('Not available (needs schema columns this build does not have):');
  for (const gap of m.unavailable) lines.push(`  ${gap.metric} — ${gap.reason}`);

  return lines.join('\n');
}

/**
 * Resolve the scope, run every metric, and render the report.
 *
 * `fallbackProjectSlug` is the manifest's project — used only when `--project`
 * named none. A slug that matches no project is an ERROR naming the slug: it is
 * a typo, and answering it with every project's numbers would be a wrong answer
 * that looks like a right one.
 */
/**
 * The project row for a slug, or `undefined`.
 *
 * Read inline rather than through `store/projects.ts`: that module owns the
 * upsert and the unassigned-ticket backfill, and importing it would pull write
 * SQL into a graph `statsNonInterference.test.ts` asserts is free of it.
 */
function findProjectId(store: Store, slug: string): number | undefined {
  const row = store.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as
    | { id: number }
    | undefined;
  return row?.id;
}

export function runStatsCommand(
  store: Store,
  parsed: ParsedStats,
  fallbackProjectSlug: string | undefined,
): string {
  const slug = parsed.projectSlug ?? fallbackProjectSlug;
  let projectId: number | undefined;
  if (slug !== undefined) {
    projectId = findProjectId(store, slug);
    if (projectId === undefined) throw new Error(`no project found for slug '${slug}'`);
  }
  const metrics = collectMetrics(store, {
    ...(projectId === undefined ? {} : { projectId }),
    ...(slug === undefined ? {} : { projectSlug: slug }),
    ...(parsed.since === undefined ? {} : { since: parsed.since }),
  });
  return parsed.format === 'json' ? JSON.stringify(metrics, null, 2) : renderText(metrics);
}
