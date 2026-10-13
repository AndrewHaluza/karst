import { describe, it, expect, vi } from 'vitest';
import {
  formatCoreChoices,
  formatModelChoices,
  handleUsageLimitPick,
  handleUsageLimitRetry,
  handleUsageLimitDismiss,
  type QuickPickChoice,
} from './usageLimitParkOps.js';
import { openStore } from '../../store/db.js';
import { insertOpenPark, listOpenParks, listParks } from '../../store/usageLimitParks.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { setStage } from '../../store/stages.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { AgentAdapter } from '../../agent/adapter.js';

describe('usageLimitParkOps', () => {
  const fakeCatalog: ModelCatalog = {
    claude: [
      { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', providers: ['claude'] },
      { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', providers: ['claude'] },
    ],
    codex: [
      { id: 'gpt-4o', label: 'GPT-4o', providers: ['codex'] },
    ],
    antigravity: [],
    opencode: [],
    opencode2: [],
  };

  describe('formatCoreChoices', () => {
    it('appends (usage limit) to the parked core label', () => {
      const choices = formatCoreChoices('claude');
      const claudeChoice = choices.find((c) => c.id === 'claude');
      expect(claudeChoice).toBeDefined();
      expect(claudeChoice!.label).toContain('(usage limit)');

      const codexChoice = choices.find((c) => c.id === 'codex');
      expect(codexChoice).toBeDefined();
      expect(codexChoice!.label).not.toContain('(usage limit)');
    });
  });

  describe('formatModelChoices', () => {
    it('appends (usage limit) to the parked model description or label', () => {
      const choices = formatModelChoices('claude', fakeCatalog, 'claude-3-7-sonnet');
      const parkedChoice = choices.find((c) => c.model === 'claude-3-7-sonnet');
      expect(parkedChoice).toBeDefined();
      expect(parkedChoice!.description).toContain('(usage limit)');

      const otherChoice = choices.find((c) => c.model === 'claude-3-5-sonnet');
      expect(otherChoice).toBeDefined();
      expect(otherChoice!.description).not.toContain('(usage limit)');
    });
  });

  describe('handleUsageLimitPick', () => {
    it('notifies already handled when no open park exists', async () => {
      const store = openStore(':memory:');
      const warn = vi.fn();
      const pickCore = vi.fn();
      const pickModel = vi.fn();
      const redrive = vi.fn();

      await handleUsageLimitPick({
        store,
        ticketId: 1,
        stageKey: 'review',
        catalog: fakeCatalog,
        notify: { info: vi.fn(), warn, error: vi.fn() },
        pickCore,
        pickModel,
        redrive,
        refresh: vi.fn(),
        adapterFor: vi.fn(),
      });

      expect(warn).toHaveBeenCalledWith('This usage limit was already handled.');
      expect(pickCore).not.toHaveBeenCalled();
      expect(redrive).not.toHaveBeenCalled();
    });

    it('cancels without claiming when user aborts core picker', async () => {
      const store = openStore(':memory:');
      const ticket = createTicketFlow(store, { title: 'Test ticket' });
      insertOpenPark(store, {
        ticketId: ticket.id,
        stage: 'review',
        kind: 'stage-block',
        lane: 'review',
        target: 'repo',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        detail: 'out of credits',
        keptOutcome: null,
      });

      const pickCore = vi.fn().mockResolvedValue(undefined);
      const redrive = vi.fn();

      await handleUsageLimitPick({
        store,
        ticketId: ticket.id,
        stageKey: 'review',
        catalog: fakeCatalog,
        notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        pickCore,
        pickModel: vi.fn(),
        redrive,
        refresh: vi.fn(),
        adapterFor: vi.fn(),
      });

      expect(pickCore).toHaveBeenCalled();
      expect(redrive).not.toHaveBeenCalled();
      expect(listOpenParks(store, ticket.id)).toHaveLength(1);
    });

    it('claims park, executes rerunParkedStage, and redrives when user picks new model', async () => {
      const store = openStore(':memory:');
      const ticket = createTicketFlow(store, { title: 'Test ticket' });
      setStage(store, ticket.id, 'review', {
        blockedKind: 'usage-limit',
        blockedReason: 'out of credits',
        blockedAt: '2026-10-14T00:00:00Z',
      });
      insertOpenPark(store, {
        ticketId: ticket.id,
        stage: 'review',
        kind: 'stage-block',
        lane: 'review',
        target: 'repo',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        detail: 'out of credits',
        keptOutcome: JSON.stringify({
          kind: 'ok',
          findings: [],
          targets: [{ repo: 'other', pass: true }],
        }),
      });

      const pickCore = vi.fn().mockResolvedValue({ id: 'codex', label: 'Codex' });
      const pickModel = vi.fn().mockResolvedValue({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
      const redrive = vi.fn();
      const refresh = vi.fn();
      const mockAdapter = { runHeadless: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' }) } as unknown as AgentAdapter;
      const adapterFor = vi.fn().mockReturnValue(mockAdapter);

      await handleUsageLimitPick({
        store,
        ticketId: ticket.id,
        stageKey: 'review',
        catalog: fakeCatalog,
        notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        pickCore,
        pickModel,
        redrive,
        refresh,
        adapterFor,
        cwd: '/tmp',
        artifactDir: '/tmp',
      });

      expect(pickCore).toHaveBeenCalled();
      expect(pickModel).toHaveBeenCalled();
      expect(adapterFor).toHaveBeenCalledWith('codex', 'gpt-4o');
      expect(listOpenParks(store, ticket.id)).toHaveLength(0);
      expect(redrive).toHaveBeenCalledWith(ticket.id);
      expect(refresh).toHaveBeenCalledWith(ticket.id);
    });
  });

  describe('handleUsageLimitRetry', () => {
    it('claims park with resolution retry, re-runs with original provider/model, and redrives', async () => {
      const store = openStore(':memory:');
      const ticket = createTicketFlow(store, { title: 'Test ticket' });
      setStage(store, ticket.id, 'review', {
        blockedKind: 'usage-limit',
        blockedReason: 'out of credits',
        blockedAt: '2026-10-14T00:00:00Z',
      });
      insertOpenPark(store, {
        ticketId: ticket.id,
        stage: 'review',
        kind: 'stage-block',
        lane: 'review',
        target: 'repo',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        detail: 'out of credits',
        keptOutcome: JSON.stringify({
          kind: 'ok',
          findings: [],
          targets: [{ repo: 'other', pass: true }],
        }),
      });

      const redrive = vi.fn();
      const refresh = vi.fn();
      const mockAdapter = { runHeadless: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' }) } as unknown as AgentAdapter;
      const adapterFor = vi.fn().mockReturnValue(mockAdapter);

      await handleUsageLimitRetry({
        store,
        ticketId: ticket.id,
        stageKey: 'review',
        notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        redrive,
        refresh,
        adapterFor,
        cwd: '/tmp',
        artifactDir: '/tmp',
      });

      expect(adapterFor).toHaveBeenCalledWith('claude', 'claude-3-7-sonnet');
      expect(listOpenParks(store, ticket.id)).toHaveLength(0);
      const parks = listParks(store, ticket.id);
      expect(parks[0]?.resolution).toBe('retry');
      expect(redrive).toHaveBeenCalledWith(ticket.id);
      expect(refresh).toHaveBeenCalledWith(ticket.id);
    });
  });

  describe('handleUsageLimitDismiss', () => {
    it('dismisses park, commits failed verdict, and redrives', async () => {
      const store = openStore(':memory:');
      const ticket = createTicketFlow(store, { title: 'Test ticket' });
      store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(ticket.id);
      setStage(store, ticket.id, 'review', {
        blockedKind: 'usage-limit',
        blockedReason: 'out of credits',
        blockedAt: '2026-10-14T00:00:00Z',
      });
      insertOpenPark(store, {
        ticketId: ticket.id,
        stage: 'review',
        kind: 'stage-block',
        lane: 'review',
        target: 'repo',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        detail: 'out of credits',
        keptOutcome: null,
      });

      const redrive = vi.fn();
      const refresh = vi.fn();

      await handleUsageLimitDismiss({
        store,
        ticketId: ticket.id,
        stageKey: 'review',
        notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        redrive,
        refresh,
        artifactDir: '/tmp',
      });

      expect(listOpenParks(store, ticket.id)).toHaveLength(0);
      const parks = listParks(store, ticket.id);
      expect(parks[0]?.resolution).toBe('dismiss');
      expect(redrive).toHaveBeenCalledWith(ticket.id);
      expect(refresh).toHaveBeenCalledWith(ticket.id);
    });
  });
});
