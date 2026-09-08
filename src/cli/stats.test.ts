import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { parseStatsArgs, runStatsCommand } from './stats.js';
import { UNAVAILABLE_METRICS } from '../store/metrics/index.js';

describe('karst stats — parse', () => {
  it('defaults to the text report with no scope of its own', () => {
    expect(parseStatsArgs(['stats'])).toEqual({ format: 'text' });
  });

  it('accepts --json, --project and --since', () => {
    expect(parseStatsArgs(['stats', '--json', '--project', 'p', '--since', '2026-01-01'])).toEqual({
      format: 'json',
      projectSlug: 'p',
      since: '2026-01-01',
    });
  });

  it('rejects a wrong command, an unknown flag and a flag with no value', () => {
    expect(() => parseStatsArgs(['context'])).toThrow(/stats/);
    expect(() => parseStatsArgs(['stats', '--nope'])).toThrow(/unknown flag/);
    expect(() => parseStatsArgs(['stats', '--project'])).toThrow(/--project/);
    expect(() => parseStatsArgs(['stats', 'PROJ-1'])).toThrow(/unknown/);
  });
});

describe('karst stats — report', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('renders every metric plus the unavailable ones with their reason', () => {
    const p = upsertProject(store, { slug: 'demo' });
    createTicket(store, { key: 'A', title: 'a', projectId: p.id });

    const out = runStatsCommand(store, parseStatsArgs(['stats']), 'demo');
    for (const heading of [
      'First-pass rate',
      'Rework loops',
      'Gate kill distribution',
      'Cycle time',
      'Agent-active time',
      'Cost per merged ticket',
      'Token burn by call site',
      'Escaped defects',
      'Finding density',
      'Agent-vs-human findings',
      'Merge friction',
      'Ship failures',
      'Graph approach efficiency',
      'Interruption rate',
      'Not available',
    ]) {
      expect(out).toContain(heading);
    }
    for (const gap of UNAVAILABLE_METRICS) {
      expect(out).toContain(gap.metric);
      expect(out).toContain(gap.reason);
    }
    expect(out).toContain('project demo');
  });

  it('emits the same data as JSON under --json', () => {
    const p = upsertProject(store, { slug: 'demo' });
    createTicket(store, { key: 'A', title: 'a', projectId: p.id });

    const parsed = JSON.parse(runStatsCommand(store, parseStatsArgs(['stats', '--json']), 'demo'));
    expect(parsed.scope).toEqual({ projectSlug: 'demo', projectId: p.id, since: null });
    expect(parsed.unavailable).toHaveLength(UNAVAILABLE_METRICS.length);
    expect(parsed.escapedDefects.tickets).toBe(1);
  });

  it('scopes to the named project, overriding the manifest default', () => {
    const mine = upsertProject(store, { slug: 'mine' });
    const other = upsertProject(store, { slug: 'other' });
    createTicket(store, { key: 'A', title: 'a', projectId: mine.id });
    createTicket(store, { key: 'B', title: 'b', projectId: other.id });
    createTicket(store, { key: 'C', title: 'c', projectId: other.id });

    const argv = parseStatsArgs(['stats', '--json', '--project', 'other']);
    const parsed = JSON.parse(runStatsCommand(store, argv, 'mine'));
    expect(parsed.scope.projectSlug).toBe('other');
    expect(parsed.escapedDefects.tickets).toBe(2);
  });

  it('fails naming the slug when the project is unknown', () => {
    expect(() => runStatsCommand(store, parseStatsArgs(['stats', '--project', 'ghost']), undefined))
      .toThrow(/ghost/);
  });

  it('reports every project when no slug is given and no manifest resolves one', () => {
    const p = upsertProject(store, { slug: 'demo' });
    createTicket(store, { key: 'A', title: 'a', projectId: p.id });
    const parsed = JSON.parse(runStatsCommand(store, parseStatsArgs(['stats', '--json']), undefined));
    expect(parsed.scope).toEqual({ projectSlug: null, projectId: null, since: null });
    expect(parsed.escapedDefects.tickets).toBe(1);
  });

  it('passes --since through to the scope', () => {
    const parsed = JSON.parse(
      runStatsCommand(store, parseStatsArgs(['stats', '--json', '--since', '2026-01-01']), undefined),
    );
    expect(parsed.scope.since).toBe('2026-01-01');
  });
});
