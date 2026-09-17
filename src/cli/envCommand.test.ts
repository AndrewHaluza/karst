import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { parseEnvArgs, runEnvCommand } from './envCommand.js';

describe('parseEnvArgs', () => {
  it('rejects a missing or unknown action', () => {
    expect(() => parseEnvArgs(['env'])).toThrow(/want 'list', 'set' or 'unset'/);
    expect(() => parseEnvArgs(['env', 'frobnicate'])).toThrow(
      "karst env: want 'list', 'set' or 'unset' (got 'frobnicate')",
    );
  });

  it('splits KEY=a=b on the first = only', () => {
    const parsed = parseEnvArgs(['env', 'set', 'KEY=a=b']);
    expect(parsed.pairs).toEqual([{ key: 'KEY', value: 'a=b' }]);
  });

  it('rejects an invalid key name and names it', () => {
    expect(() => parseEnvArgs(['env', 'set', 'MY-KEY=1'])).toThrow(/MY-KEY/);
  });

  it('rejects --values on set', () => {
    expect(() => parseEnvArgs(['env', 'set', '--values', 'K=1'])).toThrow(
      "karst env: --values is only valid for 'list'",
    );
  });
});

describe('runEnvCommand', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  it('sets on the default scope and lists it back', () => {
    runEnvCommand(store, id, ['env', 'set', 'FOO=bar']);
    const out = JSON.parse(runEnvCommand(store, id, ['env', 'list', '--values']));
    expect(out.scopes).toEqual([{ scope: '*', keys: ['FOO'], values: { FOO: 'bar' } }]);
  });

  it('keeps a first key when a second is set on the same scope', () => {
    runEnvCommand(store, id, ['env', 'set', 'A=1']);
    runEnvCommand(store, id, ['env', 'set', 'B=2']);
    const out = JSON.parse(runEnvCommand(store, id, ['env', 'list']));
    expect(out.scopes[0].keys).toEqual(['A', 'B']);
  });

  it('lists keys only, hiding values unless --values is passed', () => {
    runEnvCommand(store, id, ['env', 'set', 'K=v']);
    const bare = JSON.parse(runEnvCommand(store, id, ['env', 'list']));
    expect(bare.scopes[0].keys).toEqual(['K']);
    expect(bare.scopes[0]).not.toHaveProperty('values');
    const full = JSON.parse(runEnvCommand(store, id, ['env', 'list', '--values']));
    expect(full.scopes[0].values).toEqual({ K: 'v' });
  });

  it('unsets one key and leaves the other', () => {
    runEnvCommand(store, id, ['env', 'set', 'A=1']);
    runEnvCommand(store, id, ['env', 'set', 'B=2']);
    runEnvCommand(store, id, ['env', 'unset', 'A']);
    const out = JSON.parse(runEnvCommand(store, id, ['env', 'list']));
    expect(out.scopes[0].keys).toEqual(['B']);
  });

  it('removes the scope entirely when its final key is unset', () => {
    runEnvCommand(store, id, ['env', 'set', 'A=1']);
    runEnvCommand(store, id, ['env', 'unset', 'A']);
    const out = JSON.parse(runEnvCommand(store, id, ['env', 'list']));
    expect(out.scopes).toEqual([]);
  });

  it('writes a --service scope distinct from *', () => {
    runEnvCommand(store, id, ['env', 'set', '--service', 'api', 'TOKEN=x']);
    runEnvCommand(store, id, ['env', 'set', 'GLOBAL=y']);
    const out = JSON.parse(runEnvCommand(store, id, ['env', 'list']));
    expect(out.scopes.map((s: { scope: string }) => s.scope)).toEqual(['*', 'api']);
    expect(out.scopes[1].keys).toEqual(['TOKEN']);
  });
});
