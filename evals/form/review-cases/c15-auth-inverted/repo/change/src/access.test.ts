import { describe, expect, it } from 'vitest';
import { canEdit } from './access.js';

const user = { id: 'u1', teamId: 't1', role: 'member' as const, active: true };
const doc = { ownerId: 'u2', teamId: 't1', visibility: 'private', editors: ['u3'] };

describe('canEdit', () => {
  it('denies an inactive user', () => {
    expect(canEdit({ ...user, active: false }, doc)).toBe(false);
  });
  it('allows the owner and an admin', () => {
    expect(canEdit(user, { ...doc, ownerId: 'u1' })).toBe(true);
    expect(canEdit({ ...user, role: 'admin' }, doc)).toBe(true);
  });
  it('denies a member on a private document', () => {
    expect(canEdit(user, doc)).toBe(false);
  });
  it('allows only listed editors on a shared document', () => {
    expect(canEdit(user, { ...doc, visibility: 'shared' })).toBe(false);
    expect(canEdit({ ...user, id: 'u3' }, { ...doc, visibility: 'shared' })).toBe(true);
  });
  it('allows the same team on a team document', () => {
    expect(canEdit(user, { ...doc, visibility: 'team' })).toBe(true);
    expect(canEdit({ ...user, teamId: 't9' }, { ...doc, visibility: 'team' })).toBe(false);
  });
});
