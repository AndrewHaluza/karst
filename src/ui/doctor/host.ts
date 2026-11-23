import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { runDoctorViaCli } from '../../extension/ops/doctorOps.js';
import { ask } from '../../extension/toastSeam.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { brandIconUri } from '../panelIcon.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { createDoctorFlow, createDoctorPanelController } from './doctorFlow.js';

export interface DoctorWiringDeps {
  brandIcon?: BrandIconPaths;
  cli: () => { cliEntry: string; dbPath: string; manifestPath?: string };
}

/** The doctor's viewType; the serializer and the activation event name it. */
export const DOCTOR_VIEW_TYPE = 'karstDoctor';

/** The doctor commands and the restore path for the one doctor tab. */
export interface DoctorWiring {
  command: vscode.Disposable;
  /** Adopt the doctor tab VS Code restored after a reload; a duplicate is closed. */
  restore(raw: vscode.WebviewPanel): Promise<void>;
}

/** 'Karst: Run Doctor' — on demand only; one panel, hydrated by the design system. */
export function registerDoctorCommand(deps: DoctorWiringDeps): DoctorWiring {
  const config = (): { cliEntry: string; dbPath: string; manifestPath?: string } => deps.cli();

  /**
   * Everything a panel needs before its flow runs: the karst tab icon, scripts
   * on, and no local resource roots (the page is self-contained, DR-11).
   */
  const adopt = (panel: vscode.WebviewPanel): vscode.WebviewPanel => {
    panel.iconPath = brandIconUri(deps.brandIcon);
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    return panel;
  };

  const controller = createDoctorPanelController<vscode.WebviewPanel>({
    createPanel: () =>
      adopt(
        vscode.window.createWebviewPanel(DOCTOR_VIEW_TYPE, 'Karst Doctor', vscode.ViewColumn.Active, {
          enableScripts: true,
          localResourceRoots: [],
        }),
      ),
    createFlow: (panel) => {
      const { cliEntry, dbPath, manifestPath } = config();
      // The CLI spawns git/gh synchronously; the extension host never blocks. The
      // spawn error rides along so a missing binary is not a blank reason (DR-4).
      const runCli = (args: readonly string[]) =>
        new Promise<{ stdout: string; stderr: string; error?: unknown }>((resolve) => {
          execFile(process.execPath, [cliEntry, ...args], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
            resolve({ stdout, stderr, ...(error ? { error } : {}) }),
          );
        });
      const opts = { runCli, db: dbPath, ...(manifestPath ? { manifest: manifestPath } : {}) };
      return createDoctorFlow({
        run: (fix, only) => runDoctorViaCli(opts, fix, only),
        // The modal is the host's: a crafted webview message cannot skip it (UI-R33).
        // VS Code appends Cancel; Cancel resolves to undefined, never the action.
        confirm: async (title, items, actionLabel) =>
          (await ask.warn(title, { modal: true, detail: items.join('\n') }, actionLabel)) === actionLabel,
        // The page carries both markers; the host swaps them for the real CSS.
        render: (html) => {
          panel.webview.html = injectPalette(injectDesignSystem(html));
        },
        post: (message) => {
          void panel.webview.postMessage(message);
        },
        copy: async (text) => {
          await vscode.env.clipboard.writeText(text);
        },
      });
    },
  });

  return {
    command: vscode.commands.registerCommand('karst.runDoctor', () => controller.open()),
    restore: (raw) => controller.restore(raw),
  };
}
