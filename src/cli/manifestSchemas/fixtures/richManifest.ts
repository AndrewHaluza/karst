/**
 * A raw manifest document that sets every section with every block populated,
 * plus a variant with a disabled (draft) repository. The conformance test
 * mutates these field by field. Test support only; named `*Manifest.ts` under
 * the schema folder, never imported by production code.
 */

export type Raw = Record<string, unknown>;

const SLOT = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };

const GATE_SCRIPT = {
  name: 'unit',
  kind: 'script',
  script: 'test',
  repo: 'api',
  sandbox: 'inside',
  onResourceKill: 'park',
  maxConcurrent: 2,
  timeoutMinutes: 30,
  enabled: true,
};
const GATE_COMMAND = { name: 'lint', kind: 'command', command: 'eslint', args: ['.', '--quiet'] };

export function richManifest(): Raw {
  return {
    id: 'proj-1',
    host: '127.0.0.1',
    portRange: [4000, 4100],
    baselineBranch: 'develop',
    worktreePathDisplay: 'relative',
    ticketLabelTemplate: '{key|slice:-4} — {title|truncate:48}',
    terminalNameTemplate: 'Karst: {key|slice:-4}',
    archiveDoneAfterDays: 3,
    archivePlanningAfterDays: 5,
    debug: true,
    closeDoneTerminalsWithTicket: true,
    diffsInSourceControl: false,
    stopServersOnDone: 'auto',
    subtasks: { maxConcurrentPerParent: 2, maxConcurrentTotal: 4 },
    conventions: {
      branchName: 'karst/{type}/{slug}',
      commitMessage: '{type}({scope}): {title} [{key}]',
      pullRequestTitle: '{title}',
      pullRequestDescription: '{description}',
      defaultType: 'feat',
    },
    repositories: {
      api: {
        repoPath: '/work/api',
        baselineBranch: 'main',
        scope: 'api',
        hasMigrations: true,
        signals: ['api', 'backend'],
        enabled: true,
        conventions: { commitMessage: '{title}', pullRequestTitle: '{title}', pullRequestDescription: '{description}' },
        sandbox: { setup: 'npm ci', setupHosts: ['registry.npmjs.org', '*.npmjs.org'] },
        graphWorkspace: { link: ['node_modules'], setup: 'npm ci', setupWhen: ['package-lock.json'] },
        ship: { exclude: ['dist/**'], regenerate: ['npm run -s docs', { run: 'npm run gen', sandbox: 'host', paths: ['gen'] }] },
        services: {
          server: {
            start: 'node server.mjs',
            health: 'http://{host}:{port}/health',
            build: 'npm run -s build',
            reset: 'node reset.mjs',
            cwd: 'apps/api',
            healthIdentity: true,
            healthTimeoutSeconds: 60,
            sandbox: 'host',
            ports: [{ name: 'port', env: 'PORT', default: 8000 }],
            portRange: [8000, 8100],
            dependsOn: [
              { target: 'db/store', port: 'port', bind: [{ env: 'DB_URL', template: 'postgres://{host}:{port}' }] },
            ],
          },
        },
      },
      db: {
        repoPath: '/work/db',
        services: {
          store: {
            start: '',
            docker: {
              image: 'postgres:16',
              containerPort: 5432,
              env: { POSTGRES_PASSWORD: 'dev' },
              volumes: ['./pgdata:/var/lib/postgresql/data'],
              args: ['-c', 'fsync=off'],
            },
            sandbox: 'host',
            ports: [{ name: 'port', env: 'DB_PORT', default: 5432 }],
          },
        },
      },
      web: {
        repoPath: '/work/web',
        service: {
          start: 'npm run dev',
          health: 'http://{host}:{port}/',
          ports: [{ name: 'port', env: 'PORT', default: 3000 }],
        },
      },
      docs: { repoPath: '/work/docs' },
    },
    approaches: [
      {
        id: 'rpi',
        label: 'Research Plan Implement',
        description: 'Discover before coding.',
        entrypoint: 'research',
        source: { type: 'git', repo: 'shanraisshan/claude-code-best-practice', ref: 'main', include: ['agents'] },
        recommended: true,
        workflow: [
          { name: 'describe' },
          { name: 'research', command: '/rpi:research', description: 'Look around', evidence: { outputKind: 'research' } },
        ],
        outputs: [{ glob: 'rpi/*/plan/**', kind: 'plan' }],
        checks: ['intent-spec', 'spec-plan'],
        enabled: true,
      },
      {
        id: 'npmflow',
        label: 'From npm',
        source: { type: 'npm', package: 'some-pkg', command: 'npm install', collect: [] },
      },
      {
        id: 'graph',
        label: 'Graph',
        graph: {
          planner: { profile: 'expert', prompt: { artifact: 'prompts/planner.md' } },
          profiles: { expert: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
          commands: {
            build: {
              command: 'npm',
              args: ['run', 'build'],
              cwd: 'repository',
              access: 'read',
              timeoutSeconds: 600,
              env: { CI: '1' },
            },
          },
          limits: { maxParallel: 4, maxNodeRuns: 40, maxExpertRuns: 5, maxReplans: 2, maxActivations: 200 },
        },
      },
    ],
    agents: { research: { role: 'research', command: 'research', promptPath: 'research.md', enabled: true } },
    agentProvider: 'claude',
    defaultModel: 'claude-opus-5-5',
    defaultEffort: 'high',
    processes: {
      uatTester: { agent: 'research', enabled: true },
      review: { pinned: true, provider: 'codex', model: 'gpt-5', effort: 'high', agentName: 'rev' },
    },
    agentPresets: { fast: { label: 'Fast', slots: { uatFix: SLOT, review: SLOT } }, legacy: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } },
    activeAgentPreset: 'fast',
    agentBackends: { claude: 'sbx', codex: 'host', opencode: 'docker', opencode2: 'host', agy: 'host' },
    remotes: {
      devbox: {
        host: 'devbox.example.com',
        user: 'karst',
        port: 2222,
        keyPath: '~/.ssh/id_ed25519',
        mode: 'direct',
        remoteDir: '/srv/karst',
        allowHostServices: false,
      },
    },
    quota: { warnThresholdPct: 80, claudeGlobalStatusline: true, claudeOauthUsageApi: false },
    resilience: { retries: 2, backoffMs: 1000, fallbackModels: ['claude-sonnet-5-5'] },
    artifacts: { maxAgeDays: 30 },
    agentSandbox: true,
    sandboxMemory: {
      interactiveMemory: '4g',
      interactiveReservation: '2g',
      gateMemory: '2048m',
      gateReservation: '1g',
      sbxMemory: '8g',
      sbxMinFree: '1g',
    },
    sandboxLimits: { cpus: 4, workers: true, gateSlots: 2 },
    analysis: { codePointers: true },
    ticketing: {
      provider: 'clickup',
      teamId: 'team',
      listId: 'list',
      advanceOnShip: true,
      shipStatus: 'Done',
      advanceOnStart: true,
      startStatus: 'In progress',
      searchEnabled: true,
      syncSubtasks: 'link',
    },
    uat: {
      testDir: 'tests',
      maxFixAttempts: 3,
      stallTimeoutMinutes: 45,
      gates: [{ ...GATE_SCRIPT, report: 'report.json' }, GATE_COMMAND],
      probeWhenAllDisabled: true,
      keepStackForUser: true,
      testerVerifier: { ...GATE_SCRIPT, report: 'verifier.json' },
      harnesses: [{ name: 'browser', whenChanged: ['src/**'], start: 'npm run harness', stop: 'npm run stop', evidence: '.karst/uat-scratch/out/browser/h.md', startTimeoutSeconds: 60, description: 'Browser harness' }],
      testerObservations: {
        blockingSeverity: 'high',
        onSkip: 'reask',
        requireEvidence: { file: 'evidence/*.md', whenChanged: ['src/**'] },
      },
      tester: { tokenBudget: 400000 },
      baselineReview: { paths: ['docs'], precheck: true },
      env: { NODE_ENV: 'test' },
      secrets: ['API_KEY'],
      passthrough: ['HOME'],
      origins: ['https://example.com'],
      authBootstrap: { path: 'auth.json', secrets: ['TOKEN'] },
      author: { enabled: true, agent: 'research' },
      repositories: { api: { env: { A: 'b' }, secrets: ['S'], gates: [GATE_COMMAND], testDir: 'it' } },
    },
    review: {
      maxFixAttempts: 3,
      stallTimeoutMinutes: 30,
      requireIndependentSignal: false,
      openChanges: true,
      probeWhenAllDisabled: true,
      gates: [GATE_SCRIPT],
      findings: { enabled: true, blockingSeverity: 'medium', maxFindings: 20 },
      stallDetection: { enabled: true, sameFileRounds: 4, repeatedFindingRounds: 2 },
      repositories: { api: { gates: [GATE_COMMAND] } },
    },
    autopilot: {
      enabled: true,
      ci: { policy: 'ask', maxAttempts: 3, checks: ['build'] },
      conflicts: { policy: 'auto', maxRounds: 2 },
    },
  };
}

/** The rich document plus a disabled repository whose content is incomplete (draft mode). */
export function richDraftManifest(): Raw {
  const raw = richManifest();
  (raw.repositories as Raw).draft = {
    repoPath: '',
    enabled: false,
    service: {
      start: '',
      ports: [{ name: '', env: '', default: 0 }],
      dependsOn: [{ target: 'x', port: 'p', bind: [] }],
    },
  };
  return raw;
}
