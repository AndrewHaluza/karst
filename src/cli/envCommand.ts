import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { serviceUnits, SERVICE_SEP, unitsOf } from '../manifest/runnable.js';
import {
  ALL_SERVICES,
  getEnvOverrides,
  isValidEnvKey,
  setServiceEnvOverrides,
} from '../store/ticketEnvOverrides.js';

export type EnvAction = 'list' | 'set' | 'unset';

export interface ParsedEnvArgs {
  action: EnvAction;
  /** Manifest repository name, or `*` for every service. */
  scope: string;
  /** `set`: KEY=VALUE pairs. `unset`: bare KEYs. `list`: empty. */
  pairs: { key: string; value: string }[];
  /** `list` only: print values, not just keys. */
  showValues: boolean;
}

export function parseEnvArgs(rest: string[]): ParsedEnvArgs {
  const action = rest[1];
  if (action !== 'list' && action !== 'set' && action !== 'unset') {
    throw new Error(`karst env: want 'list', 'set' or 'unset' (got '${action ?? ''}')`);
  }

  let scope = ALL_SERVICES;
  let showValues = false;
  const positionals: string[] = [];
  for (let i = 2; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--service') {
      const name = rest[++i];
      if (name === undefined) throw new Error('karst env: --service needs a name');
      scope = name;
    } else if (token === '--values') {
      if (action !== 'list') throw new Error("karst env: --values is only valid for 'list'");
      showValues = true;
    } else {
      positionals.push(token);
    }
  }

  if (action === 'list') {
    if (positionals.length > 0) throw new Error("karst env: 'list' takes no arguments");
    return { action, scope, pairs: [], showValues };
  }

  if (action === 'set') {
    if (positionals.length === 0) throw new Error("karst env: 'set' wants at least one KEY=VALUE");
    const pairs: { key: string; value: string }[] = [];
    for (const positional of positionals) {
      const eq = positional.indexOf('=');
      if (eq === -1) throw new Error(`karst env: 'set' wants KEY=VALUE (got '${positional}')`);
      const key = positional.slice(0, eq);
      const value = positional.slice(eq + 1);
      if (!isValidEnvKey(key)) {
        throw new Error(`karst env: '${key}' is not a valid environment variable name`);
      }
      pairs.push({ key, value });
    }
    return { action, scope, pairs, showValues };
  }

  if (positionals.length === 0) throw new Error("karst env: 'unset' wants at least one KEY");
  const pairs = positionals.map((positional) => {
    if (positional.includes('=')) {
      throw new Error(`karst env: 'unset' wants a bare KEY (got '${positional}')`);
    }
    if (!isValidEnvKey(positional)) {
      throw new Error(`karst env: '${positional}' is not a valid environment variable name`);
    }
    return { key: positional, value: '' };
  });
  return { action, scope, pairs, showValues };
}

/**
 * Resolve a `--service` scope to the unit key env overrides are stored under.
 * `*` passes through. With a manifest, the scope must name a unit: `repo` for a
 * single-service repository, `repo/service` for a multi-service one. A bare
 * `repo` that declares several services is refused, naming the choices. The
 * manifest is optional so a caller without one keeps the raw scope.
 */
export function resolveEnvScope(manifest: Manifest | undefined, scope: string): string {
  if (scope === ALL_SERVICES || manifest === undefined) return scope;
  const keys = serviceUnits(manifest).map((u) => u.key);
  if (keys.includes(scope)) return scope;
  const repo = manifest.repositories[scope];
  if (repo !== undefined && unitsOf(scope, repo).length > 1) {
    const choices = unitsOf(scope, repo).map((u) => `${scope}${SERVICE_SEP}${u.name}`);
    throw new Error(
      `karst env: '${scope}' has several services — name one of ${choices.join(', ')}`,
    );
  }
  throw new Error(
    `karst env: unknown service "${scope}" (valid: ${ALL_SERVICES}, ${keys.join(', ')})`,
  );
}

export function runEnvCommand(
  store: Store,
  ticketId: number,
  rest: string[],
  manifest?: Manifest,
): string {
  const parsedArgs = parseEnvArgs(rest);
  const parsed =
    parsedArgs.action === 'list'
      ? parsedArgs
      : { ...parsedArgs, scope: resolveEnvScope(manifest, parsedArgs.scope) };

  if (parsed.action === 'list') {
    const all = getEnvOverrides(store, ticketId);
    const scopes = Object.entries(all)
      .map(([scope, entries]) => ({
        scope,
        keys: Object.keys(entries).sort(),
        ...(parsed.showValues ? { values: entries } : {}),
      }))
      .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
    return JSON.stringify({ ok: true, ticketId, scopes });
  }

  if (parsed.action === 'set') {
    const current = getEnvOverrides(store, ticketId)[parsed.scope] ?? {};
    const merged: Record<string, string> = { ...current };
    for (const { key, value } of parsed.pairs) merged[key] = value;
    setServiceEnvOverrides(store, ticketId, parsed.scope, merged);
    return JSON.stringify({
      ok: true,
      ticketId,
      scope: parsed.scope,
      set: Object.keys(merged).sort(),
    });
  }

  const current = getEnvOverrides(store, ticketId)[parsed.scope] ?? {};
  const next: Record<string, string> = { ...current };
  const removed: string[] = [];
  for (const { key } of parsed.pairs) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      removed.push(key);
    }
  }
  setServiceEnvOverrides(store, ticketId, parsed.scope, next);
  return JSON.stringify({
    ok: true,
    ticketId,
    scope: parsed.scope,
    unset: removed.sort(),
  });
}
