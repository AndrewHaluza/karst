import type { AgentProvider } from '../../manifest/types.js';
import type { AsyncOutputProbe } from '../../runtime/depsAsync.js';
import {
  opencode2BinaryPath,
  opencode2Config,
  opencode2IsolationEnv,
} from '../../agent/opencode2Binary.js';
import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from '../../agent/opencode2Auth.js';

/**
 * The pre-launch "no provider signed in" warning for an OpenCode v2 session.
 *
 * Karst runs every v2 spawn under its OWN XDG dirs, so the credentials the user
 * gave their personal OpenCode install are invisible to a karst session. With an
 * empty store the v2 TUI renders `No provider selected` and the session can
 * never answer — the binary probe and the version check both pass, so nothing
 * upstream catches it. This warns at the one moment the user can still act.
 *
 * `vscode` is never imported here (see `ratchet.test.ts`): the probe, the
 * warning-with-actions, and the login command are all injected.
 */

/**
 * The message. Names the palette title the user runs (`package.json`), not the
 * terminal's own name, and says what the session will show — the symptom the
 * user actually sees.
 */
export const OPENCODE2_AUTH_WARNING =
  'Karst: OpenCode v2 has no provider signed in — the session opens with ' +
  '"No provider selected". Sign in with \'Karst: Log in to OpenCode v2\'.';

export interface Opencode2AuthWarningDeps {
  /** The provider this ticket's session will launch under. */
  provider: AgentProvider;
  /** Captures `<binary> <args>` output without blocking the host. */
  probe: AsyncOutputProbe;
  /** Awaitable warning carrying actions; resolves to the chosen label, or undefined. */
  choose: (message: string, ...buttons: string[]) => Promise<string | undefined>;
  /** Opens the login terminal (the registered `karst.opencode2.login` command). */
  logIn: () => Promise<void> | void;
  debug?: (message: string) => void;
}

/**
 * True when the launch should continue. A warning only: a dismissal or an
 * explicit "Launch anyway" proceeds, and an undetermined probe never blocks —
 * the cost of a false "you aren't signed in" would be refusing every opencode2
 * session on a machine that is signed in via the environment.
 */
export async function warnOpencode2AuthIfUnset(
  deps: Opencode2AuthWarningDeps,
): Promise<boolean> {
  if (deps.provider !== 'opencode2') return true;
  const binary = opencode2BinaryPath();
  // Unset is not this check's business: the capability guard already refuses
  // and names `karst.opencode2.binaryPath`.
  if (!binary) return true;
  const env = opencode2IsolationEnv(opencode2Config().home);
  const { stdout, exitCode } = await deps.probe(binary, OPENCODE2_AUTH_LIST_ARGS, env);
  if (exitCode !== 0) {
    deps.debug?.(
      `[agent:opencode2] auth list probe failed (exit ${exitCode}) — not warning`,
    );
    return true;
  }
  if (opencode2HasCredentials(stdout)) return true;
  const choice = await deps.choose(OPENCODE2_AUTH_WARNING, 'Log in', 'Launch anyway');
  if (choice !== 'Log in') return true;
  await deps.logIn();
  return false;
}
