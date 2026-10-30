import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ArtifactStore } from '../../artifacts/store.js';
import { alignmentReportPath } from './alignmentReport.js';
import { mediumPlus, type AlignmentOutcome } from './alignmentTrigger.js';
import type { Finding } from '../review/findings.js';

const MESSAGE_CAP = 2000;
const MEDIUM_PLUS: readonly string[] = ['critical', 'high', 'medium'];

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** One bullet per medium+ finding, cut at the cap with a `…N more` tail. */
function findingLines(findings: readonly Finding[]): string {
  const lines = findings
    .filter((f) => MEDIUM_PLUS.includes(f.severity))
    .map((f) => `- [${f.severity}] ${oneLine(`${f.title} — ${f.detail ?? ''}`).replace(/ —$/, '')}`);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > MESSAGE_CAP) break;
    kept.push(line);
    used += line.length + 1;
  }
  const more = lines.length - kept.length;
  return [...kept, ...(more > 0 ? [`…${more} more`] : [])].join('\n');
}

export interface RecordDeps {
  store: Pick<ArtifactStore, 'commitRevision'>;
  postMessage(input: { toTicketId: number; body: string }): void;
}

/**
 * Warn-only output of an alignment run: a `review`-kind report in the ticket's
 * artifact store (always) and ONE mailbox message when any finding is medium+.
 * The fingerprint trailers are written ONLY for a successful intent→spec run,
 * so a failed run never verifies the edge for the review gate.
 */
export async function recordAlignmentOutcome(deps: RecordDeps, r: AlignmentOutcome): Promise<void> {
  const issues = mediumPlus(r.findings);
  const dir = await mkdtemp(join(tmpdir(), 'karst-alignment-'));
  try {
    const src = join(dir, 'report.md');
    await writeFile(src, r.report, 'utf8');
    const treePath = alignmentReportPath(r.edge);
    const slash = treePath.indexOf('/');
    await deps.store.commitRevision({
      ticketId: r.ticketId,
      repo: treePath.slice(0, slash),
      relPath: treePath.slice(slash + 1),
      sourcePath: src,
      trailers: {
        kind: 'review',
        source: 'karst',
        ...(!r.failed && r.edge === 'intent-spec'
          ? { specfp: r.childFp, intentfp: r.parentFp, mediumplus: String(issues) }
          : {}),
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (issues > 0) {
    deps.postMessage({
      toTicketId: r.ticketId,
      body:
        `Artifact alignment (${r.edge}): ${issues} issue(s)\n${findingLines(r.findings)}\n` +
        `Full report: karst artifact show ${alignmentReportPath(r.edge)}`,
    });
  }
}
