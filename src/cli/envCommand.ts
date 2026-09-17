import type { Store } from '../store/db.js';
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

export function runEnvCommand(store: Store, ticketId: number, rest: string[]): string {
  const parsed = parseEnvArgs(rest);

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
