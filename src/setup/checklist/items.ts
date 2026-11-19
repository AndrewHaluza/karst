import { resolve } from 'node:path';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import type { ManifestSection } from '../../manifest/sectionTable.js';
import type { ReadinessItem } from '../readiness/types.js';
import type { DiscoveredRepo, DiscoveryResult } from '../discover.js';

/** What one item rule sees. `manifest` is always defined here. */
export interface RuleContext {
  manifest: Manifest;
  /** The manifest's directory: a relative `repoPath` resolves against it, as the loader and the readiness probes do. */
  manifestDir: string;
  discovered: readonly DiscoveredRepo[];
  readiness: readonly ReadinessItem[];
  /** True when the user skipped `code` for this target (or for the whole item). */
  skipped(target?: string): boolean;
}

/** A rule returns the open problems; none means done. `skippedAny` marks a skip that closed a problem. */
export interface RuleResult {
  problems: string[];
  skippedAny: boolean;
}

export interface ChecklistDef {
  code: string;
  section: ManifestSection;
  title: string;
  required: boolean;
  tool: string;
  doneDetail: string;
  rule(ctx: RuleContext): RuleResult;
}

const result = (problems: string[], skippedAny = false): RuleResult => ({ problems, skippedAny });

function enabledRepos(m: Manifest): [string, RepositoryDef][] {
  return Object.entries(m.repositories).filter(([, r]) => r.enabled !== false);
}

const samePath = (dir: string, a: string, b: string): boolean => resolve(dir, a) === resolve(dir, b);

function matched(ctx: RuleContext, d: DiscoveredRepo): [string, RepositoryDef][] {
  return enabledRepos(ctx.manifest).filter(([, r]) => samePath(ctx.manifestDir, r.repoPath, d.path));
}

/** The readiness items that start with `prefix`, failing only. */
function failing(ctx: RuleContext, ...prefixes: string[]): string[] {
  return ctx.readiness
    .filter((i) => i.status === 'fail' && prefixes.some((p) => i.id === p || i.id.startsWith(`${p}.`)))
    .map((i) => `${i.id}: ${i.detail}`);
}

function reposRegistered(ctx: RuleContext): RuleResult {
  const missing: string[] = [];
  let skippedAny = false;
  for (const d of ctx.discovered) {
    if (matched(ctx, d).length > 0) continue;
    if (ctx.skipped(d.name)) skippedAny = true;
    else missing.push(d.name);
  }
  if (missing.length > 0) return result([`not in repositories: ${missing.join(', ')}`]);
  if (ctx.discovered.length === 0 && enabledRepos(ctx.manifest).length === 0) {
    return ctx.skipped() ? result([], true) : result(['no repository is registered']);
  }
  return result([], skippedAny);
}

function reposBaseline(ctx: RuleContext): RuleResult {
  const repos = enabledRepos(ctx.manifest);
  if (repos.length === 0) return result(['no repository is registered']);
  return result(failing(ctx, 'repo.git', 'repo.baseline', 'repo.origin', 'repo.remote'));
}

const hasPorts = (s: { ports?: readonly unknown[]; health?: string }): boolean =>
  (s.ports?.length ?? 0) > 0 && (s.health ?? '').trim() !== '';

/** Only `service` counts: `setup verify` and the readiness `services` item run that one, not a named `services` map. */
function declaredServices(r: RepositoryDef): { ports?: readonly unknown[]; health?: string }[] {
  return r.service ? [r.service] : [];
}

function servicesDeclared(ctx: RuleContext): RuleResult {
  const problems: string[] = [];
  let skippedAny = false;
  for (const d of ctx.discovered) {
    if (d.service === null) continue;
    const repos = matched(ctx, d);
    if (repos.some(([, r]) => declaredServices(r).some(hasPorts))) continue;
    if (ctx.skipped(d.name)) skippedAny = true;
    else if (repos.length > 0) problems.push(`${d.name} is runnable but has no service with ports and health`);
  }
  for (const [name, r] of enabledRepos(ctx.manifest)) {
    const bad = declaredServices(r).some((s) => !hasPorts(s));
    if (!bad) continue;
    if (ctx.skipped(name)) skippedAny = true;
    else problems.push(`${name} declares a service without ports or health`);
  }
  problems.push(...failing(ctx, 'services'));
  // `warn` means setup verify did not run: a declared service is not verified yet.
  for (const w of ctx.readiness.filter((x) => x.id === 'services' && x.status === 'warn')) {
    problems.push(`services: ${w.detail}`);
  }
  return result(problems, skippedAny);
}

function qualityGates(ctx: RuleContext): RuleResult {
  const r = ctx.manifest.review;
  const declared =
    (r?.gates?.length ?? 0) > 0 || Object.values(r?.repositories ?? {}).some((o) => (o.gates?.length ?? 0) > 0);
  const problems = declared ? [] : ['no review gate is declared'];
  problems.push(...failing(ctx, 'gates.script.review', 'gates.review'));
  return result(problems);
}

function agentsDefault(ctx: RuleContext): RuleResult {
  const m = ctx.manifest;
  const problems: string[] = [];
  if (m.agentProvider === undefined) problems.push('agentProvider is not set');
  if ((m.defaultModel ?? '').trim() === '') problems.push('defaultModel is not set');
  problems.push(...failing(ctx, `core.${m.agentProvider ?? 'claude'}`));
  return result(problems);
}

const ticketingProvider = (ctx: RuleContext): RuleResult =>
  result(ctx.manifest.ticketing?.provider === undefined ? ['ticketing.provider is not set'] : []);

function gitConventions(ctx: RuleContext): RuleResult {
  const c = ctx.manifest.conventions;
  const set = [c?.branchName, c?.commitMessage, c?.pullRequestTitle, c?.pullRequestDescription].some(
    (v) => (v ?? '').trim() !== '',
  );
  return result(set ? [] : ['no branch, commit or pull request convention is set']);
}

function uatPaths(ctx: RuleContext): RuleResult {
  if (ctx.manifest.uat === undefined) return result([]);
  return result(failing(ctx, 'gates.script.uat', 'uat.tester'));
}

function approachesEnabled(ctx: RuleContext): RuleResult {
  const on = (ctx.manifest.approaches ?? []).some((a) => a.enabled !== false);
  return result(on ? [] : ['no approach is enabled']);
}

/** The checklist, in the order the agent works it. One data table; `compute.ts` runs it. */
export const ITEMS: readonly ChecklistDef[] = [
  { code: 'repos.registered', section: 'services', title: 'Register every discovered repository', required: true, tool: 'add-repo', doneDetail: 'every discovered repository is registered', rule: reposRegistered },
  { code: 'repos.baseline', section: 'general', title: 'The baseline branch exists on origin', required: true, tool: 'set-general', doneDetail: 'the baseline branch and origin are ready', rule: reposBaseline },
  { code: 'services.declared', section: 'services', title: 'Declare a service with ports and health for each runnable repository', required: true, tool: 'set-service', doneDetail: 'each runnable repository has a service', rule: servicesDeclared },
  { code: 'quality.gates', section: 'quality', title: 'Point the review gates at gate scripts that exist on the baseline', required: true, tool: 'set-quality', doneDetail: 'review gates are declared and their scripts exist', rule: qualityGates },
  { code: 'agents.default', section: 'agents', title: 'Set the agent provider and the default model', required: true, tool: 'set-agents', doneDetail: 'the default agent is set and its CLI is present', rule: agentsDefault },
  { code: 'ticketing.provider', section: 'ticketing', title: 'Set a ticketing source', required: false, tool: 'set-ticketing', doneDetail: 'a ticketing source is set', rule: ticketingProvider },
  { code: 'git.conventions', section: 'git', title: 'Set the branch and commit conventions', required: false, tool: 'set-git', doneDetail: 'a convention is set', rule: gitConventions },
  { code: 'uat.paths', section: 'quality', title: 'Make the UAT tester paths exist', required: false, tool: 'set-quality', doneDetail: 'UAT is off or its paths exist', rule: uatPaths },
  { code: 'approaches.enabled', section: 'approaches', title: 'Enable the approaches you want', required: false, tool: 'set-approaches', doneDetail: 'an approach is enabled', rule: approachesEnabled },
];

/**
 * Sections no item names, each with the reason. A new manifest section must be
 * named by an item or listed here (@arch:FIELDCHK); `items.test.ts` enforces it.
 */
export const OPTIONAL_SECTIONS: Partial<Record<ManifestSection, string>> = {
  autopilot: 'Autopilot is opt-in and has safe defaults; first setup does not need it.',
  project: 'Project identity and sandbox limits have defaults; `id` is set once at scaffold.',
};

export type { DiscoveryResult };
