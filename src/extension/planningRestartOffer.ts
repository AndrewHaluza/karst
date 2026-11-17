import * as vscode from 'vscode';
import type { PlanningOpsDeps } from './ops/planningOps.js';
import { ask } from './toastSeam.js';

/** Thin vscode binding for `PlanningOpsDeps.offerRestart`: [Restart] [Keep]. */
export const offerPlannerRestart: NonNullable<PlanningOpsDeps['offerRestart']> = async (message, labels) => {
  const picked = await ask.warn(message, labels.restart, labels.keep);
  return picked === labels.restart ? 'restart' : picked === labels.keep ? 'keep' : undefined;
};
