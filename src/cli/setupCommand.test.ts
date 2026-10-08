import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupCommand } from './setupCommand.js';
import type { DiscoveryProbe } from '../setup/discover.js';
import type { ChangeProposal } from '../setup/proposal.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-setup-cmd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeProbe(): DiscoveryProbe {
  return {
    readFile: (p) => (p === '/w/web/package.json' ? JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '^5' } }) : undefined),
    listDir: (p) => (p === '/w' ? ['web'] : []),
    exists: (p) => p === '/w' || p === '/w/web' || p === '/w/web/.git',
    git: () => undefined,
  };
}

describe('runSetupCommand discover', () => {
  it('prints the deterministic discovery result', () => {
    const out = JSON.parse(
      runSetupCommand(['setup', 'discover', '--root', '/w', '--default-branch', 'main'], { probe: fakeProbe() }),
    );
    expect(out.empty).toBe(false);
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toMatchObject({ name: 'web', baselineBranch: 'main', baselineBranchSource: 'default' });
    expect(out.repos[0].service.start).toBe('npm run dev');
  });

  it('rejects unknown args and a missing root value', () => {
    expect(() => runSetupCommand(['setup', 'discover', '--nope'], { probe: fakeProbe() })).toThrow(/unknown argument/);
    expect(() => runSetupCommand(['setup', 'discover', '--root'], { probe: fakeProbe() })).toThrow(/--root needs a path/);
  });

  it('refuses a --root that does not exist rather than reporting an empty workspace', () => {
    expect(() => runSetupCommand(['setup', 'discover', '--root', '/missing'], { probe: fakeProbe() })).toThrow(
      /--root \/missing does not exist/,
    );
  });
});

describe('runSetupCommand propose-change', () => {
  it('writes a change proposal into KARST_SETUP_OUTBOX', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });
    const change = { kind: 'change', repo: 'web', reason: 'deps missing', command: 'npm ci' };
    const out = JSON.parse(
      runSetupCommand(['setup', 'propose-change'], {
        outboxEnv: outbox,
        uuid: () => 'fixed',
        readStdin: () => JSON.stringify(change),
      }),
    );
    expect(out).toEqual({ ok: true, kind: 'change', file: join(realpathSync(outbox), 'fixed.json') });
    const written = JSON.parse(readFileSync(join(outbox, 'fixed.json'), 'utf8')) as ChangeProposal;
    expect(written).toEqual(change);
  });

  it('normalizes the flat MCP tool object (no kind) into a change proposal', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });
    const toolObject = { subcommand: 'propose-change', repo: 'web', reason: 'deps', command: 'npm ci' };
    const out = JSON.parse(
      runSetupCommand(['setup', 'propose-change'], {
        outboxEnv: outbox,
        uuid: () => 'fixed',
        readStdin: () => JSON.stringify(toolObject),
      }),
    );
    expect(out).toMatchObject({ ok: true, kind: 'change' });
    const written = JSON.parse(readFileSync(join(outbox, 'fixed.json'), 'utf8')) as ChangeProposal;
    expect(written).toEqual({ kind: 'change', repo: 'web', reason: 'deps', command: 'npm ci' });
  });

  it('rejects a manifest proposal and malformed JSON', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });
    expect(() =>
      runSetupCommand(['setup', 'propose-change'], {
        outboxEnv: outbox,
        readStdin: () => JSON.stringify({ kind: 'manifest', targetPath: '/a', yaml: 'x', summary: 's' }),
      }),
    ).toThrow(/kind must be 'change'/);
    expect(() =>
      runSetupCommand(['setup', 'propose-change'], { outboxEnv: outbox, readStdin: () => 'not json' }),
    ).toThrow(/not one JSON object/);
  });

  it('refuses without an outbox and refuses trailing args', () => {
    expect(() =>
      runSetupCommand(['setup', 'propose-change'], {
        readStdin: () => JSON.stringify({ kind: 'change', repo: 'web', reason: 'r', command: 'c' }),
      }),
    ).toThrow(/KARST_SETUP_OUTBOX/);
    expect(() => runSetupCommand(['setup', 'propose-change', '--x'], {})).toThrow(/takes no arguments/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runSetupCommand(['setup', 'nope'])).toThrow(/unknown subcommand/);
  });
});
