import { describe, expect, it } from 'vitest';
import { describeHolders, parseLsofHolders } from './fixtures.js';

describe('parseLsofHolders', () => {
  it('reads pid, command and port from lsof -F output', () => {
    const out = 'p4001\ncnode\nn*:28689\nn127.0.0.1:28690\np4002\ncnode\nn[::1]:28700\n';
    expect(parseLsofHolders(out)).toEqual([
      { pid: 4001, command: 'node', port: 28689 },
      { pid: 4001, command: 'node', port: 28690 },
      { pid: 4002, command: 'node', port: 28700 },
    ]);
  });
  it('ignores a line without a valid pid or port', () => {
    expect(parseLsofHolders('n*:28689\npx\nnode\ncnode\nn*:http\n')).toEqual([]);
  });
});

describe('describeHolders', () => {
  it('is empty with no holder', () => {
    expect(describeHolders([])).toBe('');
  });
  it('names the holders and counts the rest', () => {
    const holders = [1, 2, 3].map((pid) => ({ pid, command: 'node', port: 28600 + pid }));
    expect(describeHolders(holders, 2)).toBe(' Holders: pid 1 (node) on port 28601; pid 2 (node) on port 28602, and 1 more.');
  });
});
