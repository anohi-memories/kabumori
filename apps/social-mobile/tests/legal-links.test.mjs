import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLegalDiagnostics, LEGAL_LINK_LABELS, resolveLegalLinks, validateSupportEmail, validateWebLink } from '../src/domain/legal-links.ts';

test('web links: https on a real host only; everything else is unavailable, never guessed', () => {
  assert.deepEqual(validateWebLink('https://policies.kabumori.jp/privacy'), { status: 'ok', href: 'https://policies.kabumori.jp/privacy' });
  assert.deepEqual(validateWebLink(undefined), { status: 'missing', href: null });
  assert.deepEqual(validateWebLink('   '), { status: 'missing', href: null });
  assert.deepEqual(validateWebLink('not a url'), { status: 'invalid_url', href: null });
  assert.deepEqual(validateWebLink('http://kabumori.jp/privacy'), { status: 'not_https', href: null });
  assert.deepEqual(validateWebLink('javascript:alert(1)'), { status: 'not_https', href: null });
  assert.deepEqual(validateWebLink('https://user:pw@kabumori.jp/privacy'), { status: 'invalid_url', href: null });
  assert.deepEqual(validateWebLink('https://kabumori.jp:8443/privacy'), { status: 'invalid_url', href: null });
  for (const placeholder of ['https://example.com/privacy', 'https://www.example.org/terms', 'https://localhost/x', 'https://site.test/x', 'https://127.0.0.1/x', 'https://intranet/x', 'https://a.invalid/x']) {
    assert.equal(validateWebLink(placeholder).status, 'placeholder', placeholder);
  }
});

test('links that carry credential-like parameters are refused', () => {
  for (const url of ['https://kabumori.jp/p?token=abc', 'https://kabumori.jp/p?api_key=x', 'https://kabumori.jp/p?X-Amz-Signature=1', 'https://kabumori.jp/p#access_token=x']) {
    assert.deepEqual(validateWebLink(url), { status: 'credential_like', href: null }, url);
  }
  assert.equal(validateWebLink('https://kabumori.jp/p?lang=ja').status, 'ok');
});

test('support: https page first, then a real e-mail address, else unavailable', () => {
  assert.deepEqual(validateSupportEmail('support@kabumori.jp'), { status: 'ok', href: 'mailto:support@kabumori.jp' });
  assert.equal(validateSupportEmail('support@example.com').status, 'placeholder');
  assert.equal(validateSupportEmail('nope').status, 'invalid_url');
  const both = resolveLegalLinks({ privacyPolicyUrl: undefined, termsUrl: undefined, supportUrl: 'https://kabumori.jp/support', supportEmail: 'support@kabumori.jp' });
  assert.equal(both.support.href, 'https://kabumori.jp/support');
  const mailOnly = resolveLegalLinks({ privacyPolicyUrl: undefined, termsUrl: undefined, supportUrl: undefined, supportEmail: 'support@kabumori.jp' });
  assert.equal(mailOnly.support.href, 'mailto:support@kabumori.jp');
  const badPageGoodMail = resolveLegalLinks({ privacyPolicyUrl: undefined, termsUrl: undefined, supportUrl: 'http://x.jp', supportEmail: 'support@kabumori.jp' });
  assert.equal(badPageGoodMail.support.status, 'ok');
  const badPage = resolveLegalLinks({ privacyPolicyUrl: undefined, termsUrl: undefined, supportUrl: 'http://x.jp', supportEmail: undefined });
  assert.deepEqual(badPage.support, { id: 'support', status: 'not_https', href: null });
});

test('nothing configured: all unavailable; diagnostics carry status codes only', () => {
  const links = resolveLegalLinks({ privacyPolicyUrl: undefined, termsUrl: undefined, supportUrl: undefined, supportEmail: undefined });
  for (const id of ['privacy', 'terms', 'support']) assert.deepEqual(links[id], { id, status: 'missing', href: null });
  assert.equal(formatLegalDiagnostics(links), 'legal: privacy=missing terms=missing support=missing');
  const configured = resolveLegalLinks({ privacyPolicyUrl: 'https://kabumori.jp/privacy', termsUrl: 'https://kabumori.jp/p?token=SECRETVALUE', supportUrl: undefined, supportEmail: 'help@kabumori.jp' });
  const line = formatLegalDiagnostics(configured);
  assert.equal(line, 'legal: privacy=ok terms=credential_like support=ok');
  assert.doesNotMatch(line, /kabumori\.jp|SECRETVALUE|help@/u);
  assert.deepEqual(LEGAL_LINK_LABELS, { privacy: 'プライバシーポリシー', terms: '利用規約', support: 'お問い合わせ' });
});
