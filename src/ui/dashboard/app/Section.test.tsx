// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { GroupHeader, Section } from './Section.js';

afterEach(cleanup);

const query = (sel: string): Element | null => document.querySelector(sel);
const text = (sel: string): string => query(sel)?.textContent ?? '';

describe('Section — empty (no body) mode', () => {
  it('keeps the header and its actions and shows one muted line instead of a body (UI-R46)', () => {
    render(
      <Section title="Pull requests" count={0} actions={<button type="button">Refresh</button>} bodyId="prs" empty="No pull requests yet.">
        <div>a row</div>
      </Section>,
    );
    expect(text('.phead .sec-title')).toBe('Pull requests');
    expect(text('.phead .pops button')).toBe('Refresh');
    // A zero count is not a count (DB-11): the empty line says what is absent.
    expect(query('.phead .count')).toBeNull();
    const empty = query('#prs')!;
    expect(empty.className).toBe('k-empty k-empty--inline');
    expect(empty.textContent).toBe('No pull requests yet.');
    expect(empty.tagName).toBe('DIV');
    // No body wrapper, no icon, no bold heading: one line is the whole body.
    expect(query('.pbody')).toBeNull();
    expect(query('.estate')).toBeNull();
    expect(query('.emark')).toBeNull();
    expect(query('.ehead')).toBeNull();
    expect(query('.k-empty-title')).toBeNull();
    // The children are not rendered beside the line.
    expect(query('#prs')!.textContent).not.toContain('a row');
  });

  it('renders a non-zero count beside the title', () => {
    render(<Section title="Worktrees" count={3} bodyId="worktrees" empty="No worktrees yet." />);
    expect(text('.phead .count')).toBe('3');
  });

  it('falls back to the body for an empty string, null and undefined (the loading state)', () => {
    for (const empty of ['', null, undefined]) {
      render(<Section title="Servers" bodyId="servers" empty={empty} />);
      expect(query('.k-empty'), String(empty)).toBeNull();
      expect(query('.pbody#servers'), String(empty)).not.toBeNull();
      expect(query('.pbody')!.childElementCount).toBe(0);
      cleanup();
    }
  });

  it('omits the body wrapper only without an empty: children render inside it', () => {
    render(
      <Section title="Servers" bodyId="servers">
        <div>a row</div>
      </Section>,
    );
    expect(text('.pbody#servers')).toBe('a row');
  });

  it('moves the panel from the empty line to the body in the same id when the first item arrives (UI-R46)', () => {
    const { rerender } = render(<Section title="Pull requests" count={0} bodyId="prs" empty="No pull requests yet." />);
    expect(query('#prs')!.className).toBe('k-empty k-empty--inline');
    rerender(
      <Section title="Pull requests" count={1} bodyId="prs">
        <div>row</div>
      </Section>,
    );
    expect(query('.k-empty')).toBeNull();
    const body = query('#prs')!;
    expect(body.className).toBe('pbody');
    expect(body.textContent).toBe('row');
    expect(text('.phead .count')).toBe('1');
  });
});

describe('Section — summary', () => {
  it('renders a plain summary with its full text in title and aria-label (UI-R44)', () => {
    render(<Section title="Servers" summary="1 running · 1 failed" summaryTitle="1 running · 1 failed" />);
    const sum = query('.phead .sec-sum')!;
    expect(sum.textContent).toBe('1 running · 1 failed');
    expect(sum.getAttribute('title')).toBe('1 running · 1 failed');
    expect(sum.getAttribute('aria-label')).toBe('1 running · 1 failed');
    expect(sum.className).toBe('sec-sum');
  });

  it('renders the summary in the mono face when asked', () => {
    render(<Section title="Worktrees" summary="feat/x" summaryMono />);
    expect(query('.phead .sec-sum')!.className).toBe('sec-sum mono');
    expect(query('.phead .sec-sum')!.getAttribute('title')).toBeNull();
  });

  it('renders no summary slot for a null or empty summary', () => {
    render(<Section title="Worktrees" summary={null} />);
    expect(query('.sec-sum')).toBeNull();
    cleanup();
    render(<Section title="Worktrees" summary="" />);
    expect(query('.sec-sum')).toBeNull();
  });
});

describe('GroupHeader', () => {
  it('renders the label and count, and the note when there is one', () => {
    render(<GroupHeader label="Ticket services" count={2} note="run from this ticket's worktrees" />);
    expect(text('.sec-group .gname')).toBe('Ticket services');
    expect(text('.sec-group .gcount')).toBe('2');
    expect(text('.sec-group .gnote')).toBe("run from this ticket's worktrees");
  });

  it('omits the note when there is none', () => {
    render(<GroupHeader label="Shared services" count={0} />);
    expect(query('.sec-group .gnote')).toBeNull();
  });
});
