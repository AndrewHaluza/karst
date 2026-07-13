import { describe, it, expect } from 'vitest';
import {
  renderTicketLabel,
  DEFAULT_TICKET_LABEL_TEMPLATE,
  type TicketLabelFields,
} from './ticketLabelTemplate.js';

const base: TicketLabelFields = {
  id: 7,
  key: 'PROJ-142',
  title: 'do things',
  stageCurrent: 'implement',
  agentState: 'working',
  selectedRepos: ['fe', 'be'],
};

describe('renderTicketLabel', () => {
  it('default template reproduces the historical "<key> — <title>" label', () => {
    expect(renderTicketLabel(base)).toBe('PROJ-142 — do things');
    expect(renderTicketLabel(base, DEFAULT_TICKET_LABEL_TEMPLATE)).toBe('PROJ-142 — do things');
  });

  it('default falls back to #id when key is unset and (untitled) when title is unset', () => {
    expect(renderTicketLabel({ ...base, key: null })).toBe('#7 — do things');
    expect(renderTicketLabel({ ...base, title: null })).toBe('PROJ-142 — (untitled)');
    expect(renderTicketLabel({ ...base, key: null, title: null })).toBe('#7 — (untitled)');
  });

  it('blank/whitespace template is treated as the default', () => {
    expect(renderTicketLabel(base, '')).toBe('PROJ-142 — do things');
    expect(renderTicketLabel(base, '   ')).toBe('PROJ-142 — do things');
  });

  it('substitutes each supported variable', () => {
    expect(renderTicketLabel(base, '{id}')).toBe('7');
    expect(renderTicketLabel(base, '{status}')).toBe('working');
    expect(renderTicketLabel(base, '{stage}')).toBe('implement');
    expect(renderTicketLabel(base, '{repos}')).toBe('fe, be');
    expect(renderTicketLabel(base, '{key} · {stage} · {status}')).toBe(
      'PROJ-142 · implement · working',
    );
  });

  it('unknown tokens render empty, never a raw brace', () => {
    expect(renderTicketLabel(base, '{key} {nope}')).toBe('PROJ-142 ');
    expect(renderTicketLabel(base, '{bogus}')).toBe('PROJ-142 — do things'); // all-empty → default
  });

  it('a template that resolves to empty falls back to the default', () => {
    // fresh ticket: no stage/status; a stage-only template would be blank.
    const fresh: TicketLabelFields = {
      id: 3,
      key: null,
      title: null,
      stageCurrent: null,
      agentState: null,
      selectedRepos: [],
    };
    expect(renderTicketLabel(fresh, '{status}')).toBe('#3 — (untitled)');
  });

  it('empty repos join to an empty string', () => {
    expect(renderTicketLabel({ ...base, selectedRepos: [] }, '{key} [{repos}]')).toBe('PROJ-142 []');
  });
});
