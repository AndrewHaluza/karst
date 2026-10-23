/**
 * The two decisions behind a "Resolve conflicts" click, shared by the ticket
 * dashboard and the sidebar mini-dashboard. Both are host-agnostic: the caller
 * injects the store-backed brief, the session seams and the vscode toast.
 */

/**
 * Pick the brief for this click and either decline it or deliver it.
 *
 * Async because the environment comes from the runners' LISTING, not from a
 * path helper: `bridgeOf` names a bridge path for every ticket whenever the
 * bridge root exists, which handed host tickets (T758, T765) the sandbox brief.
 * A listing that cannot answer (no CLI, `ENOENT` as 127, a failed listing, a
 * rejected probe) still reads as "no sandbox" here; arch:AC-39 makes it
 * tri-state.
 *
 * The STORE decides whether the conflict still exists — `repo` arrived in a
 * webview message, and a stale panel can name one that has since gone, so a
 * null brief is a message to the user, never a generic session.
 */
export interface ResolveConflictInput {
  /** The repo the click named; passed through untouched. */
  readonly repo: string;
  /** The ticket label for the "nothing to resolve" message. */
  readonly label: string;
  readonly hasSandbox: () => Promise<boolean | undefined>;
  readonly briefFor: (sandboxed: boolean) => string | null;
  readonly notify: (message: string) => void;
  readonly deliver: (brief: string, repo: string) => void;
}

export async function resolveConflictClick(input: ResolveConflictInput): Promise<void> {
  // A probe that REJECTS is the same case as one that answers `undefined`: the
  // listing could not say, so it reads as "no sandbox". Without the catch the
  // rejection escaped (both call sites start the click with `void`): no brief,
  // no session, no toast, only an unhandled rejection in the host log.
  const sandboxed = (await input.hasSandbox().catch(() => undefined)) ?? false;
  const brief = input.briefFor(sandboxed);
  if (brief === null) {
    input.notify(
      `No merge conflict is recorded for "${input.repo}" on ticket ${input.label} — nothing to resolve.`,
    );
    return;
  }
  input.deliver(brief, input.repo);
}

/**
 * Deliver a prompt to the ticket's session, live or not: nudge the open
 * terminal, else launch one seeded with it. A conflict brief handed to
 * `openSession` alone would be dropped whenever a session is already up —
 * `openSession` only focuses an existing terminal.
 *
 * A graph ticket is never nudged from here: the graph coordinator owns its
 * sessions (entry-point matrix, Slice 3 Task 7).
 */
export interface SessionHandOffDeps {
  readonly isGraphTicket: () => boolean;
  readonly nudge: (prompt: string) => boolean;
  readonly focus: () => void;
  readonly open: (seedPrompt: string, seedRepo: string) => void;
}

export function makeSessionHandOff(
  deps: SessionHandOffDeps,
): (prompt: string, repo: string) => void {
  return (prompt, repo) => {
    if (deps.isGraphTicket()) return;
    if (deps.nudge(prompt)) {
      deps.focus();
      return;
    }
    deps.open(prompt, repo);
  };
}
