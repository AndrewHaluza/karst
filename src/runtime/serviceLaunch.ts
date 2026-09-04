/**
 * The one place a `ServiceDef` becomes something spawnable.
 *
 * A service is either a command in the worktree or a container image, and BOTH
 * spin (ticket-hot services) and baseline (the shared singleton) have to start
 * either kind. Deriving the argv in each of them would be two answers to one
 * question — and the day they disagreed, one of the two would start a container
 * karst never recorded a name for, which is precisely the leak this feature
 * exists to avoid. So the derivation lives here and both callers read it.
 */

import type { ServiceDef } from '../manifest/types.js';
import { containerName, renderDockerRun } from './dockerCommand.js';
import { renderHealthUrl } from './healthUrl.js';

export interface ServiceLaunch {
  command: string;
  args: string[];
  /** The container name for a docker service; undefined for a command service. */
  container?: string;
  /** The URL (or `tcp://` target) the start is gated on. */
  healthUrl: string;
}

/**
 * The health target when the manifest declares none.
 *
 * `/health` is the right guess for a command service — it is a web app until
 * shown otherwise. It is the WRONG guess for a container: the images people run
 * this way are databases, caches and brokers, which answer nothing an HTTP probe
 * can read, so the gate could only ever time out and kill a container that came
 * up perfectly. For those the honest question is whether the published port
 * accepts a connection, which is what `tcp://` asks (`runtime/health.ts`).
 */
function defaultHealthUrl(isContainer: boolean, host: string, port: number): string {
  return isContainer ? `tcp://${host}:${port}` : `http://${host}:${port}/health`;
}

/**
 * Expand `${VAR}` / `$VAR` tokens in a start command against the resolved env
 * BEFORE the whitespace split, so a manifest can write the allocated port into
 * the command itself — e.g. `npm run dev -- --port ${PORT} --strictPort`. This
 * makes port binding independent of the worktree's own config: a hot worktree
 * branched before an app-side config fix still binds its allocated port. An
 * unknown token expands to empty string (mirrors shell behaviour).
 */
export function expandEnvTokens(start: string, env: Record<string, string>): string {
  return start.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, braced, bare) => env[braced ?? bare] ?? '');
}

function splitCommand(start: string): { command: string; args: string[] } {
  const parts = start.trim().split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
}

export interface ServiceLaunchInput {
  service: ServiceDef;
  /** The repository name — the service's identity in `servers` and in the name. */
  name: string;
  /** The ticket this service is hot for, or null for the baseline singleton. */
  ticketId: number | null;
  /** The resolved spawn env (dependency bind vars, the allocated port). */
  env: Record<string, string>;
  host: string;
  /** The allocated host port. A container publishes it onto its own port. */
  port: number;
  /** The directory the process runs in — the worktree, or the baseline checkout. */
  cwd: string;
}

/** Derive the argv (and container name, if any) for one service. */
export function serviceLaunch(input: ServiceLaunchInput): ServiceLaunch {
  const { service, name, ticketId, env, host, port, cwd } = input;

  const healthUrl = service.health
    ? renderHealthUrl(service.health, host, port)
    : defaultHealthUrl(service.docker !== undefined, host, port);

  if (service.docker) {
    const container = containerName(name, ticketId);
    const { command, args } = renderDockerRun({
      docker: service.docker,
      container,
      hostPort: port,
      host,
      env,
      cwd,
    });
    return { command, args, container, healthUrl };
  }

  // Expand ${PORT}-style tokens against the resolved env so a manifest can pin
  // the port in the command (independent of the worktree's own config).
  return { ...splitCommand(expandEnvTokens(service.start, env)), healthUrl };
}
