import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composeResumeSeed, composeConflictSeed } from './entrySeed.js';
import { buildSessionSeed, measureSeed, INSTRUCTIONS_HEADING } from './seed.js';
import { renderInstructionsPointer } from './instructions.js';
import { markerStageFor } from './markerStage.js';
import { renderGateOnlyInstruction } from './workflowCommand.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';

// Representative pre-rendered context halves (see ticketContext.test.ts for the
// shaping coverage). buildSessionSeed only routes and composes sections.
const AUTHORED = '# Ticket: PROJ-9 — Fix login redirect\n\n## Prompt\nUsers bounce to /login.';
const FACTS = '## Current stage\n- stage: impl (running)\n\n## Repositories in scope\n- backend: /repo/backend';

describe('buildSessionSeed routing', () => {
  it('routes facts, servers, guide and marker into the instruction layer', () => {
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      factsContext: FACTS,
      invocation: '/karst:rpi PROJ-9',
      markerInstruction: 'RUN THE MARKER',
      guideInstruction: 'READ THE GUIDE',
      serversInstruction: '## Services\n\nRULE',
    });
    expect(seed.instructions).toBeDefined();
    expect(seed.instructions!.startsWith(INSTRUCTIONS_HEADING)).toBe(true);
    expect(seed.instructions).toContain('## Current stage');
    expect(seed.instructions).toContain('## Services');
    expect(seed.instructions).toContain('READ THE GUIDE');
    expect(seed.instructions).toContain('RUN THE MARKER');
    // Authored text is NOT duplicated into the instruction layer.
    expect(seed.instructions).not.toContain('Users bounce to /login');
  });

  it('routes the invocation FIRST, then authored text and the approach method, into the kickoff', () => {
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      factsContext: FACTS,
      approachPrompt: '# Research first\nGo look.',
      invocation: '/karst:rpi PROJ-9',
      markerInstruction: 'RUN THE MARKER',
      guideInstruction: 'READ THE GUIDE',
    });
    expect(seed.kickoff.split('\n')[0]).toBe('/karst:rpi PROJ-9');
    const ctxIdx = seed.kickoff.indexOf('# Ticket: PROJ-9');
    const approachIdx = seed.kickoff.indexOf('# Approach');
    expect(ctxIdx).toBeGreaterThan(0);
    expect(approachIdx).toBeGreaterThan(ctxIdx);
    // The rules never repeat in the kickoff.
    expect(seed.kickoff).not.toContain('RUN THE MARKER');
    expect(seed.kickoff).not.toContain('READ THE GUIDE');
    expect(seed.kickoff).not.toContain('## Services');
  });

  it('omits the invocation line when none is given (kickoff starts with authored text)', () => {
    const seed = buildSessionSeed({ authoredContext: AUTHORED, factsContext: FACTS });
    expect(seed.kickoff.startsWith('# Ticket: PROJ-9')).toBe(true);
    expect(seed.kickoff).not.toContain('/karst:');
  });

  it('returns an empty split when there is genuinely nothing to say', () => {
    expect(buildSessionSeed({})).toEqual({ instructions: null, kickoff: '' });
    expect(buildSessionSeed({ authoredContext: '   ', factsContext: '' })).toEqual({
      instructions: null,
      kickoff: '',
    });
  });

  it('keeps the guide pointer out of the kickoff but in the instruction layer', () => {
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      factsContext: FACTS,
      guideInstruction: 'To understand how Karst works and what this CLI can do, run `g`.',
    });
    expect(seed.instructions).toContain('To understand how Karst works');
    expect(seed.kickoff).not.toContain('To understand how Karst works');
  });

  it('still seeds the instruction layer for a gate stage (no marker) with the gate sentence', () => {
    const markerStage = markerStageFor('review');
    expect(markerStage).toBeNull();
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      factsContext: FACTS,
      markerInstruction: renderGateOnlyInstruction(),
    });
    expect(seed.instructions!.toLowerCase()).toContain('gate exit codes');
    expect(seed.kickoff.toLowerCase()).not.toContain('gate exit codes');
  });
});

describe('buildSessionSeed inline (solo/no-command fallback)', () => {
  it('inlines the whole layer into the kickoff and writes no instruction layer', () => {
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      approachPrompt: 'do the thing',
      invocation: '/karst:rpi PROJ-9',
      markerInstruction: 'RUN THE MARKER',
      guideInstruction: 'READ THE GUIDE',
      serversInstruction: '## Services\n\nRULE',
      inlineInstructions: true,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff.split('\n')[0]).toBe('/karst:rpi PROJ-9');
    const authoredIdx = seed.kickoff.indexOf('# Ticket: PROJ-9');
    const serversIdx = seed.kickoff.indexOf('## Services');
    const approachIdx = seed.kickoff.indexOf('# Approach');
    const guideIdx = seed.kickoff.indexOf('READ THE GUIDE');
    const markerIdx = seed.kickoff.indexOf('RUN THE MARKER');
    // Pre-split order: authored, servers, approach, guide, marker.
    expect(authoredIdx).toBeGreaterThan(0);
    expect(serversIdx).toBeGreaterThan(authoredIdx);
    expect(approachIdx).toBeGreaterThan(serversIdx);
    expect(guideIdx).toBeGreaterThan(approachIdx);
    expect(markerIdx).toBeGreaterThan(guideIdx);
  });

  it('self-contained bare form when only a marker exists', () => {
    const seed = buildSessionSeed({
      authoredContext: AUTHORED,
      markerInstruction: 'RUN THE MARKER',
      inlineInstructions: true,
    });
    expect(seed.instructions).toBeNull();
    expect(seed.kickoff).toBe(`${AUTHORED}\n\nRUN THE MARKER`);
  });
});

describe('measureSeed', () => {
  it('counts BOTH layers as resident seed size', () => {
    const instructions = { path: '/s/karst-instructions.md', body: '# Karst rules\nDo the thing.' };
    const m = measureSeed('kickoff', undefined, instructions);
    expect(m.seedChars).toBe('kickoff'.length + instructions.body.length);
    expect(m.instructionsChars).toBe(instructions.body.length);
    expect(m.instructionsHash).toHaveLength(10);
    // No instruction layer → the fields are absent, never invented.
    expect(measureSeed('kickoff')).not.toHaveProperty('instructionsChars');
  });

  it('reports zero length for a bare launch (undefined seed)', () => {
    expect(measureSeed(undefined)).toEqual({ seedChars: 0, guidePointer: false });
  });

  it('detects the guide pointer in the instruction layer', () => {
    const instructions = { path: '/s/karst-instructions.md', body: '# Rules\nGUIDE-HERE' };
    expect(measureSeed('kickoff', 'GUIDE-HERE', instructions).guidePointer).toBe(true);
    expect(measureSeed('kickoff', 'GUIDE-HERE').guidePointer).toBe(false);
  });

  it('flags a pointer core whose kickoff carries the instructions pointer', () => {
    const m = measureSeed(renderInstructionsPointer());
    expect(m.instructionsPointer).toBe(true);
    expect(measureSeed('no pointer here')).not.toHaveProperty('instructionsPointer');
  });

  it('records instructionsPointer from the ADAPTER channel for a pointer core', () => {
    const instructions = { path: '/s/karst-instructions.md', body: '# Rules' };
    // The pointer is spliced into the kickoff INSIDE buildInteractiveCommand,
    // after the raw seed — so the reported channel, not a text scan, is the
    // fact for pointer cores (the raw kickoff here has no pointer text).
    const m = measureSeed('/karst:rpi PROJ-9', undefined, instructions, 'pointer');
    expect(m.instructionsPointer).toBe(true);
    // native-file / fallback cores never set it.
    expect(measureSeed('/karst:rpi PROJ-9', undefined, instructions, 'native-file')).not
      .toHaveProperty('instructionsPointer');
    expect(measureSeed('go', undefined, instructions, 'fallback')).not.toHaveProperty(
      'instructionsPointer',
    );
  });
});

describe('buildSessionSeed budget', () => {
  it('truncates an oversized approach method with the stated pointer', () => {
    // Filler is 'q', not 'z' — the honest approach pointer's own wording
    // ("materialized") contains a 'z', which would corrupt a 'z'-based count.
    const bigMethod = '# Big approach\n' + 'q'.repeat(20_000);
    const seed = buildSessionSeed({ approachPrompt: bigMethod, ticketKey: 'PROJ-9' });
    // The approach-method pointer is NOT `karst context <key>` — that command
    // renders TicketContext, which never carries the approach body, so it
    // would be a stated pointer to nothing. This is the honest one instead.
    expect(seed.kickoff).toContain('the approach method is longer than fits here');
    expect(seed.kickoff).not.toContain('karst context PROJ-9');
    // 8000-char budget applies to the whole method text, including the 15-char
    // "# Big approach\n" heading, so 8000 - 15 = 7985 'q' characters survive.
    expect(seed.kickoff.match(/q/g)!.length).toBe(7985);
  });

  it('never truncates the marker instruction, even with a huge context and method', () => {
    const bigContext = 'c'.repeat(50_000);
    const bigMethod = 'm'.repeat(50_000);
    const marker = 'FIRE THE MARKER: run `karst stage impl pass`';
    const seed = buildSessionSeed({
      authoredContext: bigContext,
      approachPrompt: bigMethod,
      markerInstruction: marker,
      ticketKey: 'PROJ-9',
    });
    expect(seed.instructions).toContain(marker);
  });

  it('reports truncation via the injected debug callback', () => {
    const bigMethod = 'z'.repeat(20_000);
    const seen: string[] = [];
    buildSessionSeed({
      approachPrompt: bigMethod,
      ticketKey: 'PROJ-9',
      debug: (m) => seen.push(m),
    });
    expect(seen.some((m) => m.includes('approach method'))).toBe(true);
  });

  it('does not truncate a method body under budget', () => {
    const seed = buildSessionSeed({ approachPrompt: '# Small\nGo look.', ticketKey: 'PROJ-9' });
    expect(seed.kickoff).not.toContain('truncated --');
  });
});

describe('seed split end-to-end (routing of a real ticket)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('routes the authored half to the kickoff and the operational facts to the instructions', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Oversized' });
    updateTicketFields(store, t.id, {
      description: 'Prompt: ' + 'p'.repeat(100),
      brief: 'Brief: ' + 'b'.repeat(100),
      selectedRepos: ['frontend'],
    });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
    setStage(store, t.id, 'review', { status: 'running' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [{ gateName: 'lint-gate', exitCode: 1, summary: 'boom' }],
    });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      findings: [
        {
          severity: 'high',
          repo: '/repo',
          file: 'src/x.ts',
          line: 3,
          title: 'Null deref',
          detail: 'd',
          source: 'agent',
        },
      ],
    });

    const ctx = buildTicketContext(store, undefined, t.id, '/storage');
    const authored = renderTicketContext(ctx, undefined, { sections: 'narrative' });
    const facts = renderTicketContext(ctx, undefined, { sections: 'facts' });
    const seed = buildSessionSeed({
      authoredContext: authored,
      factsContext: facts,
      invocation: '/karst:rpi PROJ-9',
      markerInstruction: 'RUN THE MARKER',
      guideInstruction: '`karst guide`',
      ticketKey: 'PROJ-9',
    });

    // Authored prompt/brief ride the kickoff; operational facts do not.
    expect(seed.kickoff).toContain('## Prompt');
    expect(seed.kickoff).toContain('## Context brief');
    expect(seed.kickoff).not.toContain('## Current stage');
    expect(seed.kickoff).not.toContain('## Repositories in scope');
    // Facts ride the instruction layer.
    expect(seed.instructions).toContain('## Current stage');
    expect(seed.instructions).toContain('- lint-gate: exit 1');
    expect(seed.instructions).toContain('## Repositories in scope');
    expect(seed.instructions).toContain('- findings:');
    expect(seed.instructions).toContain('Null deref');
    expect(seed.instructions).not.toContain('## Prompt');
  });

  it('keeps attachments in the authored half only', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
    updateTicketFields(store, t.id, { description: 'Do it' });
    insertAttachment(store, {
      ticketId: t.id,
      kind: 'image',
      storedName: 'a.png',
      originalName: 'shot.png',
      byteSize: 1,
    });
    const ctx = buildTicketContext(store, undefined, t.id, '/storage');
    const authored = renderTicketContext(ctx, undefined, { sections: 'narrative' });
    const facts = renderTicketContext(ctx, undefined, { sections: 'facts' });
    const seed = buildSessionSeed({
      authoredContext: authored,
      factsContext: facts,
      invocation: '/karst:rpi PROJ-9',
      ticketKey: 'PROJ-9',
    });
    expect(seed.kickoff).toContain('## Attachments');
    expect(seed.instructions ?? '').not.toContain('## Attachments');
  });
});

describe('buildSessionSeed blockers section', () => {
  it('carries a landed blocker outcome in the kickoff, never the instruction layer', () => {
    const authored = `${AUTHORED}\n\n## Blockers\nThese blockers landed before you started.\n\nB-1 landed: Widget API\n\nFull outcome: karst context B-1`;
    const seed = buildSessionSeed({ authoredContext: authored, factsContext: FACTS, invocation: '/karst:rpi PROJ-9' });
    expect(seed.kickoff).toContain('B-1 landed: Widget API');
    expect(seed.instructions ?? '').not.toContain('B-1 landed');
  });
});

describe('seeds state the session own id once per route', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());
  const count = (s: string, needle: string): number => s.split(needle).length - 1;

  it('launch, resume and conflict seeds carry the facts self-line; sub-task names the parent', () => {
    const parent = createTicket(store, { key: 'PK-1', title: 'Parent' });
    const t = createTicket(store, { key: 'PK-2', title: 'Kid', subtaskParentId: parent.id });
    const ctx = buildTicketContext(store, undefined, t.id, '/storage');
    const facts = renderTicketContext(ctx, undefined, { sections: 'facts' });
    const authored = renderTicketContext(ctx, undefined, { sections: 'narrative' });
    const self = `You are working on T${t.id}`;
    const launch = buildSessionSeed({ authoredContext: authored, factsContext: facts, invocation: '/karst:rpi PK-2' });
    expect(count(launch.instructions!, self)).toBe(1);
    expect(launch.instructions).toContain(`sub-task of T${parent.id}`);
    expect(launch.kickoff).not.toContain(self);
    const resume = composeResumeSeed({ ticketKey: 'PK-2', resumeBrief: 'go', invocation: '/karst:rpi', factsContext: facts });
    expect(count(resume.instructions!, self)).toBe(1);
    const conflict = composeConflictSeed({ ticketKey: 'PK-2', conflictBrief: 'fix', invocation: '/karst:rpi', factsContext: facts });
    expect(count(conflict.instructions!, self)).toBe(1);
  });

  it('inline mode states the id once, via the Ticket heading', () => {
    const t = createTicket(store, { key: 'PK-3', title: 'Solo' });
    const ctx = buildTicketContext(store, undefined, t.id, '/storage');
    const seed = buildSessionSeed({ authoredContext: renderTicketContext(ctx), inlineInstructions: true });
    expect(count(seed.kickoff, `# Ticket: T${t.id}`)).toBe(1);
    expect(count(seed.kickoff, `T${t.id}`)).toBe(1);
  });
});
