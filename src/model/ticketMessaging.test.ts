import { describe, it, expect } from 'vitest';
import { checkMessaging, type MessagingTicket } from './ticketMessaging.js';

const t = (over: Partial<MessagingTicket> & { id: number }): MessagingTicket => ({
  projectId: 1,
  subtaskParentId: null,
  archivedAt: null,
  ...over,
});

const parent = t({ id: 1 });
const child = t({ id: 2, subtaskParentId: 1 });
const sibling = t({ id: 3, subtaskParentId: 1 });
const grandchild = t({ id: 4, subtaskParentId: 2 });

describe('checkMessaging', () => {
  it('lets a child address its direct parent', () => {
    expect(checkMessaging(child, parent)).toEqual({ ok: true });
  });

  it('lets a parent address its direct child', () => {
    expect(checkMessaging(parent, child)).toEqual({ ok: true });
  });

  it('refuses siblings, naming the rule', () => {
    const r = checkMessaging(child, sibling);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/direct parent or a direct child/);
  });

  it('refuses a grandchild in both directions', () => {
    expect(checkMessaging(grandchild, parent).ok).toBe(false);
    expect(checkMessaging(parent, grandchild).ok).toBe(false);
  });

  it('refuses a different project even when the link matches', () => {
    const other = t({ id: 2, projectId: 2, subtaskParentId: 1 });
    const r = checkMessaging(other, parent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/project/);
  });

  it('refuses an archived recipient', () => {
    const r = checkMessaging(child, { ...parent, archivedAt: '2026-01-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/archived/);
  });

  it('refuses a detached child (link cleared) from reaching its old parent', () => {
    const detached = { ...child, subtaskParentId: null };
    expect(checkMessaging(detached, parent).ok).toBe(false);
    expect(checkMessaging(parent, detached).ok).toBe(false);
  });

  it('refuses a ticket addressing itself', () => {
    expect(checkMessaging(parent, parent).ok).toBe(false);
  });

  it('treats two null projects as the same project only when both are unscoped', () => {
    const a = t({ id: 1, projectId: null });
    const b = t({ id: 2, projectId: null, subtaskParentId: 1 });
    expect(checkMessaging(b, a)).toEqual({ ok: true });
    expect(checkMessaging(b, parent).ok).toBe(false);
  });
});
