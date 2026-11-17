/**
 * Mirrors the window-wide page width onto `<body data-layout>`. The dashboard stylesheet caps the in-flow page
 * from that one attribute (`body[data-layout="centered"]`, UI-R48). The host writes the same attribute into the
 * document before the first paint, so this only has to follow later `layout` pushes. Renders nothing.
 */
import { useLayoutEffect } from 'react';
import { selectLayout } from './headerSlices.js';
import { useSlice } from './useSlice.js';

export function BodyLayout(): null {
  const layout = useSlice(selectLayout);
  useLayoutEffect(() => {
    document.body.dataset.layout = layout;
  }, [layout]);
  return null;
}
