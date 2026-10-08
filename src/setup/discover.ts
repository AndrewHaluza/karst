/**
 * Deterministic workspace discovery for the onboarding setup agent.
 *
 * The agent reasons over these FACTS; it does not have to guess them. All I/O
 * is injected (`DiscoveryProbe`), so the whole engine is pure and unit-testable
 * against fixture workspaces — and a real `git`/`fs` probe can back a future
 * `karst setup discover` verb without touching this file.
 *
 * Two rules from the ticket are enforced here, not left to the prompt:
 *  - the baseline branch is DETECTED (origin HEAD, else a present
 *    main/master/develop, else the caller's default) — never assumed `develop`;
 *  - a repository only gets a service candidate when a real start command AND a
 *    real port can be inferred. No placeholder commands, no invented ports: a
 *    repo that does not qualify comes back with `service: null` and a reason.
 */

export interface DiscoveryProbe {
  /** File text, or undefined when absent/unreadable. */
  readFile(path: string): string | undefined;
  /** Directory entry names, or [] when absent/not a directory. */
  listDir(path: string): string[];
  /** True when the path exists (file or directory). */
  exists(path: string): boolean;
  /** `git -C <dir> <args>` stdout trimmed, or undefined on any failure. */
  git(dir: string, args: readonly string[]): string | undefined;
}

export interface PortCandidate {
  name: string;
  env: string;
  default: number;
}

export interface ServiceCandidate {
  start: string;
  /** Health template using `{host}`/`{port}`; omitted means the runtime default. */
  health?: string;
  ports: PortCandidate[];
  /** Where the inference came from, for the report's "assumptions made" list. */
  source: 'package.json' | 'Procfile' | 'Makefile' | 'docker-compose';
}

export interface DiscoveredRepo {
  /** Manifest-safe repository name derived from the directory. */
  name: string;
  /** Absolute directory path (as given to the probe). */
  path: string;
  baselineBranch: string;
  baselineBranchSource: 'origin-head' | 'local' | 'head' | 'default';
  service: ServiceCandidate | null;
  /** Why there is no service, when `service` is null. */
  serviceReason: string;
}

export interface DiscoveryResult {
  repos: DiscoveredRepo[];
  /** True when the workspace holds no git repository at all. */
  empty: boolean;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.karst']);

/**
 * How deep below the workspace root to look for repositories. A monorepo keeps
 * its apps at `apps/<app>` or `packages/<pkg>` (depth 2); 3 leaves headroom for
 * one more grouping level without walking a whole tree.
 */
const MAX_DISCOVERY_DEPTH = 3;

/** Turn a directory basename into a manifest-safe repository name. */
export function repoNameFor(dirName: string): string {
  const cleaned = dirName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  // A name made only of punctuation (e.g. '...') is not a usable key.
  if (cleaned === '' || /^[._-]+$/.test(cleaned)) return 'repo';
  return cleaned.slice(0, 64);
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function basename(p: string): string {
  const s = stripTrailingSlash(p);
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/** Is `dir` itself a git worktree? `.git` is a directory (normal) or file (submodule). */
function isGitRepo(dir: string, probe: DiscoveryProbe): boolean {
  return probe.exists(`${dir}/.git`);
}

/**
 * Detect the real baseline branch for a repository:
 *  1. `origin/HEAD` (what `git clone` checked out) — the authoritative answer;
 *  2. else a present local `main`, then `master`, then `develop`;
 *  3. else the CURRENT branch (`symbolic-ref --short HEAD`) — this is the only
 *     signal a freshly `git init`ed, never-committed repo has, and it is still
 *     the real branch the user is on (e.g. `main` or `trunk`), not a guess;
 *  4. else the caller's `defaultBranch`.
 * The order `main → master → develop` is deliberate: the ticket says never
 * assume `develop`, and between the two legacy defaults `main` is the modern one.
 */
export function detectBaselineBranch(
  dir: string,
  probe: DiscoveryProbe,
  defaultBranch: string,
): { branch: string; source: DiscoveredRepo['baselineBranchSource'] } {
  const head = probe.git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) {
    const branch = basename(head.trim());
    if (branch !== '' && branch !== 'HEAD') return { branch, source: 'origin-head' };
  }
  for (const candidate of ['main', 'master', 'develop']) {
    const found = probe.git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    // `show-ref --quiet` prints nothing on success and exits 0; the probe
    // returns '' (not undefined) for a successful empty stdout.
    if (found !== undefined) return { branch: candidate, source: 'local' };
  }
  // A never-committed repo has no refs at all, but HEAD still names the branch
  // the user is on. `--short` returns 'HEAD' when detached, which we ignore.
  const current = probe.git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (current) {
    const branch = current.trim();
    if (branch !== '' && branch !== 'HEAD') return { branch, source: 'head' };
  }
  return { branch: defaultBranch, source: 'default' };
}

function parsePackageJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const FRAMEWORK_PORTS: readonly [string, number][] = [
  ['next', 3000],
  ['nuxt', 3000],
  ['@angular/core', 4200],
  ['react-scripts', 3000],
  ['@sveltejs/kit', 5173],
  ['vite', 5173],
  ['webpack-dev-server', 8080],
];

function allDependencyNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) {
    const block = pkg[key];
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

function frameworkPort(pkg: Record<string, unknown>): { port: number; framework: string } | undefined {
  const deps = allDependencyNames(pkg);
  for (const [framework, port] of FRAMEWORK_PORTS) {
    if (deps.has(framework)) return { port, framework };
  }
  return undefined;
}

/** The `PORT=<n>` value from `.env.example` / `.env`, if present. */
function envExamplePort(repoDir: string, probe: DiscoveryProbe): number | undefined {
  for (const file of ['.env.example', '.env']) {
    const text = probe.readFile(`${repoDir}/${file}`);
    if (text === undefined) continue;
    const m = /^\s*PORT\s*=\s*(\d{2,5})\s*$/m.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }
  return undefined;
}

/** A `--port <n>` / `-p <n>` flag inside a package.json script. */
function scriptPort(script: string): number | undefined {
  const m = /(?:--port|-p)\s+(\d{2,5})\b/.exec(script);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

function readScripts(pkg: Record<string, unknown>): Record<string, string> {
  const scripts = pkg.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/** Is this script something that STARTS a long-running server? */
function isServerScript(name: string): boolean {
  return /^(dev|start|serve|develop)$/.test(name);
}

function inferFromPackageJson(
  repoDir: string,
  probe: DiscoveryProbe,
): { service: ServiceCandidate; reason: string } | { service: null; reason: string } {
  const pkg = parsePackageJson(probe.readFile(`${repoDir}/package.json`));
  if (pkg === undefined) return { service: null, reason: 'no package.json' };
  const scripts = readScripts(pkg);
  // Prefer dev, then start, then serve — the conventional long-running targets.
  const pick = ['dev', 'start', 'serve'].find((n) => isServerScript(n) && scripts[n] !== undefined);
  if (pick === undefined) return { service: null, reason: 'no dev/start/serve script' };

  let port = scriptPort(scripts[pick]!);
  let framework: string | undefined;
  if (port === undefined) {
    const fw = frameworkPort(pkg);
    if (fw) {
      port = fw.port;
      framework = fw.framework;
    }
  }
  if (port === undefined) port = envExamplePort(repoDir, probe);
  if (port === undefined) {
    return {
      service: null,
      reason: `found a '${pick}' script but no port (add PORT to .env.example, or declare the port in the manifest)`,
    };
  }
  const start = pick === 'start' ? 'npm start' : `npm run ${pick}`;
  // A framework dev server answers its root page; a bare node server is assumed
  // to answer /health, which is the runtime default when health is omitted.
  const health = framework ? 'http://{host}:{port}/' : undefined;
  const service: ServiceCandidate = {
    start,
    ports: [{ name: 'port', env: 'PORT', default: port }],
    source: 'package.json',
  };
  if (health !== undefined) service.health = health;
  return { service, reason: `inferred from package.json '${pick}' script${framework ? ` (${framework})` : ''}` };
}

function inferFromProcfile(
  repoDir: string,
  probe: DiscoveryProbe,
): ServiceCandidate | null {
  const text = probe.readFile(`${repoDir}/Procfile`);
  if (text === undefined) return null;
  const web = /^\s*web:\s*(.+)$/m.exec(text);
  const cmd = web?.[1]?.trim();
  if (!cmd) return null;
  const port = envExamplePort(repoDir, probe);
  if (port === undefined) return null;
  return { start: cmd, ports: [{ name: 'port', env: 'PORT', default: port }], source: 'Procfile' };
}

function inferFromMakefile(
  repoDir: string,
  probe: DiscoveryProbe,
): ServiceCandidate | null {
  const text = probe.readFile(`${repoDir}/Makefile`);
  if (text === undefined) return null;
  const target = ['dev', 'start', 'run', 'serve'].find((t) => new RegExp(`^${t}:`, 'm').test(text));
  if (!target) return null;
  const port = envExamplePort(repoDir, probe);
  if (port === undefined) return null;
  return { start: `make ${target}`, ports: [{ name: 'port', env: 'PORT', default: port }], source: 'Makefile' };
}

/** `docker-compose.yml` / `compose.yml`: first published `host:container` port. */
function inferFromCompose(
  repoDir: string,
  probe: DiscoveryProbe,
): ServiceCandidate | null {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((f) =>
    probe.exists(`${repoDir}/${f}`),
  );
  if (file === undefined) return null;
  const text = probe.readFile(`${repoDir}/${file}`);
  if (text === undefined) return null;
  // Deliberately shallow: YAML parsing belongs to a real parser, and inventing a
  // port is worse than reporting no service. Match a `- 8080:8080` list item.
  const m = /-\s*["']?(\d{2,5}):(\d{2,5})["']?/.exec(text);
  if (!m) return null;
  const hostPort = Number(m[1]);
  if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort >= 65536) return null;
  return {
    start: 'docker compose up',
    ports: [{ name: 'port', env: 'PORT', default: hostPort }],
    source: 'docker-compose',
  };
}

export function inferService(
  repoDir: string,
  probe: DiscoveryProbe,
): { service: ServiceCandidate | null; reason: string } {
  const pkg = inferFromPackageJson(repoDir, probe);
  if (pkg.service) return pkg;

  const procfile = inferFromProcfile(repoDir, probe);
  if (procfile) return { service: procfile, reason: 'inferred from Procfile' };
  const makefile = inferFromMakefile(repoDir, probe);
  if (makefile) return { service: makefile, reason: 'inferred from Makefile' };
  const compose = inferFromCompose(repoDir, probe);
  if (compose) return { service: compose, reason: 'inferred from docker-compose' };

  // No runnable start: the repo gets NO service, with the package.json reason
  // (the most specific) or a generic one.
  return { service: null, reason: pkg.reason };
}

export function discoverWorkspace(
  root: string,
  probe: DiscoveryProbe,
  defaultBranch: string,
): DiscoveryResult {
  const trimmedRoot = stripTrailingSlash(root);
  const dirs: { name: string; path: string }[] = [];

  // The workspace root may itself be the repository (a single-repo project), or
  // hold repositories at any depth up to `MAX_DISCOVERY_DEPTH` (a monorepo keeps
  // its apps under `apps/` or `packages/`). The walk STOPS at a repository, so
  // nested git repos inside one (submodules, vendored checkouts) are not
  // reported as separate projects.
  const collect = (dir: string, depth: number): void => {
    if (isGitRepo(dir, probe)) {
      dirs.push({ name: basename(dir), path: dir });
      return;
    }
    if (depth >= MAX_DISCOVERY_DEPTH) return;
    for (const entry of probe.listDir(dir).sort()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const child = `${dir}/${entry}`;
      if (!probe.exists(child)) continue;
      collect(child, depth + 1);
    }
  };
  collect(trimmedRoot, 0);

  const usedNames = new Set<string>();
  const repos = dirs.map((d): DiscoveredRepo => {
    let name = repoNameFor(d.name);
    let n = 2;
    while (usedNames.has(name)) name = `${repoNameFor(d.name)}-${n++}`;
    usedNames.add(name);
    const { branch, source } = detectBaselineBranch(d.path, probe, defaultBranch);
    const inferred = inferService(d.path, probe);
    return {
      name,
      path: d.path,
      baselineBranch: branch,
      baselineBranchSource: source,
      service: inferred.service,
      serviceReason: inferred.reason,
    };
  });

  return { repos, empty: repos.length === 0 };
}
