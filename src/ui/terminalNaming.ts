import type { BrandIconPaths } from './brandIcon.js';

/** The naming bag `SessionManager.openSession` applies to the terminal tab. */
export interface TerminalNamingBag {
  name: string;
  iconPath?: string;
  color?: string;
}

/**
 * The naming bag for an agent terminal tab. A terminal's name/icon/color are
 * FROZEN at creation (`Terminal.creationOptions` is readonly), so a status
 * glyph would be the stage-at-launch forever — a fix-run terminal would keep
 * its failed red long after the fix passed. Terminals therefore carry the
 * status-free brand mark (the same full-color mark the settings / new-ticket
 * panel tabs wear) and NO color (869egvp46-fu2).
 */
export function terminalNaming(opts: {
  name: string;
  brandIcon?: BrandIconPaths;
}): TerminalNamingBag {
  return {
    name: opts.name,
    ...(opts.brandIcon ? { iconPath: opts.brandIcon.light } : {}),
  };
}
