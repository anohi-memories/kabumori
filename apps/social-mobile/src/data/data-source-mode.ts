/**
 * Which data source this build uses. Pure (no imports) so it is unit-tested.
 *
 * - `supabase`: exactly the value "supabase" (real data; needs a valid Supabase config)
 * - `mock`: unset/empty or exactly "mock" (the explicit local preview; never real data)
 * - `invalid`: anything else (a typo must not silently become the mock preview
 *   in a build that was meant to use real data)
 */
export type DataSourceMode = 'supabase' | 'mock' | 'invalid';

export function dataSourceMode(value: string | undefined): DataSourceMode {
  const normalized = value?.trim();
  if (normalized === 'supabase') return 'supabase';
  if (normalized === undefined || normalized === '' || normalized === 'mock') return 'mock';
  return 'invalid';
}

export const INVALID_DATA_SOURCE_REASON = 'EXPO_PUBLIC_DATA_SOURCE の値が正しくありません（supabase または mock）。実データは読み込みません。';

export type InitialDataStatus = 'mock_preview' | 'loading' | 'blocked';

/** The first status before anything is loaded; must agree with the selection made later. */
export function initialDataStatusFor(mode: DataSourceMode): InitialDataStatus {
  return mode === 'supabase' ? 'loading' : mode === 'invalid' ? 'blocked' : 'mock_preview';
}
