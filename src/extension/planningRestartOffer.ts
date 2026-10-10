import * as vscode from 'vscode';
import type { PlanningOpsDeps } from './ops/planningOps.js';

/** Thin vscode binding for `PlanningOpsDeps.offerRestart`: [Restart with <new>] [Keep <old>]. */
export const offerPlannerRestart: NonNullable<PlanningOpsDeps['offerRestart']> = async (message, labels) => {
  const picked = await vscode.window.showWarningMessage(message, labels.restart, labels.keep);
  return picked === labels.restart ? 'restart' : picked === labels.keep ? 'keep' : undefined;
};
