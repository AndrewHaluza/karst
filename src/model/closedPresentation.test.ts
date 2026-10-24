import { describe, it, expect } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { getTicket } from '../store/tickets.js';
import { setAgentState } from '../store/tickets.js';
import { closeTicket } from '../workflow/closeTicket.js';
import { transition } from '../workflow/machine.js';
import { stageBadge } from './stageBadge.js';
import { ticketGlyph, needsUser } from './ticketGlyph.js';
import { stageColorClass } from './stagePalette.js';

function closedTicket(agent?: 'waiting') {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  if (agent) setAgentState(store, id, agent);
  closeTicket(store, id, { reason: 'done by Sam' });
  return getTicket(store, id);
}

describe('a closed ticket presents as closed, never as done or needs-you', () => {
  it('badge reads Closed with the closed stage', () => {
    const b = stageBadge(closedTicket());
    expect(b.label).toBe('Closed');
    expect(b.stage).toBe('closed');
  });

  it('glyph is gray, not the green of a delivered ticket', () => {
    expect(ticketGlyph(closedTicket())).toBe('gray');
  });

  it('a waiting agent does not make a closed ticket need the user', () => {
    const t = closedTicket('waiting');
    expect(needsUser(t)).toBe(false);
    expect(ticketGlyph(t)).toBe('gray');
  });

  it('has its own stage color class, not the unknown fallback', () => {
    expect(stageColorClass('closed')).toBe('stg-closed');
  });
});
