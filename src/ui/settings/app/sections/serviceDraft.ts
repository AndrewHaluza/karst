/**
 * The Services tab's draft helpers (NDL-126 §8.3, phase 3 step 3).
 *
 * This tab is the repository/port/binding graph, and most of the risk is in what
 * a write must NOT do. Each rule below exists because the alternative silently
 * changes a user's configuration:
 *
 * - **`repositories` is SPREAD, never rebuilt.** The host's `mergeSection` deletes
 *   a field the incoming manifest no longer carries, so a rebuilt map drops every
 *   repository the tab does not render (D1/D3, the same rule as Git's
 *   `conventions` and Agents' `processes`).
 * - **A DRAFT repository is a DISABLED one.** A new repository is created with no
 *   `service` key and `enabled: false`. It is not runnable until the user says
 *   so, and the system never uses a disabled repository — so an incomplete one is
 *   a valid manifest.
 * - **A rename is a RE-KEY.** The repository name is the record key, so renaming
 *   rebuilds the map preserving insertion order AND repoints every `dependsOn`
 *   target that referenced the old name (or any `old/<service>` of it). Missing
 *   the repoint leaves a dependency pointing at a repository that no longer exists.
 * - **The two shapes are kept as written.** `service:` is the shorthand for ONE
 *   service named after the repository; `services:` is the named map. Saving never
 *   converts one into the other, except by the explicit "Split" action.
 * - **The runtime fields render only when there IS a service.** An empty "Start
 *   command" box is what used to invite a fake value.
 * - **An empty port list is NOT "nothing happens".** The host falls back to
 *   probing the repository's `package.json`, so the empty state says so rather
 *   than showing a blank table.
 */
import { resolveTarget, SERVICE_SEP, unitsOf } from '../../../../manifest/runnable.js';
import type {
  DependsOn,
  Manifest,
  PortSlot,
  RepositoryDef,
  ServiceDef,
} from '../../../../manifest/types.js';

/** A service name is a path-safe token: it is joined to the repo as `repo/service`. */
const SERVICE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The repository names in insertion order — the roster's row order. */
export function repositoryNames(draft: Manifest): readonly string[] {
  return Object.keys(draft.repositories ?? {});
}

/** The first free `repo-N` name, the way the vanilla Add button picks one. */
export function nextRepositoryName(draft: Manifest): string {
  let n = 1;
  let name = `repo-${n}`;
  while ((draft.repositories ?? {})[name]) {
    n += 1;
    name = `repo-${n}`;
  }
  return name;
}

/** A newly added repository: no `service`, disabled, awaiting the author. */
export function newRepository(): RepositoryDef {
  return { repoPath: '', hasMigrations: false, signals: [], enabled: false };
}

/** Every service definition a repository declares, in order, for either shape. */
function serviceDefsOf(repo: RepositoryDef | undefined): readonly ServiceDef[] {
  if (!repo) return [];
  return unitsOf('', repo).map((u) => u.def);
}

/**
 * Rewrite every `dependsOn` target in the draft through `rewrite`. Both shapes are
 * walked, so a rename reaches a dependency declared on a `services:` entry too.
 * A service with no `dependsOn` key is left without one — only present lists are
 * rewritten, so nothing is added to the file.
 */
function mapDependsOn(
  repositories: Record<string, RepositoryDef>,
  rewrite: (target: string) => string,
): Record<string, RepositoryDef> {
  const repoRewrite = (def: ServiceDef): ServiceDef =>
    def.dependsOn === undefined
      ? def
      : ({
          ...def,
          dependsOn: def.dependsOn.map((dep: DependsOn) => ({ ...dep, target: rewrite(dep.target) })),
        } as ServiceDef);
  return Object.fromEntries(
    Object.entries(repositories).map(([name, repo]) => {
      const next: RepositoryDef = { ...repo };
      if (repo.service) next.service = repoRewrite(repo.service);
      if (repo.services) {
        next.services = Object.fromEntries(
          Object.entries(repo.services).map(([svc, def]) => [svc, repoRewrite(def)]),
        );
      }
      return [name, next];
    }),
  );
}

/** Repoint a target at a renamed repository: `old` and `old/<service>` both follow it. */
function repointRepo(target: string, oldName: string, nextName: string): string {
  if (target === oldName) return nextName;
  if (target.startsWith(`${oldName}${SERVICE_SEP}`)) {
    return `${nextName}${target.slice(oldName.length)}`;
  }
  return target;
}

/**
 * Rename a repository: re-key the map preserving insertion order and repoint every
 * `dependsOn.target` that named the old one.
 *
 * Returns `null` for a blank or duplicate name — the caller re-renders, which
 * restores the old value, exactly as the vanilla view does.
 */
export function renameRepository(draft: Manifest, oldName: string, raw: string): Manifest | null {
  const next = (raw ?? '').trim();
  if (next === oldName) return null;
  if (next === '') return null;
  const repositories = draft.repositories ?? {};
  if (Object.prototype.hasOwnProperty.call(repositories, next)) return null;

  // Insertion order is preserved by rebuilding the map in the OLD key order with
  // the renamed entry in the old entry's position, so the roster does not re-sort.
  const repointed = mapDependsOn(repositories, (t) => repointRepo(t, oldName, next));
  const entries = Object.entries(repointed).map(
    ([name, repo]) => [name === oldName ? next : name, repo] as const,
  );
  return { ...draft, repositories: Object.fromEntries(entries) as Manifest['repositories'] };
}

/** Add, replace or remove one repository, spreading the map. */
export function writeRepository(draft: Manifest, name: string, repo: RepositoryDef | null): Manifest {
  const next = { ...(draft.repositories ?? {}) } as Record<string, RepositoryDef>;
  // Absent IS "no repositories" — the same absent-field rule every other control
  // follows, so an emptied map deletes the key rather than writing `{}`.
  if (repo === null) delete next[name];
  else next[name] = repo;
  const rest: Manifest = { ...draft };
  if (Object.keys(next).length > 0) rest.repositories = next as Manifest['repositories'];
  else delete (rest as { repositories?: unknown }).repositories;
  return rest;
}

/** Write one field onto a repository, spreading the record. */
export function writeRepositoryField(
  draft: Manifest,
  name: string,
  patch: Partial<RepositoryDef>,
): Manifest {
  const repo = (draft.repositories ?? {})[name];
  if (!repo) return draft;
  return writeRepository(draft, name, { ...repo, ...patch } as RepositoryDef);
}

/**
 * Set `enabled` explicitly.
 *
 * Absent means enabled on disk, so the toggle writes a literal boolean rather
 * than flipping `enabled === false` — that would turn an absent field into a
 * literal `true` and churn the file.
 */
export function setRepositoryEnabled(draft: Manifest, name: string, enabled: boolean): Manifest {
  return writeRepositoryField(draft, name, { enabled });
}

/** Whether a repository declares a service in either shape — i.e. whether runtime fields render. */
export function isRunnable(repo: RepositoryDef | undefined): boolean {
  return serviceDefsOf(repo).length > 0;
}

/** Whether a repository uses the `services:` map (its entries are edited one by one). */
export function isMultiService(repo: RepositoryDef | undefined): boolean {
  return repo?.services !== undefined;
}

/** The runtime badge, answering "what will spin actually do here?". */
export function runtimeBadge(repo: RepositoryDef | undefined): 'docker' | 'service' | 'worktree' {
  const defs = serviceDefsOf(repo);
  if (defs.length === 0) return 'worktree';
  return defs.some((d) => d.docker) ? 'docker' : 'service';
}

/** The baseline a repository uses: its own, else the project default. */
export function baselineFor(repo: RepositoryDef | undefined, projectBaseline: string | undefined): string {
  return repo?.baselineBranch || projectBaseline || 'main';
}

/** Parse one port's default value, which the DOM delivers as a string. */
export function portDefault(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the dependency's bind list out of a newline-separated textarea. */
export function parseLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The EMPTY-PORT fallback line.
 *
 * An empty port list is NOT "nothing happens": the host falls back to probing the
 * repository's `package.json` scripts, and an empty override is indistinguishable
 * from no override. So the empty state has to say which fallback applies.
 */
export function emptyPortsNotice(def: ServiceDef | undefined): string {
  return def?.docker
    ? 'No ports declared — a container service publishes only the ports this list declares, so none are published.'
    : "No ports declared — Karst probes this repository's package.json scripts instead. Not a Node project? Declare the port explicitly.";
}

/** The EMPTY-DEPENDENCY notice, which differs when nothing else is runnable. */
export function emptyDependencyNotice(otherRunnable: readonly string[]): string | null {
  return otherRunnable.length === 0 ? 'No other runnable repositories to depend on.' : null;
}

/** Write one port on a service definition, spreading the array. A blank name removes the port. */
export function writePort(
  def: ServiceDef,
  index: number,
  patch: { name?: string; env?: string; default?: number | undefined },
): ServiceDef {
  const ports: PortSlot[] = [...(def.ports ?? [])];
  const existing = ports[index] ?? ({ name: '', env: '', default: 0 } as unknown as PortSlot);
  const merged: Record<string, unknown> = { ...existing, ...patch };
  // A cleared optional value is DELETED rather than written as '' or 0, so the
  // file says "unset" instead of carrying a value the host has to special-case.
  if (patch.name === '') delete merged.name;
  if (patch.env === '') delete merged.env;
  if (patch.default === undefined) delete merged.default;
  ports[index] = merged as unknown as PortSlot;
  return { ...def, ports } as ServiceDef;
}

/** Add a port. The vanilla view appends an empty row the user then fills. */
export function addPort(def: ServiceDef): ServiceDef {
  const ports = [...(def.ports ?? []), { name: '', env: '', default: 0 }];
  return { ...def, ports } as ServiceDef;
}

/** Remove the port at `index`, and drop `ports` when the last one goes. */
export function removePort(def: ServiceDef, index: number): ServiceDef {
  const ports: PortSlot[] = [...(def.ports ?? [])];
  ports.splice(index, 1);
  if (ports.length === 0) {
    // An empty ARRAY would still claim the key, so the host's merge would keep a
    // block the user deleted. Removing the key is what "no ports" means.
    const copy = { ...def } as Record<string, unknown>;
    delete copy.ports;
    return copy as unknown as ServiceDef;
  }
  return { ...def, ports } as ServiceDef;
}

/** Add a signal word, ignoring a blank one. */
export function addSignal(repo: RepositoryDef, signal: string): RepositoryDef {
  const trimmed = signal.trim();
  if (trimmed === '') return repo;
  return { ...repo, signals: [...(repo.signals ?? []), trimmed] } as RepositoryDef;
}

/** Remove one signal by VALUE — signals are a set of words, not keyed rows. */
export function removeSignal(repo: RepositoryDef, signal: string): RepositoryDef {
  return { ...repo, signals: (repo.signals ?? []).filter((s: string) => s !== signal) };
}

/* ------------------------------------------------------------------------ *
 * Multi-service (`services:` map)
 * ------------------------------------------------------------------------ */

/** Whether `name` is a legal service name: a path-safe token, never containing `/`. */
export function isValidServiceName(name: string): boolean {
  return SERVICE_NAME_RE.test(name);
}

/** The first free `service-N` name in a `services:` map. */
export function nextServiceName(repo: RepositoryDef): string {
  const taken = repo.services ?? {};
  let n = 1;
  while (Object.prototype.hasOwnProperty.call(taken, `service-${n}`)) n += 1;
  return `service-${n}`;
}

/**
 * Convert the `service:` shorthand into a `services:` map holding ONE entry named
 * after the repository. This is the only path from one shape to the other — the
 * reverse is never automatic.
 */
export function splitToServices(repo: RepositoryDef, repoName: string): RepositoryDef {
  if (!repo.service) return repo;
  const { service, ...rest } = repo;
  return { ...rest, services: { [repoName]: service } } as RepositoryDef;
}

/** Add an empty service entry to a `services:` map, creating the map if needed. */
export function addService(repo: RepositoryDef, name: string): RepositoryDef {
  const entry = { start: '', ports: [], dependsOn: [] } as unknown as ServiceDef;
  return { ...repo, services: { ...(repo.services ?? {}), [name]: entry } } as RepositoryDef;
}

/** Remove one service entry; the `services` key goes when the last one does. */
export function removeService(repo: RepositoryDef, name: string): RepositoryDef {
  const services = { ...(repo.services ?? {}) };
  delete services[name];
  const copy = { ...repo } as Record<string, unknown>;
  if (Object.keys(services).length === 0) {
    delete copy.services;
  } else {
    copy.services = services;
  }
  return copy as unknown as RepositoryDef;
}

/** Write fields onto one service entry of a `services:` map, keeping its siblings. */
export function writeService(
  repo: RepositoryDef,
  name: string,
  patch: Partial<ServiceDef>,
): RepositoryDef {
  const current = (repo.services ?? {})[name];
  if (!current) return repo;
  const services = { ...(repo.services ?? {}), [name]: { ...current, ...patch } as ServiceDef };
  return { ...repo, services } as RepositoryDef;
}

/**
 * Rename one service entry of a repository. Refused (returns `null`) when the new
 * name is blank, illegal, or already taken in that repository. Preserves the
 * entry's position and repoints every `dependsOn` that named `repo/old`, anywhere
 * in the draft.
 */
export function renameServiceInDraft(
  draft: Manifest,
  repoName: string,
  oldName: string,
  raw: string,
): Manifest | null {
  const next = (raw ?? '').trim();
  if (next === oldName || !isValidServiceName(next)) return null;
  const repo = (draft.repositories ?? {})[repoName];
  if (!repo?.services || !Object.prototype.hasOwnProperty.call(repo.services, oldName)) return null;
  if (Object.prototype.hasOwnProperty.call(repo.services, next)) return null;

  const oldKey = `${repoName}${SERVICE_SEP}${oldName}`;
  const newKey = `${repoName}${SERVICE_SEP}${next}`;
  const services = Object.fromEntries(
    Object.entries(repo.services).map(([svc, def]) => [svc === oldName ? next : svc, def]),
  ) as Record<string, ServiceDef>;
  const repositories = {
    ...(draft.repositories ?? {}),
    [repoName]: { ...repo, services },
  } as Record<string, RepositoryDef>;
  const repointed = mapDependsOn(repositories, (t) => (t === oldKey ? newKey : t));
  return { ...draft, repositories: repointed as Manifest['repositories'] };
}

/* ------------------------------------------------------------------------ *
 * Dependency targets
 * ------------------------------------------------------------------------ */

/**
 * Every unit key a dependency may name: `repo` for a single-service repository,
 * `repo/service` for each `services:` entry, in declaration order.
 */
function allUnitKeys(draft: Manifest): readonly string[] {
  return Object.entries(draft.repositories ?? {}).flatMap(([name, repo]) =>
    unitsOf(name, repo).map((u) => u.key),
  );
}

/** The targets a dependency may name: every runnable unit but its own. */
export function dependencyTargetsFor(draft: Manifest, ownerKey: string): readonly string[] {
  return allUnitKeys(draft).filter((key) => key !== ownerKey);
}

/** The port names a dependency target offers, which its bind `port` selects from. */
export function portsOfTarget(draft: Manifest, target: string): readonly string[] {
  const resolved = resolveTarget(draft.repositories ?? {}, target);
  if (!('unit' in resolved)) return [];
  return (resolved.unit.def.ports ?? []).map((p) => p.name);
}
