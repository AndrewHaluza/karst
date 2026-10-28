export interface PausedAskInput {
  key: string;
  /** Lowercase phrase for the sentence, e.g. `retry UAT`. */
  action: string;
  /** Button label, e.g. `Retry UAT`. */
  label: string;
  isPaused: () => boolean;
  unpause: () => void;
  /** Modal choice seam; resolves the picked button, or undefined on cancel. */
  choose: (message: string, choices: string[]) => Promise<string | undefined>;
}

/**
 * A paused ticket runs nothing (@arch:PAUSE), so an action that needs the
 * driver would silently stall. Ask per click — never remembered — whether to
 * unpause first, run the action anyway, or cancel.
 */
export async function askWhenPaused(i: PausedAskInput): Promise<'proceed' | 'cancel'> {
  if (!i.isPaused()) return 'proceed';
  const unpauseLabel = `Unpause and ${i.label}`;
  const onlyLabel = `${i.label} only, keep paused`;
  const pick = await i.choose(`${i.key} is paused, so ${i.action} will not run until you unpause.`, [
    unpauseLabel,
    onlyLabel,
  ]);
  if (pick === unpauseLabel) {
    i.unpause();
    return 'proceed';
  }
  return pick === onlyLabel ? 'proceed' : 'cancel';
}
