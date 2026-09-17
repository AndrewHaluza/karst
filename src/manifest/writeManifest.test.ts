import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { writeManifest } from './write.js';
import { loadManifest, loadManifestWithDiagnostics } from './load.js';
import { validateManifest } from './schema.js';
import { review as reviewFixture } from './fixtures.js';
import type { Manifest } from './types.js';
import { mergeSection } from '../ui/settings/sections.js';

// Includes an unknown top-level key (`extraTopLevel`) and an unmodeled repository
// sub-key (`repositories.backend.customField`) that must SURVIVE a write.
const RAW = `
extraTopLevel: keep-me
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
    customField: also-keep
    service:
      start: npm run dev
      ports:
        - { name: http, env: PORT, default: 3000 }
      dependsOn: []
`;

/** A pre-rework manifest, for the on-disk upgrade path. */
const LEGACY_RAW = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 3000 }
    dependsOn: []
`;

function fixture(body = RAW): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-wm-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, body);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('writeManifest', () => {
  it('round-trips an edited manifest through validation', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = { ...m, baselineBranch: 'main' };
      writeManifest(path, edited);
      expect(loadManifest(path).baselineBranch).toBe('main');
    } finally {
      cleanup();
    }
  });

  it('preserves unknown top-level keys and unmodeled repository fields', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, host: '0.0.0.0' });
      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.repositories.backend.customField).toBe('also-keep');
      expect(raw.host).toBe('0.0.0.0'); // edit landed
    } finally {
      cleanup();
    }
  });

  it('persists an edited ticketing block', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = {
        ...m,
        ticketing: { provider: 'clickup', teamId: '9001', listId: '42' },
      };
      writeManifest(path, edited);
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        teamId: '9001',
        listId: '42',
        advanceOnShip: false,
        advanceOnStart: false,
        searchEnabled: true,
      });
    } finally {
      cleanup();
    }
  });

  it('persists an edited review block', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = {
        ...m,
        review: {
          maxFixAttempts: 4,
          stallTimeoutMinutes: 90,
          requireIndependentSignal: false,
          openChanges: true,
          gates: [{ name: 'lint', kind: 'script', script: 'lint' }],
          findings: { enabled: true, blockingSeverity: 'medium', maxFindings: 10 },
          repositories: {},
        },
      };
      writeManifest(path, edited);
      expect(loadManifest(path).review).toEqual(edited.review);
    } finally {
      cleanup();
    }
  });

  // Without the `review: manifest.review` line in the overlay, Save silently
  // drops the whole block on the next write — this is that failure mode,
  // isolated from the "round-trips every modeled section" test below.
  it('drops the review block entirely once cleared', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        review: {
          maxFixAttempts: 4,
          stallTimeoutMinutes: 90,
          requireIndependentSignal: false,
          openChanges: true,
          findings: { enabled: true, blockingSeverity: 'medium', maxFindings: 10 },
          repositories: {},
        },
      });
      expect(loadManifest(path).review).toBeDefined();

      writeManifest(path, { ...m, review: undefined });
      expect(loadManifest(path).review).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // Regression guard: writeManifest whitelists modeled top-level keys in its
  // overlay, so ANY newly-added Manifest field silently fails to persist until
  // it's added there. This round-trips a fully-populated manifest and asserts
  // every modeled section survives — a new field left out of the overlay makes
  // this fail. If you add a Manifest field, add it to the overlay AND here.
  it('round-trips every modeled section without dropping fields', () => {
    const { path, cleanup } = fixture();
    try {
      const full: Manifest = {
        host: '0.0.0.0',
        portRange: [5000, 5999],
        baselineBranch: 'main',
        repositories: {
          backend: {
            repoPath: '../backend',
            baselineBranch: 'release',
            // `validateRepository` always sets this concretely, so a round-trip
            // reload carries it whether or not the file does.
            enabled: true,
            hasMigrations: true,
            signals: ['api', 'endpoint'],
            scope: 'api',
            service: {
              start: 'npm run dev',
              health: 'http://{host}:{port}/health',
              healthIdentity: true,
              ports: [{ name: 'http', env: 'PORT', default: 3000 }],
              portRange: [5000, 5100],
              dependsOn: [],
            },
          },
          // A non-runnable repository must survive the round-trip too — if the
          // overlay wrote an empty `service: {}` here, reload would reject it.
          docs: {
            repoPath: '../docs',
            enabled: true,
            hasMigrations: false,
            signals: ['readme'],
          },
        },
        approaches: [
          {
            id: 'tdd',
            label: 'TDD',
            recommended: true,
            enabled: false,
            workflow: [{ name: 'research', command: '/rpi:research' }],
          },
          {
            id: 'karst-graph-engineering',
            label: 'Dynamic Graph',
            enabled: false,
            graph: {
              planner: { profile: 'expert', prompt: { artifact: 'skills/graph-planner/SKILL.md' } },
              profiles: {
                expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
                worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
              },
              commands: {
                test: {
                  command: 'npm',
                  args: ['test'],
                  cwd: 'repository',
                  access: 'write',
                  timeoutSeconds: 1800,
                },
              },
              limits: {
                confirmGeneratedGraph: true,
                maxParallel: 1,
                maxNodeRuns: 40,
                maxExpertRuns: 5,
                maxReplans: 2,
                maxActivations: 200,
                maxGraphWallSeconds: 86400,
                maxAgentWallSeconds: 7200,
                maxAgentIdleSeconds: 1800,
                maxArtifactBytes: 104857600,
                maxLogBytes: 10485760,
                maxAggregateArtifactBytes: 536870912,
                maxAggregateWorkspaceBytes: 21474836480,
              },
            },
          },
        ],
        agents: {
          implement: {
            role: 'implement',
            command: 'claude',
            enabled: false,
            promptPath: 'agents/implement.md',
          },
        },
        processes: {
          uatTester: {
            agent: 'implement',
            agentName: 'UAT Author',
            provider: 'codex',
            model: 'gpt-5.6-sol',
            enabled: true,
          },
          review: { provider: 'antigravity', model: 'gemini-3.6-flash-high', enabled: false },
        },
        worktreePathDisplay: 'absolute',
        ticketLabelTemplate: '{key} · {stage} · {status}',
        terminalNameTemplate: 'Karst: {key} · {stage}',
        conventions: {
          branchName: 'karst/{type}/{slug}',
          defaultType: 'fix',
          commitMessage: '{type}({scope}): {title} [{key}]',
          pullRequestTitle: '[{key}] {title}',
          pullRequestDescription: '## Summary\n\n{description}\n\nRepository: {repo}\n',
        },
        uat: {
          testDir: 'e2e/karst',
          maxFixAttempts: 2,
          stallTimeoutMinutes: 45,
          gates: [
            { name: 'test', kind: 'script', script: 'test' },
            { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'backend' },
          ],
          testerVerifier: { name: 'verify-uat', kind: 'command', command: './scripts/verify-uat.sh' },
          testerObservations: { blockingSeverity: 'high' },
          env: { SMTP_HOST: '127.0.0.1' },
          secrets: ['STRIPE_SECRET_KEY'],
          passthrough: ['CUSTOM_REGISTRY_TOKEN'],
          origins: ['http://localhost:5173'],
          authBootstrap: { path: 'e2e/auth.setup.ts', secrets: ['UAT_ACCOUNT_PASSWORD'] },
          author: { agent: 'uat-author', enabled: true },
          repositories: { backend: { env: { VITE_MODE: 'uat' } } },
        },
        ticketing: {
          provider: 'clickup',
          teamId: '9001',
          listId: '42',
          advanceOnShip: true,
          shipStatus: 'in review',
          advanceOnStart: true,
          startStatus: 'in dev',
          searchEnabled: true,
        },
        review: {
          maxFixAttempts: 2,
          stallTimeoutMinutes: 90,
          requireIndependentSignal: false,
          openChanges: true,
          gates: [
            { name: 'lint', kind: 'script', script: 'lint' },
            { name: 'clippy', kind: 'command', command: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
          ],
          findings: { enabled: false, blockingSeverity: 'critical', maxFindings: 25 },
          repositories: { backend: { gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }] } },
        },
        agentProvider: 'codex',
        defaultModel: 'claude-opus-4-8',
        agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
        defaultAgentPreset: 'fast',
        resilience: { retries: 2, backoffMs: 2000, fallbackModels: [] },
        // Same reason: absent defaultEffort would round-trip regardless of the
        // overlay, so the populated manifest pins the explicit value.
        defaultEffort: 'high',
        // Non-default on purpose: a missing writeManifest overlay would fall
        // back to the loader's default and the round-trip would still pass.
        archiveDoneAfterDays: 7,
        // Same reason: absent debug would round-trip regardless of the overlay,
        // so the populated manifest pins the explicit value.
        debug: true,
        // Same reason again: absent closeDoneTerminalsWithTicket would round-trip
        // whether or not the overlay wrote it, so the populated manifest pins the
        // explicit value.
        closeDoneTerminalsWithTicket: true,
        // Same reason: absent diffsInSourceControl would round-trip regardless of
        // the overlay, so the populated manifest pins the explicit value.
        diffsInSourceControl: true,
        id: 'karst-extension',
      };
      writeManifest(path, full);
      const reloaded = loadManifest(path);
      expect(reloaded).toEqual(full);
    } finally {
      cleanup();
    }
  });

  it('round-trips a disabled draft repository with a blank repoPath', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = {
        ...m,
        repositories: {
          ...m.repositories,
          scratch: { repoPath: '', hasMigrations: false, signals: [], enabled: false },
        },
      };
      writeManifest(path, edited);
      const after = loadManifest(path);
      expect(after.repositories.scratch!.repoPath).toBe('');
      expect(after.repositories.scratch!.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('preserves unknown top-level data while writing multiline conventions', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const pullRequestDescription =
        '  ## Summary\n\n{description}\n\nRepository: {repo}\n';
      writeManifest(path, {
        ...m,
        conventions: {
          commitMessage: 'feat({repo}): {title}',
          pullRequestDescription,
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.conventions.pullRequestDescription).toBe(pullRequestDescription);
      expect(loadManifest(path).conventions).toEqual({
        commitMessage: 'feat({repo}): {title}',
        pullRequestDescription,
      });
    } finally {
      cleanup();
    }
  });

  it('removes stale raw conventions when the modeled section is cleared', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  commitMessage: "feat({repo}): {title}"
  pullRequestTitle: "[{key}] {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, conventions: undefined });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toBeUndefined();
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(loadManifest(path).conventions).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('preserves unknown nested convention keys while overlaying modeled fields', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  organizationPolicy: keep-me
  commitMessage: "old: {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        conventions: {
          ...m.conventions,
          commitMessage: 'feat({repo}): {title}',
          pullRequestTitle: '[{key}] {title}',
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toEqual({
        organizationPolicy: 'keep-me',
        commitMessage: 'feat({repo}): {title}',
        pullRequestTitle: '[{key}] {title}',
      });
    } finally {
      cleanup();
    }
  });

  it('clears one modeled convention while retaining unknown nested keys', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  organizationPolicy: keep-me
  commitMessage: "feat: {title}"
  pullRequestTitle: "[{key}] {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        conventions: {
          commitMessage: m.conventions!.commitMessage,
          pullRequestTitle: undefined,
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toEqual({
        organizationPolicy: 'keep-me',
        commitMessage: 'feat: {title}',
      });
      expect(loadManifest(path).conventions).toEqual({
        commitMessage: 'feat: {title}',
      });
    } finally {
      cleanup();
    }
  });

  // Turning a repository's service OFF must actually remove the block. If the
  // overlay merely omitted the key, the raw `service:` would survive and the
  // repo would silently stay runnable after the user said it wasn't.
  it('drops the `service:` block when a repository becomes non-runnable', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      const { service: _removed, ...withoutService } = backend;
      writeManifest(path, { ...m, repositories: { backend: withoutService } });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.service).toBeUndefined();
      // The unmodeled sub-key still survives.
      expect(raw.repositories.backend.customField).toBe('also-keep');
    } finally {
      cleanup();
    }
  });

  it('persists a service.portRange and drops it once cleared', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      const withRange: Manifest = {
        ...m,
        repositories: {
          backend: {
            ...backend,
            service: { ...backend.service!, portRange: [5000, 5100] },
          },
        },
      };
      writeManifest(path, withRange);
      let raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service.portRange).toEqual([5000, 5100]);
      expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([5000, 5100]);

      writeManifest(path, {
        ...m,
        repositories: {
          backend: { ...backend, service: { ...backend.service!, portRange: undefined } },
        },
      });
      raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service.portRange).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.service!.portRange).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // Draft state is the ONE repository field whose default is not what a reload
  // produces from silence: `enabled: true` is omitted from the file, so only
  // `false` has to survive as a written key. A round-trip that lost it would
  // quietly promote a half-filled draft into a repository the resolver uses.
  it('round-trips a draft repository, writing `enabled` only when false', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      writeManifest(path, {
        ...m,
        repositories: { backend: { ...backend, enabled: false } },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.enabled).toBe(false);
      expect(loadManifest(path).repositories.backend!.enabled).toBe(false);

      // Back to enabled: the key is dropped, not written as `true`.
      writeManifest(path, {
        ...m,
        repositories: { backend: { ...backend, enabled: true } },
      });
      const back = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(back.repositories.backend.enabled).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('upgrades a legacy `services:` file on write, leaving no stale key', () => {
    const { path, cleanup } = fixture(LEGACY_RAW);
    try {
      const m = loadManifest(path); // migrated in memory
      writeManifest(path, { ...m, host: '0.0.0.0' });

      const text = readFileSync(path, 'utf8');
      expect(text).toContain('repositories:');
      expect(text).not.toContain('services:');
      // And the upgraded file reloads clean (both keys present would throw).
      expect(loadManifest(path).repositories.backend!.service!.start).toBe('npm run dev');
    } finally {
      cleanup();
    }
  });

  it('never writes when the merged manifest fails validation', () => {
    const { path, cleanup } = fixture();
    try {
      const before = readFileSync(path, 'utf8');
      const m = loadManifest(path);
      // portRange min > max — validateManifest throws.
      const bad: Manifest = { ...m, portRange: [9000, 1000] };
      expect(() => writeManifest(path, bad)).toThrow(/portRange/);
      expect(readFileSync(path, 'utf8')).toBe(before); // untouched
    } finally {
      cleanup();
    }
  });

  // The proof task for the whole Quality-tab phase: edit → validate →
  // writeManifest → reload → the edit is there and NOTHING ELSE MOVED.
  // Exercises the real writeManifest/loadManifestWithDiagnostics/mergeSection
  // together (no mocks) — a mocked collaborator here would prove nothing about
  // the round trip. Strengthened over the plan's version with a per-repo
  // review override (Task 13), since a naive overlay could drop it.
  it('round-trips a quality save through writeManifest, including a per-repo override', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        uat: {
          maxFixAttempts: 3,
          stallTimeoutMinutes: 60,
          env: { A: 'b' },
          secrets: ['K'],
          passthrough: [],
          origins: [],
          repositories: {},
        },
        review: reviewFixture(),
      });

      const { manifest: onDisk } = loadManifestWithDiagnostics(path);

      // Simulate the Quality tab's spread-preserving updaters
      // (updateUat/updateReview, webview.html): patch one uat field and add a
      // per-repo review gate override, spreading everything else untouched.
      const posted: Manifest = {
        ...onDisk,
        uat: { ...onDisk.uat!, maxFixAttempts: 9 },
        review: {
          ...onDisk.review!,
          repositories: {
            ...onDisk.review!.repositories,
            backend: { gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }] },
          },
        },
      };
      writeManifest(path, mergeSection(onDisk, posted, 'quality'));

      const { manifest: after, notices } = loadManifestWithDiagnostics(path);
      expect(after.uat?.maxFixAttempts).toBe(9);
      expect(after.uat?.secrets).toEqual(['K']);
      expect(after.uat?.env).toEqual({ A: 'b' });
      expect(after.review?.repositories.backend).toEqual({
        gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }],
      });

      // Nothing outside `quality` moved.
      expect(after.host).toBe(onDisk.host);
      expect(after.baselineBranch).toBe(onDisk.baselineBranch);
      expect(after.repositories).toEqual(onDisk.repositories);

      // The inert keys survived a UI save, so they must still be reported.
      expect(notices.some((n) => n.includes('uat.secrets'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  // The other half of the proof: an invalid edit must never reach disk, and
  // the thrown error must name the field, not just "invalid manifest". Routed
  // through writeManifest itself (not a bare validateManifest call) because
  // that is the exact seam the Quality tab's Save goes through.
  it('rejects an invalid quality draft without writing, naming the field', () => {
    const { path, cleanup } = fixture();
    try {
      const before = readFileSync(path, 'utf8');
      const m = loadManifest(path);
      const invalid: Manifest = { ...m, review: { ...reviewFixture(), maxFixAttempts: 0 } };
      expect(() => writeManifest(path, invalid)).toThrow(/review\.maxFixAttempts/);
      expect(readFileSync(path, 'utf8')).toBe(before); // untouched
    } finally {
      cleanup();
    }
  });

  // The proof task for the processes block: a valid `processes:` must survive
  // load → write → load with its meaning intact (js-yaml reformats, so it is
  // meaning, never bytes). Without the explicit `processes: manifest.processes`
  // line in the overlay, Save silently drops the whole block.
  it('round-trips a processes block through load → write → load in meaning', () => {
    const { path, cleanup } = fixture(`${RAW}
processes:
  uatTester:
    agentName: My UAT Agent
    provider: codex
    model: gpt-5.6-sol
    instructions: |
      Focus on API endpoint behavior.
      Test edge cases around authentication.
`);
    try {
      const m = loadManifest(path);
      expect(m.processes).toEqual({
        uatTester: {
          agentName: 'My UAT Agent',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          // The retired `instructions:` in the fixture is dropped at load, so
          // the write cannot carry it back out either — one prompt source.
          enabled: true,
        },
      });
      writeManifest(path, { ...m, host: '0.0.0.0' });
      expect(loadManifest(path).processes).toEqual(m.processes);
    } finally {
      cleanup();
    }
  });

  it('drops the processes block entirely once cleared', () => {
    const { path, cleanup } = fixture(`${RAW}
processes:
  uatTester: { provider: codex }
`);
    try {
      const m = loadManifest(path);
      expect(loadManifest(path).processes).toBeDefined();
      writeManifest(path, { ...m, processes: undefined });
      expect(loadManifest(path).processes).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects an invalid processes edit without writing, naming the field', () => {
    const { path, cleanup } = fixture();
    try {
      const before = readFileSync(path, 'utf8');
      const m = loadManifest(path);
      const invalid: Manifest = {
        ...m,
        processes: { uatTester: { provider: 'copilot' as never } },
      };
      expect(() => writeManifest(path, invalid)).toThrow(
        /processes\.uatTester\.provider must be one of/,
      );
      expect(readFileSync(path, 'utf8')).toBe(before); // untouched
    } finally {
      cleanup();
    }
  });

  it('round-trips agentPresets and defaultAgentPreset', () => {
    const { path, cleanup } = fixture();
    try {
      writeManifest(
        path,
        validateManifest({
          host: 'localhost',
          portRange: [4000, 4999],
          baselineBranch: 'develop',
          repositories: { extention: { repoPath: '/repo', hasMigrations: false } },
          agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
          defaultAgentPreset: 'fast',
          processes: { review: { preset: 'fast' } },
        }),
      );
      const reloaded = loadManifest(path);
      expect(reloaded.agentPresets).toEqual({
        fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      });
      expect(reloaded.defaultAgentPreset).toBe('fast');
      expect(reloaded.processes?.review?.preset).toBe('fast');
    } finally {
      cleanup();
    }
  });

  it('drops a cleared defaultAgentPreset on save', () => {
    const { path, cleanup } = fixture(`${RAW}
agentPresets:
  fast:
    provider: opencode
    model: m
defaultAgentPreset: fast
`);
    try {
      const current = loadManifest(path);
      writeManifest(path, validateManifest({ ...current, defaultAgentPreset: undefined }));
      expect(loadManifest(path).defaultAgentPreset).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // The invariant that motivated the whole nested-block task (A1): without the
  // validator preserving the block, validateApproaches' fresh-object
  // construction DROPS every graph field on the first load→save cycle. The
  // approaches overlay passes the validated array through whole — the proof
  // that no separate overlay entry is needed is this round trip succeeding.
  it('round-trips a full graph: block through load → write → load byte-identically', () => {
    const { path, cleanup } = fixture(`${RAW}
approaches:
  - id: karst-graph-engineering
    label: Dynamic Graph
    enabled: false
    graph:
      planner: { profile: expert, prompt: { artifact: skills/graph-planner/SKILL.md } }
      profiles:
        expert: { provider: claude, model: claude-opus-5, effort: high }
        worker: { provider: claude, model: claude-sonnet-5, effort: low }
        fast: { provider: claude, model: claude-sonnet-5, effort: low }
      commands:
        test: { command: npm, args: [test], cwd: repository, access: write, timeoutSeconds: 1800 }
        typecheck: { command: npm, args: [run, typecheck], cwd: repository, access: write, timeoutSeconds: 900 }
        build: { command: npm, args: [run, build], cwd: repository, access: write, timeoutSeconds: 1800 }
      limits:
        confirmGeneratedGraph: true
        maxParallel: 1
        maxNodeRuns: 40
        maxExpertRuns: 5
        maxReplans: 2
        maxActivations: 200
        maxGraphWallSeconds: 86400
        maxAgentWallSeconds: 7200
        maxAgentIdleSeconds: 1800
        maxArtifactBytes: 104857600
        maxLogBytes: 10485760
        maxAggregateArtifactBytes: 536870912
        maxAggregateWorkspaceBytes: 21474836480
`);
    try {
      const first = loadManifest(path);
      expect(first.approaches![0]!.graph).toBeDefined();
      // A Save that merely touches host keeps the whole block.
      writeManifest(path, { ...first, host: '0.0.0.0' });
      const second = loadManifest(path);
      expect(second.approaches![0]!.graph).toEqual(first.approaches![0]!.graph);
    } finally {
      cleanup();
    }
  });
});
