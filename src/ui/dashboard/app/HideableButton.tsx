/**
 * A runtime-pending button whose visibility follows a host flag. The `hidden` CLASS is toggled on the node in a
 * layout effect and never through the `className` prop: React rewriting `className` would wipe the runtime's
 * `is-pending` class (interop rule, pinned in parity/interop.render.integration.test.ts).
 */
import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'hidden'> & { readonly off: boolean };

export function HideableButton({ off, ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    ref.current?.classList.toggle('hidden', off);
  }, [off]);
  return <button ref={ref} type="button" {...rest} />;
}
