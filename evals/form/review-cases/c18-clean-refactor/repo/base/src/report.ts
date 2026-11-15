export interface Row {
  label: string;
  cents: number;
}

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${frac}`;
}

export function renderRows(rows: Row[]): string[] {
  return rows.map((r) => `${r.label}: ${formatMoney(r.cents)}`);
}
