/**
 * Render a `docker:` service block into the argv `startHot` spawns.
 *
 * Pure, and deliberately so: a container service must NOT become a second
 * runtime. Once this returns `{ command: 'docker', args }` everything downstream
 * — port reclaim, the health gate, the log file, the `servers` row, the cwd that
 * ties the process to its worktree, `killTree` — is the code that already runs
 * every other service, and stays tested by the tests that already cover it.
 *
 * Two decisions are load-bearing:
 *
 *  - The container runs ATTACHED (`docker run`, never `-d`). Detached, the
 *    client exits immediately, karst records a pid that is already gone, and the
 *    only handle on the running container is a name nothing checks. Attached,
 *    the client is a normal child in its own process group whose stdout IS the
 *    container's log, so `.karst/logs/<name>.log` fills without a second reader.
 *  - The name is DETERMINISTIC and recorded. A pid can be reissued by the OS to
 *    a stranger, which is why `serverIdentity.ts` refuses to signal one it cannot
 *    attribute; a container name cannot. It is therefore the handle every stop
 *    and reap path uses to make sure the container itself is gone — killing the
 *    client alone leaves the container running, holding its port and its memory,
 *    which is exactly the leak this feature must not introduce.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { DockerDef } from '../manifest/types.js';

/** Characters docker accepts in a container name; everything else collapses to `-`. */
function sanitize(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * The container name for one (service, ticket). Deterministic so a restart, a
 * reap, or a later window can address the same container without having stored
 * anything, and ticket-scoped so two tickets running the same service are two
 * containers rather than one fighting itself. `null` is the baseline singleton.
 */
export function containerName(service: string, ticketId: number | null): string {
  const scope = ticketId === null ? 'baseline' : `t${ticketId}`;
  return `karst-${scope}-${sanitize(service)}`;
}

export interface DockerRunInput {
  docker: DockerDef;
  /** From `containerName` — recorded in `servers.container` by the caller. */
  container: string;
  /** The allocated host port, published onto `docker.containerPort`. */
  hostPort: number;
  /** The interface to publish on (the manifest's `host`). */
  host: string;
  /** The RESOLVED service env (dependency bind vars, PORT). Block env wins. */
  env: Record<string, string>;
  /** The worktree — relative volume sources resolve against it. */
  cwd: string;
}

/**
 * A volume entry with its SOURCE resolved. `./data:/var/lib/x` in a manifest
 * means "this ticket's own data", so it must resolve against the worktree —
 * docker itself would reject the relative path outright, and an author who
 * worked around that with an absolute path would have every ticket sharing one
 * directory.
 */
function resolveVolume(entry: string, cwd: string): string {
  const sep = entry.indexOf(':');
  if (sep <= 0) return entry; // validation rejects this shape; render it verbatim
  const src = entry.slice(0, sep);
  const rest = entry.slice(sep + 1);
  // A named volume (no path separator, e.g. `pgdata:/var/lib/x`) is docker's own
  // storage and must NOT be turned into a directory path.
  const isPath = src.startsWith('.') || src.startsWith('/') || src.startsWith('~');
  // `~` is the SHELL's expansion and docker never runs one, so it has to happen
  // here — resolving it against the worktree would hand docker a literal `~`
  // directory that does not exist instead of the user's home.
  // `src.slice(2)` (not `slice(1)`): the remainder must stay RELATIVE, or
  // `resolve` would read the leading `/` as absolute and drop the home prefix.
  const expanded = src === '~' ? homedir() : src.startsWith('~/') ? resolvePath(homedir(), src.slice(2)) : src;
  const source = isPath && !isAbsolute(expanded) ? resolvePath(cwd, expanded) : expanded;
  return `${source}:${rest}`;
}

/** Render `docker run …` for one service. Never throws; never shells out. */
export function renderDockerRun(input: DockerRunInput): { command: 'docker'; args: string[] } {
  const { docker, container, hostPort, host, env, cwd } = input;

  // The block's own env wins over the resolver's: the resolver supplies
  // addresses and ports it derived, the author supplies what the image needs,
  // and where the two name the same variable the author meant the author's.
  const merged = { ...env, ...docker.env };

  const args = [
    'run',
    '--rm',
    '--name',
    container,
    '-p',
    `${host}:${hostPort}:${docker.containerPort}`,
  ];
  // One argv entry per value, never a joined string: `spawn` runs docker without
  // a shell, so a value holding spaces or `;` is data, not syntax.
  for (const [key, value] of Object.entries(merged)) args.push('-e', `${key}=${value}`);
  for (const volume of docker.volumes) args.push('-v', resolveVolume(volume, cwd));
  args.push(docker.image, ...docker.args);

  return { command: 'docker', args };
}
