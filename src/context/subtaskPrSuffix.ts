import { summarizeMergeCheck } from '../model/mergeCheckView.js';
import type { TicketContextPr } from './ticketContext.js';

/**
 * The sub-task row suffix in the pulled `karst context --md` document: the
 * cached PR facts an orchestrator would otherwise fetch with one `gh` call per
 * repo. Never rendered into the bounded seed (arch:RESIDENT).
 */
export function subtaskPrSuffix(stage: string | null, prs: readonly TicketContextPr[]): string {
  if (prs.length === 0) return stage === 'ship' ? ' — no PR yet' : '';
  return ` — ${prs.map(formatPr).join(', ')}`;
}

function formatPr(p: TicketContextPr): string {
  const head = p.number !== null ? `${p.repo}#${p.number}` : p.repo;
  const parts = [p.baseRef ? `${head} → ${p.baseRef}` : head];
  if (p.status) parts.push(p.status);
  if (p.mergeCheck) parts.push(`merge: ${summarizeMergeCheck(p.mergeCheck)}`);
  return parts.join(' · ');
}
