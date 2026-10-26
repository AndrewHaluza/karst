import type { GateDef, Manifest, RepositoryDef } from '../types.js';
import { resolveBaselineBranch } from '../baselineBranch.js';

/**
 * The machine facts the env warnings need. Injected so the loader stays pure
 * and the in-memory proposal parse can run the same checks. Branches, scripts
 * and remotes may legitimately appear after setup, so a miss is a warning.
 */
export interface EnvProbe {
  pathExists: (p: string) => boolean;
  /** Local branch or `origin/<branch>` ref. */
  branchExists: (repoPath: string, branch: string) => boolean;
  hasRemote: (repoPath: string, remote: string) => boolean;
  /** `repoPath` is the repository root; `rel` is repo-relative. */
  fileExists: (repoPath: string, rel: string) => boolean;
}

type Named = [string, RepositoryDef];

/** First token of a command, when it is a repo-relative path (`scripts/x.sh`, `./x`). */
function relativeScript(command: string | undefined): string | undefined {
  const first = command?.trim().split(/\s+/)[0];
  if (!first || first.startsWith('/') || first.startsWith('~') || !first.includes('/')) return undefined;
  return first;
}

function gateWarnings(gates: GateDef[], where: string, repos: Named[], probe: EnvProbe): string[] {
  return gates.flatMap((g, i) => {
    const script = relativeScript(g.command);
    if (script === undefined) return [];
    const targets = repos.filter(([name]) => g.repo === undefined || name.toLowerCase() === g.repo.toLowerCase());
    // Unscoped gates run in every repo, so name each one that lacks the file.
    return targets.filter(([, r]) => !probe.fileExists(r.repoPath, script)).map(
      ([, r]) => `${where}[${i}].command: '${script}' not found in ${r.repoPath} — add the script or fix the path`,
    );
  });
}

function singleGate(gate: GateDef | undefined, where: string, repos: Named[], probe: EnvProbe): string[] {
  return gate ? gateWarnings([gate], where, repos, probe).map((w) => w.replace('[0]', '')) : [];
}

function repoWarnings(manifest: Manifest, name: string, repo: RepositoryDef, probe: EnvProbe): string[] {
  const out: string[] = [];
  const branch = resolveBaselineBranch(manifest, repo);
  if (!probe.branchExists(repo.repoPath, branch)) {
    out.push(
      `repositories.${name}.baselineBranch: branch '${branch}' not found in ${repo.repoPath} (local or origin) — create or push it, or set baselineBranch`,
    );
  }
  if (!probe.hasRemote(repo.repoPath, 'origin')) {
    out.push(
      `repositories.${name}: no 'origin' remote in ${repo.repoPath} — ship push needs one (git remote add origin <url>)`,
    );
  }
  return out;
}

/**
 * With no declared review gates the default pipeline probes each repo's
 * package.json scripts; none to probe leaves `requireIndependentSignal` with
 * nothing to satisfy it.
 */
function reviewSignalWarnings(manifest: Manifest, repos: Named[], probe: EnvProbe): string[] {
  const { review } = manifest;
  if (!review || !review.requireIndependentSignal || repos.length === 0) return [];
  const declared =
    (review.gates ?? []).length > 0 ||
    Object.values(review.repositories).some((r) => (r.gates ?? []).length > 0);
  if (declared || repos.some(([, r]) => probe.fileExists(r.repoPath, 'package.json'))) return [];
  return [
    'review.gates: none declared and no repository has a package.json to probe, so review has no independent signal — declare review.gates or set review.requireIndependentSignal: false',
  ];
}

/** Environment warnings for a validated manifest. Disabled repos and missing paths are skipped (doctor reports those). */
export function envWarnings(manifest: Manifest, probe: EnvProbe): string[] {
  const repos = Object.entries(manifest.repositories).filter(
    ([, r]) => r.enabled !== false && probe.pathExists(r.repoPath),
  );
  const { uat, review } = manifest;
  return [
    ...repos.flatMap(([name, r]) => repoWarnings(manifest, name, r, probe)),
    ...gateWarnings(uat?.gates ?? [], 'uat.gates', repos, probe),
    ...singleGate(uat?.testerVerifier, 'uat.testerVerifier', repos, probe),
    ...gateWarnings(review?.gates ?? [], 'review.gates', repos, probe),
    ...reviewSignalWarnings(manifest, repos, probe),
  ];
}
