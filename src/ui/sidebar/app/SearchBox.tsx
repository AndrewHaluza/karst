/**
 * The search box. Typing posts `set-filter` after a short debounce; the box is
 * kept in sync with the host's filter on every snapshot (the host owns the
 * filter, so a push that changed it rewrites the box). A clear button appears
 * once there is text, and Escape clears it at once (SB-9).
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { useSidebar } from './SidebarContext.js';

const DEBOUNCE_MS = 150;

export function SearchBox() {
  const { state, post } = useSidebar();
  const [value, setValue] = useState(state.filter || '');
  const input = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setValue(state.filter || '');
    const el = input.current;
    if (el && el.value !== state.filter) el.value = state.filter;
  }, [state]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const clear = (): void => {
    clearTimeout(timer.current);
    setValue('');
    if (input.current) {
      input.current.value = '';
      input.current.focus();
    }
    post({ type: 'set-filter', query: '' });
  };

  return (
    <div className="search" role="search">
      <svg className="search-icon k-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
        <path d="M21 21l-6 -6" />
      </svg>
      <input
        type="text"
        id="search"
        className="k-input search-input"
        aria-label="Search tickets and plans"
        placeholder="Search tickets and plans…"
        ref={input}
        onInput={(e) => {
          clearTimeout(timer.current);
          const query = e.currentTarget.value;
          setValue(query);
          timer.current = setTimeout(() => post({ type: 'set-filter', query }), DEBOUNCE_MS);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || value === '') return;
          e.preventDefault();
          e.stopPropagation();
          clear();
        }}
      />
      {value !== '' ? (
        <button type="button" className="k-iconbtn search-clear" data-search-clear="1" aria-label="Clear search" title="Clear search" onClick={clear}>
          <Icon name="x" />
        </button>
      ) : null}
    </div>
  );
}
