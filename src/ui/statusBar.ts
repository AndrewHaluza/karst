import type { Glyph } from '../model/glyph.js';

/**
 * The live verbose channel: whatever a tab or terminal abbreviates to a color,
 * the status bar states in words. Host-agnostic — the vscode item lives behind
 * `StatusBarHost` so this is unit-testable with a fake.
 */
export interface StatusTicket {
  ticketId: number;
  key: string;
  stage: string;
  state: string;
  glyph: Glyph;
}

export interface StatusBarHost {
  set(text: string, warning: boolean, command: { id: string; arg: unknown }): void;
  hide(): void;
}

/** `KAR-7 · review · running`; a red glyph prefixes `⚠` (blocker, multi-channel). */
export function statusBarText(v: StatusTicket): string {
  const body = `${v.key} · ${v.stage} · ${v.state}`;
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
