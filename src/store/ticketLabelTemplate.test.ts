import { describe, it, expect } from 'vitest';
import {
  renderTicketLabel,
  validateLabelTemplate,
  DEFAULT_TICKET_LABEL_TEMPLATE,
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  type TicketLabelFields,
} from './ticketLabelTemplate.js';

const base: TicketLabelFields = {
  id: 7,
  key: 'PROJ-142',
  title: 'do things',
  stageCurrent: 'implement',
  agentState: 'working',
  selectedRepos: ['fe', 'be'],
  parentTicketId: null,
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
      parentTicketId: null,
    };
    expect(renderTicketLabel(fresh, '{status}')).toBe('#3 — (untitled)');
  });

  it('empty repos join to an empty string', () => {
    expect(renderTicketLabel({ ...base, selectedRepos: [] }, '{key} [{repos}]')).toBe('PROJ-142 []');
  });

  it('renders the one-char follow-up marker in the default terminal template', () => {
    const fu = { ...base, key: 'PROJ-1-fu1', parentTicketId: 7 };
    expect(renderTicketLabel(fu, DEFAULT_TERMINAL_NAME_TEMPLATE)).toBe(
      'Karst: ↳ PROJ-1-fu1 — do things',
    );
    // A non-follow-up renders byte-identically to the historical default.
    expect(renderTicketLabel(base, DEFAULT_TERMINAL_NAME_TEMPLATE)).toBe(
      'Karst: PROJ-142 — do things',
    );
  });

  it('{followUp} renders the marker prefix only for a follow-up ticket', () => {
    expect(renderTicketLabel({ ...base, parentTicketId: 7 }, '{followUp}{key}')).toBe(
      '↳ PROJ-142',
    );
    expect(renderTicketLabel({ ...base, parentTicketId: null }, '{followUp}{key}')).toBe(
      'PROJ-142',
    );
  });

  it('the default ticket label template never embeds the marker — the sidebar owns the rich marker', () => {
    expect(renderTicketLabel({ ...base, parentTicketId: 7 })).toBe('PROJ-142 — do things');
  });
});

describe('placeholder transforms', () => {
  it('shortens a look-alike ticket key to its distinguishing tail', () => {
    expect(renderTicketLabel({ ...base, key: '869e82530' }, '{key|slice:-4} — {title}')).toBe(
      '2530 — do things',
    );
    expect(renderTicketLabel({ ...base, key: '869e820e2' }, '{key|slice:-4} — {title}')).toBe(
      '20e2 — do things',
    );
  });

  it('applies a chain left to right', () => {
    expect(renderTicketLabel(base, '{key|slice:-3|upper} · {title|truncate:6}')).toBe(
      '142 · do th…',
    );
  });

  it('fills an empty field with its default instead of leaving a gap', () => {
    const fresh: TicketLabelFields = {
      id: 3,
      key: null,
      title: null,
      stageCurrent: null,
      agentState: null,
      selectedRepos: [],
      parentTicketId: null,
    };
    expect(renderTicketLabel(fresh, '{status|default:idle}')).toBe('idle');
    expect(renderTicketLabel(base, '{status|default:idle}')).toBe('working');
  });

  it('transforms an unknown variable as the empty string, never a raw brace', () => {
    expect(renderTicketLabel(base, '{key} {nope|upper}')).toBe('PROJ-142 ');
  });

  it('an invalid transform falls back to the default template rather than throwing', () => {
    expect(renderTicketLabel(base, '{key|slize:-4}')).toBe('PROJ-142 — do things');
    expect(renderTicketLabel(base, '{key|slice:x}')).toBe('PROJ-142 — do things');
  });

  it('renders templates without transforms byte-identically', () => {
    for (const template of ['{key} — {title}', 'Karst: {key} — {title}', '{key} [{repos}]', 'x']) {
      expect(renderTicketLabel(base, template)).toBe(
        template
          .replace('{key}', 'PROJ-142')
          .replace('{title}', 'do things')
          .replace('{repos}', 'fe, be'),
      );
    }
  });
});

describe('validateLabelTemplate', () => {
  it('accepts templates with no transforms and every unknown variable', () => {
    expect(() => validateLabelTemplate('ticketLabelTemplate', '{key} — {title}')).not.toThrow();
    expect(() => validateLabelTemplate('ticketLabelTemplate', '{whatever}')).not.toThrow();
  });

  it('rejects an unknown transform, naming the field and the placeholder', () => {
    expect(() => validateLabelTemplate('terminalNameTemplate', 'Karst: {key|slize:-4}')).toThrow(
      /terminalNameTemplate contains unknown transform "slize" in "\{key\|slize:-4\}"/,
    );
  });

  it('rejects a malformed argument, naming the placeholder and the reason', () => {
    expect(() => validateLabelTemplate('ticketLabelTemplate', '{key|slice:x}')).toThrow(
      /ticketLabelTemplate has an invalid "slice" argument in "\{key\|slice:x\}": start must be an integer/,
    );
  });
});
