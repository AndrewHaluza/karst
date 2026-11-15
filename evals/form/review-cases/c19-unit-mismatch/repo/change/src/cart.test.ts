import { describe, expect, it } from 'vitest';
import { cartTotal, lineTotal } from './cart.js';

describe('cart', () => {
  it('multiplies price by quantity', () => {
    expect(lineTotal({ name: 'pen', price: 2, quantity: 3 })).toBe(6);
  });
  it('sums the lines', () => {
    expect(cartTotal([{ name: 'pen', price: 2, quantity: 3 }, { name: 'cap', price: 1, quantity: 1 }])).toBe(7);
  });
});
