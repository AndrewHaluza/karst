/**
 * The provider brand mark as an opaque island (NDL-126 §9.4 R-X3).
 *
 * `providerBadgeInto` — the MOUNTING form of the shared provider runtime, added
 * beside `providerBadgeHtml` in `model/providerIdentity.ts` — builds the ClickUp
 * peak (or a label-only badge for a provider with no mark) inside a container
 * React never reconciles children into.
 *
 * A React component cannot adopt the badge's HTML string instead: that would need
 * `dangerouslySetInnerHTML`, which R-X6 bans and which would defeat UI-R32's
 * escaping guarantee for a mark that is already a first-class shared asset. The
 * island keeps one definition of the mark with no mirrored SVG.
 */
import { useEffect, useRef } from 'react';
import { providerLabel } from '../../../../model/ticketProviders.js';

/** `providerBadgeInto(el, provider)` from the injected provider blob. */
export type ProviderBadgeMount = (element: HTMLElement, provider: string) => void;

export interface ProviderBadgeIslandProps {
  readonly provider: string;
  /** Injected in tests; defaults to the `KARST_PROVIDER_JS` page global. */
  readonly mount?: ProviderBadgeMount | null;
  /** The accessible name, from the shared `PROVIDER_LABELS` vocabulary. */
  readonly label?: string;
}

export function ProviderBadgeIsland({ provider, mount, label }: ProviderBadgeIslandProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const badge = mount ?? pageProviderBadgeMount();
    if (!root || !badge) return;
    badge(root, provider);
  }, [mount, provider]);

  const name = label ?? providerLabel(provider);
  if (!name) {
    return <span ref={rootRef} className="provbadge" />;
  }
  return (
    <span ref={rootRef} className="provbadge" role="img" aria-label={name} />
  );
}

function pageProviderBadgeMount(): ProviderBadgeMount | null {
  const scope = globalThis as unknown as {
    providerBadgeInto?: ProviderBadgeMount;
  };
  return scope.providerBadgeInto ?? null;
}
