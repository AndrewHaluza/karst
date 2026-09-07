import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';
import { AGENT_GUIDE } from '../cli/guide.js';
import { renderDoneMarkerInstruction } from './workflowCommand.js';
import { MARKER_REFUSED } from './promptText.js';

/**
 * PROMPT-06 — single source of truth for reused agent prompt text.
 *
 * The marker contract is stated in three places (the guide's rule 3, the
 * done-marker instruction, and the ticket-context non-marker note). Each used
 * to carry its own hand-maintained wording, so a change to the rule silently
 * drifted two others. These tests pin all three to the SAME exported constant
 * BY IDENTITY — the imported `MARKER_REFUSED` value — so a re-worded copy can
 * no longer slip in next to the canonical one.
 */
describe('promptText — marker rule by identity', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seedAtGate(): number {
    const t = createTicket(store, { key: 'PROJ-R', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
    return t.id;
  }

  it('is the same constant in the guide, the marker instruction, and the ticketContext note', () => {
    // The guide's rule 3 (a non-agent-advanced note about the marker refusal).
    expect(AGENT_GUIDE).toContain(MARKER_REFUSED);

    // The done-marker instruction seeded into workflow commands / fix resumes.
    const instruction = renderDoneMarkerInstruction(
      'node "/ext/dist/cli/main.js" stage impl pass --db "/x.db" --ticket',
      'PROJ-9',
    );
    expect(instruction).toContain(MARKER_REFUSED);

    // The ticket-context note rendered at a gate stage.
    const id = seedAtGate();
    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).toContain(MARKER_REFUSED);
  });

  it('is not satisfied by a coincidental substring — the constant is what appears', () => {
    // Guard the guard: the three surfaces must contain the exact exported
    // value, not merely any sentence that happens to include "refused".
    expect(MARKER_REFUSED).toMatch(/^done marker is refused$/);
  });
});