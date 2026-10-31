import type { MarkerStage } from './markerStage.js';
import { MARKER_REFUSED, PROCESS_KILL_RULE } from './promptText.js';

/**
 * Instruction text for an agent inside a runner-enforced sandbox (arch:AC-34).
 * The host `stage … pass` CLI, its database and the MCP server do not exist
 * there; the done marker is `emit-marker.cjs`, the bridge's file transport.
 * Only `impl` and `fix` carry a marker (the script refuses any other stage).
 */
export interface SandboxMarkerInput {
  /** The bridge dir as the agent sees it (`SessionRunner.bridgeRunDir`); ends in the numeric ticket id. */
  readonly runDir: string;
  /** The adapter id: the script dir `<runDir>/<core>` the bridge writers fill. */
  readonly core: string;
  readonly stage: MarkerStage;
}

/** `node <runDir>/<core>/emit-marker.cjs <runDir>/events.ndjson <stage>`: derived from the channel paths, never invented. */
export function sandboxMarkerCommand(input: SandboxMarkerInput): string {
  return `node ${input.runDir}/${input.core}/emit-marker.cjs ${input.runDir}/events.ndjson ${input.stage}`;
}

/** The done-marker instruction for a sandboxed impl/fix session. */
export function renderSandboxMarkerInstruction(input: SandboxMarkerInput): string {
  const command = sandboxMarkerCommand(input);
  return (
    "When you have finished this stage's work — whether that is code, research, or a " +
    'confirmation — commit your changes (uncommitted changes block the marker), then run ' +
    `\`${command}\` to record the done marker and advance the ticket to its next stage. ` +
    'The karst CLI, its database and any MCP tools are not available inside this sandbox; this command is the only way to finish. ' +
    'Its exit code is the answer: 0 = accepted, the stage advanced. ' +
    '1 = refused; the reason is on stderr (a dirty working tree or a failing `git status` refuses and records nothing in events.ndjson) — do not retry, tell the user. ' +
    '3 = queued (the host answered `retrying`, or its reply did not arrive within 60 s); this is NOT a failure: do not loop-retry, the host retries on its own. ' +
    'A session ending does not advance the ticket on its own — you must run this marker explicitly. ' +
    `Do NOT run it while you are waiting for the user to answer a question: a stage whose agent is waiting on the user is not complete, and the ${MARKER_REFUSED}. ` +
    'The marker is also refused when no repository has changes from its base branch — at least one target must differ, so commit your work to the ticket branch first. ' +
    `${PROCESS_KILL_RULE} ` +
    'Karst notes cannot be posted from the sandbox (not available in the sandbox).'
  );
}

/** What replaces a host CLI command span in sandboxed text. */
export const NOT_IN_SANDBOX = '(not available in the sandbox)';

/** A backtick span carrying a host-only CLI command or env ref. */
const HOST_CLI_SPAN = /`[^`]*(?:\$\{?KARST_(?:CLI|DB|MANIFEST)\b|\bnode\s+"?\$KARST_CLI|--db\s)[^`]*`/g;
/** A bare `karst <subcommand> …` span (the host CLI by name). */
const BARE_KARST_SPAN = /`karst\s+[a-z][a-z-]*\b[^`]*`/g;
/** The MCP phrasing (the sandbox has no karst MCP server). */
const MCP_TOOL_CLAUSE = /call the karst MCP tool `[a-z-]+`(?: with \{[^}]*\})?/g;

/** The Claude ToolSearch hint for deferred karst MCP tools. */
const DEFERRED_HINT = /karst MCP tools may be deferred: load them first with ToolSearch `[^`]*`\.?/g;

/**
 * Last line of defence for sandboxed text: any host command span or MCP tool
 * call that survived composition is replaced, so the agent is never told to run
 * something that cannot exist. Returns what changed so the caller can log it.
 */
export function scrubHostCli(text: string): { readonly text: string; readonly scrubbed: number } {
  let scrubbed = 0;
  const swap = (): string => { scrubbed += 1; return NOT_IN_SANDBOX; };
  const out = text.replace(HOST_CLI_SPAN, swap).replace(BARE_KARST_SPAN, swap).replace(DEFERRED_HINT, swap).replace(MCP_TOOL_CLAUSE, swap);
  return { text: out, scrubbed };
}
