import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { transition } from '../machine.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { baselineKey, type BaselineDecision } from '../../store/baselineDecisions.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../../agent/adapter.js';
import type { AdapterSurfaces } from '../../agent/surfaces.js';
import { SUPPORTED, unsupported } from '../../agent/surfaces.js';
import type { GitBytesRunner } from '../../integrations/git.js';
import { UsageLimitError } from '../../agent/cliFailure.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import type { BaselineEntry } from './baselineReview.js';
import {
  eligibleBaselineEntries,
  modelCanReadImages,
  precheckBaselines,
  MAX_PRECHECK_ENTRIES,
  type BaselinePrecheckInput,
} from './baselinePrecheck.js';

const now = () => '2026-08-08T10:00:00.000Z';

const ASSIGNMENT = { agentName: 'UAT Agent', provider: 'claude' as const, model: 'claude-sonnet-5' };

const SURFACES = {
  structuredOutput: SUPPORTED,
  structuredOutputForm: 'tool',
} as unknown as AdapterSurfaces;

function fakeAdapter(
  respond: (opts: RunHeadlessOpts) => Promise<HeadlessResult>,
): { adapter: AgentAdapter; calls: RunHeadlessOpts[] } {
  const calls: RunHeadlessOpts[] = [];
  return {
    calls,
    adapter: {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the pre-check');
      },
      runHeadless: async (opts) => {
        calls.push(opts);
        return respond(opts);
      },
      surfaces: SURFACES,
    },
  };
}

const answer = (raw: string) => fakeAdapter(async () => ({ sessionId: '', verdict: null, raw }));

const PNG = 'tests/visual/__baselines__/save.png';
const ADDED_PNG = 'tests/visual/__baselines__/new.png';

function entry(over: Partial<BaselineEntry> & Pick<BaselineEntry, 'path'>): BaselineEntry {
  return {
    repo: 'web',
    cwd: '/wt/web',
    status: 'modified',
    newSha256: `sha-${over.path}`,
    mergeBase: 'mb',
    autoApproved: false,
    ...over,
  };
}

function decisions(rows: Record<string, BaselineDecision['decision']>): ReadonlyMap<string, { decision: 'approved' | 'rejected' }> {
  return new Map(Object.entries(rows).map(([key, decision]) => [key, { decision }]));
}

function fakeGitBytes(
  replies: Record<string, Buffer | 'fail'>,
): { gitBytes: GitBytesRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gitBytes: GitBytesRunner = async (args) => {
    calls.push(args);
    const value = replies[args.join(' ')];
    if (value === undefined || value === 'fail') {
      return { stdout: Buffer.alloc(0), stdoutTruncated: false, stderr: 'missing', exitCode: 128 };
    }
    return { stdout: value, stdoutTruncated: false, stderr: '', exitCode: 0 };
  };
  return { gitBytes, calls };
}

function fakeFs(): {
  fs: { writeFile: (absPath: string, data: Buffer) => Promise<void>; removeDir: (absDir: string) => Promise<void> };
  writes: Map<string, Buffer>;
  removed: string[];
} {
  const writes = new Map<string, Buffer>();
  const removed: string[] = [];
  return {
    writes,
    removed,
    fs: {
      writeFile: async (absPath, data) => {
        writes.set(absPath, data);
      },
      removeDir: async (absDir) => {
        removed.push(absDir);
      },
    },
  };
}

describe('eligibleBaselineEntries', () => {
  it('keeps added and modified PNGs (any extension case) with no earlier rejection', () => {
    const kept = eligibleBaselineEntries(
      [
        entry({ path: 'a.png' }),
        entry({ path: 'b.PNG', status: 'added' }),
        entry({ path: 'gone.png', status: 'deleted' }),
        entry({ path: 'ledger.json' }),
        entry({ path: 'rejected.png' }),
      ],
      decisions({ [baselineKey('web', 'rejected.png')]: 'rejected' }),
    );
    expect(kept.map((e) => e.path)).toEqual(['a.png', 'b.PNG']);
  });

  it('keeps a previously approved entry (only a rejection disqualifies it)', () => {
    const kept = eligibleBaselineEntries(
      [entry({ path: 'a.png' })],
      decisions({ [baselineKey('web', 'a.png')]: 'approved' }),
    );
    expect(kept.map((e) => e.path)).toEqual(['a.png']);
  });
});

describe('precheckBaselines', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const input = (over: Partial<BaselinePrecheckInput> = {}): BaselinePrecheckInput => ({
    store,
    ticketId,
    enabled: true,
    entries: [entry({ path: PNG })],
    decisions: decisions({}),
    ticket: { title: 'Move the save button', description: 'The button moves.', brief: '' },
    uiPaths: ['src/ui/settings/app/Save.tsx'],
    tester: { assignment: ASSIGNMENT, adapter: answer('{"entries":[]}').adapter },
    ...over,
  });

  const deps = (gitReplies: Record<string, Buffer | 'fail'> = { [`show mb:${PNG}`]: Buffer.from('old') }) => {
    const git = fakeGitBytes(gitReplies);
    const f = fakeFs();
    return { deps: { gitBytes: git.gitBytes, fs: f.fs, now, pid: 999 }, git, ...f };
  };

  it.each([
    ['disabled', { enabled: false }, 'pre-check disabled'],
    ['no tester', { tester: undefined }, 'no UAT tester'],
    [
      'a model whose catalog tags say text-only',
      {
        tester: {
          assignment: { ...ASSIGNMENT, provider: 'antigravity' as const, model: 'gpt-oss-120b-medium' },
          adapter: answer('{}').adapter,
        },
      },
      'model gpt-oss-120b-medium cannot read images (catalog tags)',
    ],
    ['zero eligible entries', { entries: [entry({ path: 'a.json' })] }, 'no eligible entries'],
  ] as const)('skips on %s without opening a process run', async (_label, over, reason) => {
    const { calls } = answer('{"entries":[]}');
    const debug: string[] = [];
    const res = await precheckBaselines(
      input({ ...(over as Partial<BaselinePrecheckInput>), debug: (m) => debug.push(m) }),
      deps().deps,
    );
    expect(res).toEqual({ approved: [], skippedReason: reason });
    expect(calls).toEqual([]);
    expect(listProcessRuns(store, ticketId)).toEqual([]);
    expect(debug.some((line) => line.includes(reason))).toBe(true);
  });

  it('runs on an antigravity Tester whose model carries no catalog tags', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const res = await precheckBaselines(
      input({
        tester: {
          assignment: { ...ASSIGNMENT, provider: 'antigravity', model: 'gemini-4-hydrogen-medium' },
          adapter,
        },
      }),
      deps().deps,
    );
    expect(calls).toHaveLength(1);
    expect(res.skippedReason).toBeUndefined();
    expect(listProcessRuns(store, ticketId).at(-1)!).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-4-hydrogen-medium',
    });
  });

  it('runs on a codex Tester whose model is tagged vision', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const res = await precheckBaselines(
      input({
        tester: { assignment: { ...ASSIGNMENT, provider: 'codex', model: 'gpt-5.5' }, adapter },
      }),
      deps().deps,
    );
    expect(calls).toHaveLength(1);
    expect(res.skippedReason).toBeUndefined();
    expect(listProcessRuns(store, ticketId).at(-1)!).toMatchObject({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('still runs on a claude Tester as before', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const res = await precheckBaselines(input({ tester: { assignment: ASSIGNMENT, adapter } }), deps().deps);
    expect(calls).toHaveLength(1);
    expect(res.skippedReason).toBeUndefined();
    expect(listProcessRuns(store, ticketId)).toHaveLength(1);
  });

  it('skips when the injected catalog tags the Tester model text-only, opening no process run', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const debug: string[] = [];
    const catalog = {
      claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude' as const], tags: ['text-only' as const] }],
      codex: [],
      antigravity: [],
      opencode: [],
      opencode2: [],
    };
    const res = await precheckBaselines(
      input({
        tester: { assignment: ASSIGNMENT, adapter },
        catalog: () => catalog,
        debug: (m) => debug.push(m),
      }),
      deps().deps,
    );
    expect(res).toEqual({
      approved: [],
      skippedReason: 'model claude-sonnet-5 cannot read images (catalog tags)',
    });
    expect(calls).toEqual([]);
    expect(listProcessRuns(store, ticketId)).toEqual([]);
    expect(debug.some((line) => line.includes('cannot read images (catalog tags)'))).toBe(true);
  });

  it('runs when the catalog seam throws — an unreadable catalog is unknown, not a skip', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const res = await precheckBaselines(
      input({
        tester: { assignment: ASSIGNMENT, adapter },
        catalog: () => {
          throw new Error('catalog not loaded');
        },
      }),
      deps().deps,
    );
    expect(calls).toHaveLength(1);
    expect(res.skippedReason).toBeUndefined();
  });

  it('skips above the entry cap without opening a process run', async () => {
    const entries = Array.from({ length: MAX_PRECHECK_ENTRIES + 1 }, (_, i) => entry({ path: `p${i}.png` }));
    const { adapter, calls } = answer('{"entries":[]}');
    const res = await precheckBaselines(input({ entries, tester: { assignment: ASSIGNMENT, adapter } }), deps().deps);
    expect(res).toEqual({ approved: [], skippedReason: 'more than 80 eligible entries' });
    expect(calls).toEqual([]);
    expect(listProcessRuns(store, ticketId)).toEqual([]);
  });

  it('never sends a deleted, non-PNG or earlier-rejected entry', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const { deps: d } = deps({ [`show mb:${PNG}`]: Buffer.from('old') });
    await precheckBaselines(
      input({
        entries: [
          entry({ path: PNG }),
          entry({ path: 'gone.png', status: 'deleted' }),
          entry({ path: 'ledger.json' }),
          entry({ path: 'rejected.png' }),
        ],
        decisions: decisions({ [baselineKey('web', 'rejected.png')]: 'rejected' }),
        tester: { assignment: ASSIGNMENT, adapter },
      }),
      d,
    );
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain(`web:${PNG}`);
    expect(prompt).not.toContain('gone.png');
    expect(prompt).not.toContain('ledger.json');
    expect(prompt).not.toContain('rejected.png');
  });

  it('materializes the old images, approves what the model approves, and removes the old-image folder', async () => {
    const { adapter, calls } = fakeAdapter(async (opts) => {
      opts.onOutput?.({ stream: 'stdout', text: 'examining the pairs' });
      return {
        sessionId: '',
        verdict: null,
        raw: JSON.stringify({
          entries: [
            { path: `web:${PNG}`, verdict: 'approve', reason: 'the save button moved, no defect' },
            { path: `web:${ADDED_PNG}`, verdict: 'human', reason: 'cannot tell' },
          ],
        }),
      };
    });
    const d = deps({
      [`show mb:${PNG}`]: Buffer.from('old-save'),
      // An added entry has no merge-base blob; it is never asked for one.
      [`show mb:${ADDED_PNG}`]: 'fail',
    });
    const live: string[] = [];
    const res = await precheckBaselines(
      input({
        entries: [entry({ path: PNG }), entry({ path: ADDED_PNG, status: 'added' })],
        tester: { assignment: ASSIGNMENT, adapter },
        onLiveOutput: (chunk) => live.push(chunk.text),
      }),
      d.deps,
    );

    expect(res).toEqual({
      approved: [
        { repo: 'web', path: PNG, sha256: `sha-${PNG}`, reason: 'the save button moved, no defect' },
      ],
    });
    // Binary-safe old bytes land where the prompt says they are.
    const oldPath = `/wt/web/.karst/baseline-precheck/1/old/${PNG}`;
    expect(d.writes.get(oldPath)).toEqual(Buffer.from('old-save'));
    expect(d.writes.has(`/wt/web/.karst/baseline-precheck/1/old/${ADDED_PNG}`)).toBe(false);
    expect(d.removed).toContain('/wt/web/.karst/baseline-precheck/1');
    // The prompt points at the materialized old image and the working-tree new image.
    expect(calls[0]!.prompt).toContain(oldPath);
    expect(calls[0]!.prompt).toContain(`/wt/web/${PNG}`);
    // The one call is bounded and carries the schema on a structured core.
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.policy).toBe('uat-tester');
    expect(calls[0]!.outputSchema).toBeDefined();
    // The run is its own recorded process with prompt telemetry.
    const run = listProcessRuns(store, ticketId).at(-1)!;
    expect(run).toMatchObject({
      processId: 'tester',
      stageKey: 'uat',
      provider: 'claude',
      model: 'claude-sonnet-5',
      status: 'passed',
    });
    expect(run.promptTelemetry).toMatchObject({ precheckEntries: 2 });
    expect(calls[0]!.tracking?.processRunId).toBe(run.id);
    expect(calls[0]!.tracking?.callSite).toBe('uat-tester');
    expect(live).toEqual(['examining the pairs']);
  });

  it('makes a failed git show ineligible rather than throwing, and still asks the rest', async () => {
    const { adapter, calls } = answer(
      JSON.stringify({
        entries: [
          { path: `web:${PNG}`, verdict: 'approve', reason: 'no old image' },
          { path: `web:${ADDED_PNG}`, verdict: 'approve', reason: 'new file, intended' },
        ],
      }),
    );
    const d = deps({ [`show mb:${PNG}`]: 'fail' });
    const res = await precheckBaselines(
      input({
        entries: [entry({ path: PNG }), entry({ path: ADDED_PNG, status: 'added' })],
        tester: { assignment: ASSIGNMENT, adapter },
      }),
      d.deps,
    );
    expect(calls[0]!.prompt).not.toContain(`web:${PNG}`);
    expect(calls[0]!.prompt).toContain(`web:${ADDED_PNG}`);
    expect(res.approved).toEqual([
      { repo: 'web', path: ADDED_PNG, sha256: `sha-${ADDED_PNG}`, reason: 'new file, intended' },
    ]);
    expect(d.removed).toContain('/wt/web/.karst/baseline-precheck/1');
  });

  it('approves nothing from an unreadable answer', async () => {
    const { adapter } = answer('the images look intended');
    const debug: string[] = [];
    const d = deps();
    const res = await precheckBaselines(
      input({ tester: { assignment: ASSIGNMENT, adapter }, debug: (m) => debug.push(m) }),
      d.deps,
    );
    expect(res.approved).toEqual([]);
    expect(debug.some((line) => line.toLowerCase().includes('unreadable'))).toBe(true);
    expect(d.removed).toContain('/wt/web/.karst/baseline-precheck/1');
    expect(listProcessRuns(store, ticketId).at(-1)!).toMatchObject({ status: 'passed', resultKind: 'unreadable-output' });
  });

  it('approves nothing when the call throws, and still removes the old-image folder', async () => {
    const { adapter } = fakeAdapter(async () => {
      throw new Error('core crashed');
    });
    const debug: string[] = [];
    const d = deps();
    const res = await precheckBaselines(
      input({ tester: { assignment: ASSIGNMENT, adapter }, debug: (m) => debug.push(m) }),
      d.deps,
    );
    expect(res.approved).toEqual([]);
    expect(d.removed).toContain('/wt/web/.karst/baseline-precheck/1');
    expect(debug.some((line) => line.includes('core crashed'))).toBe(true);
    expect(listProcessRuns(store, ticketId).at(-1)!).toMatchObject({
      status: 'failed',
      resultKind: 'execution-failed',
    });
  });

  it('treats a usage-limit error as no approvals, never a throw or a park', async () => {
    const { adapter } = fakeAdapter(async () => {
      throw new UsageLimitError('out of quota', { tool: 'claude', provider: 'claude', model: 'opus' });
    });
    const d = deps();
    const res = await precheckBaselines(
      input({ tester: { assignment: ASSIGNMENT, adapter } }),
      d.deps,
    );
    expect(res).toEqual({ approved: [] });
    expect(d.removed).toContain('/wt/web/.karst/baseline-precheck/1');
    expect(listProcessRuns(store, ticketId).at(-1)!).toMatchObject({ status: 'failed' });
  });

  it('sends no output schema to a core without structured output', async () => {
    const { adapter, calls } = answer('{"entries":[]}');
    const surfaces = { ...SURFACES, structuredOutput: unsupported('prose only'), structuredOutputForm: undefined };
    const bare: AgentAdapter = { ...adapter, surfaces: surfaces as unknown as AdapterSurfaces };
    const d = deps();
    await precheckBaselines(input({ tester: { assignment: ASSIGNMENT, adapter: bare } }), d.deps);
    expect(calls[0]!.outputSchema).toBeUndefined();
  });
});

describe('modelCanReadImages', () => {
  const catalog: ModelCatalog = {
    claude: [
      { id: 'untagged', label: 'Untagged', providers: ['claude'] },
      { id: 'empty-tags', label: 'Empty tags', providers: ['claude'], tags: [] },
      { id: 'eyes', label: 'Eyes', providers: ['claude'], tags: ['vision'] },
      { id: 'both-senses', label: 'Both senses', providers: ['claude'], tags: ['multimodal'] },
      { id: 'words-only', label: 'Words only', providers: ['claude'], tags: ['text-only'] },
      { id: 'ears', label: 'Ears', providers: ['claude'], tags: ['audio'] },
    ],
    codex: [{ id: 'codex-untagged', label: 'Codex untagged', providers: ['codex'] }],
    antigravity: [{ id: 'antigravity-only', label: 'Antigravity only', providers: ['antigravity'], tags: ['vision'] }],
    opencode: [],
    opencode2: [],
  };

  it('runs when no model is resolved (the core default)', () => {
    expect(modelCanReadImages('claude', null, catalog)).toBe(true);
    expect(modelCanReadImages('claude', undefined, catalog)).toBe(true);
    expect(modelCanReadImages('claude', '', catalog)).toBe(true);
  });

  it('runs when the id is not in this provider section', () => {
    expect(modelCanReadImages('claude', 'no-such-model', catalog)).toBe(true);
    expect(modelCanReadImages('opencode2', 'anything', catalog)).toBe(true);
  });

  it('runs when the model has no tags or an empty tag list', () => {
    expect(modelCanReadImages('claude', 'untagged', catalog)).toBe(true);
    expect(modelCanReadImages('claude', 'empty-tags', catalog)).toBe(true);
  });

  it('runs when the tags include vision or multimodal', () => {
    expect(modelCanReadImages('claude', 'eyes', catalog)).toBe(true);
    expect(modelCanReadImages('claude', 'both-senses', catalog)).toBe(true);
  });

  it('skips when the known tags include neither vision nor multimodal', () => {
    expect(modelCanReadImages('claude', 'words-only', catalog)).toBe(false);
    expect(modelCanReadImages('claude', 'ears', catalog)).toBe(false);
  });

  it('is keyed by provider: an id that exists only under another core is unknown', () => {
    expect(modelCanReadImages('antigravity', 'antigravity-only', catalog)).toBe(true);
    expect(modelCanReadImages('claude', 'antigravity-only', catalog)).toBe(true);
    // The same id under a provider that lost the entry stays unknown.
    expect(modelCanReadImages('codex', 'codex-untagged', catalog)).toBe(true);
    expect(modelCanReadImages('antigravity', 'codex-untagged', catalog)).toBe(true);
  });

  it('reads the bundled catalog without mutating it', () => {
    const bundled = bundledModelCatalog();
    const before = JSON.stringify(bundled);
    expect(modelCanReadImages('antigravity', 'gpt-oss-120b-medium', bundled)).toBe(false);
    expect(modelCanReadImages('antigravity', 'gemini-4-hydrogen-medium', bundled)).toBe(true);
    expect(modelCanReadImages('claude', 'claude-opus-5-5', bundled)).toBe(true);
    expect(JSON.stringify(bundled)).toBe(before);
  });

  it('runs when the provider section is absent from the catalog', () => {
    expect(modelCanReadImages('antigravity', 'anything', {} as ModelCatalog)).toBe(true);
  });
});
