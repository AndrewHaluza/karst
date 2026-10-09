/**
 * Manifest checks for `karst doctor`. Pure: every fact about the machine comes
 * in through `ManifestProbes`, and every check returns plain data. Fixes are
 * all `tier: 'consented'` — editing karst.yml, git branches and foreign
 * processes belong to the user, so doctor only ever shows the exact command.
 */

import { resolveTarget, unitsOf } from '../manifest/runnable.js';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import type { DoctorCheck, DoctorFix, DoctorStatus } from './types.js';

export interface ManifestProbes {
  manifest: Manifest | undefined;
  /** validate/load failure text, if the manifest could not load */
  manifestError?: string;
  pathExists: (p: string) => boolean;
  isGitRepo: (p: string) => boolean;
  branchExists: (repoPath: string, branch: string) => boolean;
  /** given the first token of `start` */
  binaryResolves: (command: string) => boolean;
  /** Who holds a TCP port: 'free' | 'karst' (a karst-recorded live server) | 'foreign'. */
  portHolder: (port: number) => 'free' | 'karst' | 'foreign';
}

type EnabledRepo = [string, RepositoryDef];

function check(id: string, status: DoctorStatus, detail: string, fix?: DoctorFix): DoctorCheck {
  const base = { id, area: 'manifest' as const, status, detail };
  return fix ? { ...base, fix } : base;
}

function consented(summary: string, command: string): DoctorFix {
  return { tier: 'consented', summary, command };
}

/** Disabled repositories are drafts; doctor does not judge them. */
function enabledRepos(m: Manifest): EnabledRepo[] {
  return Object.entries(m.repositories).filter(([, repo]) => repo.enabled !== false);
}

function checkValid(p: ManifestProbes): DoctorCheck {
  if (p.manifestError !== undefined) {
    return check(
      'manifest.valid',
      'fail',
      `karst.yml does not load: ${p.manifestError}`,
      consented('Fix karst.yml so it validates', 'Fix karst.yml to match the error above (use `karst manifest propose`)'),
    );
  }
  if (p.manifest === undefined) {
    return check(
      'manifest.valid',
      'warn',
      'no manifest: karst.yml was not found for this project',
      consented('Create karst.yml', 'Create karst.yml (use `karst manifest propose`)'),
    );
  }
  return check('manifest.valid', 'ok', 'karst.yml loads and validates');
}

function checkRepoPath(name: string, repo: RepositoryDef, p: ManifestProbes): DoctorCheck {
  const id = `manifest.repo-path.${name}`;
  const fix = consented('Fix repoPath for this repository', 'Fix repoPath in karst.yml (use `karst manifest propose`)');
  if (!p.pathExists(repo.repoPath)) {
    return check(id, 'fail', `repoPath ${repo.repoPath} does not exist`, fix);
  }
  if (!p.isGitRepo(repo.repoPath)) {
    return check(id, 'fail', `repoPath ${repo.repoPath} is not a git repo`, fix);
  }
  return check(id, 'ok', `repoPath ${repo.repoPath} is a git repo`);
}

function checkBaseline(name: string, repo: RepositoryDef, p: ManifestProbes): DoctorCheck | undefined {
  if (!repo.baselineBranch) return undefined;
  const branch = repo.baselineBranch;
  const id = `manifest.baseline.${name}`;
  if (!p.branchExists(repo.repoPath, branch)) {
    return check(
      id,
      'fail',
      `baseline branch ${branch} does not exist in ${repo.repoPath}`,
      consented(
        'Create the baseline branch locally from its remote',
        `git -C ${repo.repoPath} branch ${branch} origin/${branch}`,
      ),
    );
  }
  return check(id, 'ok', `baseline branch ${branch} exists`);
}

function checkStart(name: string, service: ServiceDef, p: ManifestProbes): DoctorCheck | undefined {
  const command = service.start.trim().split(/\s+/)[0] ?? '';
  if (command === '') return undefined;
  const id = `manifest.start.${name}`;
  if (!p.binaryResolves(command)) {
    return check(
      id,
      'fail',
      `start command "${command}" does not resolve on PATH`,
      consented(
        'Install the start command or correct service.start',
        `Install "${command}" or correct service.start for repository "${name}" in karst.yml`,
      ),
    );
  }
  return check(id, 'ok', `start command "${command}" resolves`);
}

function checkPorts(name: string, service: ServiceDef, p: ManifestProbes): DoctorCheck {
  const id = `manifest.ports.${name}`;
  const foreign = service.ports.filter((slot) => p.portHolder(slot.default) === 'foreign');
  const first = foreign[0];
  if (first === undefined) {
    return check(id, 'ok', 'default ports are free or held by karst');
  }
  const named = foreign.map((slot) => `${slot.default} (${slot.name})`).join(', ');
  return check(
    id,
    'warn',
    `default port held by a foreign process: ${named}`,
    consented(
      'Find the process holding the port',
      `lsof -nP -iTCP:${first.default} -sTCP:LISTEN`,
    ),
  );
}

function resolvesDependency(m: Manifest, target: string, port: string): boolean {
  const resolved = resolveTarget(m.repositories, target);
  return 'unit' in resolved && resolved.unit.def.ports.some((slot) => slot.name === port);
}

function checkDependsOn(name: string, service: ServiceDef, m: Manifest): DoctorCheck {
  const id = `manifest.depends-on.${name}`;
  const unresolved = service.dependsOn.filter((dep) => !resolvesDependency(m, dep.target, dep.port));
  if (unresolved.length === 0) {
    return check(id, 'ok', 'every dependsOn target resolves');
  }
  const named = unresolved.map((dep) => `${dep.target}:${dep.port}`).join(', ');
  return check(
    id,
    'fail',
    `dependsOn does not resolve: ${named}`,
    consented(
      'Point dependsOn at a runnable repository with that port slot',
      `Fix dependsOn for repository "${name}" in karst.yml (use \`karst manifest propose\`)`,
    ),
  );
}

function checksForRepo(name: string, repo: RepositoryDef, m: Manifest, p: ManifestProbes): DoctorCheck[] {
  const out: DoctorCheck[] = [checkRepoPath(name, repo, p)];
  const baseline = checkBaseline(name, repo, p);
  if (baseline) out.push(baseline);
  for (const unit of unitsOf(name, repo)) {
    const start = checkStart(unit.key, unit.def, p);
    if (start) out.push(start);
    out.push(checkPorts(unit.key, unit.def, p));
    out.push(checkDependsOn(unit.key, unit.def, m));
  }
  return out;
}

/** Every manifest check, in report order. */
export function checkManifest(p: ManifestProbes): DoctorCheck[] {
  const valid = checkValid(p);
  const m = p.manifest;
  if (m === undefined) return [valid];
  const repoChecks = enabledRepos(m).flatMap(([name, repo]) => checksForRepo(name, repo, m, p));
  return [valid, ...repoChecks];
}
