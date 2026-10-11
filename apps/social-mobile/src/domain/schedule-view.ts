/**
 * View logic for the schedule tab (pure; no React, network or storage).
 *
 *   R2  The AI planning inputs (remembered frequency, owner's approvalMode) are bound to the exact brand
 *       they were read for. They are never shown for another brand, never survive a workspace switch, and
 *       a late answer for a previous brand/load is discarded. An unreadable brand is labelled as such.
 *   R3  Production `scheduled_posts` rows have no account binding (`accountId: 'unknown'`). They are brand-
 *       level: they are never relabelled as the selected account's posts, never enter a per-account
 *       conflict solver, and never appear under another brand.
 */

export const DEFAULT_AI_FREQUENCY = 3;
export const DEFAULT_AI_APPROVAL_MODE = 'manual_review';

export type AiSettingsStatus = 'unloaded' | 'loading' | 'ready' | 'no_saved_settings' | 'unavailable' | 'blocked';

/** What the planner may use for AI slots. `default` means nothing remembered was read for this brand. */
export type AiPlanning = {
  frequencyTargetPerWeek: number;
  approvalMode: string;
  source: 'saved' | 'default';
  status: AiSettingsStatus;
};

export type AiSettingsState = {
  /** The brand this state belongs to; any other brand sees the unloaded default. */
  brandId: string | null;
  /** Monotonic load id: only the answer to the latest load of the current brand is accepted. */
  loadId: number;
  status: AiSettingsStatus;
  frequencyTargetPerWeek: number;
  approvalMode: string;
};

export const AI_SETTINGS_UNLOADED: AiSettingsState = {
  brandId: null,
  loadId: 0,
  status: 'unloaded',
  frequencyTargetPerWeek: DEFAULT_AI_FREQUENCY,
  approvalMode: DEFAULT_AI_APPROVAL_MODE,
};

export type AiSettingsRead =
  | { state: 'ready'; data: { frequencyTargetPerWeek: number; approvalMode: string } | null }
  | { state: 'unavailable' }
  | { state: 'blocked' };

/** A new load for `brandId`: everything remembered for any other brand is dropped at once. */
export function startAiSettingsLoad(_state: AiSettingsState, brandId: string, loadId: number): AiSettingsState {
  return { ...AI_SETTINGS_UNLOADED, brandId, loadId, status: 'loading' };
}

/** Applies a read result only if it answers the current load of the current brand. */
export function applyAiSettingsResult(state: AiSettingsState, brandId: string, loadId: number, result: AiSettingsRead): AiSettingsState {
  if (state.brandId !== brandId || state.loadId !== loadId) return state;
  if (result.state === 'ready') {
    if (!result.data) return { ...state, status: 'no_saved_settings', frequencyTargetPerWeek: DEFAULT_AI_FREQUENCY, approvalMode: DEFAULT_AI_APPROVAL_MODE };
    return { ...state, status: 'ready', frequencyTargetPerWeek: result.data.frequencyTargetPerWeek, approvalMode: result.data.approvalMode };
  }
  return { ...state, status: result.state, frequencyTargetPerWeek: DEFAULT_AI_FREQUENCY, approvalMode: DEFAULT_AI_APPROVAL_MODE };
}

/** The planning inputs for the brand shown right now. Anything not read for exactly this brand is the default. */
export function aiPlanningFor(state: AiSettingsState, brandId: string | null | undefined): AiPlanning {
  if (!brandId || state.brandId !== brandId) {
    return { frequencyTargetPerWeek: DEFAULT_AI_FREQUENCY, approvalMode: DEFAULT_AI_APPROVAL_MODE, source: 'default', status: 'unloaded' };
  }
  if (state.status === 'ready') {
    return { frequencyTargetPerWeek: state.frequencyTargetPerWeek, approvalMode: state.approvalMode, source: 'saved', status: 'ready' };
  }
  return { frequencyTargetPerWeek: DEFAULT_AI_FREQUENCY, approvalMode: DEFAULT_AI_APPROVAL_MODE, source: 'default', status: state.status };
}

// ---------------------------------------------------------------------------------------------------
// R3: attributing server rows
// ---------------------------------------------------------------------------------------------------

export type ViewAccount = { id: string; brandId?: string; platform: string };
export type ServerRow = { id: string; accountId: string; brandId?: string; scheduledAt: string; origin: string; status: string; text: string };

export type ClassifiedServerPosts = {
  /** Rows verifiably bound to the active account: the only rows the per-account solver may see. */
  accountBound: ServerRow[];
  /** Rows of the active account's brand with no account binding: shown read-only, never attributed. */
  brandLevel: ServerRow[];
  /** Rows that cannot be placed under the active account/brand (unknown brand or another brand's account). */
  unattributable: ServerRow[];
};

const UNBOUND = 'unknown';

export function classifyServerPosts(input: {
  rows: ServerRow[];
  accounts: ViewAccount[];
  activeAccount: ViewAccount | null;
  isPreview: boolean;
}): ClassifiedServerPosts {
  const result: ClassifiedServerPosts = { accountBound: [], brandLevel: [], unattributable: [] };
  const active = input.activeAccount;
  if (!active) return result;
  const accountBrand = new Map(input.accounts.map((account) => [account.id, account.brandId]));
  for (const row of input.rows) {
    if (row.accountId !== UNBOUND) {
      // Bound to an account: only the active account's own rows. Another brand's account is unattributable.
      if (row.accountId === active.id) result.accountBound.push(row);
      else if (input.isPreview) continue; // sample data of another account: simply not this account's
      else if (accountBrand.get(row.accountId) !== undefined && accountBrand.get(row.accountId) !== active.brandId) result.unattributable.push(row);
      continue;
    }
    // Brand-level (no account binding in production).
    if (!row.brandId) result.unattributable.push(row);
    else if (row.brandId === active.brandId) result.brandLevel.push(row);
    // another brand's rows are simply not this workspace's
  }
  return result;
}
