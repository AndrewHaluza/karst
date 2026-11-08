import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_COMMAND } from './gate.js';
import { hasUiStep, parseSteps } from './steps.js';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

// vscodeProbe.ts imports `vscode` and cannot load under vitest, so the "absent without the flag" guarantee is pinned on source.
describe('probe is absent without KARST_UAT_PROBE=1', () => {
  const binding = read('src', 'uatHost', 'probe', 'vscodeProbe.ts');

  it('installs nothing and registers nothing without the gate', () => {
    expect(binding).toMatch(/if \(!probeEnabled\(env\)\) return undefined;\s*(\/\/[^\n]*\s*)?if \(installed\) return installed;\s*const rec = new ProbeRecorder\(\);\s*installed = rec;\s*patchNotifications/);
    expect(binding).toMatch(/if \(!rec\) return;\s*const host/);
    expect(binding.match(/registerCommand\(/g)).toHaveLength(1);
  });

  it('is the only registration of the probe command, reached only through the binding', () => {
    const ext = read('src', 'extension.ts');
    expect(ext).toContain('const probeRecorder = installProbeRecorder();');
    expect(ext).toContain('registerProbeCommand(context, probeRecorder, () => store!,');
    expect(ext).not.toContain(PROBE_COMMAND);
  });

  it('is never contributed in package.json (no palette entry, no menu)', () => {
    expect(read('package.json')).not.toContain(PROBE_COMMAND);
  });

  it('the harness sets the flag only when a script is given', () => {
    expect(read('scripts', 'uat-host', 'run.mjs')).toMatch(/scriptArg\s*\?\s*\{ KARST_UAT_PROBE: '1'/);
  });
});

// The debugging port and the Playwright driver belong to a UI script only (arch:UATHOST-02).
describe('the CDP port opens only for a script with a UI step', () => {
  const run = read('scripts', 'uat-host', 'run.mjs');

  it('the host-side check separates a UI script from a plain one', () => {
    expect(hasUiStep(parseSteps([{ type: 'snapshot' }, { type: 'wait', for: { log: 'x' } }]))).toBe(false);
    expect(hasUiStep(parseSteps([{ type: 'snapshot' }, { type: 'read' }]))).toBe(true);
  });

  it('run.mjs takes the port flag and the driver only from the UI plan', () => {
    expect(run).not.toMatch(/remote-debugging-port/);
    expect(run).toContain('...uiPlan.launchArgs');
    expect(run).toMatch(/if \(uiPlan\.enabled\) \{\s*uiDriver = spawn\(/);
    expect(read('scripts', 'uat-host', 'uiScript.mjs')).toMatch(/if \(!hasUi\) return \{ enabled: false, launchArgs: \[\], testsEnv: \{\} \}/);
  });

  it('a UI script is refused outside the container, and no shipped sample without a UI step holds one', () => {
    expect(run).toContain('uiHostRefusal(hasUi, process.env)');
    for (const f of ['smoke.json', 'launch.json', 'stranded-uat.steps.json']) {
      expect(hasUiStep(parseSteps(JSON.parse(read('scripts', 'uat-host', 'samples', f))))).toBe(false);
    }
  });
});
