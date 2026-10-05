import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Ratchet: the shipped CLI's machine path (`dist/cli/main.js`) must never be
 * interpolated into agent-facing prompt text. Prompts reference `"$KARST_CLI"`
 * (or `"$KARST_GRAPH_CLI"`); the path itself lives only in the two env sources.
 */
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'extension.ts'), 'utf8');
const CLI_PATH = "'dist', 'cli', 'main.js'";

function functionBody(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end);
}

describe('extension.ts CLI path ratchet', () => {
  it('names dist/cli/main.js only in cliEntryAndManifest and the graph env cliPath', () => {
    const lines = SOURCE.split('\n').filter((l) => l.includes(CLI_PATH));
    const inHelper = functionBody('cliEntryAndManifest')
      .split('\n')
      .filter((l) => l.includes(CLI_PATH));
    const graphCliPath = lines.filter((l) => /^\s*cliPath: join\(/.test(l));

    expect(inHelper).toHaveLength(1);
    expect(graphCliPath).toHaveLength(1);
    expect(lines).toHaveLength(inHelper.length + graphCliPath.length);
  });

  it('composes the graph node completion command from the env ref', () => {
    expect(SOURCE).toMatch(/cliNodeCompletionCommand: \(\) => `node \$\{envRef\('KARST_GRAPH_CLI'\)\} node complete`/);
  });
});
