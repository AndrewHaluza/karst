import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { findTicketById, updateTicketFields } from '../store/tickets.js';
import { resolveTicketByKey } from './resolveTicket.js';
import {
  assertSharedRepoBaseOverrides,
  resolvePlannedBase,
  subtaskParentBranch,
} from '../workflow/baseRef.js';
import {
  changeBaseRef as changeBaseRefWorkflow,
  describeChangeBaseRef,
} from '../workflow/changeBaseRef.js';
import type { GitRunner } from '../integrations/git.js';
import { defaultGitRunner } from '../integrations/git.js';
import type { GhRunner } from '../integrations/github.js';
import { defaultGhRunnerAsync } from '../integrations/github.js';

export interface ParsedBaseArgs {
  action: 'set' | 'reset';
  repo: string;
  baseRef?: string;
  rebase: boolean;
  ticket?: string;
  json: boolean;
}

/**
 * Parse `['base', 'set'|'reset', <repo>, <baseRef>?, ...flags]`.
 */
export function parseBaseArgs(argv: string[]): ParsedBaseArgs {
  const [cmd, action, ...rest] = argv;
  if (cmd !== 'base') {
    throw new Error(`expected 'base' command, got '${cmd ?? ''}'`);
  }
  if (action !== 'set' && action !== 'reset') {
    throw new Error(`unknown base action '${action ?? ''}' (want 'set' or 'reset')`);
  }

  const positional: string[] = [];
  let rebase = false;
  let ticket: string | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--rebase') {
      rebase = true;
    } else if (token === '--no-rebase') {
      rebase = false;
    } else if (token === '--ticket') {
      ticket = rest[++i];
      if (ticket === undefined) throw new Error('karst base: --ticket needs a value');
    } else if (token === '--json') {
      json = true;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown flag '${token}'`);
    } else {
      positional.push(token);
    }
  }

  const repo = positional[0];
  if (!repo || repo.trim() === '') {
    throw new Error(
      action === 'set'
        ? 'missing <repo> (usage: karst base set <repo> <baseRef> [--rebase] [--ticket <key>])'
        : 'missing <repo> (usage: karst base reset <repo> [--rebase] [--ticket <key>])',
    );
  }

  let baseRef: string | undefined;
  if (action === 'set') {
    baseRef = positional[1];
    if (!baseRef || baseRef.trim() === '') {
      throw new Error('missing <baseRef> (usage: karst base set <repo> <baseRef> [--rebase] [--ticket <key>])');
    }
  }

  return {
    action,
    repo: repo.trim(),
    baseRef: baseRef?.trim(),
    rebase,
    ticket,
    json,
  };
}

export interface RunBaseOptions {
  ticket?: string;
  projectSlug?: string;
  sessionTicketKey?: string;
  git?: GitRunner;
  gh?: GhRunner;
  debug?: (message: string) => void;
}

/**
 * Execute `karst base set` or `karst base reset`.
 */
export async function runBaseCommand(
  store: Store,
  manifest: Manifest | undefined,
  argv: string[],
  opts: RunBaseOptions = {},
): Promise<string> {
  const parsed = parseBaseArgs(argv);
  const targetKey = parsed.ticket ?? opts.ticket ?? opts.sessionTicketKey;
  if (!targetKey) {
    throw new Error('missing --ticket <key>');
  }

  const target = resolveTicketByKey(store, targetKey, opts.projectSlug);
  if (!target) {
    throw new Error(`no ticket found for key or id '${targetKey}'`);
  }

  // Session permission check: a session may only change base for its own ticket or its direct sub-tasks
  if (opts.sessionTicketKey) {
    const sessionTicket = resolveTicketByKey(store, opts.sessionTicketKey, opts.projectSlug);
    if (sessionTicket) {
      const isOwn = target.id === sessionTicket.id;
      const isDirectSubtask = target.subtaskParentId === sessionTicket.id;
      if (!isOwn && !isDirectSubtask) {
        throw new Error(
          `Permission denied: session ticket '${opts.sessionTicketKey}' cannot change base for ticket '${targetKey}' (allowed scope: own ticket or direct sub-tasks)`,
        );
      }
    }
  }

  // Resolve repository name and repoPath
  let repoKey = parsed.repo;
  let repoPath = parsed.repo;

  if (manifest?.repositories) {
    if (manifest.repositories[parsed.repo]) {
      repoKey = parsed.repo;
      repoPath = manifest.repositories[parsed.repo]!.repoPath;
    } else {
      const foundEntry = Object.entries(manifest.repositories).find(
        ([, r]) => r.repoPath === parsed.repo,
      );
      if (foundEntry) {
        repoKey = foundEntry[0];
        repoPath = foundEntry[1].repoPath;
      }
    }
  }

  // Check if worktree exists for this ticket
  const worktreeRow = store.db
    .prepare('SELECT path, base_ref FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(target.id, repoPath) as { path: string; base_ref: string | null } | undefined;

  const isPostSpin = worktreeRow !== undefined;

  if (!isPostSpin) {
    // PRE-SPIN: write tickets.base_refs
    if (parsed.action === 'set') {
      const nextBaseRefs = { ...(target.baseRefs ?? {}) };
      nextBaseRefs[repoKey] = parsed.baseRef!;
      if (repoPath !== repoKey) {
        nextBaseRefs[repoPath] = parsed.baseRef!;
      }
      if (manifest) {
        assertSharedRepoBaseOverrides(manifest, nextBaseRefs);
      }
      updateTicketFields(store, target.id, { baseRefs: nextBaseRefs });
      if (parsed.json) {
        return JSON.stringify({
          ok: true,
          ticketId: target.id,
          repo: repoKey,
          baseRef: parsed.baseRef!,
          preSpin: true,
        });
      }
      return `Base branch for ${repoKey} set to ${parsed.baseRef!}.`;
    } else {
      // reset
      const nextBaseRefs = { ...(target.baseRefs ?? {}) };
      delete nextBaseRefs[repoKey];
      if (repoPath !== repoKey) {
        delete nextBaseRefs[repoPath];
      }
      updateTicketFields(store, target.id, { baseRefs: nextBaseRefs });
      if (parsed.json) {
        return JSON.stringify({
          ok: true,
          ticketId: target.id,
          repo: repoKey,
          preSpin: true,
          reset: true,
        });
      }
      return `Base branch for ${repoKey} reset to default.`;
    }
  }

  // POST-SPIN: live changeBaseRef
  const git = opts.git ?? defaultGitRunner;
  const gh = opts.gh ?? defaultGhRunnerAsync;
  if (!manifest) {
    throw new Error('karst base: a manifest is required to change the base of a live worktree');
  }
  const effectiveManifest = manifest;

  if (parsed.action === 'set') {
    // Record in tickets.base_refs too
    const nextBaseRefs = { ...(target.baseRefs ?? {}) };
    nextBaseRefs[repoKey] = parsed.baseRef!;
    if (repoPath !== repoKey) {
      nextBaseRefs[repoPath] = parsed.baseRef!;
    }
    assertSharedRepoBaseOverrides(manifest, nextBaseRefs);

    const result = await changeBaseRefWorkflow({
      store,
      manifest: effectiveManifest,
      ticketId: target.id,
      repoPath,
      toBase: parsed.baseRef!,
      rebase: parsed.rebase,
      git,
      gh,
      debug: opts.debug,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // Persist the override only once git agreed: a refused rebase must not leave
    // a stored base the worktree never reached.
    updateTicketFields(store, target.id, { baseRefs: nextBaseRefs });
    const message = describeChangeBaseRef(result);
    if (parsed.json) {
      return JSON.stringify({ ...result, message });
    }
    return message;
  } else {
    // reset
    const nextBaseRefs = { ...(target.baseRefs ?? {}) };
    delete nextBaseRefs[repoKey];
    if (repoPath !== repoKey) {
      delete nextBaseRefs[repoPath];
    }

    const parentBranch =
      target.subtaskParentId !== null
        ? subtaskParentBranch(store, target, manifest, repoKey)
        : null;
    const toBase = resolvePlannedBase(
      { subtaskParentId: target.subtaskParentId, baseRefs: {} },
      manifest,
      repoKey,
      parentBranch,
    ).baseRef;

    const result = await changeBaseRefWorkflow({
      store,
      manifest: effectiveManifest,
      ticketId: target.id,
      repoPath,
      toBase,
      rebase: parsed.rebase,
      git,
      gh,
      debug: opts.debug,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // Persist the override only once git agreed: a refused rebase must not leave
    // a stored base the worktree never reached.
    updateTicketFields(store, target.id, { baseRefs: nextBaseRefs });
    const message = describeChangeBaseRef(result);
    if (parsed.json) {
      return JSON.stringify({ ...result, message });
    }
    return message;
  }
}
