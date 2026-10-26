import type { GateDef, Manifest } from '../../manifest/types.js';
import { deriveNpmScript } from '../../workflow/gates/npmScript.js';
import type { ReadinessItem, ReadinessProbes } from './types.js';

type Located = { where: string; gate: GateDef };
type Baseline = (repoName: string) => string;

function enabledRepos(m: Manifest): [string, Manifest['repositories'][string]][] {
  return Object.entries(m.repositories).filter(([, r]) => r.enabled !== false);
}

function located(where: string, gates: readonly GateDef[] | undefined): Located[] {
  return (gates ?? []).map((gate, i) => ({ where: `${where}[${i}]`, gate }));
}

function reviewGates(m: Manifest): Located[] {
  const r = m.review;
  if (!r) return [];
  return [
    ...located('review.gates', r.gates),
    ...Object.entries(r.repositories).flatMap(([k, o]) => located(`review.repositories.${k}.gates`, o.gates)),
  ];
}

function uatGates(m: Manifest): Located[] {
  const u = m.uat;
  if (!u) return [];
  return [
    ...located('uat.gates', u.gates),
    ...Object.entries(u.repositories).flatMap(([k, o]) => located(`uat.repositories.${k}.gates`, o.gates)),
  ];
}

function scriptOf(g: GateDef): string | null {
  return g.kind === 'script' ? (g.script ?? null) : deriveNpmScript(g.command ?? '', g.args ?? []);
}

function targets(m: Manifest, g: GateDef) {
  return enabledRepos(m).filter(([name]) => g.repo === undefined || name.toLowerCase() === g.repo.toLowerCase());
}

function reviewItem(m: Manifest, p: ReadinessProbes): ReadinessItem | undefined {
  if (!m.review) return undefined;
  const declared = reviewGates(m).length > 0;
  const probeable = enabledRepos(m).some(([, r]) => p.fileExists(r.repoPath, 'package.json'));
  if (m.review.requireIndependentSignal && !declared && !probeable) {
    return {
      id: 'gates.review',
      status: 'fail',
      detail: 'no review gates declared and no repository has a package.json to probe, so review has no independent signal',
      fix: 'declare review.gates or set review.requireIndependentSignal: false',
    };
  }
  return { id: 'gates.review', status: 'ok', detail: declared ? 'review gates are declared' : 'review probes package.json scripts' };
}

function uatItem(m: Manifest): ReadinessItem | undefined {
  if (!m.uat) return undefined;
  if (uatGates(m).length === 0 && !m.uat.testerVerifier) {
    return { id: 'gates.uat', status: 'warn', detail: 'uat is declared but has no gates and no testerVerifier', fix: 'declare uat.gates or a uat.testerVerifier' };
  }
  return { id: 'gates.uat', status: 'ok', detail: 'uat has something to run' };
}

async function scriptItems(m: Manifest, baselineOf: Baseline, p: ReadinessProbes): Promise<ReadinessItem[]> {
  const out: ReadinessItem[] = [];
  for (const { where, gate } of [...reviewGates(m), ...uatGates(m)]) {
    const script = scriptOf(gate);
    if (script === null) continue;
    for (const [name, repo] of targets(m, gate)) {
      const branch = baselineOf(name);
      const id = `gates.script.${where}`;
      out.push(
        (await p.baseDefinesScript(repo.repoPath, branch, script))
          ? { id, status: 'ok', detail: `script "${script}" exists on ${branch} in ${name}` }
          : { id, status: 'fail', detail: `script "${script}" is missing on ${branch} in ${name}`, fix: `add "${script}" to package.json scripts on ${branch}` },
      );
    }
  }
  return out;
}

function testerItem(m: Manifest, p: ReadinessProbes): ReadinessItem | undefined {
  const tv = m.uat?.testerVerifier;
  if (!tv) return undefined;
  const token = (tv.kind === 'script' ? tv.script : tv.command)?.trim().split(/\s+/)[0] ?? '';
  const relative = token.includes('/') && !token.startsWith('/') && !token.startsWith('~');
  const repos = targets(m, tv);
  const found =
    tv.kind === 'script' || token === ''
      ? true
      : relative
        ? repos.length > 0 && repos.every(([, r]) => p.fileExists(r.repoPath, token))
        : p.binaryResolves(token);
  return found
    ? { id: 'uat.tester', status: 'ok', detail: `uat.testerVerifier command '${token}' resolves` }
    : { id: 'uat.tester', status: 'fail', detail: `uat.testerVerifier command '${token}' not found`, fix: relative ? 'add the script or fix the path' : `install '${token}' or fix the command` };
}

/** Items 4 and 5: gate resolution, gate scripts on the baseline, UAT tester/verifier. */
export async function checkGates(m: Manifest, baselineOf: Baseline, p: ReadinessProbes): Promise<ReadinessItem[]> {
  return [
    reviewItem(m, p),
    uatItem(m),
    ...(await scriptItems(m, baselineOf, p)),
    testerItem(m, p),
  ].filter((i): i is ReadinessItem => i !== undefined);
}
