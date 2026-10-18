// F1 manual X single post: the pure TypeScript SHA-256 that binds the user's consent to the exact text.
// It must equal node:crypto (and therefore the server's sha256(convert_to(text, 'UTF8')) in hex) for every text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, utf8Bytes } from '../src/features/manual-publish/manual-publish-hash.ts';

const reference = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('published test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('equals node:crypto around every padding / block boundary', () => {
  for (let length = 0; length <= 200; length += 1) {
    const text = 'a'.repeat(length);
    assert.equal(sha256Hex(text), reference(text), `length ${length}`);
  }
});

test('equals node:crypto for multi-byte text: CJK, emoji (surrogate pairs), combining marks, newlines, tabs', () => {
  const samples = [
    'こんにちは世界', '😀', '𠮷野家', '🇯🇵🇺🇸', 'é', 'a\nb\tc', 'line1\nline2\n', 'あ'.repeat(1000), 'é€☃',
    'https://example.com/path?x=1&y=2 のリンク', '\u0001\u007f', '﻿先頭にBOM',
  ];
  for (const text of samples) assert.equal(sha256Hex(text), reference(text), JSON.stringify(text).slice(0, 40));
});

test('equals node:crypto on 400 pseudo-random texts (deterministic)', () => {
  let state = 12345;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const pool = ['a', 'Z', '0', ' ', '\n', 'あ', '漢', 'ー', '😀', '𠮷', 'é', '#', 'https://x.co/1 '];
  for (let i = 0; i < 400; i += 1) {
    let text = '';
    const n = next() % 300;
    for (let k = 0; k < n; k += 1) text += pool[next() % pool.length];
    assert.equal(sha256Hex(text), reference(text), `case ${i}`);
  }
});

test('the text is hashed exactly as given: a trailing space, CRLF vs LF and composed vs decomposed all differ', () => {
  const base = sha256Hex('hello');
  assert.notEqual(sha256Hex('hello '), base);
  assert.notEqual(sha256Hex('a\r\nb'), sha256Hex('a\nb'));
  assert.notEqual(sha256Hex('é'), sha256Hex('é'));
  assert.match(base, /^[0-9a-f]{64}$/u, 'lowercase hex, 64 digits (what the server compares against)');
});

test('utf8Bytes equals TextEncoder, and a lone surrogate becomes U+FFFD like TextEncoder', () => {
  for (const text of ['abc', 'あ', '😀', '𠮷', 'a\ud800b', '\udc00']) {
    assert.deepEqual(utf8Bytes(text), [...new TextEncoder().encode(text)], JSON.stringify(text));
  }
});
