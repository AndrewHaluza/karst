/**
 * A compact, self-focusing text input for in-place edits (the preset rename).
 * It owns its own value so typing re-renders only this input, not the view
 * around it. Enter commits, Escape cancels, blur commits a changed value.
 * `onCommit` returns whether the value was accepted; a refused value keeps
 * the editor open so the caller's fault line can explain why.
 */
import { useState } from 'react';

export function InlineTextInput({
  initialValue,
  label,
  onCommit,
  onCancel,
}: {
  readonly initialValue: string;
  readonly label: string;
  readonly onCommit: (value: string) => boolean;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const commit = (): void => {
    if (value === initialValue) onCancel();
    else if (onCommit(value)) onCancel();
  };
  return (
    <input
      autoFocus
      className="k-input inline-text-input"
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}
