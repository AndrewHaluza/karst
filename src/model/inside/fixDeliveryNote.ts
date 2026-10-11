/**
 * How a round's stored fix brief (@arch:V77) reads on its recovery row: the
 * receipt state of "fix brief #<id>". Pure — the dashboard state builder feeds
 * it the row's timestamps; nothing here reads the store.
 */
export interface FixDeliveryFacts {
  id: number;
  pointedAt: string | null;
  repointedAt: string | null;
  pointerFailedAt: string | null;
  readAt: string | null;
  deliveredVia: 'seed' | 'pointer' | null;
  supersededAt: string | null;
}

/** The note for a round's delivery, or undefined when there is nothing to say. */
export function fixDeliveryNote(delivery: FixDeliveryFacts | undefined): string | undefined {
  if (delivery === undefined || delivery.supersededAt !== null) return undefined;
  const label = `fix brief #${delivery.id}`;
  if (delivery.readAt !== null) {
    return delivery.deliveredVia === 'seed'
      ? `${label} delivered in the launch seed`
      : `${label} read by the agent`;
  }
  if (delivery.pointerFailedAt !== null) return `${label} could not be pointed at`;
  if (delivery.repointedAt !== null) return `${label} pointed at twice, not read yet`;
  if (delivery.pointedAt !== null) return `${label} pointed at, not read yet`;
  return `${label} waiting to be pointed at`;
}
