/**
 * OpenCode v2 credential readiness — the pure half of karst's pre-launch
 * "no provider signed in" warning.
 *
 * v2 keeps credentials in its OWN store, not in the user's real
 * `~/.local/share/opencode`, because every karst spawn runs under karst-owned
 * XDG dirs (`opencode2Binary.ts`). A store with no credential makes the TUI
 * render `Connect a provider` / `No provider selected` for the session's whole
 * life — a launch that looks alive and can never answer. Nothing karst already
 * probes can see that: the binary is present and the version is in range.
 *
 * `opencode auth list` is the only reader of that store that does not print
 * secrets (`auth export` prints the keys themselves, so it must never be
 * captured). Live-verified on 2.0.27: the EXIT CODE is 0 either way, so the
 * OUTPUT is the whole signal — an empty store prints exactly
 * `No authenticated integrations`, a signed-in one prints a
 * `<integration>  <label>  stored` row per credential.
 */

/** The one command whose output distinguishes an empty store from a signed-in one. */
export const OPENCODE2_AUTH_LIST_ARGS: readonly string[] = ['auth', 'list', '--standalone'];

/** The empty-store line an unauthenticated `auth list` prints (live 2.0.27). */
const NO_CREDENTIALS = /no authenticated integrations/i;

/**
 * True when `auth list --standalone` output shows at least one stored
 * credential. Unreadable output (a blank stream) reads as credentials PRESENT:
 * the caller only has an exit code in that case, and a probe that cannot be
 * read must never become a false "you aren't signed in".
 */
export function opencode2HasCredentials(stdout: string): boolean {
  return !NO_CREDENTIALS.test(stdout);
}
