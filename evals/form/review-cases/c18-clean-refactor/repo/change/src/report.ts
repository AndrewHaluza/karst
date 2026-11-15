import { formatMoney } from './money.js';

export interface Row {
  label: string;
  cents: number;
}

export function renderRows(rows: Row[]): string[] {
  return rows.map((r) => `${r.label}: ${formatMoney(r.cents)}`);
}
