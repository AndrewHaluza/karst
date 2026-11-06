import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Path-based `node:fs` calls on sandbox-writable code (`arch:AC-34`).
 *
 * A sandboxed agent can write the bridge dir. A host call that takes a PATH
 * under that dir can follow a planted symlink. Review used to catch these late
 * (T705, T712, T961). This test is a RATCHET: each path-based call in scope is
 * counted per file and call name, and an allowlist entry must give the reason.
 * It does not judge safety. It forces a decision that the reviewer sees in the
 * diff. Calls on a handle (`handle.chmod`) are the safe form and are not
 * counted. DI-wired fs calls (for example in `extension.ts`) are not visible.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(SRC, '..');

export const CHECKED_CALLS: readonly string[] = [
  'chmod', 'chown', 'lchown', 'utimes', 'stat', 'readFile', 'writeFile', 'appendFile', 'mkdir',
  'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'symlink', 'truncate', 'readdir',
].flatMap((name) => [name, `${name}Sync`]);

const OPEN_CALLS: readonly string[] = ['open', 'openSync'];
const FS_MODULES: readonly string[] = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'];

const RULE =
  'Paths under the bridge dir are hostile (a sandboxed agent can plant a symlink there). ' +
  'Use a handle opened with O_NOFOLLOW, or add an allowlist entry with the reason.';

interface AllowEntry {
  readonly file: string;
  readonly call: string;
  readonly count: number;
  readonly reason: string;
}

/** Count of flagged calls per call name in one source text. */
export function scanSource(fileName: string, text: string): ReadonlyMap<string, number> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const named = new Map<string, string>(); // local name -> imported fs name
  const namespaces = new Set<string>();
  const constants = new Map<string, string>(); // const name -> initializer text

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && FS_MODULES.includes(stmt.moduleSpecifier.text)) {
      const clause = stmt.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) named.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
  }
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer.getText(sf));
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const holdsNoFollow = (expr: ts.Expression | undefined, seen = new Set<string>()): boolean => {
    if (!expr) return false;
    if (expr.getText(sf).includes('O_NOFOLLOW')) return true;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !seen.has(n.text)) {
        const def = constants.get(n.text);
        if (def !== undefined) {
          seen.add(n.text);
          if (def.includes('O_NOFOLLOW')) found = true;
          else {
            const inner = ts.createSourceFile('x.ts', `const v = ${def};`, ts.ScriptTarget.Latest, true);
            ts.forEachChild(inner, function walk(c) {
              if (ts.isIdentifier(c) && constants.has(c.text) && !seen.has(c.text)) {
                seen.add(c.text);
                if ((constants.get(c.text) ?? '').includes('O_NOFOLLOW')) found = true;
              }
              ts.forEachChild(c, walk);
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(expr);
    return found;
  };

  const counts = new Map<string, number>();
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name: string | undefined;
      if (ts.isIdentifier(callee)) name = named.get(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) {
        let root: ts.Expression = callee.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression; // fs.promises.x
        if (ts.isIdentifier(root) && namespaces.has(root.text)) name = callee.name.text;
      }
      if (name !== undefined) {
        const flagged =
          CHECKED_CALLS.includes(name) || (OPEN_CALLS.includes(name) && !holdsNoFollow(node.arguments[1]));
        if (flagged) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sf);
  return counts;
}

/** Violations of the allowlist for a set of per-file counts. */
export function checkCounts(
  found: ReadonlyMap<string, ReadonlyMap<string, number>>,
  allow: readonly AllowEntry[],
): string[] {
  const problems: string[] = [];
  const allowed = new Map(allow.map((e) => [`${e.file}\u0000${e.call}`, e.count]));
  for (const [file, calls] of found) {
    for (const [call, n] of calls) {
      const limit = allowed.get(`${file}\u0000${call}`) ?? 0;
      if (n > limit) {
        problems.push(
          `${file}: ${n} call(s) of ${call}, allowlist allows ${limit}. ${RULE} ` +
            `Action: use a handle, or set {file: '${file}', call: '${call}', count: ${n}, reason} in ALLOWLIST.`,
        );
      }
    }
  }
  for (const e of allow) {
    const n = found.get(e.file)?.get(e.call) ?? 0;
    if (n < e.count) {
      problems.push(
        `${e.file}: stale allowlist entry for ${call(e)}: lists ${e.count}, found ${n}. ` +
          `Action: lower the count to ${n}${n === 0 ? ' (remove the entry)' : ''}.`,
      );
    }
  }
  return problems;
}
const call = (e: AllowEntry): string => e.call;

const HOST = 'host-only path';
const STATE = `${HOST}: <root>/state, outside the mounted events dir`;

/**
 * Seeded from the code on the base branch. Every reason names the path source or the check.
 * A reason that starts with `UNCHECKED` marks a call on a sandbox-writable path with no check:
 * it is kept here only so the ratchet holds, and it is a follow-up for the owner (see the PR).
 */
const ALLOWLIST: readonly AllowEntry[] = [
  { file: 'src/agent/bridge/bridgeDir.ts', call: 'mkdir', count: 5, reason: `2 ${HOST} (<root>/events/<id> mount root, <root>/state); 3 UNCHECKED follow-up: resultsDir, inboxDir and claude-projects sit inside the agent-writable dir and a recursive mkdir through a planted dangling link would create a host directory (projects is then chmodded via O_NOFOLLOW handle)` },
  { file: 'src/agent/bridge/bridgeDir.ts', call: 'chmod', count: 1, reason: `${HOST}: chmod of the mount root <root>/events/<id> itself; its parent <root>/events is outside the mount, so the agent cannot replace it (sticky bit 1777 protects children)` },
  { file: 'src/agent/bridge/bridgeDir.ts', call: 'rm', count: 6, reason: `${HOST}: the mount root (recursive rm unlinks planted links, never follows them; parent is host-only) plus five <root>/state files and the host-head file` },
  { file: 'src/agent/bridge/bridgeDir.ts', call: 'readdir', count: 1, reason: `${HOST}: lists <root>/events, the parent of the mounts` },
  { file: 'src/agent/bridge/bridgePoller.ts', call: 'readFile', count: 1, reason: `${STATE} (poller offset file)` },
  { file: 'src/agent/bridge/bridgePoller.ts', call: 'writeFile', count: 1, reason: `${STATE} (poller offset temp file)` },
  { file: 'src/agent/bridge/bridgePoller.ts', call: 'rename', count: 1, reason: `${STATE} (poller offset file)` },
  { file: 'src/agent/bridge/bridgeSink.ts', call: 'readFile', count: 1, reason: `${STATE} (pending marker record)` },
  { file: 'src/agent/bridge/bridgeSink.ts', call: 'readFileSync', count: 1, reason: `${STATE} (handled marker seqs)` },
  { file: 'src/agent/bridge/bridgeSink.ts', call: 'writeFile', count: 2, reason: `${STATE} (pending record and handled seqs temp files)` },
  { file: 'src/agent/bridge/bridgeSink.ts', call: 'rename', count: 2, reason: `${STATE} (pending record and handled seqs)` },
  { file: 'src/agent/bridge/bridgeSink.ts', call: 'rm', count: 1, reason: `${STATE} (pending marker record)` },
  { file: 'src/agent/bridge/inbox.ts', call: 'mkdirSync', count: 2, reason: 'checked before use: statOrUndefined (lstat) shows the inbox dir missing, or a tampered link or file was just removed' },
  { file: 'src/agent/bridge/inbox.ts', call: 'rmSync', count: 1, reason: 'checked before use: lstat shows a symlink or non-directory; recursive rm unlinks a link and never follows it' },
  { file: 'src/agent/bridge/inbox.ts', call: 'renameSync', count: 1, reason: 'checked before use: lstat of the inbox dir, source created with O_EXCL|O_NOFOLLOW; rename replaces the target name and follows no link' },
  { file: 'src/agent/bridge/markerReply.ts', call: 'writeFile', count: 1, reason: 'checked before use: assertPlainResultsDir (lstat plus realpath containment); flag wx is O_EXCL so a planted link at the temp name is refused' },
  { file: 'src/agent/bridge/markerReply.ts', call: 'rename', count: 1, reason: 'checked before use: assertPlainResultsDir (lstat plus realpath containment); rename replaces the target name and follows no link' },
  { file: 'src/agent/bridge/markerReply.ts', call: 'mkdir', count: 1, reason: 'checked before use: runs only when lstat shows resultsDir missing; realpath containment is checked right after' },
  { file: 'src/agent/bridge/mirror.ts', call: 'rmSync', count: 3, reason: 'checked before use: ensureRealDir removes a link found by lstat; removeEntry lstats first and never recurses; the temp removal follows a stillInside (lstat plus realpath) check' },
  { file: 'src/agent/bridge/mirror.ts', call: 'mkdirSync', count: 1, reason: 'checked before use: ensureRealDir runs it after lstat shows the dir missing or a link was removed; stillInside is checked before any write' },
  { file: 'src/agent/bridge/mirror.ts', call: 'renameSync', count: 1, reason: 'checked before use: stillInside (lstat plus realpath) just before; temp was opened with O_EXCL|O_NOFOLLOW' },
  { file: 'src/agent/bridge/mirror.ts', call: 'unlinkSync', count: 1, reason: 'checked before use: removeEntry lstat shows a non-directory; unlink removes a link and never follows it' },
  { file: 'src/agent/bridge/mirror.ts', call: 'readdirSync', count: 2, reason: 'checked before use: pruneMirror and pruneOldLogs return early unless stillInside (lstat plus realpath) holds' },
  { file: 'src/agent/claudeTranscriptRead.ts', call: 'stat', count: 1, reason: `${HOST}: the branch with no root reads a transcript written by the host agent; the sandbox branch uses openChecked (realpath containment, O_NOFOLLOW handle)` },
  { file: 'src/agent/claudeTranscriptRead.ts', call: 'readFile', count: 1, reason: `${HOST}: the branch with no root reads a transcript written by the host agent; the sandbox branch uses openChecked (realpath containment, O_NOFOLLOW handle)` },
  { file: 'src/agent/sbx/sbxClone.ts', call: 'rm', count: 3, reason: `${HOST}: <project>/.karst/sbx-clones/<name>, removed only while no sandbox exists; recursive rm never follows links` },
  { file: 'src/agent/sbx/sbxClone.ts', call: 'mkdir', count: 1, reason: `${HOST}: parent of <project>/.karst/sbx-clones/<name>` },
  { file: 'src/agent/sbx/sbxRunner.ts', call: 'rm', count: 2, reason: 'checked before use: ensureXferDir (lstat, a link or file is replaced by a real dir) just before; rm of the in.bundle file unlinks a link and never follows it' },
];

function listScope(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name) && !/\.(integration|e2e)\.test\.ts$/.test(name)) out.push(full);
    }
  };
  walk(join(SRC, 'agent', 'bridge'));
  walk(join(SRC, 'agent', 'sbx'));
  for (const name of readdirSync(join(SRC, 'agent'))) {
    if (/^claudeTranscript.*\.ts$/.test(name) && !name.endsWith('.test.ts')) out.push(join(SRC, 'agent', name));
  }
  return out.sort();
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');

describe('fs call conformance (arch:AC-34)', () => {
  it('every path-based fs call in scope is on the allowlist with its exact count', () => {
    const found = new Map<string, ReadonlyMap<string, number>>();
    for (const file of listScope()) found.set(rel(file), scanSource(file, readFileSync(file, 'utf8')));
    expect(checkCounts(found, ALLOWLIST)).toEqual([]);
  });

  it('every allowlist entry holds a reason and a unique file+call', () => {
    const keys = ALLOWLIST.map((e) => `${e.file}:${e.call}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of ALLOWLIST) {
      expect(e.reason.trim().length, `${e.file} ${e.call}`).toBeGreaterThan(10);
      expect(e.count).toBeGreaterThan(0);
    }
  });
});

describe('scanner fixtures', () => {
  const scan = (src: string): ReadonlyMap<string, number> => scanSource('fixture.ts', src);

  it('flags a new chmod', () => {
    const found = new Map([['f.ts', scan(`import { chmod } from 'node:fs/promises'; await chmod(p, 0o777);`)]]);
    const problems = checkCounts(found, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('f.ts');
    expect(problems[0]).toContain('chmod');
    expect(problems[0]).toContain('hostile');
    expect(problems[0]).toContain('O_NOFOLLOW');
    expect(problems[0]).toContain('allowlist entry');
  });

  it('does not flag handle.chmod', () => {
    const src = `import { open } from 'node:fs/promises'; const h = await open(p, 'r+', 0); await h.chmod(0o700);`;
    // the open has no O_NOFOLLOW, so only `open` is flagged; chmod is not
    expect([...scan(src).keys()]).toEqual(['open']);
  });

  it('passes an open with O_NOFOLLOW inline', () => {
    const src = `import { open } from 'node:fs/promises'; import { constants } from 'node:fs';
      await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);`;
    expect(scan(src).size).toBe(0);
  });

  it('passes an open with a named flags constant that holds O_NOFOLLOW', () => {
    const src = `import { openSync, constants } from 'node:fs';
      const BASE = constants.O_RDONLY | constants.O_NOFOLLOW;
      const FLAGS = BASE | constants.O_NONBLOCK;
      openSync(p, FLAGS);`;
    expect(scan(src).size).toBe(0);
  });

  it('flags an open without O_NOFOLLOW, also via a named constant', () => {
    expect(scan(`import { open } from 'node:fs/promises'; await open(p, 'r');`).get('open')).toBe(1);
    const src = `import { openSync, constants } from 'node:fs';
      const FLAGS = constants.O_RDONLY; openSync(p, FLAGS);`;
    expect(scan(src).get('openSync')).toBe(1);
  });

  it('flags a namespace import call (fs.rm) and a default import call', () => {
    expect(scan(`import * as fs from 'node:fs/promises'; await fs.rm(p);`).get('rm')).toBe(1);
    expect(scan(`import fs from 'node:fs'; fs.promises.unlink(p);`).get('unlink')).toBe(1);
  });

  it('follows an import alias and ignores names not imported from fs', () => {
    expect(scan(`import { rm as remove } from 'node:fs/promises'; remove(p);`).get('rm')).toBe(1);
    expect(scan(`import { rm } from './other.js'; rm(p); deps.stat(p);`).size).toBe(0);
  });

  it('fails on a stale count when a call is removed', () => {
    const found = new Map([['f.ts', scan(`import { rm } from 'node:fs/promises'; await rm(a);`)]]);
    const allow: AllowEntry[] = [{ file: 'f.ts', call: 'rm', count: 2, reason: 'host-only path under state' }];
    const problems = checkCounts(found, allow);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stale');
    expect(problems[0]).toContain('f.ts');
    expect(problems[0]).toContain('lower the count to 1');
  });

  it('fails when an entry has no matching call at all', () => {
    const problems = checkCounts(new Map(), [{ file: 'g.ts', call: 'rm', count: 1, reason: 'host-only path' }]);
    expect(problems[0]).toContain('remove the entry');
  });

  it('passes when the counts match', () => {
    const found = new Map([['f.ts', scan(`import { rm } from 'node:fs/promises'; rm(a);`)]]);
    expect(checkCounts(found, [{ file: 'f.ts', call: 'rm', count: 1, reason: HOST }])).toEqual([]);
  });
});
