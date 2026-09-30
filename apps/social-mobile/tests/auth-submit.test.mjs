// D3: sign-up has a visible in-flight/sent state and cannot be re-submitted by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emailSubmitView, SIGN_UP_COOLDOWN_MS } from '../src/domain/auth-submit.ts';

const root = resolve(import.meta.dirname, '..');
const base = { mode: 'sign_up', busy: false, allowed: true, signUpSentAt: null, now: 1_000_000 };

test('idle, in flight and sent states are visibly different', () => {
  assert.deepEqual(emailSubmitView(base), { disabled: false, label: '登録する', cooldownSeconds: 0 });
  assert.deepEqual(emailSubmitView({ ...base, busy: true }), { disabled: true, label: '登録しています…', cooldownSeconds: 0 });
  const sent = emailSubmitView({ ...base, signUpSentAt: base.now - 1000 });
  assert.equal(sent.disabled, true);
  assert.match(sent.label, /^送信済み（あと59秒で再送できます）$/u);
  assert.equal(emailSubmitView({ ...base, signUpSentAt: base.now - SIGN_UP_COOLDOWN_MS }).disabled, false, 'usable again after the cooldown');
  assert.equal(emailSubmitView({ ...base, allowed: false }).disabled, true);
});

test('the cooldown applies to sign-up only; sign-in and reset are unaffected', () => {
  for (const mode of ['sign_in', 'reset']) {
    const view = emailSubmitView({ ...base, mode, signUpSentAt: base.now });
    assert.equal(view.disabled, false, mode);
    assert.equal(view.cooldownSeconds, 0);
  }
  assert.equal(emailSubmitView({ ...base, mode: 'sign_in', busy: true }).label, 'ログインしています…');
  assert.equal(emailSubmitView({ ...base, mode: 'reset', busy: true }).label, '送信しています…');
});

test('the screen blocks duplicates synchronously and claims "sent" only after a successful sign-up', async () => {
  const screen = await readFile(join(root, 'src/components/auth-screen.tsx'), 'utf8');
  assert.match(screen, /if \(inFlight\.current\) return;/u, 'same-tick double press is ignored');
  const signUp = screen.slice(screen.indexOf("} else if (mode === 'sign_up') {"), screen.indexOf('} else {\n      const result = await auth.requestPasswordReset'));
  const failure = signUp.indexOf('if (!result.ok) setMessage');
  const sentAt = signUp.indexOf('setSignUpSentAt(Date.now())');
  assert.ok(failure > 0 && sentAt > failure, 'the sent state is set only on the success branch');
  assert.match(screen, /finally \{\s*inFlight\.current = false;\s*setBusy\(null\);/u, 'the guard is always released');
  assert.match(screen, /accessibilityRole="alert"/u, 'messages are announced');
});
