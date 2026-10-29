import { isHttpUrl } from '../shared/url.js';
import { validateInsideProgressEvent, type InsideProgressEvent } from '../../model/inside/progress.js';
import { isKnownProvider } from '../../agent/provider.js';
import type { WebviewMessage } from './messages.js';

import {
  isAgentProcessId, isFiniteNumber, isStageKey, isGateStage, storedPath, storedSha,
  MAX_GATE_NAME_CHARS, MAX_ENV_TEXT_CHARS, MAX_ACTION_ID_CHARS, MAX_ARTIFACT_ID_CHARS, MAX_BASELINE_INDICES,
  BASELINE_BLOCK_ID, MAX_BASELINE_REASON_CHARS, MAX_MODEL_ID_CHARS, MAX_GATE_ATTEMPT_KEY_CHARS, MAX_REPO_PATH_CHARS,
} from './messageValidate.js';
/**
 * Narrow an untrusted webview message to a `WebviewMessage`, validating BOTH the
 * discriminant and its companion field's type — the webview is a trust boundary,
 * so `serverId` must be a number and `path`/`url` must be strings before they
 * reach `Uri.file`/`Uri.parse`/`executeCommand`. `url` must also be http(s), so
 * a crafted `file://`/other-scheme message can't drive `openExternal`. Returns
 * null for anything malformed.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const num = typeof m.serverId === 'number' && Number.isFinite(m.serverId);
  const path = typeof m.path === 'string' && m.path.length > 0;
  const branch = typeof m.branch === 'string' && m.branch.length > 0;
  switch (m.type) {
    case 'stop-server':
      return num ? { type: 'stop-server', serverId: m.serverId as number } : null;
    case 'restart-server':
      return num ? { type: 'restart-server', serverId: m.serverId as number } : null;
    case 'start-server':
      return num ? { type: 'start-server', serverId: m.serverId as number } : null;
    case 'open-server':
      return num ? { type: 'open-server', serverId: m.serverId as number } : null;
    case 'copy-server-url':
      return num ? { type: 'copy-server-url', serverId: m.serverId as number } : null;
    case 'spin-servers':
      return { type: 'spin-servers' };
    // Panel-level: no payload is read, so a stray `serverId` is dropped rather
    // than reshaped — these must never degrade into their per-row namesakes.
    case 'restart-servers':
      return { type: 'restart-servers' };
    case 'stop-servers':
      return { type: 'stop-servers' };
    case 'open-resources':
      return { type: 'open-resources' };
    case 'sandbox-sync':
    case 'sandbox-diff':
    case 'sandbox-stop':
    case 'sandbox-remove':
    case 'sandbox-carry':
    case 'sandbox-stash-update':
      return { type: m.type };
    case 'show-changes':
      return { type: 'show-changes' };
    case 'open-worktree-terminal':
      return path ? { type: 'open-worktree-terminal', path: m.path as string } : null;
    case 'open-worktree-folder':
      return path ? { type: 'open-worktree-folder', path: m.path as string } : null;
    case 'copy-worktree-branch':
      return branch ? { type: 'copy-worktree-branch', branch: m.branch as string } : null;
    case 'launch-worktree-extension':
      return path ? { type: 'launch-worktree-extension', path: m.path as string } : null;
    case 'open-pr':
      return isHttpUrl(m.url) ? { type: 'open-pr', url: m.url } : null;
    case 'copy-pr-url':
      return isHttpUrl(m.url) ? { type: 'copy-pr-url', url: m.url } : null;
    case 'open-ticket-link':
      return isHttpUrl(m.url) ? { type: 'open-ticket-link', url: m.url } : null;
    case 'edit-ticket':
      return { type: 'edit-ticket' };
    case 'open-dependency':
      return typeof m.ticketId === 'number' && Number.isInteger(m.ticketId) && m.ticketId > 0
        ? { type: 'open-dependency', ticketId: m.ticketId } : null;
    case 'stop-driver':
      return { type: 'stop-driver' };
    case 'ship-ticket':
      return { type: 'ship-ticket' };
    case 'resume-ticket':
      return { type: 'resume-ticket' };
    case 'pause-execution':
      return { type: 'pause-execution' };
    case 'unpause-execution':
      return { type: 'unpause-execution' };
    // Payload-free like the panel-level server controls: a companion field is
    // dropped, so the recovery can only ever move the ticket the panel owns.
    case 'send-back-to-implement':
      return { type: 'send-back-to-implement' };
    case 'reset-stage':
      return { type: 'reset-stage' };
    // Review-stall answers (T845): payload-free like reset-stage — the host
    // derives the ticket and re-checks the stall itself.
    case 'review-stall-hint':
      return { type: 'review-stall-hint' };
    case 'review-stall-continue':
      return { type: 'review-stall-continue' };
    case 'review-stall-rescope':
      return { type: 'review-stall-rescope' };
    case 'address-pr-feedback':
      return { type: 'address-pr-feedback' };
    case 'send-ci-failure':
      return { type: 'send-ci-failure' };
    case 'rebase-on-base':
      return { type: 'rebase-on-base' };
    case 'deliver-to-pr':
      return { type: 'deliver-to-pr' };
    case 'create-follow-up-ticket':
      return { type: 'create-follow-up-ticket' };
    case 'create-subtask':
      return { type: 'create-subtask' };
    case 'detach-subtask':
      return { type: 'detach-subtask' };
    case 'close-ticket':
      return { type: 'close-ticket' };
    case 'reopen-ticket':
      return { type: 'reopen-ticket' };
    case 'open-stage-log':
      return isStageKey(m.stageKey) ? { type: 'open-stage-log', stageKey: m.stageKey } : null;
    case 'resolve-conflicts':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'resolve-conflicts', repo: m.repo }
        : null;
    // A companion `method` is DROPPED, not honored: how to merge is the host's
    // question to the user, never the webview's to answer.
    case 'merge-pr':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'merge-pr', repo: m.repo }
        : null;
    // Narrowed exactly like `merge-pr`: the repo is the entire payload (typed,
    // non-empty, never trimmed — a path is not free text), and everything else
    // about the action is the host's to decide.
    case 'dismiss-pr':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'dismiss-pr', repo: m.repo }
        : null;
    case 'undismiss-pr':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'undismiss-pr', repo: m.repo }
        : null;
    // Payload-free like the panel-level server controls: a companion `repo` or
    // ticket id is dropped, so the refresh can only ever re-probe the ticket the
    // host already opened this panel for.
    case 'refresh-prs':
      return { type: 'refresh-prs' };
    // Payload-free for the same reason as `refresh-prs`: the host re-reads the
    // ticket it already opened this panel for.
    case 'refresh-ship-preview':
      return { type: 'refresh-ship-preview' };
    // Payload-free like the panel-level server controls: a companion `enabled`
    // is dropped rather than honored, so the host's value stays authoritative.
    case 'toggle-bind':
      return { type: 'toggle-bind' };
    // The selection is re-validated host-side (isKnownProvider + model-choice
    // membership) before anything is confirmed or persisted, so the webview's
    // draft is a suggestion, never authority — but the two fields still pass
    // the trust boundary typed and bounded.
    case 'switch-agent': {
      const provider = typeof m.provider === 'string' ? m.provider : '';
      if (!isKnownProvider(provider)) return null;
      // A missing/blank model means "inherit"; a NON-string model drops the
      // whole message rather than being coerced to a value the webview never
      // offered.
      const model = m.model == null ? '' : (typeof m.model === 'string' ? m.model : null);
      if (model === null) return null;
      if (model.length > MAX_MODEL_ID_CHARS) return null;
      // Same contract for the effort/variant: absent/blank = inherit; a
      // non-string or oversized value drops the whole message.
      const effort = m.effort == null ? '' : (typeof m.effort === 'string' ? m.effort : null);
      if (effort === null) return null;
      if (effort.length > MAX_MODEL_ID_CHARS) return null;
      return { type: 'switch-agent', provider, model: model || null, effort: effort || null };
    }
    case 'copy-ticket-key':
      return { type: 'copy-ticket-key' };
    // Both fields are required and typed here, at the boundary — a missing or
    // malformed one drops the whole message rather than resuming with a
    // guessed ticket or an invalid stage.
    case 'stage-resume':
      return isFiniteNumber(m.ticketId) && isStageKey(m.stageKey)
        ? { type: 'stage-resume', ticketId: m.ticketId as number, stageKey: m.stageKey }
        : null;
    case 'usage-limit-pick':
      return isFiniteNumber(m.ticketId) && isStageKey(m.stageKey)
        ? { type: 'usage-limit-pick', ticketId: m.ticketId as number, stageKey: m.stageKey }
        : null;
    case 'usage-limit-retry':
      return isFiniteNumber(m.ticketId) && isStageKey(m.stageKey)
        ? { type: 'usage-limit-retry', ticketId: m.ticketId as number, stageKey: m.stageKey }
        : null;
    case 'usage-limit-dismiss':
      return isFiniteNumber(m.ticketId) && isStageKey(m.stageKey)
        ? { type: 'usage-limit-dismiss', ticketId: m.ticketId as number, stageKey: m.stageKey }
        : null;
    // Every field is required and typed here, at the trust boundary: `stage` is
    // narrowed to the closed `GATE_STAGES` set, and a blank or oversized name
    // drops the whole message rather than reaching a store write.
    //
    // The name itself is stored VERBATIM — it is deliberately not checked
    // against the resolved gate list. Resolution matches by exact name
    // (`partitionDisabled`), so a name that no gate carries disables nothing;
    // and a gate renamed in karst.yml must keep its stored entry rather than
    // have it silently dropped, or renaming it back would lose the user's
    // choice. Bounded, inert, and recoverable beats validated-and-forgotten.
    case 'set-disabled-gates': {
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      return isGateStage(m.stage) &&
        name.length > 0 &&
        name.length <= MAX_GATE_NAME_CHARS &&
        typeof m.disabled === 'boolean'
        ? { type: 'set-disabled-gates', stage: m.stage, name, disabled: m.disabled }
        : null;
    }
    case 'inside-action': {
      // CLOSED message: `type` + `actionId` (+ an optional `requestId` the
      // panel's readRequestId validates separately) and NOTHING else. Any
      // other companion field — a forged kind, repo, path, PR number or SHA —
      // drops the whole message rather than being ignored: a legacy-shaped
      // target-bearing payload is rejected, never downgraded to an id lookup.
      const extra = Object.keys(m).filter(
        (k) => k !== 'type' && k !== 'actionId' && k !== 'requestId',
      );
      if (extra.length > 0) return null;
      const actionId = typeof m.actionId === 'string' ? m.actionId : '';
      if (actionId.length === 0 || actionId.length > MAX_ACTION_ID_CHARS) return null;
      if (!/^[A-Za-z0-9:_-]+$/.test(actionId)) return null;
      return { type: 'inside-action', actionId };
    }
    case 'artifact-open-resource': {
      // The id names an ARTIFACT (a bounded kind id), the index a RESOURCE of
      // that artifact — never a path or URL. Both are validated here, at the
      // boundary; the host re-derives the artifacts and resolves both against
      // them before opening anything, so a crafted message cannot aim the
      // editor at an arbitrary file.
      const artifactId = typeof m.artifactId === 'string' ? m.artifactId : '';
      if (artifactId.length === 0 || artifactId.length > MAX_ARTIFACT_ID_CHARS) return null;
      if (!/^[a-z0-9-]+$/.test(artifactId)) return null;
      if (!Number.isInteger(m.index) || (m.index as number) < 0) return null;
      return { type: 'artifact-open-resource', artifactId, index: m.index as number };
    }
    case 'stored-artifact-open': {
      const path = storedPath(m.path);
      const sha = storedSha(m.sha);
      return path && sha ? { type: 'stored-artifact-open', path, sha } : null;
    }
    case 'stored-artifact-diff': {
      const path = storedPath(m.path);
      const from = storedSha(m.from);
      const to = storedSha(m.to);
      return path && from && to ? { type: 'stored-artifact-diff', path, from, to } : null;
    }
    case 'stored-artifact-live': {
      const path = storedPath(m.path);
      return path ? { type: 'stored-artifact-live', path } : null;
    }
    case 'stored-artifact-reveal':
      return { type: 'stored-artifact-reveal' };
    case 'stored-artifact-purge':
      return { type: 'stored-artifact-purge' };
    case 'baseline-approve': {
      if (m.blockId !== BASELINE_BLOCK_ID) return null;
      const indices = m.indices;
      if (!Array.isArray(indices) || indices.length === 0 || indices.length > MAX_BASELINE_INDICES) return null;
      if (!indices.every((i) => Number.isInteger(i) && (i as number) >= 0)) return null;
      return { type: 'baseline-approve', blockId: BASELINE_BLOCK_ID, indices: indices as number[] };
    }
    case 'baseline-reject': {
      if (m.blockId !== BASELINE_BLOCK_ID) return null;
      if (!Number.isInteger(m.index) || (m.index as number) < 0) return null;
      // Bounded at the boundary; the host trims and treats blank as missing.
      if (typeof m.reason !== 'string' || m.reason.length > MAX_BASELINE_REASON_CHARS) return null;
      return { type: 'baseline-reject', blockId: BASELINE_BLOCK_ID, index: m.index as number, reason: m.reason };
    }
    // The stage is narrowed to GATE_STAGES here, at the trust boundary; a
    // non-gate stage (or a malformed payload) drops the whole message.
    case 'stage-log-request':
      return isGateStage(m.stage) ? { type: 'stage-log-request', stage: m.stage } : null;
    // The process is narrowed to the closed AgentProcessId set; anything else
    // drops the whole message.
    case 'agent-log-request':
      return isAgentProcessId(m.processId)
        ? { type: 'agent-log-request', processId: m.processId }
        : null;
    // The stage is narrowed to GATE_STAGES; the key is a bounded, non-empty
    // string — no coercion. The host re-resolves both against the ticket's
    // actual attempt history before rendering anything.
    case 'select-gate-attempt': {
      const key = typeof m.key === 'string' ? m.key : '';
      return isGateStage(m.stage) && key.length > 0 && key.length <= MAX_GATE_ATTEMPT_KEY_CHARS
        ? { type: 'select-gate-attempt', stage: m.stage, key }
        : null;
    }
    // The stage is narrowed to GATE_STAGES. `repo` is a recorded repo value
    // (a path), typed and non-empty, matched the way `change-base-ref` matches
    // its own repo — never trimmed, because a path is not free text. An
    // explicit `null` is the "all repositories" reset and is the ONLY
    // non-string this accepts. The host re-resolves the value against the
    // batch it is about to render.
    case 'select-findings-repo': {
      if (!isGateStage(m.stage)) return null;
      if (m.repo === null) return { type: 'select-findings-repo', stage: m.stage, repo: null };
      const repo = typeof m.repo === 'string' ? m.repo : '';
      return repo.length > 0 && repo.length <= MAX_REPO_PATH_CHARS
        ? { type: 'select-findings-repo', stage: m.stage, repo }
        : null;
    }
    // `repo` is the worktree's repoPath, matched like `resolve-conflicts`/
    // `merge-pr` (typed, non-empty, never trimmed — a path is not free text).
    // `baseRef` IS trimmed and must be non-blank: a blank base names nothing
    // to change to. `rebase` defaults ON when absent — the safe reading of a
    // missing switch (see the type's own doc).
    case 'change-base-ref': {
      const repo = typeof m.repo === 'string' ? m.repo : '';
      const baseRef = typeof m.baseRef === 'string' ? m.baseRef.trim() : '';
      if (repo.length === 0 || baseRef.length === 0) return null;
      return { type: 'change-base-ref', repo, baseRef, rebase: m.rebase !== false };
    }
    case 'rerun-gate':
      return isGateStage(m.stage) ? { type: 'rerun-gate', stage: m.stage } : null;
    case 'server-logs-request':
      return { type: 'server-logs-request' };
    case 'server-logs-close':
      return { type: 'server-logs-close' };
    case 'server-logs-detach':
      return { type: 'server-logs-detach' };
    case 'xterm-request':
      return { type: 'xterm-request' };
    case 'server-logs-tab': {
      const tab = typeof m.tab === 'string' ? m.tab : '';
      return tab.length > 0 && tab.length <= MAX_GATE_NAME_CHARS
        ? { type: 'server-logs-tab', tab }
        : null;
    }
    // The scope is a manifest repository name (or `*`) and the body is
    // `.env`-shaped text, both bounded here. Neither is trimmed into meaning:
    // an empty body is the legitimate way to CLEAR a scope, and the host still
    // checks the scope against the ticket's own repositories before writing.
    case 'env-overrides-save': {
      const scope = typeof m.scope === 'string' ? m.scope : '';
      const text = typeof m.text === 'string' ? m.text : '';
      if (scope.length === 0 || scope.length > MAX_GATE_NAME_CHARS) return null;
      if (text.length > MAX_ENV_TEXT_CHARS) return null;
      return { type: 'env-overrides-save', scope, text };
    }
    default:
      return null;
  }
}

/**
 * Narrow an untrusted host→webview inside-progress payload to a closed
 * `InsideProgressEvent`, validating the discriminant/status combinations in
 * one place (the webview is a trust boundary in both directions: a host bug
 * must not ship an event the renderer cannot handle). The webview's own
 * renderer switch can therefore meet only known shapes.
 */
export function parseInsideProgress(raw: unknown): InsideProgressEvent | null {
  return validateInsideProgressEvent(raw);
}
