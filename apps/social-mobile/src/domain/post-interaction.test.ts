import assert from 'node:assert/strict';
import test from 'node:test';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS, type SocialMobileContentSettings } from './content-settings.ts';
import {
  approveAvailability,
  editAvailability,
  failureReasonText,
  hasXReconnectNeeded,
  regenerateAvailability,
  retryAvailability,
  summarizePostingMode,
} from './post-interaction.ts';
import type { PostStatus, SocialAccount } from './types.ts';

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: 'a1',
    platform: 'x',
    profile: { displayName: 'x', handle: '@x', avatarColor: '#000', voice: { tone: '', language: 'ja', avoid: [] } },
    connectionStatus: 'connected',
    postingState: 'active',
    ...overrides,
  };
}

const settings: SocialMobileContentSettings = SOCIAL_MOBILE_CONTENT_DEFAULTS;

// --- every action is truthfully unavailable today, each with its own reason ---

test('edit/regenerate/approve are unavailable with a non-empty reason, and never claim success', () => {
  for (const availability of [editAvailability(), regenerateAvailability(), approveAvailability()]) {
    assert.equal(availability.available, false);
    assert.ok(!availability.available && availability.reason.length > 0);
  }
});

test('retry is unavailable for every status, but the reason differs for a failed post', () => {
  const statuses: PostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'failed'];
  const reasons = new Set<string>();
  for (const status of statuses) {
    const availability = retryAvailability(status);
    assert.equal(availability.available, false);
    if (!availability.available) reasons.add(availability.reason);
  }
  // failed has a distinct reason from every non-failed status.
  assert.equal(reasons.size, 2);
});

test('failure reason text is shown only for a failed post', () => {
  for (const status of ['draft', 'scheduled', 'publishing', 'published'] as const) {
    assert.equal(failureReasonText(status), null, status);
  }
  assert.notEqual(failureReasonText('failed'), null);
  assert.ok((failureReasonText('failed') ?? '').length > 0);
});

// --- reconnect CTA condition ---

test('reconnect is needed only when a connected-platform X account needs attention', () => {
  assert.equal(hasXReconnectNeeded([]), false);
  assert.equal(hasXReconnectNeeded([account({ connectionStatus: 'connected' })]), false);
  assert.equal(hasXReconnectNeeded([account({ connectionStatus: 'needs_attention' })]), true);
  // A non-X account needing attention does not trigger the X reconnect CTA.
  assert.equal(hasXReconnectNeeded([account({ platform: 'instagram', connectionStatus: 'needs_attention' })]), false);
  // Any one X account needing attention is enough, even with other accounts fine.
  assert.equal(
    hasXReconnectNeeded([account({ id: 'a2', connectionStatus: 'connected' }), account({ id: 'a1', connectionStatus: 'needs_attention' })]),
    true,
  );
});

// --- manual approval vs auto-post: two independent axes ---

test('no account selected reads autoPostEnabled as unknown (null), never a guessed on/off', () => {
  assert.equal(summarizePostingMode(null, settings).autoPostEnabled, null);
});

test('autoPostEnabled reflects the account postingState directly', () => {
  assert.equal(summarizePostingMode(account({ postingState: 'active' }), settings).autoPostEnabled, true);
  assert.equal(summarizePostingMode(account({ postingState: 'paused' }), settings).autoPostEnabled, false);
});

test('approvalMode reflects content settings, or null when settings are not available', () => {
  assert.equal(summarizePostingMode(account(), null).approvalMode, null);
  assert.equal(summarizePostingMode(account(), { ...settings, approvalMode: 'manual_review' }).approvalMode, 'manual_review');
  assert.equal(summarizePostingMode(account(), { ...settings, approvalMode: 'auto_post_preference' }).approvalMode, 'auto_post_preference');
});

test('autoPostEnabled and approvalMode are independent: a paused account can still be manual_review, an active one can still require review', () => {
  const paused = summarizePostingMode(account({ postingState: 'paused' }), { ...settings, approvalMode: 'manual_review' });
  assert.equal(paused.autoPostEnabled, false);
  assert.equal(paused.approvalMode, 'manual_review');

  const activeButManual = summarizePostingMode(account({ postingState: 'active' }), { ...settings, approvalMode: 'manual_review' });
  assert.equal(activeButManual.autoPostEnabled, true);
  assert.equal(activeButManual.approvalMode, 'manual_review');
});
