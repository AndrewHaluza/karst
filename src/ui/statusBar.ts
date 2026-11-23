import { formatTicketRef } from '../model/entityId.js';
import { GLYPH_WORD, type Glyph } from '../model/glyph.js';
import { stageWord } from './shared/ticketRefView.js';

/**
 * The live verbose channel: whatever a tab or terminal abbreviates to a color,
 * the status bar states in words. Host-agnostic — the vscode item lives behind
 * `StatusBarHost` so this is unit-testable with a fake.
 */
export interface StatusTicket {
  ticketId: number;
  key: string;
  /** The raw stage key; the bar shows its full title (`uat` → `UAT`). */
  stage: string;
  glyph: Glyph;
}

export interface StatusBarHost {
  set(text: string, warning: boolean, command: { id: string; arg: unknown }): void;
  hide(): void;
}

/**
 * `T7 · KAR-7 · UAT · Running`: one reference, the stage word and the state word
 * from the shared `GLYPH_WORD` table (SB-4, SB-13). The caller passes `t.key`
 * as-is, so the ref is formatted once. A red glyph prefixes `⚠` (blocker,
 * multi-channel).
 */
export function statusBarText(v: StatusTicket): string {
  const body = `${formatTicketRef(v.ticketId, v.key)} · ${stageWord(v.stage).full} · ${GLYPH_WORD[v.glyph]}`;
  return v.glyph === 'red' ? `⚠ ${body}` : body;
}

/** Drives one status-bar item for the active/focused ticket. */
export class StatusBarManager {
  constructor(private readonly host: StatusBarHost) {}

  render(v: StatusTicket | null): void {
    if (!v) {
      this.host.hide();
      return;
    }
    this.host.set(statusBarText(v), v.glyph === 'red', {
      id: 'karst.openDashboard',
      arg: v.ticketId,
    });
  }
}
