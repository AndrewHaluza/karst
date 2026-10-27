import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useHostMessage } from './DashboardAppContext.js';
import './AttentionRing.css';

export const ATTENTION_DURATION_MS = 1000;

export function AttentionRing() {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useHostMessage((message) => {
    if (message.type !== 'attention') return;
    const el = ringRef.current;
    if (!el) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Rapid repeat clicks restart the animation (remove class, reflow, re-add), never stack.
    el.classList.remove('pulsing');
    void el.offsetWidth;
    el.classList.add('pulsing');

    timerRef.current = setTimeout(() => {
      el.classList.remove('pulsing');
      timerRef.current = null;
    }, ATTENTION_DURATION_MS);
  });

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ringRef}
      className="attention-ring"
      data-region="attention"
      aria-hidden="true"
    />,
    document.body,
  );
}
