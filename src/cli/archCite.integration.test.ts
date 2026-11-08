import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without types
import { run as runDocsGate } from '../../scripts/docsGate.mjs';
import { appendDesignRulesSection, renderCitationText } from '../model/archCitations.js';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listArchCitations } from '../store/archCitations.js';
import { runArchCommand } from './archCommand.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SRC = 'export function alpha() {\n  return 1;\n}\n';
const DOC = '# Doc\n\n## [@arch:T-01] Rule\ncovers: src/a.ts#alpha\ntext\nEND_DOC_BLOCK: [@arch:T-01]\n';

describe('arch cite end to end', () => {
  it('a covered change fails docs:gate, passes after a cite, and the PR body carries the line', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arch-cite-int-'));
    dirs.push(cwd);
    const g = (...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' });
    const put = (p: string, t: string): void => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), t); };
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.invalid');
    g('config', 'user.name', 't');
    put('src/a.ts', SRC);
    put('docs/arch/t.md', DOC);
    put('docs/COVERS.json', JSON.stringify({ 'src/a.ts#alpha': ['arch:T-01'] }));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('checkout', '-q', '-b', 'feat');
    put('src/a.ts', SRC.replace('return 1', 'return 2'));
    g('add', '-A');
    g('commit', '-q', '-m', 'change');

    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'P-1', title: 't', source: 'manual' });
    const gateBody = (): string => renderCitationText(listArchCitations(store, ticket.id));

    expect(runDocsGate({ baseRef: 'main', body: gateBody(), cwd }).block).toBe(true);

    runArchCommand(store, ticket, ['arch', 'cite', '@arch:T-01', '--why', 'alpha keeps its contract'], { sessionTicketKey: 'P-1', cwd });

    expect(runDocsGate({ baseRef: 'main', body: gateBody(), cwd }).block).toBe(false);
    const prBody = appendDesignRulesSection('Ticket: P-1 — t', listArchCitations(store, ticket.id));
    expect(prBody).toContain('- @arch:T-01 — alpha keeps its contract');
    expect(runDocsGate({ baseRef: 'main', body: prBody, cwd }).block).toBe(false);
  });
});
