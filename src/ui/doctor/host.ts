import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { runDoctorViaCli } from '../../extension/ops/doctorOps.js';
import { brandIconUri } from '../panelIcon.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { renderDoctorHtml } from '../../doctor/renderHtml.js';

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

/** 'Karst: Run Doctor' — on demand only; shows the report in a panel. */
export function registerDoctorCommand(deps: DoctorWiringDeps): DoctorWiring {
  let current: vscode.WebviewPanel | undefined;
  /** Configure a raw panel (new or restored), run the report into it. */
  const adopt = async (panel: vscode.WebviewPanel): Promise<void> => {
    current = panel;
    panel.onDidDispose(() => {
      if (current === panel) current = undefined;
    });
    const { cliEntry, dbPath, manifestPath } = deps.cli();
    const runCli = (args: readonly string[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [cliEntry, ...args], { maxBuffer: 4 * 1024 * 1024 }, (_e, stdout, stderr) =>
          resolve({ stdout, stderr }),
        );
      });
    const opts = { runCli, db: dbPath, ...(manifestPath ? { manifest: manifestPath } : {}) };
    // A restored panel arrives with default options.
    panel.webview.options = { enableScripts: true };
    panel.iconPath = brandIconUri(deps.brandIcon);
    const show = async (fix: boolean): Promise<void> => {
      try {
        panel.webview.html = renderDoctorHtml(await runDoctorViaCli(opts, fix), randomBytes(16).toString('hex'));
      } catch (e) {
        void vscode.window.showErrorMessage(`Karst doctor: ${(e as Error).message}`);
      }
    };
    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m.type === 'fix') void show(true);
    });
    await show(false);
  };
  return {
    command: vscode.commands.registerCommand('karst.runDoctor', async () => {
      await adopt(vscode.window.createWebviewPanel(DOCTOR_VIEW_TYPE, 'Karst Doctor', vscode.ViewColumn.Active, { enableScripts: true }));
    }),
    restore: async (raw) => {
      if (current) {
        raw.dispose();
        return;
      }
      await adopt(raw);
    },
  };
}
