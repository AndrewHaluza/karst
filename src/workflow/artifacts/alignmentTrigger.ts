/**
 * Debounced, one-in-flight-per-ticket trigger for the edge alignment check.
 * Fires on a spec/plan revision, skips edges the approach verifies itself, and
 * skips an edge whose parent+child fingerprints did not change since a
 * successful run. Never rejects: every failure is logged and the next edge runs.
 */
import { effectiveChecks, type ChainEdge } from '../../approaches/checks.js';
import type { ApproachDef } from '../../manifest/types.js';
import type { Finding } from '../review/findings.js';
import { chainFingerprint, intentFingerprint, nodeText, parentOf, type ArtifactChain } from './chain.js';
import type { AlignmentResult } from './alignment.js';

export const ALIGNMENT_DEBOUNCE_MS = 60_000;

export interface RevisionEvent {
  ticketId: number;
  kind: string;
}

export interface AlignmentOutcome extends AlignmentResult {
  ticketId: number;
  edge: ChainEdge;
  parentFp: string;
  childFp: string;
}

export interface TriggerDeps {
  loadChain(ticketId: number): Promise<ArtifactChain>;
  approachFor(ticketId: number): ApproachDef | undefined;
  run(input: {
    ticketId: number;
    edge: ChainEdge;
    parentText: string;
    childText: string;
    paths?: { parent?: string[]; child?: string[] };
  }): Promise<AlignmentResult>;
  record(outcome: AlignmentOutcome): Promise<void> | void;
  debug?(message: string): void;
}

/** Severities that mean the edge is NOT clean. */
export function mediumPlus(findings: readonly Finding[]): number {
  return findings.filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium').length;
}

export function createAlignmentTrigger(deps: TriggerDeps) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const pendingKinds = new Map<number, Set<'spec' | 'plan'>>();
  const inFlight = new Set<number>();
  const lastFp = new Map<string, string>(); // `${ticketId}:${edge}` → parentFp|childFp

  async function checkEdge(ticketId: number, chain: ArtifactChain, child: 'spec' | 'plan', skip: ReadonlySet<ChainEdge>): Promise<void> {
    const node = chain[child];
    const rel = node ? parentOf(chain, child) : null;
    if (!node || !rel || skip.has(rel.edge)) return;
    const parentText = rel.parent === 'intent' ? chain.intent! : nodeText(chain.spec!);
    const parentFp = rel.parent === 'intent' ? intentFingerprint(chain.intent!) : chainFingerprint(chain.spec!);
    const childFp = chainFingerprint(node);
    const key = `${ticketId}:${rel.edge}`;
    const fp = `${parentFp}|${childFp}`;
    if (lastFp.get(key) === fp) return;
    const r = await deps.run({
      ticketId,
      edge: rel.edge,
      parentText,
      childText: nodeText(node),
      paths: {
        parent: rel.parent === 'intent' ? undefined : chain.spec!.files.map((f) => `${f.repo}/${f.relPath}`),
        child: node.files.map((f) => `${f.repo}/${f.relPath}`),
      },
    });
    if (!r.failed) lastFp.set(key, fp);
    await deps.record({ ticketId, edge: rel.edge, parentFp, childFp, ...r });
  }

  async function fire(ticketId: number): Promise<void> {
    timers.delete(ticketId);
    if (inFlight.has(ticketId)) {
      schedule(ticketId);
      return;
    }
    const kinds = pendingKinds.get(ticketId) ?? new Set<'spec' | 'plan'>();
    pendingKinds.delete(ticketId);
    inFlight.add(ticketId);
    try {
      const chain = await deps.loadChain(ticketId);
      const skip = effectiveChecks(deps.approachFor(ticketId) ?? { id: '' });
      const children = new Set<'spec' | 'plan'>(kinds);
      if (kinds.has('spec') && chain.plan) children.add('plan');
      for (const child of children) {
        // One edge's failure must never abort the remaining edges or reject the timer.
        try {
          await checkEdge(ticketId, chain, child, skip);
        } catch (err) {
          deps.debug?.(`[alignment] edge ${child} failed for ticket ${ticketId}: ${String(err)}`);
        }
      }
    } catch (err) {
      deps.debug?.(`[alignment] run failed for ticket ${ticketId}: ${String(err)}`);
    } finally {
      inFlight.delete(ticketId);
    }
  }

  function schedule(ticketId: number): void {
    const t = timers.get(ticketId);
    if (t) clearTimeout(t);
    timers.set(ticketId, setTimeout(() => void fire(ticketId), ALIGNMENT_DEBOUNCE_MS));
  }

  return {
    onRevision(e: RevisionEvent): void {
      if (e.kind !== 'spec' && e.kind !== 'plan') return;
      const kinds = pendingKinds.get(e.ticketId) ?? new Set<'spec' | 'plan'>();
      kinds.add(e.kind);
      pendingKinds.set(e.ticketId, kinds);
      schedule(e.ticketId);
    },
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
