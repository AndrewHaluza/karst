/**
 * The cross-adapter conformance suite (869ej1zpv R2).
 *
 * Every rule here is universal — it belongs to the SEAM, not to a core's flag
 * vocabulary — and every one of them had drifted, because each was pinned four
 * times in four files by convention. A fix landed in whichever adapter the
 * reporter happened to be running: `--model` was pinned on three cores and
 * missing on the fourth, the endpoint rebind existed for codex alone, the
 * readable console stream for two of four.
 *
 * The suite loops `IMPLEMENTED_PROVIDERS` through `resolveAdapter`, so a fifth
 * core is under test the moment it is added to `FACTORIES` — it cannot be
 * copied from an existing adapter minus a rule.
 */
import { describe, it, expect } from 'vitest';
import { resolveAdapter } from './registry.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';
import { consoleLineRendererFor } from './consoleFormat.js';
import { KARST_EXCLUDE_RULES } from '../runtime/karstExcludes.js';
import type { AgentAdapter, MaterializeOpts, RunHeadlessOpts } from './adapter.js';
import type { AgentProvider } from '../manifest/types.js';
import type { AdapterSurfaces, SurfaceSupport } from './surfaces.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';

/** Replace the adapter's spawn with one that records argv and answers `stdout`. */
type SpawnCall = { command: string; args: string[]; cwd: string };

function withRecordedSpawn(
  adapter: AgentAdapter,
  result: { stdout: string; stderr?: string; exitCode: number },
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  // Every adapter holds its spawn on the same private field; the seam is what
  // is under test, so reaching it here is deliberate and kept in one helper.
  (adapter as unknown as { spawnHeadless: unknown }).spawnHeadless = async (
    command: string,
    args: string[],
    cwd: string,
  ) => {
    calls.push({ command, args, cwd });
    return { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode };
  };
  return calls;
}

/**
 * A stdout each core parses as its own successful run. The output SHAPE is
 * provider-specific by definition (it is the one thing an adapter exists to
 * translate), so it is the only per-provider value in this suite.
 */
const OK_STDOUT: Record<AgentProvider, string> = {
  claude: JSON.stringify({ session_id: 'ses_1', result: 'ok' }),
  antigravity: JSON.stringify({ session_id: 'ses_1', result: 'ok' }),
  codex: [
    JSON.stringify({ type: 'thread.started', thread_id: 'ses_1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
  ].join('\n'),
  opencode: [
    JSON.stringify({ type: 'session', sessionID: 'ses_1' }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }),
  ].join('\n'),
};

function baseOpts(): RunHeadlessOpts {
  return { prompt: 'go', cwd: '/wt' };
}

function surfacesOf(provider: AgentProvider): AdapterSurfaces {
  const declared = resolveAdapter(provider).surfaces;
  if (!declared) throw new Error(`${provider} declares no surfaces`);
  return declared;
}

function reasonOf(support: SurfaceSupport): string {
  return support.supported ? '' : support.reason;
}

describe.each(IMPLEMENTED_PROVIDERS)('adapter conformance: %s', (provider) => {
  it('declares a position on every seam surface, with a reason for each drop', () => {
    const surfaces = surfacesOf(provider);
    const keys: (keyof AdapterSurfaces)[] = [
      'exactModel',
      'model',
      'effortHeadless',
      'effortInteractive',
      'allowedTools',
      'permissionMode',
      'resume',
      'sessionName',
      'consoleStream',
      'structuredOutput',
      'hookChannel',
      'endpointRebind',
      'skillDiscovery',
    ];
    for (const key of keys) {
      const support = surfaces[key];
      expect(support, `${provider}.surfaces.${key}`).toBeDefined();
      if (!support.supported) {
        // An unexplained drop is the bug this rule exists to prevent: the
        // reason IS the drop-site comment a future fixer reads.
        expect(reasonOf(support).length, `${provider}.surfaces.${key} reason`).toBeGreaterThan(20);
      }
    }
  });

  it('pins the resolved model on a headless run when it declares model support', async () => {
    const surfaces = surfacesOf(provider);
    const adapter = resolveAdapter(provider);
    const calls = withRecordedSpawn(adapter, { stdout: OK_STDOUT[provider], exitCode: 0 });
    await adapter.runHeadless({ ...baseOpts(), model: 'a-model-id' });
    const args = calls[0]!.args;
    if (surfaces.model.supported) {
      // Without this the CLI falls back to its own default, which was measured
      // at opus pricing on a PR-description call (869ef1e6x) and was still
      // missing from the agy path a release later (869ej1zpv G1).
      expect(args, `${provider} headless argv`).toContain('a-model-id');
    } else {
      expect(args).not.toContain('a-model-id');
    }
  });

  it('pins the resolved effort on a headless run when it declares effort support', async () => {
    const surfaces = surfacesOf(provider);
    const adapter = resolveAdapter(provider);
    const calls = withRecordedSpawn(adapter, { stdout: OK_STDOUT[provider], exitCode: 0 });
    await adapter.runHeadless({ ...baseOpts(), effort: 'high' });
    const argv = calls[0]!.args.join(' ');
    expect(argv.includes('high'), `${provider} headless effort`).toBe(
      surfaces.effortHeadless.supported,
    );
  });

  it('carries the resume id into a headless run', async () => {
    const adapter = resolveAdapter(provider);
    const calls = withRecordedSpawn(adapter, { stdout: OK_STDOUT[provider], exitCode: 0 });
    await adapter.runHeadless({ ...baseOpts(), resume: 'ses_prev' });
    expect(calls[0]!.args, `${provider} headless resume`).toContain('ses_prev');
  });

  it('translates an outputSchema into the core\'s structured-output flag when declared supported', async () => {
    const surfaces = surfacesOf(provider);
    const adapter = resolveAdapter(provider);
    const schema = { type: 'array', items: { type: 'object' } };
    const calls = withRecordedSpawn(adapter, { stdout: OK_STDOUT[provider], exitCode: 0 });
    await adapter.runHeadless({ ...baseOpts(), outputSchema: schema });
    const args = calls[0]!.args;
    if (surfaces.structuredOutput.supported) {
      // A supported core must actually hand the schema to its CLI — claude
      // inlines it (`--json-schema <json>`), codex points at a materialized file
      // (`--output-schema <file>`). The request must reach argv, never be
      // dropped on the floor.
      expect(
        args.some((a) => a === '--json-schema' || a === '--output-schema'),
        `${provider} structured-output flag`,
      ).toBe(true);
      // The serialized schema text (claude inline) or its file path (codex) must
      // appear in argv so the CLI can actually read it.
      expect(args.some((a) => a.includes('array') || a.includes('output-schema'))).toBe(true);
    } else {
      // An unsupported core must not fabricate a structured-output flag it cannot
      // honor — the prose contract stays the only path.
      expect(args.some((a) => a === '--json-schema' || a === '--output-schema')).toBe(false);
    }
  });

  it('rejects a nonzero exit with a bounded, single-line diagnostic', async () => {
    const adapter = resolveAdapter(provider);
    withRecordedSpawn(adapter, {
      stdout: 'x'.repeat(50_000),
      stderr: 'boom\nsecond line\n',
      exitCode: 1,
    });
    await expect(adapter.runHeadless(baseOpts())).rejects.toThrow();
    const error = await adapter
      .runHeadless(baseOpts())
      .then(() => new Error('expected a rejection'), (e: unknown) => e as Error);
    // `describeHeadlessFailure` is the ONE description of a failed headless run
    // (untrusted CLI prose: collapsed to one line and capped before it can
    // reach a verdict, a log or a toast).
    expect(error.message.includes('\n'), `${provider} failure is one line`).toBe(false);
    expect(error.message.length, `${provider} failure is bounded`).toBeLessThan(4_000);
  });

  it('aborts through the shared bounded spawner', async () => {
    // Not a spawn stub: this asserts the adapter delegates to `spawnHeadlessCli`,
    // which is what makes Stop reach a hung core and bounds it at 15 minutes.
    const adapter = resolveAdapter(provider);
    const controller = new AbortController();
    controller.abort();
    const error = await adapter
      .runHeadless({ ...baseOpts(), cwd: process.cwd(), signal: controller.signal })
      .then(() => new Error('expected a rejection'), (e: unknown) => e as Error);
    expect(error, `${provider} aborted run`).toBeInstanceOf(Error);
    expect(error.name, `${provider} abort rejection`).toBe('AbortError');
  });

  it('agrees with consoleFormat about whether it has a structured stream', () => {
    const surfaces = surfacesOf(provider);
    expect(consoleLineRendererFor(provider) !== null, `${provider} console renderer`).toBe(
      surfaces.consoleStream.supported,
    );
  });

  it('never claims or overwrites a pre-existing repository directory', () => {
    const adapter = resolveAdapter(provider);
    if (!adapter.materializeApproach) return;
    const root = mkdtempSync(join(tmpdir(), `karst-conformance-${provider}-`));
    const baseDir = join(root, 'approaches');
    const sessionDir = join(root, 'session');
    mkdirSync(join(baseDir, 'rpi', 'skills', 'planning'), { recursive: true });
    writeFileSync(
      join(baseDir, 'rpi', 'skills', 'planning', 'SKILL.md'),
      '---\nname: planning\ndescription: Plan.\n---\nPlan.',
    );
    const opts: MaterializeOpts = {
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }],
        workflow: [{ name: 'research' }],
      },
      baseDir,
      sessionDir,
      soloAgent: { name: 'planner', body: '# planner' },
    };

    const first = adapter.materializeApproach(opts);
    // Every owned path was created by THIS call and is inside the session dir.
    for (const owned of first.ownedPaths) {
      expect(existsSync(owned), `${provider} owned path exists`).toBe(true);
      expect(owned.startsWith(sessionDir), `${provider} owned path is session-local`).toBe(true);
    }

    // A repository that checks in its own tree at those paths keeps it: the
    // second call must neither rewrite the contents nor re-claim the path.
    // An owned path may be a directory (a plugin dir) or a single file (the
    // opencode bridge), so the sentinel is placed accordingly.
    const sentinelTargets = first.ownedPaths.map((owned) =>
      statSync(owned).isDirectory() ? join(owned, 'REPO-OWNED.md') : owned,
    );
    for (const sentinel of sentinelTargets) writeFileSync(sentinel, 'repo content');
    const second = adapter.materializeApproach(opts);
    expect(second.ownedPaths, `${provider} re-claims a pre-existing dir`).toEqual([]);
    for (const sentinel of sentinelTargets) {
      expect(readFileSync(sentinel, 'utf8'), `${provider} overwrote repository content`).toBe(
        'repo content',
      );
    }
  });

  it('has every materialized path covered by a karst exclude rule', () => {
    const adapter = resolveAdapter(provider);
    if (!adapter.materializeApproach) return;
    const root = mkdtempSync(join(tmpdir(), `karst-exclude-${provider}-`));
    const baseDir = join(root, 'approaches');
    mkdirSync(join(baseDir, 'rpi', 'skills', 'planning'), { recursive: true });
    writeFileSync(join(baseDir, 'rpi', 'skills', 'planning', 'SKILL.md'), '# s');
    const materialized = adapter.materializeApproach({
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }],
        workflow: [{ name: 'research' }],
      },
      baseDir,
      sessionDir: root,
    });
    // Ship's `commitAllIfDirty` is a plain `git add -A`: an unexcluded
    // materialized path becomes a commit, a push, and a PR whose whole diff is
    // karst's own scaffolding (869eck3gv). Cleanup fires on session CLOSE and
    // ship usually runs before that, so exclusion is the invariant.
    for (const owned of materialized.ownedPaths) {
      const rel = relative(root, owned).split(sep).join('/');
      const covered = KARST_EXCLUDE_RULES.some((rule) => matchesExcludeRule(rule, rel));
      expect(covered, `${provider}: no KARST_EXCLUDE_RULES pattern covers /${rel}`).toBe(true);
    }
  });
});

/**
 * Does a root-anchored `.git/info/exclude` rule cover this working-tree-relative
 * path? Only the shapes the rule list actually uses: a literal prefix, a
 * trailing `/`, and a single `*` inside one path segment.
 */
function matchesExcludeRule(rule: string, relPath: string): boolean {
  const pattern = rule.replace(/^\//, '').replace(/\/$/, '');
  const patternParts = pattern.split('/');
  const pathParts = relPath.split('/');
  if (pathParts.length < patternParts.length) return false;
  return patternParts.every((part, index) => {
    const segment = pathParts[index]!;
    if (!part.includes('*')) return part === segment;
    const [prefix, suffix] = part.split('*') as [string, string];
    return segment.startsWith(prefix) && segment.endsWith(suffix);
  });
}

describe('the seam itself', () => {
  it('declares surfaces for every provider registry.ts can resolve', () => {
    for (const provider of IMPLEMENTED_PROVIDERS) {
      expect(resolveAdapter(provider).surfaces, `${provider} surfaces`).toBeDefined();
    }
  });

  it('keeps dirname(dirname()) of the failure log equal to the configDir the bridge is given', () => {
    // The codex bridge recovers configDir from its diagnostics path argument by
    // walking two directories up. Parameterizing the provider must not change
    // that arithmetic.
    const configDir = join(tmpdir(), 'cfg');
    for (const provider of ['codex', 'opencode'] as const) {
      const path = join(configDir, provider, 'hook-failures.jsonl');
      expect(dirname(dirname(path))).toBe(configDir);
    }
  });
});
