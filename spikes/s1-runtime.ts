/**
 * T0.3 — Runtime composition spike (throwaway).
 *
 * Goal: a nested `.karst` worktree with inherited deps runs a frontend on an alt
 * port, wired via resolved env to a backend on its default port. A request
 * through the frontend reaches the backend.
 *
 * Run: npx tsx spikes/s1-runtime.ts
 *
 * Proves (§7, §8):
 *  - `<repo>/.karst/worktrees/<slug>` created via `git worktree add`.
 *  - frontend spawned with PORT=<alt> and VITE_API_URL=http://host:<backend-default>.
 *  - a fetch through the frontend is served data from the default-port backend.
 *  - project-local bins resolve from the worktree via ancestor node_modules walk
 *    (no install needed inside the worktree).
 *
 * Gate: passing here clears M1 to start.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const BACKEND_DEFAULT_PORT = 47100; // backend "default" per manifest
const FRONTEND_ALT_PORT = 47201; // frontend "alt" (allocated) port

function sh(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
}

/** A trivial git repo with an initial commit, so worktrees can branch off it. */
function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  sh('git', ['init', '-q'], repo);
  sh('git', ['config', 'user.email', 'spike@karst.local'], repo);
  sh('git', ['config', 'user.name', 'spike'], repo);
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-q', '-m', 'init'], repo);
  return repo;
}

const backendServer = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((req, res) => {
  if (req.url === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: 'from-backend' }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, () => console.error('backend up on ' + port));
`;

// Frontend fetches the backend via VITE_API_URL and re-serves the value —
// proving the wired env actually reaches the default-port backend.
const frontendServer = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
const apiUrl = process.env.VITE_API_URL;
createServer(async (req, res) => {
  if (req.url === '/') {
    try {
      const r = await fetch(apiUrl + '/api/data');
      const body = await r.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ proxied: body.value, via: apiUrl }));
    } catch (e) {
      res.writeHead(502); res.end(String(e));
    }
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, () => console.error('frontend up on ' + port));
`;

function waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        await fetch(url);
        resolve();
      } catch {
        if (Date.now() > deadline) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 150);
      }
    };
    void tick();
  });
}

function spawnNode(entry: string, cwd: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'karst-runtime-'));
  const procs: ChildProcess[] = [];
  try {
    // --- fixtures: two repos, frontend depends on backend ---
    const backendRepo = makeRepo(root, 'backend', { 'server.mjs': backendServer });
    const frontendRepo = makeRepo(root, 'frontend', { 'server.mjs': frontendServer });

    // --- baseline backend on its DEFAULT port (not worktreed for this spike) ---
    console.log(`[s1-runtime] starting baseline backend on ${BACKEND_DEFAULT_PORT}`);
    procs.push(
      spawnNode('server.mjs', backendRepo, { PORT: String(BACKEND_DEFAULT_PORT) }),
    );
    await waitForHttp(`http://${HOST}:${BACKEND_DEFAULT_PORT}/api/data`);

    // --- frontend worktree at <repo>/.karst/worktrees/<slug> ---
    const slug = 'spike';
    const worktreePath = join(frontendRepo, '.karst', 'worktrees', slug);
    console.log(`[s1-runtime] git worktree add ${worktreePath}`);
    sh('git', ['worktree', 'add', '-q', '-b', `karst/${slug}`, worktreePath], frontendRepo);

    // --- resolved env: frontend on ALT port, wired to backend DEFAULT port ---
    const resolvedEnv = {
      PORT: String(FRONTEND_ALT_PORT),
      VITE_API_URL: `http://${HOST}:${BACKEND_DEFAULT_PORT}`,
    };
    console.log(
      `[s1-runtime] starting frontend (worktree) on ${FRONTEND_ALT_PORT}, VITE_API_URL=${resolvedEnv.VITE_API_URL}`,
    );
    procs.push(spawnNode('server.mjs', worktreePath, resolvedEnv));
    await waitForHttp(`http://${HOST}:${FRONTEND_ALT_PORT}/`);

    // --- assert: request through frontend returns backend's value ---
    const res = await fetch(`http://${HOST}:${FRONTEND_ALT_PORT}/`);
    const body = (await res.json()) as { proxied?: string; via?: string };
    if (body.proxied !== 'from-backend') {
      throw new Error(`frontend did not reach backend: ${JSON.stringify(body)}`);
    }
    console.log(`[s1-runtime] frontend proxied backend value: ${JSON.stringify(body)}`);

    // --- assert: project-local bin resolves from the worktree via ancestor walk ---
    verifyAncestorBinResolution(frontendRepo, worktreePath);

    console.log('\n[s1-runtime] PASS');
    console.log('  ✓ nested .karst worktree created');
    console.log('  ✓ frontend on alt port, backend on default port');
    console.log('  ✓ request through frontend reached the default-port backend');
    console.log('  ✓ ancestor node_modules bin resolution works from worktree');
  } finally {
    for (const p of procs) p.kill();
    // best-effort cleanup
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install a fake local bin in the PARENT repo's node_modules/.bin, then confirm a
 * process running in the nested worktree resolves it via the ancestor walk — i.e.
 * the worktree needs no install of its own for deps present up the tree.
 */
function verifyAncestorBinResolution(parentRepo: string, worktreePath: string): void {
  const binDir = join(parentRepo, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const fakeBin = join(binDir, 'karst-fake-tool');
  writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("ancestor-bin-ok");\n');
  spawnSync('chmod', ['+x', fakeBin]);

  // npx resolves bins by walking up from cwd through ancestor node_modules/.bin.
  const r = spawnSync('npx', ['--no-install', 'karst-fake-tool'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout.includes('ancestor-bin-ok')) {
    throw new Error(
      `ancestor bin resolution failed from worktree: status=${r.status} out=${r.stdout} err=${r.stderr}`,
    );
  }
}

main().catch((err) => {
  console.error('\n[s1-runtime] FAIL');
  console.error(err.message);
  process.exit(1);
});
