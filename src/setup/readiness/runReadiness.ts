import type { AgentProvider, Manifest } from '../../manifest/types.js';
import { resolveBaselineBranch } from '../../manifest/baselineBranch.js';
import { agentDependency } from '../../runtime/deps.js';
import { checkGates } from './gateChecks.js';
import { checkRepo } from './repoChecks.js';
import type { ReadinessItem, ReadinessProbes, ReadinessReport } from './types.js';

export interface ServicesVerdict {
  ok: boolean;
  error?: string;
  failed: string[];
}

export interface ReadinessInput {
  manifest: Manifest | undefined;
  loadError?: string;
  /** D269 warnings from the loader; every one is a fail here. */
  warnings: readonly string[];
  /** `--repos` filter; empty = all. */
  repos: readonly string[];
  probes: ReadinessProbes;
  /** Runs `setup verify` for the selected repos; undefined = no store available. */
  verifyServices?: (repos: readonly string[]) => Promise<ServicesVerdict>;
}

/** Every agent core the manifest can launch: default, per-process, and preset slots (default claude). */
export function coresUsed(m: Manifest): AgentProvider[] {
  const found = new Set<AgentProvider>([m.agentProvider ?? 'claude']);
  for (const p of Object.values(m.processes ?? {})) if (p?.provider) found.add(p.provider);
  for (const preset of Object.values(m.agentPresets ?? {})) {
    for (const slot of Object.values(preset.slots)) if (slot?.provider) found.add(slot.provider);
  }
  return [...found];
}

function coreItems(m: Manifest, p: ReadinessProbes): ReadinessItem[] {
  return coresUsed(m).map((provider): ReadinessItem => {
    const id = `core.${provider}`;
    const state = p.coreState(provider);
    if (state === 'ok') return { id, status: 'ok', detail: `${provider} CLI is installed and ready` };
    const dep = agentDependency(provider);
    return {
      id,
      status: 'fail',
      detail: `${provider} CLI is ${state === 'missing' ? 'not installed' : 'installed but not ready'}`,
      fix: state === 'missing' ? dep.install : (dep.ready?.fix ?? dep.install),
    };
  });
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
  i.warnings.forEach((w, n) =>
    items.push({ id: `manifest.warning.${n}`, status: 'fail', detail: w, fix: 'apply the fix named in the message' }),
  );
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
