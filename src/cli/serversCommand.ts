import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { spinTicket } from '../runtime/spin.js';
import { stopTicketServers } from '../runtime/supervisor.js';
import { listServersByTicket, listWorktreesByTicket } from '../store/dashboard.js';

export type ServersAction = 'list' | 'spin' | 'restart' | 'stop';

export interface ParsedServersArgs {
  action: ServersAction;
  /** `--repos a,b` split and trimmed; empty when the flag was absent. */
  repos: string[];
}

/**
 * Karst session variables are host-owned and must never reach a spawned
 * service. This CLI runs INSIDE an agent session, so `process.env` carries the
 * graph capability (a one-shot authenticator) and the callback token;
 * `startHot` merges `process.env` into every child it spawns
 * (`runtime/supervisor.ts`), so without this scrub a user's dev server would
 * inherit karst's session credentials. A service has no use for any `KARST_*`
 * variable — the manifest's own service env is a separate layer applied OVER
 * `process.env`, so scrubbing cannot drop a variable the manifest meant to set.
 */
export function scrubKarstSessionEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('KARST_')) delete env[key];
  }
}

export function parseServersArgs(rest: string[]): ParsedServersArgs {
  const action = rest[1];
  if (action !== 'list' && action !== 'spin' && action !== 'restart' && action !== 'stop') {
    throw new Error(
      `karst servers: want 'list', 'spin', 'restart' or 'stop' (got '${action ?? ''}')`,
    );
  }

  let repos: string[] = [];
  const positionals: string[] = [];
  for (let i = 2; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--repos') {
      const csv = rest[++i];
      if (csv === undefined) {
        throw new Error('karst servers: --repos needs a comma-separated list');
      }
      if (action === 'list' || action === 'stop') {
        throw new Error("karst servers: --repos is only valid for 'spin' and 'restart'");
      }
      repos = csv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      positionals.push(token);
    }
  }

  const extra = positionals[0];
  if (extra !== undefined) {
    throw new Error(`karst servers: unexpected argument '${extra}'`);
  }

  return { action, repos };
}

export function resolveHotRepos(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  requested: readonly string[],
  manifestPath: string,
): string[] {
  const known = Object.keys(manifest.repositories);
  let hot: string[];
  if (requested.length > 0) {
    hot = [...requested];
  } else {
    // `worktrees.repo` stores the repository's PATH (createWorktree inserts
    // `repoPath`), while `manifest.repositories` is keyed by NAME — so the
    // worktree rows are translated back to names here. Several repository
    // entries may share one repoPath (a monorepo with several runnable
    // processes), and every one of them is scoped onto that worktree, so every
    // name declaring a present path is returned.
    const paths = new Set(listWorktreesByTicket(store, ticketId).map((w) => w.repo));
    const fromWorktrees = known.filter((name) => paths.has(manifest.repositories[name]!.repoPath));
    hot = fromWorktrees.length > 0 ? fromWorktrees : known;
  }
  for (const name of hot) {
    if (!known.includes(name)) {
      throw new Error(
        `karst servers: '${name}' is not a repository in ${manifestPath} ` +
          `(have: ${known.join(', ')})`,
      );
    }
  }
  if (hot.length === 0) {
    throw new Error(`karst servers: ${manifestPath} declares no repositories`);
  }
  return hot;
}

export async function runServersCommand(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  rest: string[],
  manifestPath: string | undefined,
): Promise<string> {
  const parsed = parseServersArgs(rest);

  if (parsed.action === 'list') {
    if (!manifest) throw new Error("karst servers: 'list' needs --manifest <karst.yml>");
    return JSON.stringify({ ok: true, ticketId, servers: listServersByTicket(store, ticketId) });
  }

  if (parsed.action === 'stop') {
    await stopTicketServers(store, ticketId);
    return JSON.stringify({
      ok: true,
      ticketId,
      action: 'stop',
      servers: listServersByTicket(store, ticketId),
    });
  }

  if (!manifest) {
    throw new Error(`karst servers: '${parsed.action}' needs --manifest <karst.yml>`);
  }
  const hot = resolveHotRepos(store, manifest, ticketId, parsed.repos, manifestPath!);
  scrubKarstSessionEnv(process.env);
  const result = await spinTicket(store, manifest, ticketId, hot);
  return JSON.stringify({
    ok: true,
    ticketId,
    action: parsed.action,
    repos: hot,
    servers: result.servers.map((s) => ({
      id: s.id,
      service: s.service,
      host: s.host,
      port: s.port,
      status: s.status,
    })),
    reclaimedPids: result.reclaimedPids,
  });
}
