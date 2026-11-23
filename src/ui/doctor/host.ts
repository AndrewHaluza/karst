import * as vscode from 'vscode';
import { ask } from '../../extension/toastSeam.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { brandIconUri } from '../panelIcon.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { createDoctorFlow, createDoctorPanelController } from './doctorFlow.js';
import { createDoctorRun, type DoctorCliInput } from './doctorRun.js';

export interface DoctorWiringDeps {
  brandIcon?: BrandIconPaths;
  /** The session's current CLI input; read per run, so a manifest switch lands. */
  cli: () => DoctorCliInput;
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
  const controller = createDoctorPanelController<vscode.WebviewPanel>({
    createPanel: () =>
      vscode.window.createWebviewPanel(DOCTOR_VIEW_TYPE, 'Karst Doctor', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [],
      }),
    /**
     * Everything a panel needs before its flow runs: the karst tab icon, scripts
     * on, and no local resource roots (the page is self-contained, DR-11). The
     * controller runs this for a created AND a restored panel — a restore comes
     * back with the serializer's options, so scripts would stay off.
     */
    adopt: (panel) => {
      panel.iconPath = brandIconUri(deps.brandIcon);
      panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    },
    createFlow: (panel, lifecycle) => {
      return createDoctorFlow({
        // The run reads the session's CLI input on every call (doctorRun.ts), so
        // a rerun after a manifest switch uses the current manifestPath.
        run: createDoctorRun(deps.cli),
        // The modal is the host's: a crafted webview message cannot skip it (UI-R33).
        // VS Code appends Cancel; Cancel resolves to undefined, never the action.
        confirm: async (title, items, actionLabel) =>
          (await ask.warn(title, { modal: true, detail: items.join('\n') }, actionLabel)) === actionLabel,
        // The page carries all three markers; the host swaps CSS, runtime and palette.
        render: (html) => {
          panel.webview.html = injectPalette(injectDesignSystem(html));
        },
        post: (message) => {
          // The Thenable rejects when the tab is disposed between the flow's
          // guard and this call: a dropped message is not an unhandled rejection.
          void Promise.resolve(panel.webview.postMessage(message)).catch(() => undefined);
        },
        copy: async (text) => {
          await vscode.env.clipboard.writeText(text);
        },
        // A run that finishes after the tab closed must not touch the webview.
        isDisposed: lifecycle.isDisposed,
      });
    },
  });

  return {
    command: vscode.commands.registerCommand('karst.runDoctor', () => controller.open()),
    restore: (raw) => controller.restore(raw),
  };
}
