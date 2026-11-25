import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_IMPORT_BYTES,
  MAX_LIST_ENTRIES,
  runPlanArtifactsCommand,
  type PlanArtifactsDeps,
} from './planArtifactsCommand.js';

/**
 * `karst plan-artifacts list` / `import` — a planning session reads a file of
 * another session of the same project, confined to that session's scratch dir.
 * Every path is a real tmp dir; the session-project lookup is injected.
 */
describe('plan-artifacts', () => {
  const OWN = 7;
  const OTHER = 17;
  let root: string;
  let scratchRoot: string;
  let ownSession: string;
  let artifacts: string;
  let otherSession: string;
  /** session id -> project id, the injected store lookup. */
  let sessions: Map<number, number>;

  const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    KARST_PLANNING_SESSION: String(OWN),
    KARST_ARTIFACTS: join(ownSession, 'artifacts'),
    KARST_PROJECT: '1',
    ...over,
  });

  const run = (argv: string[], over: Record<string, string | undefined> = {}): string =>
    runPlanArtifactsCommand(argv, {
      env: env(over),
      sessionProject: (id) => sessions.get(id),
    } as PlanArtifactsDeps);

  const write = (path: string, body: string | Uint8Array = 'x'): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-plan-artifacts-')));
    scratchRoot = join(root, 'planning-scratch');
    ownSession = join(scratchRoot, String(OWN));
    artifacts = join(ownSession, 'artifacts');
    otherSession = join(scratchRoot, String(OTHER));
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(join(otherSession, 'ref-chip'), { recursive: true });
    mkdirSync(join(otherSession, 'artifacts'), { recursive: true });
    mkdirSync(join(otherSession, 'outbox'), { recursive: true });
    write(join(otherSession, 'ref-chip', 'ref-chip.html'), '<html>chip</html>');
    write(join(otherSession, 'artifacts', 'mutation-gate-plan.md'), '# gate plan');
    write(join(otherSession, 'notes.md'), 'notes');
    write(join(otherSession, 'outbox', 'abc.json'), '{}');
    write(join(otherSession, 'proposals.json'), '[]');
    write(join(otherSession, 'karst-instructions.md'), 'rules');
    write(join(otherSession, '.hidden', 'secret.txt'), 'secret');
    sessions = new Map([
      [OWN, 1],
      [OTHER, 1],
      [18, 2],
    ]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('list', () => {
    it('lists nested regular files relative to the session dir, skipping the reserved entries', () => {
      const rows = JSON.parse(run(['plan-artifacts', 'list', '--session', 'P17', '--json'])) as {
        path: string;
        bytes: number;
        mtime: string;
      }[];
      expect(rows.map((r) => r.path)).toEqual([
        'artifacts/mutation-gate-plan.md',
        'notes.md',
        'ref-chip/ref-chip.html',
      ]);
      const chip = rows.find((r) => r.path === 'ref-chip/ref-chip.html')!;
      expect(chip.bytes).toBe(Buffer.byteLength('<html>chip</html>'));
      expect(Number.isNaN(Date.parse(chip.mtime))).toBe(false);
    });

    it('defaults to the own session', () => {
      write(join(artifacts, 'own-plan.md'), 'mine');
      const rows = JSON.parse(run(['plan-artifacts', 'list', '--json'])) as { path: string }[];
      expect(rows.map((r) => r.path)).toEqual(['artifacts/own-plan.md']);
    });

    it('prints a plain table with a header', () => {
      const out = run(['plan-artifacts', 'list', '--session', 'P17']);
      expect(out).toMatch(/PATH/);
      expect(out).toContain('ref-chip/ref-chip.html');
      expect(out).not.toContain('proposals.json');
    });

    it('caps the rows at MAX_LIST_ENTRIES, sorted by path', () => {
      for (let i = 0; i < MAX_LIST_ENTRIES + 5; i++) {
        write(join(otherSession, 'bulk', `${String(i).padStart(4, '0')}.txt`), 'x');
      }
      const rows = JSON.parse(run(['plan-artifacts', 'list', '--session', 'P17', '--json'])) as { path: string }[];
      expect(rows).toHaveLength(MAX_LIST_ENTRIES);
      expect(rows[0]!.path).toBe('artifacts/mutation-gate-plan.md');
      expect(rows.at(-1)!.path < 'bulk/9999.txt').toBe(true);
    });

    it('refuses a session of another project', () => {
      expect(() => run(['plan-artifacts', 'list', '--session', 'P18'])).toThrow(/another project/);
    });

    it('refuses an unknown session', () => {
      expect(() => run(['plan-artifacts', 'list', '--session', 'P99'])).toThrow(/not found/);
    });

    it('prints an empty result for a session with no files and reports a pruned scratch dir', () => {
      sessions.set(20, 1);
      mkdirSync(join(scratchRoot, '20'), { recursive: true });
      expect(run(['plan-artifacts', 'list', '--session', 'P20'])).toBe('no files');
      expect(JSON.parse(run(['plan-artifacts', 'list', '--session', 'P20', '--json']))).toEqual([]);
      rmSync(otherSession, { recursive: true, force: true });
      expect(() => run(['plan-artifacts', 'list', '--session', 'P17', '--json'])).toThrow(/does not exist/);
    });

    it('does not follow a symlinked directory', () => {
      symlinkSync(artifacts, join(otherSession, 'linked-dir'));
      const rows = JSON.parse(run(['plan-artifacts', 'list', '--session', 'P17', '--json'])) as { path: string }[];
      expect(rows.map((r) => r.path).some((p) => p.startsWith('linked-dir/'))).toBe(false);
    });

    it('rejects an invalid session reference', () => {
      expect(() => run(['plan-artifacts', 'list', '--session', 'P0'])).toThrow(/P<n>/);
      expect(() => run(['plan-artifacts', 'list', '--session'])).toThrow(/needs a value/);
    });

    it('refuses a session dir that is a symlink outside the sessions root', () => {
      rmSync(otherSession, { recursive: true, force: true });
      symlinkSync(ownSession, otherSession);
      expect(() => run(['plan-artifacts', 'list', '--session', 'P17'])).toThrow(/outside the sessions root/);
    });

    it('refuses outside a planning session', () => {
      expect(() =>
        run(['plan-artifacts', 'list'], { KARST_PLANNING_SESSION: undefined }),
      ).toThrow(/planning session/);
    });

    it('refuses an artifacts dir that is not this session\'s', () => {
      expect(() =>
        run(['plan-artifacts', 'list'], { KARST_ARTIFACTS: join(otherSession, 'artifacts') }),
      ).toThrow(/another planning session/);
      expect(() =>
        run(['plan-artifacts', 'list'], { KARST_ARTIFACTS: join(ownSession, 'outbox') }),
      ).toThrow(/artifacts/);
    });
  });

  describe('import', () => {
    const imported = (): string => readFileSync(join(artifacts, 'ref-chip.html'), 'utf8');

    it('copies a nested file into the own artifacts dir and prints its relative path', () => {
      const out = JSON.parse(run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html']));
      expect(out).toEqual({ ok: true, path: 'ref-chip.html' });
      expect(imported()).toBe('<html>chip</html>');
    });

    it('honours --as for the destination name', () => {
      const out = JSON.parse(
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html', '--as', 'mockup.html']),
      );
      expect(out).toEqual({ ok: true, path: 'mockup.html' });
      expect(readFileSync(join(artifacts, 'mockup.html'), 'utf8')).toBe('<html>chip</html>');
    });

    it('refuses a path outside the session dir', () => {
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', '../18/x']),
      ).toThrow(/outside/);
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', join(otherSession, 'notes.md')]),
      ).toThrow(/relative/);
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'notes.md/../notes.md']),
      ).toThrow(/outside/);
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip//ref-chip.html']),
      ).toThrow(/outside/);
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip\\ref-chip.html']),
      ).toThrow(/relative/);
    });

    it('refuses a path that does not exist', () => {
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'nope.md']),
      ).toThrow(/does not exist/);
    });

    it('refuses a symlink, even one that stays inside the dir', () => {
      symlinkSync(join(otherSession, 'notes.md'), join(otherSession, 'link.md'));
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'link.md']),
      ).toThrow(/link/);
    });

    it('refuses a hardlink', () => {
      linkSync(join(otherSession, 'notes.md'), join(otherSession, 'hard.md'));
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'hard.md']),
      ).toThrow(/hardlink/);
    });

    it('refuses a folder', () => {
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip']),
      ).toThrow(/regular file|folder/);
    });

    it('refuses the reserved entries', () => {
      for (const path of ['proposals.json', 'outbox/abc.json', 'karst-instructions.md', '.hidden/secret.txt']) {
        expect(() => run(['plan-artifacts', 'import', '--session', 'P17', '--path', path]), path).toThrow(/skipped|reserved/);
      }
    });

    it('refuses an existing destination without --force and replaces it with --force', () => {
      writeFileSync(join(artifacts, 'ref-chip.html'), 'old');
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html']),
      ).toThrow(/exists/);
      expect(readFileSync(join(artifacts, 'ref-chip.html'), 'utf8')).toBe('old');
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html', '--force']),
      ).not.toThrow();
      expect(imported()).toBe('<html>chip</html>');
    });

    it('refuses --force onto a symlink destination', () => {
      symlinkSync(join(ownSession, 'elsewhere.html'), join(artifacts, 'ref-chip.html'));
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html', '--force']),
      ).toThrow(/link/);
    });

    it('refuses a destination that is a folder', () => {
      mkdirSync(join(artifacts, 'ref-chip.html'));
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'ref-chip/ref-chip.html', '--force']),
      ).toThrow(/folder/);
    });

    it('imports an empty file and leaves no tmp file behind', () => {
      write(join(otherSession, 'empty.md'), '');
      expect(JSON.parse(run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'empty.md']))).toEqual({
        ok: true,
        path: 'empty.md',
      });
      expect(readFileSync(join(artifacts, 'empty.md'), 'utf8')).toBe('');
      expect(readdirSync(artifacts).filter((f) => f.startsWith('.plan-artifacts-'))).toEqual([]);
    });

    it('refuses --as that is not one plain file name', () => {
      for (const as of ['a/b', '..', '.', '', 'a\\b']) {
        expect(() =>
          run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'notes.md', '--as', as]),
          as,
        ).toThrow(/--as/);
      }
    });

    it('refuses a session of another project and an unknown session', () => {
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P18', '--path', 'notes.md']),
      ).toThrow(/another project/);
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P99', '--path', 'notes.md']),
      ).toThrow(/not found/);
    });

    it('requires --session and --path', () => {
      expect(() => run(['plan-artifacts', 'import', '--path', 'notes.md'])).toThrow(/--session/);
      expect(() => run(['plan-artifacts', 'import', '--session', 'P17'])).toThrow(/--path/);
    });

    it('refuses a file over the size cap', () => {
      write(join(otherSession, 'big.bin'), Buffer.alloc(MAX_IMPORT_BYTES + 1));
      expect(() =>
        run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'big.bin']),
      ).toThrow(/too large/);
    });

    it('refuses an unknown flag', () => {
      expect(() => run(['plan-artifacts', 'import', '--session', 'P17', '--path', 'notes.md', '--nope'])).toThrow(/unknown flag/);
      expect(() => run(['plan-artifacts', 'list', '--nope'])).toThrow(/unknown flag/);
    });
  });

  it('refuses an unknown subcommand', () => {
    expect(() => run(['plan-artifacts', 'copy'])).toThrow(/unknown subcommand/);
  });
});
