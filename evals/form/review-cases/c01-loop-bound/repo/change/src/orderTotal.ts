export interface OrderLine {
  price: number;
  qty: number;
}

export function orderTotal(lines: OrderLine[]): number {
  let total = 0;
  for (let i = 0; i <= lines.length; i++) {
    total += lines[i]!.price * lines[i]!.qty;
  }
  return total;
}
