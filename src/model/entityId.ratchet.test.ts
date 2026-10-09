import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SKIP_DIR = new Set(['ui', 'node_modules']);
// `#${…}` carrying a PR/revision/run number, not a ticket/draft/session id. Per entry:
//   pr.number / p.number     GitHub pull-request numbers (the one legitimate `#N`)
//   *.revisionNumber         graph plan revision counter, not an entity id
//   nodeRunId / processRunId graph run row numbers, not ticket ids
//   metrics.instructionsHash a content hash shown as `#abc…`
const ALLOWED = /#\$\{(pr\.number|p\.number|outcome\.revisionNumber|result\.revisionNumber|nodeRunId|processRunId|metrics\.instructionsHash)\}/;
const ENTITY = /#\$\{[^}]*(ticketId|sessionId|subtaskId|parentId|proposalId|\bid\b|requestedId|fromTicketId|draftId|planId|rootId|depId|blockerId|parentTicketId|graphRunTicketId|toTicketId|\bn\b)[^}]*\}/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(e)) walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('entity-id ratchet', () => {
  it('no source text builds a #<entity id>; use entityId.ts', () => {
    const offenders = walk(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        ENTITY.test(line) && !ALLOWED.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []),
    );
    expect(offenders).toEqual([]);
  });
  it("no source concatenates '#' + an id", () => {
    const re = /['"]#['"]\s*\+/;
    const offenders = walk(ROOT).filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
