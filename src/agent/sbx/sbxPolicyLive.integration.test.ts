import { execFile, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSbxSessionRunner } from './sbxRunner.js';
import { NODE_SBX_PROCESS } from './sbxProcess.js';
import { parseSbxAllowed, sbxHostPolicyArgs, sbxPolicyArgs, sbxPolicyListArgs, setupHostResource } from './sbxPorts.js';

/**
 * Live check of karst's sbx policy argv against a REAL sandbox (T1192, @arch:AC-49).
 * It runs only when KARST_SBX_SCRATCH names a sandbox: the `sbx-scratch` UAT harness sets it
 * (scripts/uat-harness/sbx-scratch), and so can a person who made a sandbox. Otherwise it skips.
 */
const SCRATCH = process.env.KARST_SBX_SCRATCH ?? '';
const SCRATCH_PREFIX = 'karst-uat-';
const reason = SCRATCH === '' ? 'KARST_SBX_SCRATCH is not set (the sbx-scratch UAT harness sets it)' : '';
const HTTP_TIMEOUT_S = '15';
const WILDCARD_COVERED_HOST = 'objects.githubusercontent.com'; // global default rule `**.githubusercontent.com:443`

const sbx = (args: string[]) => spawnSync('sbx', args, { encoding: 'utf8' });
const allowed = (): Set<string> => parseSbxAllowed(sbx(sbxPolicyListArgs(SCRATCH)).stdout);
/** Resources of the allow rules scoped to the sandbox itself, never the global ones. */
const sandboxRules = (): Set<string> => {
  const rules = (JSON.parse(sbx(sbxPolicyListArgs(SCRATCH)).stdout) as { rules: { scope: string; decision: string; resources: string[] }[] }).rules;
  return new Set(rules.filter((r) => r.scope.startsWith('sandbox') && r.decision === 'allow').flatMap((r) => r.resources.map((x) => x.toLowerCase())));
};
const must = (args: string[]): void => {
  const out = sbx(args);
  expect(out.status, `sbx ${args.join(' ')}: ${out.stderr}`).toBe(0);
};

describe.skipIf(reason !== '')(`sbx policy allow/rm against a real sandbox (${reason || SCRATCH})`, () => {
  beforeAll(() => {
    // The name guard: a live rm must never reach a ticket's own sandbox.
    expect(SCRATCH.startsWith(SCRATCH_PREFIX), `KARST_SBX_SCRATCH must start with ${SCRATCH_PREFIX}`).toBe(true);
  });

  it('setup hosts: allow shows the rule, rm exits 0 and the rule is gone', () => {
    const host = 'karst-live-test.example.com';
    const resource = setupHostResource(host);
    must(sbxHostPolicyArgs('allow', SCRATCH, [host]));
    expect(sandboxRules().has(resource)).toBe(true);
    must(sbxHostPolicyArgs('rm', SCRATCH, [host]));
    expect(sandboxRules().has(resource)).toBe(false);
  });

  it('baseline ports: allow shows localhost and the host alias, rm removes both', () => {
    const port = 39_217;
    const resources = [`localhost:${port}`, `host.docker.internal:${port}`];
    must(sbxPolicyArgs('allow', SCRATCH, [port]));
    for (const r of resources) expect(sandboxRules().has(r)).toBe(true);
    must(sbxPolicyArgs('rm', SCRATCH, [port]));
    for (const r of resources) expect(sandboxRules().has(r)).toBe(false);
  });

  it('setupWindow on a host the global policy covers by a wildcard: nothing is added and close succeeds', async () => {
    const resource = setupHostResource(WILDCARD_COVERED_HOST);
    const runner = createSbxSessionRunner({ proc: NODE_SBX_PROCESS, core: 'claude', name: SCRATCH, existing: [SCRATCH] });
    const window = await runner.setupWindow!([WILDCARD_COVERED_HOST]);
    expect(window.ok, JSON.stringify(window)).toBe(true);
    expect(allowed().has(resource) || [...allowed()].some((r) => r.startsWith('**.'))).toBe(true);
    expect(sandboxRules().has(resource)).toBe(false); // covered: no redundant sandbox rule
    if (window.ok) await expect(window.close()).resolves.toBeUndefined();
    expect(sandboxRules().has(resource)).toBe(false);
  });

  describe('guest HTTP to localhost:<port>', () => {
    let server: Server;
    let port = 0;
    beforeAll(async () => {
      server = createServer((_req, res) => { res.end('ok'); });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    });

    // The guest's no_proxy lists `localhost`, so a plain curl hits the guest loopback; `--noproxy ''` sends it through the sbx proxy like the agent's HTTP client.
    // Async on purpose: a spawnSync would block this process's event loop, and with it the HTTP server the guest calls.
    const status = (): Promise<string> =>
      new Promise((resolve) => {
        execFile('sbx', ['exec', SCRATCH, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '', '--max-time', HTTP_TIMEOUT_S, `http://localhost:${port}/`],
          (_err, stdout) => resolve(stdout.trim()));
      });

    it('is 403 before the allow, 200 after, and 403 again after rm', async () => {
      try {
        expect(await status()).toBe('403');
        must(sbxPolicyArgs('allow', SCRATCH, [port]));
        expect(await status()).toBe('200');
      } finally {
        sbx(sbxPolicyArgs('rm', SCRATCH, [port]));
      }
      expect(await status()).toBe('403');
    });
  });
});
