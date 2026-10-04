/**
 * The one caret-scoped write for template controls (Git conventions, General
 * display templates). Runs a pure `templateCaret` edit against the control's
 * live value and selection, writes the result through the field's onChange,
 * and restores the caret after React commits the value (a browser resets the
 * selection to the end on commit). An edit that changes nothing makes NO
 * write — the vanilla refusal for a transform with no variable under the caret.
 */
import type { RefObject } from 'react';
import type { CaretField } from './templateCaret.js';

export function useCaretEdit(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  onChange: (next: string) => void,
): (edit: (input: CaretField) => string) => void {
  return (edit) => {
    const node = ref.current;
    if (!node) return;
    const caret = { pos: [0, 0] as [number, number] };
    const next = edit({
      value: node.value,
      selectionStart: node.selectionStart,
      selectionEnd: node.selectionEnd,
      setSelectionRange: (start, end) => {
        caret.pos = [start, end];
      },
    });
    if (next === node.value) return;
    onChange(next);
    queueMicrotask(() => {
      node.focus();
      node.setSelectionRange(caret.pos[0], caret.pos[1]);
    });
  };
}
