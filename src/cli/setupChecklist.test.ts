import { describe, it, expect } from 'vitest';
import {
  CHECKLIST_DETAIL_MAX,
  parseSetupChecklistArgs,
  renderChecklistText,
  runSetupChecklistCommand,
  type ChecklistSummary,
} from './setupChecklist.js';
import { ITEMS } from '../setup/checklist/items.js';
import type { ChecklistItem } from '../setup/checklist/types.js';
import { fakeProbes } from '../setup/readiness/fakeProbes.testutil.js';
import type { Manifest } from '../manifest/types.js';
import type { DiscoveryResult } from '../setup/discover.js';

const manifest = {
  host: '127.0.0.1', portRange: [3000, 3999], baselineBranch: 'main', agentProvider: 'claude', defaultModel: 'm',
  repositories: { web: { repoPath: '/w/web', hasMigrations: false } },
} as unknown as Manifest;
const discovery: DiscoveryResult = {
  empty: false,
  repos: [{ name: 'web', path: '/w/web', baselineBranch: 'main', baselineBranchSource: 'origin-head', service: null, serviceReason: 'none' }],
};
const base = { manifest, warnings: [], repos: [], probes: fakeProbes(), discovery, skips: [], manifestDir: '/w' };

/** One checklist item, with fields a test does not care about defaulted. */
const item = (over: Partial<ChecklistItem>): ChecklistItem => ({
  code: 'c',
  section: 'general',
  title: 't',
  required: true,
  status: 'todo',
  tool: 'set-general',
  detail: 'd',
  ...over,
});

const summary = (over: Partial<ChecklistSummary> = {}): ChecklistSummary => ({
  todo: 0,
  done: 0,
  skipped: 0,
  requiredTodo: 0,
  ...over,
});

describe('renderChecklistText', () => {
  it('prints every item todo for a manifest that does not exist', () => {
    const items = ITEMS.map((def) =>
      item({
        code: def.code,
        title: def.title,
        required: def.required,
        tool: def.tool,
        detail: 'karst.yml does not exist or does not load (ENOENT)',
      }),
    );
    const text = renderChecklistText(
      items,
      summary({ todo: items.length, requiredTodo: items.filter((i) => i.required).length }),
      'repos.registered',
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Setup checklist  0 of 9 done · 0 skipped · 5 required open');
    expect(lines).toHaveLength(1 + items.length * 2 + 1);
    expect(lines[1]).toBe('[ ] Register every discovered repository  required');
    expect(lines[2]).toBe('    karst.yml does not exist or does not load (ENOENT)');
    expect(lines.at(-1)).toBe('Next: repos.registered → add-repo');
    for (const lin of lines.slice(1, -1)) expect(lin).toMatch(/^(\[.\] | {4})/);
  });

  it('prints a mixed state with the marks, the requirement and the next tool', () => {
    const items = [
      item({ code: 'a.done', title: 'Done thing', status: 'done', detail: 'all set' }),
      item({ code: 'quality.gates', title: 'Needs work', tool: 'set-quality', detail: 'no review gate is declared' }),
      item({ code: 'skipped.one', title: 'Old thing', status: 'skipped', required: false, detail: 'the user skipped it' }),
      item({ code: 'optional.one', title: 'Optional thing', required: false, detail: 'nothing set' }),
    ];
    const text = renderChecklistText(items, summary({ todo: 2, done: 1, skipped: 1, requiredTodo: 1 }), 'quality.gates');
    expect(text).toBe(
      [
        'Setup checklist  1 of 4 done · 1 skipped · 1 required open',
        '[x] Done thing',
        '[ ] Needs work  required',
        '    no review gate is declared',
        '[-] Old thing  skipped by you',
        '[ ] Optional thing  optional',
        '    nothing set',
        'Next: quality.gates → set-quality',
      ].join('\n'),
    );
  });

  it('cuts a long detail at CHECKLIST_DETAIL_MAX', () => {
    const detail = 'x'.repeat(CHECKLIST_DETAIL_MAX + 80);
    const text = renderChecklistText([item({ detail })], summary({ todo: 1, requiredTodo: 1 }), 'c');
    expect(text.split('\n')[2]).toBe(`    ${'x'.repeat(CHECKLIST_DETAIL_MAX)}`);
  });

  it('says all required items are done when next is null', () => {
    const items = [item({ code: 'a', status: 'done' }), item({ code: 'b', required: false })];
    const text = renderChecklistText(items, summary({ todo: 1, done: 1 }), null);
    expect(text.split('\n').at(-1)).toBe('All required items are done.');
  });

  it('says all required items are done when no required item is todo, even with an optional todo', () => {
    const items = [item({ code: 'a', status: 'done' }), item({ code: 'b', required: false })];
    const text = renderChecklistText(items, summary({ todo: 1, done: 1, requiredTodo: 0 }), 'b');
    expect(text.split('\n').at(-1)).toBe('All required items are done.');
  });
});

describe('setup checklist command', () => {
  it('prints the items, the counts and the next todo as JSON by default', async () => {
    const out = JSON.parse(await runSetupChecklistCommand(base));
    expect(out.items.map((i: { code: string }) => i.code)[0]).toBe('repos.registered');
    expect(out.summary).toMatchObject({ requiredTodo: 1 });
    expect(out.ok).toBe(false);
    expect(out.next).toBe('quality.gates');
  });

  it('returns the same JSON for an explicit json format', async () => {
    await expect(runSetupChecklistCommand({ ...base, format: 'json' })).resolves.toBe(
      await runSetupChecklistCommand(base),
    );
  });

  it('leaves a not-run services check out of the verdict only when servicesUnverified is set', async () => {
    const svc = { start: 'npm run dev', ports: [3000], health: 'http://localhost:3000' };
    const withService = { ...manifest, repositories: { web: { repoPath: '/w/web', hasMigrations: false, service: svc } } } as unknown as Manifest;
    const input = { ...base, manifest: withService, verifyServices: undefined };
    const code = (o: string): string | undefined => JSON.parse(o).items.find((i: { code: string }) => i.code === 'services.declared')?.status;
    expect(code(await runSetupChecklistCommand(input))).toBe('todo');
    expect(code(await runSetupChecklistCommand({ ...input, servicesUnverified: true }))).toBe('done');
    expect(code(await runSetupChecklistCommand({ ...input, servicesUnverified: false }))).toBe('todo');
  });

  it('prints the text block for format text', async () => {
    const out = await runSetupChecklistCommand({ ...base, format: 'text' });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^Setup checklist {2}\d+ of 9 done · \d+ skipped · \d+ required open$/);
    expect(lines.at(-1)).toMatch(/^Next: \S+ → \S+$|^All required items are done\.$/);
    expect(() => JSON.parse(out)).toThrow();
  });

  it('is ok when no required item is todo', async () => {
    const m = { ...manifest, review: { gates: [{ name: 'l', command: 'npm', args: ['run', '-s', 'gate:l'] }], repositories: {} } } as unknown as Manifest;
    const out = JSON.parse(await runSetupChecklistCommand({ ...base, manifest: m }));
    expect(out.ok).toBe(true);
    expect(out.summary.requiredTodo).toBe(0);
  });

  it('a skip lowers the required todo count', async () => {
    const out = JSON.parse(
      await runSetupChecklistCommand({ ...base, skips: [{ code: 'quality.gates', reason: 'none', at: 't' }] }),
    );
    expect(out.ok).toBe(true);
    expect(out.items.find((i: { code: string }) => i.code === 'quality.gates').status).toBe('skipped');
  });

  it('shows every item todo for a manifest that does not load', async () => {
    const out = JSON.parse(await runSetupChecklistCommand({ ...base, manifest: undefined, loadError: 'ENOENT' }));
    expect(new Set(out.items.map((i: { status: string }) => i.status))).toEqual(new Set(['todo']));
    expect(out.ok).toBe(false);
  });
});

describe('parseSetupChecklistArgs', () => {
  it('defaults to json', () => {
    expect(parseSetupChecklistArgs(['setup', 'checklist'])).toEqual({ format: 'json' });
  });

  it('accepts --format text and --format json', () => {
    expect(parseSetupChecklistArgs(['setup', 'checklist', '--format', 'text'])).toEqual({ format: 'text' });
    expect(parseSetupChecklistArgs(['setup', 'checklist', '--format', 'json'])).toEqual({ format: 'json' });
  });

  it('rejects a missing or unknown --format value', () => {
    expect(() => parseSetupChecklistArgs(['setup', 'checklist', '--format'])).toThrow(
      /--format must be 'text' or 'json', got ''/,
    );
    expect(() => parseSetupChecklistArgs(['setup', 'checklist', '--format', 'yaml'])).toThrow(
      /--format must be 'text' or 'json', got 'yaml'/,
    );
  });

  it('rejects every other flag', () => {
    expect(() => parseSetupChecklistArgs(['setup', 'checklist', '--skip', 'x'])).toThrow(/unknown argument '--skip'/);
    expect(() => parseSetupChecklistArgs(['setup', 'checklist', '--format', 'text', '--skip', 'x'])).toThrow(
      /unknown argument '--skip'/,
    );
  });

  it('rejects another subcommand', () => {
    expect(() => parseSetupChecklistArgs(['setup', 'status'])).toThrow(/expected 'setup checklist'/);
  });
});
