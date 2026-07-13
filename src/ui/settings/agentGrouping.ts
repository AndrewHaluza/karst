import type { SettingsAgentRow } from './state.js';

/**
 * Order agent rows for the provenance roster: local `file` agents first (in
 * their given order), then `approach` agents grouped by `approachId` — groups
 * appear in first-appearance order, rows within a group keep their order.
 * Disabled rows are retained (the tab is where they get re-enabled). Pure; a new
 * array is returned.
 */
export function sortAgentRowsByProvenance(
  rows: readonly SettingsAgentRow[],
): SettingsAgentRow[] {
  const files = rows.filter((r) => r.source === 'file');
  const approachRows = rows.filter((r) => r.source === 'approach');
  const order: string[] = [];
  const byId = new Map<string, SettingsAgentRow[]>();
  for (const r of approachRows) {
    const id = r.approachId ?? '';
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(r);
  }
  return [...files, ...order.flatMap((id) => byId.get(id)!)];
}
