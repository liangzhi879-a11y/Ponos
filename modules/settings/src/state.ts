export interface SettingsState { theme: string; provider: string; model: string }

export const DEFAULT_SETTINGS: SettingsState = { theme: 'vaporwave', provider: '', model: '' }

/** event:state.changed → { key, value, version }；仅归并 settings key 且 value 为对象时应用。 */
export function reduceSettings(state: SettingsState, ev: any): SettingsState {
  if (ev?.key !== 'settings') return state
  const v = ev?.value
  if (!v || typeof v !== 'object') return state
  return { ...state, ...v }
}
