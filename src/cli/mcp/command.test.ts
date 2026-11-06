import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { commandNames } from '../registry.js';
import type { CliIo } from '../main.js';
import { defaultMcpRunner } from './command.js';

const io = { readStdin: () => '' } as unknown as CliIo;

/** Registry verbs whose first token is not enough: they dispatch on a sub-verb. */
const EXTRA_ARGV: readonly string[][] = [
  ['setup', 'check'],
  ['setup', 'verify'],
  ['artifact', 'show'],
  ['artifact', 'add'],
];

async function messageOf(argv: string[]): Promise<string> {
  try {
    return await defaultMcpRunner.run(argv, {}, io);
  } catch (e) {
    return (e as Error).message;
  }
}

describe('defaultMcpRunner routing', () => {
  const cases = [...commandNames().map((name) => [name]), ...EXTRA_ARGV];
  it.each(cases)('routes %s to a handler (never "unknown command")', async (...argv) => {
    // No --db/--manifest: a routed handler fails on the missing flag at most.
    expect(await messageOf(argv)).not.toMatch(/unknown command/);
  });
});

describe('defaultMcpRunner async verbs', () => {
  // Each async verb reaches ITS handler: the handler's own missing-flag error
  // proves the route (a wrong route gives another message or "unknown command").
  it.each([
    [['setup', 'check'], /missing --manifest/],
    [['setup', 'verify'], /missing --db/],
    [['artifact', 'show'], /missing --db/],
    [['artifact', 'add'], /missing --db/],
    [['doctor'], /missing --db/],
  ] as const)('routes %j to its handler', async (argv, expected) => {
    expect(await messageOf([...argv])).toMatch(expected);
  });

  it('returns the doctor report as a result, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-doctor-'));
    try {
      const db = join(dir, 'karst.db');
      openStore(db).close();
      const out = await defaultMcpRunner.run(['doctor', '--json', '--area', 'manifest', '--db', db], {}, io);
      expect(JSON.parse(out)).toHaveProperty('exitCode');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
