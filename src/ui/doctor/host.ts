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

/** 'Karst: Run Doctor' — on demand only; shows the report in a panel. */
export function registerDoctorCommand(deps: DoctorWiringDeps): vscode.Disposable {
  return vscode.commands.registerCommand('karst.runDoctor', async () => {
    const { cliEntry, dbPath, manifestPath } = deps.cli();
    const runCli = (args: readonly string[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [cliEntry, ...args], { maxBuffer: 4 * 1024 * 1024 }, (_e, stdout, stderr) =>
          resolve({ stdout, stderr }),
        );
      });
    const opts = { runCli, db: dbPath, ...(manifestPath ? { manifest: manifestPath } : {}) };
    const panel = vscode.window.createWebviewPanel('karstDoctor', 'Karst Doctor', vscode.ViewColumn.Active, { enableScripts: true });
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
  });
}
