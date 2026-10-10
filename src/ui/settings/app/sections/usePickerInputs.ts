/**
 * The three inputs every `AgentPickerIsland` on the Agents page needs (model
 * catalog, recent models, selectable cores), memoised on CONTENT.
 *
 * The island's mount effect keys on identity and `applyState` rebuilds these on
 * every `state` push, so handing it fresh-but-equal objects would rebuild every
 * picker mid-input (R-X3). Each is therefore keyed on a content digest.
 */
import { useMemo } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { pickerCores } from './presetDraft.js';

const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

/** Stable identity for "this picker inherits nothing". */
export const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

export function usePickerInputs() {
  const { state } = useSettingsApp();
  const modelKeys = useMemo(() => Object.keys(state.models?.models ?? {}).join(','), [state.models]);
  const recentKeys = useMemo(() => Object.keys(state.models?.recentModels ?? {}).join(','), [state.models]);
  const implementedKey = state.implementedProviders.join(',');
  const catalog = useMemo(
    () => state.models?.models ?? EMPTY_CATALOG,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [modelKeys],
  );
  const recent = useMemo(
    () => state.models?.recentModels ?? EMPTY_RECENT,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [recentKeys],
  );
  const cores = useMemo(
    () => pickerCores(state.implementedProviders),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [implementedKey],
  );
  return { catalog, recent, cores };
}
