import type { ProcessResult, SbxProcess } from './sbxProcess.js';

/** One `sbx ls` row: the name and whether the sandbox is running. */
export interface SbxListEntry {
  readonly name: string;
  readonly running: boolean;
}

const RUNNING = /\brunning\b/i;

/** `● running` → true, `stopped`/`exited`/a bare glyph → false. */
function statusSaysRunning(status: string): boolean {
  return RUNNING.test(status);
}

/**
 * Parse `sbx ls --json`. `undefined` means "not JSON we understand", so the
 * caller falls back to the human table. The real tool prints an array; a
 * wrapping object is accepted defensively because the field names are the
 * stable part (name, status), not the envelope.
 */
function parseSbxJson(stdout: string): SbxListEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { sandboxes?: unknown }).sandboxes)
      ? (parsed as { sandboxes: unknown[] }).sandboxes
      : undefined;
  if (rows === undefined) return undefined;
  const entries: SbxListEntry[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { name?: unknown; status?: unknown; state?: unknown };
    if (typeof r.name !== 'string' || r.name === '') continue;
    const status = typeof r.status === 'string' ? r.status : typeof r.state === 'string' ? r.state : '';
    entries.push({ name: r.name, running: statusSaysRunning(status) });
  }
  return entries;
}

/** Parse the human table (`SANDBOX AGENT STATUS`), dropping the header and tolerating a leading status glyph (`● running`). */
function parseSbxTable(stdout: string): SbxListEntry[] {
  const entries: SbxListEntry[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const cells = line.trim().split(/\s+/);
    const name = cells[0];
    if (!name || name === '') continue;
    // The status is the last cell; older layouts put the agent between name and status. `●` is a separate cell.
    const status = cells.slice(1).find((c) => /running|stopped|exited|paused|created|dead/i.test(c)) ?? cells.at(-1) ?? '';
    entries.push({ name, running: statusSaysRunning(status) });
  }
  return entries;
}

/** `sbx ls` entries from the machine JSON when the tool answers it, else the human table (with a leading status glyph). */
export function parseSbxList(stdout: string): SbxListEntry[] {
  return parseSbxJson(stdout) ?? parseSbxTable(stdout);
}

/** `sbx ls` names, in listing order: JSON when available, else the table's first column. */
export function parseNames(stdout: string): string[] {
  return parseSbxList(stdout).map((e) => e.name);
}

/** `sbx ls --json`, falling back to the table when the flag is unsupported or the call fails. */
export async function listSbx(proc: SbxProcess): Promise<ProcessResult & { readonly entries: readonly SbxListEntry[] }> {
  const json = await proc.run('sbx', ['ls', '--json']);
  if (json.code === 0) return { ...json, entries: parseSbxList(json.stdout) };
  // 127 = the binary is not on the PATH: the table call cannot answer either.
  if (json.code === 127) return { ...json, entries: [] };
  const table = await proc.run('sbx', ['ls']);
  return { ...table, entries: table.code === 0 ? parseSbxTable(table.stdout) : [] };
}
