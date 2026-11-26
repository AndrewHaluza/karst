import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `extension.ts` cannot load under vitest, so the GRAPH prompt render is pinned
// on the source text. A graph node has no `karst` wrapper on PATH and its env
// sets `KARST_TICKET_ID`, never `KARST_TICKET`, so its ticket context must go
// through `renderGraphTicketContext` (`commandHints: false`) and never the
// default `renderTicketContext`, which would seed `karst inbox` / `notes`.
describe('graph ticket-context render', () => {
  const source = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');

  function body(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('renders the graph session context through renderGraphTicketContext', () => {
    const ticketContext = body('const ticketContextWithDrift', 'const graphRecoveryDeps');
    expect(ticketContext).toContain('renderGraphTicketContext(');
    expect(ticketContext).not.toContain('renderTicketContext(');
  });

  it('renders the planner-recovery context through renderGraphTicketContext', () => {
    const recovery = body('const graphRecoveryDeps', 'const onGraphRecovered');
    expect(recovery).toContain('renderGraphTicketContext(');
    expect(recovery).not.toContain('renderTicketContext(');
  });
});
