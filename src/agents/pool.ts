import { basename } from 'node:path';
import type { AgentDef, ApproachDef } from '../manifest/types.js';
import { listAgentFiles } from './pkg.js';
import { listInstalled, listArtifacts } from '../approaches/pkg.js';

/**
 * A selectable single-subagent: either a local file under `agentsDir` or an
 * `agent`-kind artifact of an installed+enabled approach package.
 */
export interface PoolAgent {
  name: string; // stem, unique in the pool
  source: 'file' | 'approach';
  approachId?: string; // set when source==='approach'
  relPath?: string; // artifact relPath, set when source==='approach' (for later body read)
}

/**
 * Compute the selectable agent pool = local agent files ∪ `agent`-kind
 * artifacts of installed+ENABLED approaches, deduped by name (local file
 * wins), stably sorted by name.
 *
 * An installed approach package only contributes agents when it has a
 * matching manifest `ApproachDef` (by `id`) with `enabled !== false` — a
 * package with no matching def isn't a currently-configured approach.
 *
 * `agentsMeta` (optional) is the manifest's `agents` map keyed by agent NAME
 * (not approach id) — any pool entry whose `agentsMeta[name].enabled === false`
 * is dropped, regardless of source. Absent meta (or no entry for a name)
 * never filters it out.
 */
export function buildAgentPool(input: {
  agentsDir: string;
  approachesDir: string;
  approaches: ApproachDef[];
  agentsMeta?: Record<string, AgentDef>;
}): PoolAgent[] {
  const byName = new Map<string, PoolAgent>();

  for (const file of listAgentFiles(input.agentsDir)) {
    byName.set(file.name, { name: file.name, source: 'file' });
  }

  const defsById = new Map(input.approaches.map((def) => [def.id, def]));

  for (const pkg of listInstalled(input.approachesDir)) {
    const def = defsById.get(pkg.id);
    if (!def || def.enabled === false) continue;

    for (const artifact of listArtifacts(pkg, 'agent')) {
      const name = basename(artifact.relPath, '.md');
      if (byName.has(name)) continue; // local file wins; first-seen approach wins
      byName.set(name, {
        name,
        source: 'approach',
        approachId: pkg.id,
        relPath: artifact.relPath,
      });
    }
  }

  const agentsMeta = input.agentsMeta ?? {};

  return [...byName.values()]
    .filter((agent) => agentsMeta[agent.name]?.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}
