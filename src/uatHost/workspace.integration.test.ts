import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifest } from '../manifest/load.js';
import { buildWorkspace } from './workspace.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('buildWorkspace', () => {
  it('creates repo with pushed main, bare remote and manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-ws-'));
    dirs.push(root);
    const ws = buildWorkspace(root);
    expect(existsSync(ws.manifestPath)).toBe(true);
    expect(readFileSync(ws.manifestPath, 'utf8')).toContain(`repoPath: ${ws.repoDir}`);
    const remoteHead = execFileSync('git', ['--git-dir', ws.remoteDir, 'rev-parse', 'main']).toString().trim();
    const localHead = execFileSync('git', ['-C', ws.repoDir, 'rev-parse', 'main']).toString().trim();
    expect(remoteHead).toBe(localHead);
    expect(() => loadManifest(ws.manifestPath)).not.toThrow();
  });
});
