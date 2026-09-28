import test from 'node:test';
import assert from 'node:assert/strict';
import { signInErrorMessage } from '../src/lib/auth-errors.ts';

test('sign-in errors map to fixed messages and never echo provider text', () => {
  const secretish = { code: 'invalid_credentials', status: 400, message: 'user me@example.com not found' };
  const message = signInErrorMessage(secretish);
  assert.equal(message, 'メールアドレスまたはパスワードを確認してください。');
  assert.ok(!message.includes('example.com'));
  assert.match(signInErrorMessage({ code: 'email_not_confirmed', status: 400 }), /確認メール/u);
  assert.match(signInErrorMessage({ status: 429 }), /しばらく待って/u);
  assert.match(signInErrorMessage({ name: 'AuthRetryableFetchError', status: 0 }), /通信できませんでした/u);
  assert.match(signInErrorMessage({ status: 503 }), /通信できませんでした/u);
  assert.equal(signInErrorMessage(null), 'メールアドレスまたはパスワードを確認してください。');
});
