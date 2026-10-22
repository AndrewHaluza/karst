/**
 * Detects a Tester run that ended its turn while a command it started was still
 * running in the core's background shell (T722, T690). Such a run answered `[]`
 * before its own probe produced evidence, so it must read as PARTIAL, never as
 * a clean "observed nothing". Pure; core-neutral by marker list.
 */

/** Per-core transcript markers for "command moved to the background". */
const BACKGROUND_MARKERS: readonly RegExp[] = [
  // opencode / opencode2: "Command moved to the background (shell ID: sh_abc)"
  /Command moved to the background \(shell ID:\s*([^)\s]*)\s*\)/g,
];

export const BACKGROUND_ENDED_DETAIL = 'tester ended while a background command was still running';

/**
 * True when the LAST backgrounded command is never mentioned again after its
 * marker line — no output read, no kill, no wait — so the answer ended on it.
 * A shell whose id reappears later (output polled, killed) counts as settled.
 */
export function endedOnBackgroundCommand(transcript: string): boolean {
  let last: { end: number; id: string } | null = null;
  for (const marker of BACKGROUND_MARKERS) {
    for (const m of transcript.matchAll(new RegExp(marker.source, marker.flags))) {
      const end = (m.index ?? 0) + m[0].length;
      if (last === null || end > last.end) last = { end, id: m[1] ?? '' };
    }
  }
  if (last === null) return false;
  const rest = transcript.slice(last.end);
  return last.id === '' || !rest.includes(last.id);
}
