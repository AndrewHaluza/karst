import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAgentFile } from './pkg.js';
import { buildAgentPool } from './pool.js';
import { writeApproachArtifacts, type ApproachPackage, type ApproachArtifact } from '../approaches/pkg.js';
import type { ApproachDef } from '../manifest/types.js';

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function installApproach(
  approachesDir: string,
  id: string,
  agentRelPaths: string[],
): void {
  const artifacts: ApproachArtifact[] = agentRelPaths.map((relPath) => ({
    kind: 'agent',
    relPath,
  }));
  const pkg: ApproachPackage = {
    id,
    label: id,
    prompts: [],
    artifacts,
  };
  writeApproachArtifacts(
    approachesDir,
    pkg,
    agentRelPaths.map((relPath) => ({ relPath, body: `# ${relPath}` })),
  );
}

describe('buildAgentPool', () => {
  it('local file wins over an approach artifact with the same name', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    writeAgentFile(agentsDir, 'reviewer', 'local reviewer body');
    installApproach(approachesDir, 'tdd', ['agents/reviewer.md']);

    const approaches: ApproachDef[] = [{ id: 'tdd', label: 'TDD' }];
    const pool = buildAgentPool({ agentsDir, approachesDir, approaches });

    expect(pool).toHaveLength(1);
    expect(pool[0]).toEqual({ name: 'reviewer', source: 'file' });
  });

  it('an approach def with enabled:false contributes no agents', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    installApproach(approachesDir, 'tdd', ['agents/reviewer.md']);

    const approaches: ApproachDef[] = [{ id: 'tdd', label: 'TDD', enabled: false }];
    const pool = buildAgentPool({ agentsDir, approachesDir, approaches });

    expect(pool).toEqual([]);
  });

  it('an installed pkg with no matching manifest def contributes no agents', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    installApproach(approachesDir, 'orphan', ['agents/reviewer.md']);

    const pool = buildAgentPool({ agentsDir, approachesDir, approaches: [] });

    expect(pool).toEqual([]);
  });

  it('includes distinct names from both sources, sorted by name', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    writeAgentFile(agentsDir, 'zeta-local', 'body');
    installApproach(approachesDir, 'tdd', ['agents/alpha-approach.md']);

    const approaches: ApproachDef[] = [{ id: 'tdd', label: 'TDD' }];
    const pool = buildAgentPool({ agentsDir, approachesDir, approaches });

    expect(pool.map((a) => a.name)).toEqual(['alpha-approach', 'zeta-local']);
    expect(pool).toEqual([
      { name: 'alpha-approach', source: 'approach', approachId: 'tdd', relPath: 'agents/alpha-approach.md' },
      { name: 'zeta-local', source: 'file' },
    ]);
  });

  it('derives name as the basename of relPath without .md extension', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    installApproach(approachesDir, 'tdd', ['agents/foo.md']);

    const approaches: ApproachDef[] = [{ id: 'tdd', label: 'TDD' }];
    const pool = buildAgentPool({ agentsDir, approachesDir, approaches });

    expect(pool).toEqual([
      { name: 'foo', source: 'approach', approachId: 'tdd', relPath: 'agents/foo.md' },
    ]);
  });

  it('returns [] when nothing is installed and no local files exist', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    const pool = buildAgentPool({ agentsDir, approachesDir, approaches: [] });
    expect(pool).toEqual([]);
  });

  it('excludes a file agent whose agentsMeta entry has enabled:false', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    writeAgentFile(agentsDir, 'reviewer', 'body');

    const pool = buildAgentPool({
      agentsDir,
      approachesDir,
      approaches: [],
      agentsMeta: { reviewer: { role: 'reviewer', enabled: false } },
    });

    expect(pool).toEqual([]);
  });

  it('excludes an approach agent whose agentsMeta entry has enabled:false', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    installApproach(approachesDir, 'tdd', ['agents/reviewer.md']);

    const approaches: ApproachDef[] = [{ id: 'tdd', label: 'TDD' }];
    const pool = buildAgentPool({
      agentsDir,
      approachesDir,
      approaches,
      agentsMeta: { reviewer: { role: 'reviewer', enabled: false } },
    });

    expect(pool).toEqual([]);
  });

  it('keeps agents that are enabled or have no agentsMeta entry', () => {
    const agentsDir = makeDir('karst-agents-pool-');
    const approachesDir = makeDir('karst-approaches-pool-');
    writeAgentFile(agentsDir, 'reviewer', 'body');
    writeAgentFile(agentsDir, 'planner', 'body');

    const pool = buildAgentPool({
      agentsDir,
      approachesDir,
      approaches: [],
      agentsMeta: { reviewer: { role: 'reviewer', enabled: true } },
    });

    expect(pool.map((a) => a.name)).toEqual(['planner', 'reviewer']);
  });
});
