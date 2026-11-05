/** Runs in the sandbox: the kernel's OOM-kill lines (no guest swap, so the guest kills at the limit instead of slowing down). */
export const OOM_LOG = ['sh', '-c', "dmesg 2>&1 | grep -i 'killed process' | tail -n 5"] as const;

/** How long the best-effort dmesg lookup may take; the sandbox may be dead or wedged. */
export const OOM_LOOKUP_TIMEOUT_MS = 8000;

/** The process name of the LAST `Killed process <pid> (<name>)` line, or null when the log has none. */
export function parseKilledProcess(dmesg: string): string | null {
  let name: string | null = null;
  for (const m of dmesg.matchAll(/killed process \d+ \(([^)]+)\)/gi)) name = m[1] ?? null;
  return name;
}

/**
 * The OOM notice for an exit-137 sbx session. `killed` is null when dmesg could not be read (a SIGKILL from the host
 * or a dead VM); the message is still an out-of-memory report, never the generic launch failure.
 */
export function oomMessage(sandbox: string, limit: string | undefined, killed: string | null): string {
  const ceiling = limit ? ` (limit ${limit.replace(/g$/i, ' GB').replace(/m$/i, ' MB')})` : '';
  const what = killed ? `: killed ${killed}` : '';
  return `Sandbox ${sandbox} ran out of memory${ceiling}${what}. Raise sandboxMemory.sbxMemory in the manifest or run fewer sandboxes at once.`;
}
