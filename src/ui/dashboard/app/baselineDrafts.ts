/**
 * What the user is doing in the baseline review is view state, not host state, and outlives a repaint: the chosen
 * compare view per entry, the selected entry, the filter, the zoom, the one entry whose reject form is open, and the
 * reason drafts (typed text survives closing the form and the 1 Hz pushes). The hook is called once, by the
 * always-mounted `DashboardAppProvider`, because the banner and the review overlay render in separate trees and the
 * drafts must outlive the overlay's close and reopen. They do NOT persist across an IDE reload.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Filter, View } from './baselineGroups.js';

export interface BaselineDrafts {
  readonly views: Readonly<Record<number, View>>;
  readonly setView: (index: number, view: View) => void;
  /** The selected entry index; null = none chosen yet (the view falls back to the first visible entry). */
  readonly selected: number | null;
  readonly select: (index: number) => void;
  /** The chosen filter; null = the default (Needs review, or All when nothing is waiting). */
  readonly filter: Filter | null;
  readonly setFilter: (filter: Filter) => void;
  /** Zoom: false = fit the viewer, true = 1:1 with scroll in the stage. */
  readonly zoom: boolean;
  readonly toggleZoom: () => void;
  readonly rejectOpen: number | null;
  readonly openReject: (index: number) => void;
  readonly closeReject: () => void;
  readonly invalid: number | null;
  readonly setInvalid: (index: number | null) => void;
  /** What was typed, per entry index. The field is uncontrolled: this is read at click time, never rendered from. */
  readonly reasons: { readonly current: Record<number, string> };
}

export function useBaselineDrafts(): BaselineDrafts {
  const [views, setViews] = useState<Readonly<Record<number, View>>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [zoom, setZoom] = useState(false);
  const [rejectOpen, setRejectOpen] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<number | null>(null);
  const reasons = useRef<Record<number, string>>({});
  const setView = useCallback((index: number, view: View) => setViews((v) => ({ ...v, [index]: view })), []);
  const select = useCallback((index: number) => setSelected(index), []);
  const toggleZoom = useCallback(() => setZoom((z) => !z), []);
  const openReject = useCallback((index: number) => {
    setRejectOpen(index);
    setInvalid(null);
  }, []);
  const closeReject = useCallback(() => {
    setRejectOpen(null);
    setInvalid(null);
  }, []);
  return useMemo(
    () => ({ views, setView, selected, select, filter, setFilter, zoom, toggleZoom, rejectOpen, openReject, closeReject, invalid, setInvalid, reasons }),
    [views, setView, selected, select, filter, zoom, toggleZoom, rejectOpen, openReject, closeReject, invalid],
  );
}
