import { describe, expect, it } from 'vitest';
import { conflictBriefPointer } from './conflictSession.js';

describe('conflictBriefPointer', () => {
  const line = conflictBriefPointer({ key: 'T9', repo: '/r/api', command: 'node "$KARST_CLI" conflict-brief --db "$KARST_DB"' });

  it('is one short line with no newline', () => {
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(300);
  });

  it('names the MCP tool with the key and repo, and the CLI fallback', () => {
    expect(line.startsWith('karst: conflict brief ready - call the karst MCP tool `conflict-brief`')).toBe(true);
    expect(line).toContain('{ key: "T9", repo: "/r/api" }');
    expect(line).toContain('run `node "$KARST_CLI" conflict-brief --db "$KARST_DB" T9 "/r/api"`');
  });
});
