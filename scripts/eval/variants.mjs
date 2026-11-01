// Variant overlays: per-variant fixture fields (D290). A variant is DATA with a closed key set; it can
// choose the core and the command gates, nothing else. It cannot add manifest keys, so the eval overlay
// can never declare `approaches` / `uat.baselineReview` (those raise user-decided gates, D292).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYS = ['provider', 'gates'];
const PROVIDERS = ['claude', 'codex'];
export const DEFAULT_VARIANT = 'default';

export function parseVariant(name, json) {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error(`variant ${name}: must be an object`);
  const extra = Object.keys(json).filter((k) => !KEYS.includes(k));
  if (extra.length > 0) throw new Error(`variant ${name}: unknown key "${extra[0]}" (allowed: ${KEYS.join(', ')})`);
  const provider = json.provider ?? 'claude';
  if (!PROVIDERS.includes(provider)) throw new Error(`variant ${name}: provider must be one of ${PROVIDERS.join(', ')}`);
  const gates = json.gates ?? [];
  if (!Array.isArray(gates)) throw new Error(`variant ${name}: gates must be an array`);
  return { name, provider, gates };
}

/** `default` is built in; any other name is evals/variants/<name>.json. */
export function loadVariant(name, dir, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`variant name "${name}": letters, digits, _ or - only`);
  if (name === DEFAULT_VARIANT) return parseVariant(name, {});
  const text = read(join(dir, `${name}.json`));
  if (text === null) throw new Error(`variant "${name}": no ${join(dir, `${name}.json`)}`);
  return parseVariant(name, JSON.parse(text));
}

/** The fixture file (parseFixtureFile shape) for one attempt: the brief ONLY, one ticket at scope. */
export function buildFixture({ task, variant, key = 'EVAL-1', baseRef = 'main', repoPath = '/task/repo', worktreePath = '/task/wt' }) {
  return {
    provider: variant.provider,
    taskRepo: { name: 'task', repoPath, baseRef, gates: variant.gates },
    tickets: [{
      key,
      title: task.id.slice(0, 120),
      description: task.brief,
      repo: { repoPath, baseRef, worktreePath },
      stageCurrent: 'scope',
      worktree: true,
    }],
  };
}

/** Probe steps: start the ticket, then wait until it settles (enters ship or blocks). All data. */
export function buildSteps({ key = 'EVAL-1', ticketId = 1, startCommand = 'karst.openSession', waitMs }) {
  return {
    steps: [
      { type: 'wait', for: { log: 'Karst activated' }, timeoutMs: 60_000 },
      { type: 'command', command: startCommand, args: [ticketId], timeoutMs: 120_000 },
      { type: 'wait', for: { ticketSettled: { key } }, timeoutMs: waitMs },
      { type: 'snapshot', label: 'end' },
    ],
  };
}
