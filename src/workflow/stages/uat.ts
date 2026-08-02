import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest, UatConfig } from '../../manifest/types.js';
import type { GateRunInput } from '../../store/gateRuns.js';
import { commitGateOutcome, type RunOutcome } from '../gates/commit.js';
import { nowIso } from '../../model/time.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { noTargetsReason } from '../gates/targets.js';
import { REVIEW_GATES } from '../gates/scripts.js';
import { resolveGates, type GateResolution, type ResolvedGate } from '../gates/resolve.js';
import { runGateList } from '../gates/runList.js';
import { planUatTargets, type UatTarget } from '../uat/targets.js';
import { declaredGatesFor, PROBE_SCRIPTS } from '../uat/gates.js';
import { aggregateUat, type AggregateEntry, type GateIdentity } from '../uat/aggregate.js';

/**
 * UAT stage — orchestration only.
 *
 * Plan the affected repositories, resolve each one's gate list (explicit config
 * else a package.json probe), run them, and reduce. The verdict conjunction lives
 * in `uat/aggregate.ts` and the gate mechanics in `gates/resolve.ts`/`gates/runList.ts`
 * (UAT's own config shape stays in `uat/gates.ts`), because this file was 134
 * lines and would be 600–900 if every mechanism landed in it.
 *
 * Returns `StageRunResult`: a run that could not ask its question parks durably
 * (`parkGateStage`) rather than transitioning or throwing, and consumes no
 * attempt — nothing about the code was learned.
 */

export interface RunUatOpts {
  ticketId: number;
  /** The ticket's primary worktree; used only when no manifest is supplied. */
  cwd: string;
  artifactDir: string;
  manifest?: Manifest;
  /** One signal for the whole run, so a Stop reaches the gate in flight. */
  signal?: AbortSignal;
}

export interface UatDeps {
  planTargets?: typeof planUatTargets;
  probe?: (cwd: string) => ScriptProbe;
  runGates?: typeof runGateList;
  git?: GitRunner;
  now?: () => string;
}

/** Review's gate identities for one target — what UAT must not merely duplicate. */
function reviewIdentitiesFor(target: UatTarget): GateIdentity[] {
  // `target.repo` verbatim on both sides. `sameIdentity` compares `repo` with
  // `===`, so normalising one side (trailing slash, realpath) and not the other
  // would make overlap detection silently never match.
  return REVIEW_GATES.map((gate) => ({
    repo: target.repo,
    command: 'npm',
    args: gate.args,
  }));
}

/** What a gate invocation IS, as a dedup key: the command, not the label on it. */
function identityKey(gate: ResolvedGate): string {
  return [gate.command, ...gate.args].join('\u0000');
}

/**
 * The gates for ONE target, which may back several manifest entries.
 *
 * `planUatTargets` collapses entries sharing a `repoPath` into one worktree, and
 * `declaredGatesFor` is keyed by a single repository NAME — so reading only the
 * first name would silently drop the second entry's `uat.repositories.<name>.gates`
 * override. Every name is resolved and the results unioned.
 *
 * Deduplicated by invocation identity, not by gate name: two entries in one
 * directory declaring `npm run e2e` are one question asked twice, and the same
 * identity is what `aggregate.ts` reduces over. A duplicate that is `required`
 * anywhere stays required — a configured gate whose script is missing must fail
 * rather than be skipped.
 *
 * Unavailable is only the answer when NO name produced a gate: a repository with
 * one runnable entry can still be asked something. The first unavailability wins,
 * since one probe backs every name and they therefore agree.
 */
function resolveTargetGates(
  probe: ScriptProbe,
  config: UatConfig | undefined,
  names: readonly string[],
): GateResolution {
  const keys: (string | null)[] = names.length > 0 ? [...names] : [null];
  const byIdentity = new Map<string, ResolvedGate>();
  let unavailable: Extract<GateResolution, { kind: 'unavailable' }> | null = null;

  for (const name of keys) {
    const resolved = resolveGates(probe, declaredGatesFor(config, name), PROBE_SCRIPTS);
    if (resolved.kind === 'unavailable') {
      unavailable ??= resolved;
      continue;
    }
    for (const gate of resolved.gates) {
      const key = identityKey(gate);
      const existing = byIdentity.get(key);
      if (existing === undefined) byIdentity.set(key, gate);
      else if (gate.required && !existing.required) {
        byIdentity.set(key, { ...existing, required: true });
      }
    }
  }

  const gates = [...byIdentity.values()];
  if (gates.length > 0) return { kind: 'gates', gates };
  // Zero gates and no unavailability is the malformed-package.json case, which
  // the caller turns into a named failure rather than a park.
  return unavailable ?? { kind: 'gates', gates: [] };
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  deps: UatDeps = {},
): Promise<StageRunResult> {
  const now = deps.now ?? nowIso;
  const planTargets = deps.planTargets ?? planUatTargets;
  const probe = deps.probe ?? probeScripts;
  const runGates = deps.runGates ?? runGateList;
  const git = deps.git ?? defaultGitRunner;
  const runAt = now();

  const worktrees = opts.manifest ? listWorktreesByTicket(store, opts.ticketId) : [];

  const entries: AggregateEntry[] = [];
  const reviewIdentities: GateIdentity[] = [];
  const sections: string[] = [];

  /** Write the log and commit the outcome with everything collected so far. */
  const finish = (outcome: RunOutcome, notes: readonly string[] = []): StageRunResult => {
    mkdirSync(opts.artifactDir, { recursive: true });
    const artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}.log`);
    writeFileSync(artifactPath, [...notes.map((note) => `! ${note}`), ...sections].join('\n\n'));
    const gates = entries.map<GateRunInput>((entry) => ({
      gateName: entry.result.name,
      exitCode: entry.result.exitCode,
      startedAt: entry.result.startedAt ?? null,
      endedAt: entry.result.endedAt ?? null,
      // v21 invocation identity — what review's R7 compares its own gates
      // against, so this side must carry exactly what actually ran.
      repo: entry.identity.repo,
      command: entry.identity.command,
      args: entry.identity.args,
    }));
    return commitGateOutcome(store, {
      ticketId: opts.ticketId,
      stageKey: 'uat',
      runAt,
      artifactPath,
      gates,
      outcome,
    });
  };

  const planned = opts.manifest
    ? await planTargets(opts.manifest, worktrees, git)
    : { kind: 'targets' as const, targets: [{ repo: opts.cwd, path: opts.cwd, names: [] }] };

  // Environmental: karst could not even determine which repositories are
  // affected (an unreachable remote, a broken git) — never a verdict about the
  // ticket's code, so this parks rather than transitioning or throwing. Nothing
  // has run yet, so there is no partial evidence to keep.
  if (planned.kind === 'unavailable') {
    return finish({ kind: 'blocked', blocker: planned.blocker, reason: planned.reason }, [
      planned.reason,
    ]);
  }
  const targets: UatTarget[] = planned.targets;

  if (targets.length === 0) {
    const reason = noTargetsReason(worktrees, 'UAT');
    return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
  }

  for (const target of targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path);
    const resolution = resolveTargetGates(scriptProbe, opts.manifest?.uat, target.names);

    // Environmental: karst could not ask this repository anything. Park rather
    // than reduce — a block is not a verdict about the ticket's code. Earlier
    // targets already ran, so their rows go down with the park.
    if (resolution.kind === 'unavailable') {
      const reason = `${label}: ${resolution.reason}`;
      return finish({ kind: 'blocked', blocker: resolution.blocker, reason }, [reason]);
    }

    // A malformed package.json resolves to zero gates and IS a failure about the
    // repository — an agent can fix it, so it must reach a verdict.
    if (resolution.gates.length === 0 && scriptProbe.kind === 'malformed') {
      entries.push({
        result: {
          name: `package.json (${label})`,
          exitCode: 1,
          output: `${label}: package.json is malformed — ${scriptProbe.message}`,
          startedAt: runAt,
          endedAt: runAt,
        },
        identity: { repo: target.repo, command: 'node', args: ['--parse-package-json'] },
      });
      sections.push(`# package.json (${label}, exit 1)\n${scriptProbe.message}`);
      continue;
    }

    reviewIdentities.push(...reviewIdentitiesFor(target));

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
    });

    for (const [index, result] of run.results.entries()) {
      // Zipped by POSITION: `runGateList` emits one result per gate in order, and
      // two manifest entries sharing a worktree can declare the same gate name,
      // so a name lookup would attach the wrong identity to the row.
      const gate = resolution.gates[index];
      entries.push({
        result: { ...result, name: `${result.name} (${label})` },
        identity: {
          repo: target.repo,
          command: gate?.command ?? result.name,
          args: gate?.args ?? [],
        },
      });
      sections.push(
        `# ${result.name} (${label}, ${result.exitCode === null ? 'skipped' : `exit ${result.exitCode}`})\n${result.output}`,
      );
    }

    // A Stop yields no verdict and no attempt. What already finished is still
    // recorded — discarding it would make work that really happened unrecoverable.
    if (run.kind === 'stopped') {
      return finish({ kind: 'stopped' }, ['stopped before every gate finished']);
    }
  }

  const outcome = aggregateUat(entries, reviewIdentities);
  if (outcome.kind === 'blocked') {
    return finish({ kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason }, [
      outcome.reason,
    ]);
  }
  return finish({ kind: 'verdict', verdict: outcome.verdict }, outcome.warnings);
}
