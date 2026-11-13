import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { GateProcessRunner } from '../workflow/gates/run.js';
import { manifestNamesByPath } from '../workflow/gates/targets.js';
import { regenerateOption } from '../workflow/gates/regenerateOption.js';
import { resolveTicketBaseRef } from '../workflow/baseRef.js';
import { canonicalPath } from '../runtime/pathScope.js';
import { makeManifestGatesFor, type GateRerunDeps } from './ops/fixRerunOps.js';

export interface GateRerunHost {
  readonly store: Store;
  readonly manifest: () => Manifest | undefined;
  /** The host's own gate runner. */
  readonly runProcess: GateProcessRunner;
  /** The ticket's sandbox gate runner, when it has one. */
  readonly gateProcessFor: (ticketId: number) => GateProcessRunner | undefined;
  readonly hostGateFor: (ticketId: number) => (() => GateProcessRunner) | undefined;
  readonly onGateOutput: GateRerunDeps['onGateOutput'];
  readonly onGateSpawned: GateRerunDeps['onGateSpawned'];
  readonly debug: (message: string) => void;
}

/**
 * The host gate re-run dependency set (@arch:AC-45). The three call sites share it, so the re-run
 * gets the gate slot, the host route, the base ref and the live log of a UAT gate (`runGateList`).
 */
export function bindGateRerunDeps(host: GateRerunHost): GateRerunDeps {
  return {
    store: host.store,
    runnerFor: (id) => host.gateProcessFor(id) ?? host.runProcess,
    hostRunner: host.runProcess,
    hostGateFor: (id) => host.hostGateFor(id)?.(),
    sandboxedFor: (id) => host.gateProcessFor(id) !== undefined,
    regenerateFor: (repo) => regenerateOption(host.manifest(), { repo, names: [repo] }).regenerate,
    gatesFor: makeManifestGatesFor({
      store: host.store,
      uat: () => host.manifest()?.uat,
      review: () => host.manifest()?.review,
      namesFor: (repo) => {
        const manifest = host.manifest();
        return manifest ? manifestNamesByPath(manifest).get(canonicalPath(repo)) : undefined;
      },
      debug: host.debug,
    }),
    baseRefFor: (id, repo) => {
      const manifest = host.manifest();
      return manifest ? resolveTicketBaseRef(host.store, id, repo, manifest) : undefined;
    },
    onGateOutput: host.onGateOutput,
    onGateSpawned: host.onGateSpawned,
    debug: host.debug,
  };
}
