import type { AgentProvider, Manifest } from '../../manifest/types.js';
import { resolveBaselineBranch } from '../../manifest/baselineBranch.js';
import { effectiveAgentPresetName, resolveAgentPreset } from '../../agent/agentPresets.js';
import { agentDependency } from '../../runtime/deps.js';
import { checkGates } from './gateChecks.js';
import { checkRepo } from './repoChecks.js';
import type { CodedWarning } from '../../manifest/warningCode.js';
import type { ReadinessItem, ReadinessProbes, ReadinessReport } from './types.js';

export interface ServicesVerdict {
  ok: boolean;
  error?: string;
  failed: string[];
}

export interface ReadinessInput {
  manifest: Manifest | undefined;
  loadError?: string;
  /** D269 warnings from the loader, each with a stable code; every one is a fail here. */
  warnings: readonly CodedWarning[];
  /** `--repos` filter; empty = all. */
  repos: readonly string[];
  probes: ReadinessProbes;
  /** Runs `setup verify` for the selected repos; undefined = no store available. */
  verifyServices?: (repos: readonly string[]) => Promise<ServicesVerdict>;
}

/**
 * The cores the manifest REQUIRES: the default (claude when unset), per-process
 * pins, the slots of the effective (active) preset, and the profiles of every
 * enabled approach that declares a graph. A slot of another preset is optional.
 */
export function coresUsed(m: Manifest): AgentProvider[] {
  const found = new Set<AgentProvider>([m.agentProvider ?? 'claude']);
  for (const p of Object.values(m.processes ?? {})) if (p?.provider) found.add(p.provider);
  const active = resolveAgentPreset(m, effectiveAgentPresetName(m));
  for (const slot of Object.values(active?.slots ?? {})) if (slot?.provider) found.add(slot.provider);
  for (const approach of m.approaches ?? []) {
    if (approach.enabled === false) continue;
    for (const profile of Object.values(approach.graph?.profiles ?? {})) {
      if (profile?.provider) found.add(profile.provider);
    }
  }
  return [...found];
}

/** Cores that only a non-active preset slot can launch: reported, never a blocker. */
export function coresOptional(m: Manifest): AgentProvider[] {
  const required = new Set(coresUsed(m));
  const found = new Set<AgentProvider>();
  for (const preset of Object.values(m.agentPresets ?? {})) {
    for (const slot of Object.values(preset.slots)) {
      if (slot?.provider && !required.has(slot.provider)) found.add(slot.provider);
    }
  }
  return [...found];
}

function coreItems(m: Manifest, p: ReadinessProbes): ReadinessItem[] {
  const item = (provider: AgentProvider, optional: boolean): ReadinessItem => {
    const id = `core.${provider}`;
    const state = p.coreState(provider);
    if (state === 'ok') return { id, status: 'ok', detail: `${provider} CLI is installed and ready` };
    const dep = agentDependency(provider);
    return {
      id,
      status: optional ? 'warn' : 'fail',
      detail:
        `${provider} CLI is ${state === 'missing' ? 'not installed' : 'installed but not ready'}` +
        (optional ? ' (only a preset that is not active uses it)' : ''),
      fix: state === 'missing' ? dep.install : (dep.ready?.fix ?? dep.install),
    };
  };
  return [...coresUsed(m).map((c) => item(c, false)), ...coresOptional(m).map((c) => item(c, true))];
}

async function serviceItem(m: Manifest, names: readonly string[], i: ReadinessInput): Promise<ReadinessItem> {
  const withService = names.filter((n) => m.repositories[n]?.service !== undefined);
  if (withService.length === 0) return { id: 'services', status: 'ok', detail: 'no services declared' };
  if (!i.verifyServices) {
    return {
      id: 'services',
      status: 'warn',
      detail: 'services declared but setup verify was not run (pass --db to run it)',
      fix: 'run karst setup verify',
    };
  }
  const v = await i.verifyServices(withService);
  return v.ok
    ? { id: 'services', status: 'ok', detail: `setup verify passed for ${withService.join(', ')}` }
    : {
        id: 'services',
        status: 'fail',
        detail: v.error ?? `setup verify failed for ${v.failed.join(', ')}`,
        fix: 'fix the failing service, then rerun karst setup verify',
      };
}

function selectRepos(m: Manifest, filter: readonly string[]): { names: string[]; unknown: ReadinessItem[] } {
  const enabled = Object.keys(m.repositories).filter((n) => m.repositories[n]!.enabled !== false);
  if (filter.length === 0) return { names: enabled, unknown: [] };
  return {
    names: enabled.filter((n) => filter.includes(n)),
    unknown: filter
      .filter((n) => !enabled.includes(n))
      .map((n) => ({
        id: `repo.unknown.${n}`,
        status: 'fail' as const,
        detail: `--repos names '${n}', which is not an enabled repository`,
        fix: `use one of: ${enabled.join(', ')}`,
      })),
  };
}

/** One fail item per loader warning. The id is the warning code; a repeated code gets `#2`, `#3`, ... */
export function warningItems(warnings: readonly CodedWarning[]): ReadinessItem[] {
  const seen = new Map<string, number>();
  return warnings.map((w): ReadinessItem => {
    const count = (seen.get(w.code) ?? 0) + 1;
    seen.set(w.code, count);
    return {
      id: count === 1 ? w.code : `${w.code}#${count}`,
      status: 'fail',
      detail: w.message,
      fix: 'apply the fix named in the message',
    };
  });
}

export async function runReadiness(i: ReadinessInput): Promise<ReadinessReport> {
  const items: ReadinessItem[] = [];
  const m = i.manifest;
  if (!m) {
    items.push({
      id: 'manifest.load',
      status: 'fail',
      detail: i.loadError ?? 'manifest could not be loaded',
      fix: 'fix the manifest (karst manifest validate) and rerun',
    });
    return { ok: false, items };
  }
  items.push({ id: 'manifest.load', status: 'ok', detail: 'manifest loads' });
  items.push(...warningItems(i.warnings));
  const { names, unknown } = selectRepos(m, i.repos);
  items.push(...unknown);
  for (const name of names) {
    const repo = m.repositories[name]!;
    items.push(...(await checkRepo(name, repo, resolveBaselineBranch(m, repo), i.probes)));
  }
  const baselineOf = (n: string): string => resolveBaselineBranch(m, m.repositories[n]!);
  items.push(...(await checkGates(m, baselineOf, i.probes)));
  items.push(await serviceItem(m, names, i));
  items.push(...coreItems(m, i.probes));
  return { ok: items.every((x) => x.status !== 'fail'), items };
}
