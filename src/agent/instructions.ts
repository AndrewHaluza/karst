/**
 * The agent instructions layer: karst's own rules, written ONCE to a file in
 * the session dir and delivered to the agent through its own system/developer
 * channel instead of the first user message. vscode-free.
 *
 * Karst writes the body to `<sessionDir>/karst-instructions.md` and exports the
 * path as `KARST_INSTRUCTIONS` (see `cliEnv.ts`). A core that translates the
 * body into a native flag (claude's `--append-system-prompt-file`) reads the
 * file; a core with no such channel gets a one-line POINTER in its kickoff and
 * reads the same file on demand. Either way the body never rides argv: it is a
 * path or a pointer, never the text.
 *
 * The delivery mechanism per core/path is DECLARED on the adapter
 * (`InstructionDelivery`) and pinned against real argv by the conformance suite.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KARST_INSTRUCTIONS_ENV } from './cliEnv.js';

/** The filename the instructions body is written to inside a session dir. */
export const INSTRUCTIONS_FILENAME = 'karst-instructions.md';

/** A session's instruction layer: where it was written, and what it says. */
export interface SessionInstructions {
  /** The absolute path exported to the child as `KARST_INSTRUCTIONS`. */
  path: string;
  /** The instruction body. Carried for cores whose delivery is a generated
   *  artifact (opencode agent file) rather than a file-path flag. */
  body: string;
}

/**
 * Write the instruction body into `sessionDir` and return its path. Overwrites
 * on every launch (item 7): the instructions are regenerated from the running
 * karst version and re-attached on a fresh launch AND a resume alike.
 */
export function writeSessionInstructions(sessionDir: string, body: string): SessionInstructions {
  const path = join(sessionDir, INSTRUCTIONS_FILENAME);
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return { path, body };
}

/**
 * The stable phrase every pointer carries. Telemetry matches on it to tell a
 * pointer-bearing launch from a body-bearing one, the same way
 * `GUIDE_POINTER_MARKER` marks the guide pointer.
 */
export const INSTRUCTIONS_POINTER_MARKER = 'Read the karst instructions at';

/** The one-line pointer a fallback core places in its kickoff / developer channel. */
export function renderInstructionsPointer(envName: string = KARST_INSTRUCTIONS_ENV): string {
  return `${INSTRUCTIONS_POINTER_MARKER} "$${envName}" before you begin.`;
}

/** Whether text carries the instructions pointer (matches the stable phrase). */
export function hasInstructionsPointer(
  text: string | undefined,
  marker: string = INSTRUCTIONS_POINTER_MARKER,
): boolean {
  return typeof text === 'string' && text.includes(marker);
}

/**
 * Place the pointer in a kickoff WITHOUT breaking a leading slash command: a
 * `/karst:foo KEY` invocation must stay the first token the core parses, so the
 * pointer goes after the command's own line — never before it. Any other
 * kickoff takes the pointer first.
 */
export function withInstructionsPointer(kickoff: string | undefined, pointer: string): string {
  const text = kickoff?.trim() ?? '';
  if (text.length === 0) return pointer;
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? '' : text.slice(newline + 1).trim();
  if (firstLine.startsWith('/')) {
    return rest.length > 0 ? `${firstLine}\n\n${pointer}\n\n${rest}` : `${firstLine}\n\n${pointer}`;
  }
  return `${pointer}\n\n${text}`;
}

/** Composed instruction length in characters; absent → 0. */
export function instructionsCharLength(body: string | undefined): number {
  return body?.length ?? 0;
}

/**
 * A short, stable digest of the instruction body: the prompt-metrics identity
 * of the layer. Ten hex chars is enough to tell "same wording" from "changed
 * wording" without storing the prose a second time.
 */
export function hashInstructions(body: string | undefined): string {
  return createHash('sha256').update(body ?? '', 'utf8').digest('hex').slice(0, 10);
}
