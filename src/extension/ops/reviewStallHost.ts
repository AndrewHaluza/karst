import type { ReviewStallActionDeps } from './reviewStallActions.js';
import { ticketIdArg } from './args.js';

/** The slice of vscode the review-stall answers need, so the logic runs under vitest. */
export interface StallHost {
  info: (message: string) => void;
  error: (message: string) => void;
  /** Modal warning with one button; resolves to the clicked label or undefined. */
  warn: (title: string, detail: string, button: string) => Promise<string | undefined>;
  input: (options: { prompt: string; placeHolder: string }) => Promise<string | undefined>;
  executeCommand: (command: string, ...args: unknown[]) => void;
  registerCommand: (command: string, handler: (arg: unknown) => void) => { dispose(): unknown };
}

export type ActionBaseDeps = Omit<ReviewStallActionDeps, 'info' | 'error' | 'confirm' | 'promptHint'>;
export type StallPick = 'reviewStallHint' | 'reviewStallContinue' | 'reviewStallRescope';
export type StallCommandBase = Omit<ActionBaseDeps, 'ticketId' | 'drive'> & { drive: (ticketId: number) => void };

export function buildActionDeps(host: StallHost, base: ActionBaseDeps): ReviewStallActionDeps {
  return {
    ...base,
    info: (m) => host.info(m),
    error: (m) => host.error(m),
    confirm: async (title, detail) => (await host.warn(title, detail, 'Continue')) !== undefined,
    promptHint: () =>
      host.input({
        prompt: 'Redesign hint for the fix agent',
        placeHolder: 'e.g. split this module instead of patching it again',
      }),
  };
}

export interface StallRunDeps extends ActionBaseDeps {
  editTicket: () => void;
}

/** `karst.reviewStall*` — the sidebar ⋯ menu's route to the three answers. */
export function registerStallCommands(
  host: StallHost,
  deps: StallCommandBase,
  run: (pick: StallPick, deps: StallRunDeps) => void,
): { dispose(): unknown }[] {
  const { drive, ...rest } = deps;
  const answer = (pick: StallPick) => (arg: unknown) => {
    const ticketId = ticketIdArg(arg);
    if (ticketId === undefined) return;
    run(pick, {
      ...rest,
      ticketId,
      drive: () => drive(ticketId),
      editTicket: () => host.executeCommand('karst.editTicket', ticketId),
    });
  };
  return (['reviewStallHint', 'reviewStallContinue', 'reviewStallRescope'] as const).map((pick) =>
    host.registerCommand(`karst.${pick}`, answer(pick)),
  );
}

/** The vscode API surface `hostFromVscode` touches — a structural slice so a fake can stand in. */
export interface VscodeLike {
  window: {
    showInformationMessage: (m: string) => unknown;
    showErrorMessage: (m: string) => unknown;
    showWarningMessage: (title: string, o: { modal: boolean; detail: string }, button: string) => PromiseLike<string | undefined>;
    showInputBox: (o: { prompt: string; placeHolder: string; ignoreFocusOut: boolean }) => PromiseLike<string | undefined>;
  };
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => unknown;
    registerCommand: (command: string, handler: (arg: unknown) => void) => { dispose(): unknown };
  };
}

export function hostFromVscode(api: VscodeLike): StallHost {
  return {
    info: (m) => void api.window.showInformationMessage(m),
    error: (m) => void api.window.showErrorMessage(m),
    warn: async (title, detail, button) => api.window.showWarningMessage(title, { modal: true, detail }, button),
    input: async (o) => api.window.showInputBox({ ...o, ignoreFocusOut: true }),
    executeCommand: (c, ...a) => void api.commands.executeCommand(c, ...a),
    registerCommand: (c, h) => api.commands.registerCommand(c, h),
  };
}
