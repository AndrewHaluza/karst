/**
 * The quoting boundary for every remote SSH command (D554, Part A.3).
 *
 * The remote command is ONE string built only from `sshQuote`d parts and fixed
 * literals. Nothing is interpolated bare: a host or path that reaches the
 * remote shell has already been through `sshQuote`, so `'`, `$(...)`, `;`,
 * backticks and a leading `-` are inert.
 */

/**
 * POSIX single-quote escape: `'` becomes `'\''` (close, escaped quote, reopen).
 * Inside the single quotes the shell expands nothing — no `$`, no backtick,
 * no backslash escaping, no newline splitting.
 */
export function sshQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/**
 * Run a remote script under `sh`, not under the remote user's login shell:
 * that shell can be fish or csh, so a bare script breaks (Part A.4). sshd
 * still hands `sh -c '<script>'` to the login shell as one command, and `sh`
 * is what parses it.
 */
export function remoteSh(script: string): string {
  return `sh -c ${sshQuote(script)}`;
}
