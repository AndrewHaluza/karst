import { describe, expect, it } from 'vitest';
import { fixDeliveryNote, type FixDeliveryFacts } from './fixDeliveryNote.js';

const base: FixDeliveryFacts = {
  id: 12,
  pointedAt: null,
  repointedAt: null,
  pointerFailedAt: null,
  readAt: null,
  deliveredVia: null,
  supersededAt: null,
};

describe('fixDeliveryNote', () => {
  it('names a waiting delivery', () => {
    expect(fixDeliveryNote(base)).toBe('fix brief #12 waiting to be pointed at');
  });
  it('names a pointed, unread delivery', () => {
    expect(fixDeliveryNote({ ...base, pointedAt: 't' })).toBe('fix brief #12 pointed at, not read yet');
  });
  it('names a re-sent, unread delivery', () => {
    expect(fixDeliveryNote({ ...base, pointedAt: 't', repointedAt: 't' })).toBe(
      'fix brief #12 pointed at twice, not read yet',
    );
  });
  it('names a read delivery by how it arrived', () => {
    expect(fixDeliveryNote({ ...base, readAt: 't', deliveredVia: 'pointer' })).toBe('fix brief #12 read by the agent');
    expect(fixDeliveryNote({ ...base, readAt: 't', deliveredVia: 'seed' })).toBe(
      'fix brief #12 delivered in the launch seed',
    );
  });
  it('names a delivery whose pointer could not be built', () => {
    expect(fixDeliveryNote({ ...base, pointerFailedAt: 't' })).toBe('fix brief #12 could not be pointed at');
  });
  it('says nothing about a superseded delivery or no delivery', () => {
    expect(fixDeliveryNote({ ...base, supersededAt: 't' })).toBeUndefined();
    expect(fixDeliveryNote(undefined)).toBeUndefined();
  });
  it('a read delivery wins over a later pointer failure', () => {
    expect(fixDeliveryNote({ ...base, readAt: 't', deliveredVia: 'pointer', pointerFailedAt: 't' })).toBe(
      'fix brief #12 read by the agent',
    );
  });
});
