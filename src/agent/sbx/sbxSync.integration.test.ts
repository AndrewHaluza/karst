import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSbxSessionRunner } from './sbxRunner.js';
import type { ProcessResult, SbxProcess } from './sbxProcess.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-sbxsync-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** `sbx exec <n> -- cmd` runs cmd locally in cwd (the "sandbox" is the clone); everything else is real. */
const localSbx: SbxProcess = {
  run: (command, args, opts) => {
    const argv = command === 'sbx' ? args.slice(args.indexOf('--') + 1) : args;
    const bin = command === 'sbx' ? argv[0]! : command;
    const r = spawnSync(bin, command === 'sbx' ? argv.slice(1) : [...argv], { cwd: opts?.cwd, encoding: 'utf8', env: { ...process.env, ...opts?.env } });
    return Promise.resolve<ProcessResult>({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  },
};

describe('sbx sync never executes agent-planted clone config on the host', () => {
  it('fast-forwards via the bundle while a planted hook, fsmonitor and ext:: remote stay inert', async () => {
    const wt = join(root, 'wt');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '-b', 'feat', wt]);
    git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'base');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', wt, clone]);
    git(clone, ...ID, 'commit', '-q', '--allow-empty', '-m', 'agent work');
    const pwned = join(root, 'pwned');
    for (const hook of ['post-checkout', 'post-merge', 'reference-transaction', 'pre-auto-gc']) {
      writeFileSync(join(clone, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${pwned}\n`);
      chmodSync(join(clone, '.git', 'hooks', hook), 0o755);
    }
    git(clone, 'config', 'core.fsmonitor', `touch ${pwned}`);
    git(clone, 'config', 'uploadpack.packObjectsHook', `touch ${pwned}`);
    git(clone, 'remote', 'set-url', 'origin', `ext::sh -c touch% ${pwned}`);
    const before = git(wt, 'rev-parse', 'HEAD').trim();
    const runner = createSbxSessionRunner({ proc: localSbx, core: 'claude', name: 'karst-ab12cd34-7-claude', existing: [], cloneDir: clone });
    const out = await runner.sync!({ hostWorktreePath: wt, branch: 'feat' });
    expect(out).toMatchObject({ ok: true });
    expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(git(clone, 'rev-parse', 'HEAD').trim());
    expect(git(wt, 'rev-parse', 'HEAD').trim()).not.toBe(before);
    expect(existsSync(pwned)).toBe(false);
  });
});
