import { describe, expect, it } from 'vitest';
import { renderBoard, topTasks } from './taskBoard.js';

const tasks = [
  { title: 'a', priority: 1 },
  { title: 'b', priority: 5 },
  { title: 'c', priority: 3 },
  { title: 'd', priority: 4 },
];

describe('topTasks', () => {
  it('returns the highest priority tasks first', () => {
    expect(topTasks([...tasks], 2).map((t) => t.title)).toEqual(['b', 'd']);
  });
  it('returns an empty list for a count of zero', () => {
    expect(topTasks([...tasks], 0)).toEqual([]);
  });
});

describe('renderBoard', () => {
  it('lists the top three, then the rest', () => {
    expect(renderBoard([...tasks])).toEqual(['* b', '* d', '* c', '4. a']);
  });
});
