import type { Store } from '../../store/db.js';
import type { Ticket } from '../../store/tickets.js';
import { resolveTicketByKey } from '../resolveTicket.js';
import { parseCreateTicketArgs, runCreateTicket } from './createTicket.js';
import { parseSetStageArgs, runSetStage } from './setStage.js';
import { parseAdvanceArgs, runAdvance } from './advance.js';
import { parseRunGateArgs, runRunGate } from './runGate.js';
import { parseSimulateHookArgs, runSimulateHook } from './simulateHook.js';
import { parseOpenPrArgs, runOpenPr } from './openPr.js';
import { parseMergePrArgs, runMergePr } from './mergePr.js';
import { parseGetStateArgs, runGetState } from './getState.js';
import { parseGetStageArgs, runGetStage } from './getStage.js';
import { parseGetLogsArgs, runGetLogs } from './getLogs.js';
import { parseGetHooksArgs, runGetHooks } from './getHooks.js';
import { parseAssertArgs, runAssert } from './assert.js';

/**
 * The `karst test <command>` CLI verb — the agent test driver (Phase 1 of the
 * agent-test-driver ticket). A SEPARATE parse path from `stage`/`phase`, for the
 * same security reason those two are separate from each other: this verb is
 * deliberately, explicitly powerful (it can set a stage, inject a verdict, merge
 * a PR, even reset the whole registry), so it must never share the parser whose
 * narrowing keeps an injected agent from forging a `stage ship pass`. The agent
 * guide documents it as a development/driver tool that bypasses gate verdicts.
 *
 * Every subcommand delegates to store/workflow helpers rather than writing raw
 * SQL where production seams exist, so the driver cannot drift from them.
 */

const SUBCOMMANDS: readonly string[] = [
  'create-ticket',
  'set-stage',
  'advance',
  'run-gate',
  'simulate-hook',
  'open-pr',
  'merge-pr',
  'get-state',
  'get-stage',
  'get-logs',
  'get-hooks',
  'assert',
  'reset',
];

export interface ParsedTest {
  subcommand: string;
  argv: string[];
}

export function parseTestArgs(argv: string[]): ParsedTest {
  const [cmd, subcommand, ...rest] = argv;
  if (cmd !== 'test') {
    throw new Error(`expected 'test' command, got '${cmd ?? ''}'`);
  }
  if (subcommand === undefined) {
    throw new Error(`missing test subcommand (want one of ${SUBCOMMANDS.join(', ')})`);
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `unknown test subcommand '${subcommand}' (want one of ${SUBCOMMANDS.join(', ')})`,
    );
  }
  return { subcommand, argv: rest };
}

/** Resolve the ticket a subcommand targets, or throw naming the missing key. */
function requireTicket(
  store: Store,
  ticketKey: string | undefined,
  projectSlug: string | undefined,
  subcommand: string,
): Ticket {
  if (ticketKey === undefined) {
    throw new Error(`'test ${subcommand}' requires --ticket <key>`);
  }
  const found = resolveTicketByKey(store, ticketKey, projectSlug);
  if (!found) throw new Error(`no ticket found for key '${ticketKey}'`);
  return found;
}

/**
 * Dispatch one `karst test <subcommand>` invocation. The ticket key (global
 * `--ticket`) and project slug are supplied by the CLI entry; `reset` is handled
 * by the caller (it must open the file before the schema exists).
 */
export function runTestCommand(
  store: Store,
  ticketKey: string | undefined,
  projectSlug: string | undefined,
  argv: string[],
): string {
  const { subcommand, argv: rest } = parseTestArgs(argv);

  switch (subcommand) {
    case 'create-ticket':
      return runCreateTicket(store, parseCreateTicketArgs(rest));
    case 'set-stage': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runSetStage(store, t.id, parseSetStageArgs(rest));
    }
    case 'advance': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runAdvance(store, t.id, parseAdvanceArgs(rest));
    }
    case 'run-gate': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runRunGate(store, t.id, parseRunGateArgs(rest));
    }
    case 'simulate-hook': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runSimulateHook(store, t, parseSimulateHookArgs(rest));
    }
    case 'open-pr': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runOpenPr(store, t.id, parseOpenPrArgs(rest));
    }
    case 'merge-pr': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runMergePr(store, t.id, parseMergePrArgs(rest));
    }
    case 'get-state': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      parseGetStateArgs(rest);
      return runGetState(store, t.id);
    }
    case 'get-stage': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runGetStage(store, t.id, parseGetStageArgs(rest));
    }
    case 'get-logs': {
      const parsed = parseGetLogsArgs(rest);
      const t = ticketKey === undefined ? undefined : resolveTicketByKey(store, ticketKey, projectSlug);
      if (ticketKey !== undefined && t === undefined) {
        throw new Error(`no ticket found for key '${ticketKey}'`);
      }
      return runGetLogs(store, t?.id ?? null, parsed);
    }
    case 'get-hooks': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      parseGetHooksArgs(rest);
      return runGetHooks(store, t.id);
    }
    case 'assert': {
      const t = requireTicket(store, ticketKey, projectSlug, subcommand);
      return runAssert(store, t.id, parseAssertArgs(rest));
    }
    default:
      // `reset` is dispatched by the CLI entry before a store exists; reaching
      // it here means the parse/validation accepted it but the wiring forgot.
      throw new Error(`'test ${subcommand}' must be dispatched before the store is opened`);
  }
}
