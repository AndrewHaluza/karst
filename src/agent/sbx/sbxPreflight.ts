import type { ProcessResult, SbxProcess } from './sbxProcess.js';
import { listSbx } from './sbxList.js';

export { parseNames } from './sbxList.js';

export const SBX_BIN = 'sbx';

export type SbxPreflight =
  | { readonly ok: true; readonly existing: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const NOT_SIGNED_IN = /not signed in/i;

/**
 * Can this host run an sbx session right now? Checked in order: binary, version,
 * signed in, network policy. Each failure is one actionable reason; nothing here
 * throws, so a broken sbx always resolves to "host, because …" (arch:AC-31).
 * `existing` (the `sbx ls` names) lets the runner pick create vs reattach while
 * staying synchronous.
 */
export async function sbxPreflight(proc: SbxProcess): Promise<SbxPreflight> {
  try {
    const version = await proc.run(SBX_BIN, ['version']);
    if (version.code === 127) return fail('sbx not installed (not on PATH)');
    if (version.code !== 0) return fail(`sbx version failed: ${detail(version)}`);
    // `--json` is the stable machine listing; the table is the fallback when the
    // flag is unsupported or the call itself fails (including "not signed in").
    const ls = await listSbx(proc);
    if (NOT_SIGNED_IN.test(ls.stdout + ls.stderr)) return fail('sbx not signed in (run `sbx login`)');
    if (ls.code !== 0) return fail(`sbx ls failed: ${detail(ls)}`);
    const policy = await proc.run(SBX_BIN, ['policy', 'ls']);
    if (policy.code !== 0 || policy.stdout.trim() === '') {
      return fail('sbx has no network policy (run `sbx policy init`)');
    }
    return { ok: true, existing: ls.entries.map((e) => e.name) };
  } catch (err) {
    return fail(`sbx preflight failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(reason: string): SbxPreflight {
  return { ok: false, reason };
}

function detail(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n')[0]!.slice(0, 200);
}
