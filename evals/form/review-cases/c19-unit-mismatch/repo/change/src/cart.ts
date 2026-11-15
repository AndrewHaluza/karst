import { formatPrice } from './money.js';

export interface CartItem {
  name: string;
  /** Unit price in dollars, as the catalog API returns it. */
  price: number;
  quantity: number;
}

export function lineTotal(item: CartItem): number {
  return item.price * item.quantity;
}

export function cartTotal(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function renderCart(items: readonly CartItem[]): string {
  const lines = items.map((item) => `${item.name} x${item.quantity}: ${formatPrice(lineTotal(item))}`);
  lines.push(`Total: ${formatPrice(cartTotal(items))}`);
  return lines.join('\n');
}
