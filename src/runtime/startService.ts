import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { buildSpawnEnv, shadowedOverrideKeys } from './env.js';
import { envOverridesForService, type TicketEnvOverrides } from '../store/ticketEnvOverrides.js';
import { startHot, type ServerRecord } from './supervisor.js';
import { serverLogPath } from './serverLog.js';
import { unitByKey } from '../manifest/runnable.js';
import { serviceLaunch } from './serviceLaunch.js';
import type { ResolveResult } from '../resolver/resolve.js';

export interface StartResolvedServiceArgs {
  store: Store;
  manifest: Manifest;
  ticketId: number;
  /** Service unit key (`repo`, or `repo/service`) — must be runnable. */
  name: string;
  /** The `resolve()` output the whole hot set was resolved with. */
  resolved: ResolveResult;
  /** Absolute worktree path of the service's repository (its `cwd` is applied on top). */
  cwd: string;
  /** The ticket's env overrides, already read once for the run. */
  envOverrides: TicketEnvOverrides;
  signal?: AbortSignal;
  onReclaim?: (pid: number) => void;
  debug?: (message: string) => void;
}

export async function startResolvedService(args: StartResolvedServiceArgs): Promise<ServerRecord> {
  const unit = unitByKey(args.manifest, args.name);
  if (!unit) {
    throw new Error(
      args.manifest.repositories[args.name] !== undefined
        ? `repository "${args.name}" declares no service`
        : `service "${args.name}" is not runnable in the manifest`,
    );
  }
  const repo = unit.repoDef;
  const service = unit.def;
  // `args.cwd` is the repository's worktree; the service runs in its own folder
  // inside it (a monorepo's apps/api), or at the root when it declares none.
  const cwd = service.cwd ? join(args.cwd, service.cwd) : args.cwd;
  const resolvedSvc = args.resolved.services[args.name]!;

  // The ticket's own env, layered between the repository's `.env` and
  // karst's resolved wiring. Read per service so `*` and the service's own
  // scope both apply; the origin `.env` is never written.
  const overrides = envOverridesForService(args.envOverrides, args.name);
  const overrideKeys = Object.keys(overrides);
  if (overrideKeys.length > 0) {
    const shadowed = shadowedOverrideKeys(overrides, resolvedSvc.env);
    args.debug?.(
      `[runtime] ticket ${args.ticketId}: ${args.name} applying ${overrideKeys.length} env override(s)` +
        (shadowed.length > 0 ? ` — ignored (karst-owned): ${shadowed.join(', ')}` : ''),
    );
  }
  const spawnEnv = buildSpawnEnv(join(repo.repoPath, '.env'), resolvedSvc.env, overrides);
  // Expand ${PORT}-style tokens against the resolved env so a manifest can
  // pin the port in the command (independent of the worktree's own config).
  const httpSlot = service.ports.find((p) => p.name === 'http') ?? service.ports[0]!;
  const ownPort = resolvedSvc.ports[httpSlot.name]!;
  // A command in the worktree or a container image — `serviceLaunch` is the
  // one place that difference is decided, so baseline cannot drift from it.
  const { command, args: cmdArgs, container, healthUrl } = serviceLaunch({
    service,
    name: args.name,
    ticketId: args.ticketId,
    env: spawnEnv,
    host: args.manifest.host,
    port: ownPort,
    cwd,
  });
  args.debug?.(
    `[runtime] ticket ${args.ticketId}: starting ${args.name} (port ${ownPort}, cwd ${cwd}` +
      `${container ? `, container ${container}` : ''})`,
  );
  return await startHot(args.store, {
    ticketId: args.ticketId,
    service: args.name,
    command,
    args: cmdArgs,
    cwd,
    env: spawnEnv,
    host: args.manifest.host,
    port: ownPort,
    healthUrl,
    requireIdentity: service.healthIdentity === true,
    logPath: serverLogPath(args.cwd, args.name),
    repoPath: repo.repoPath,
    container,
    signal: args.signal,
    onReclaim: args.onReclaim,
    debug: args.debug,
  });
}
