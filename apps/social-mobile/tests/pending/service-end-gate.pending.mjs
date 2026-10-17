// PENDING (optional F5 follow-up) for the POSTONA service-end gates G1 / G2 (design B,
// docs/postona-service-end-gate-g1-g2-design.md). NOT part of `npm test`.
// Run: `node --test tests/pending/service-end-gate.pending.mjs`.
// The F4+F5 joint integration (tests/service-end-g1-g2-integration.test.mjs) activated the former [SPEC G1 / F5 gate]
// specs and controls with the REAL provider, seam, gate, surface and end screen. What is left is F5's connection step 5
// (docs/f5-postona-service-end-entitlement-epoch.md section 5): the gate still renders its own copy of the end screen
// for its closed states. That copy is drawn by the gate itself and survives a new login of the same person (pinned in
// the integration test), so G1/G2 hold without it; replacing it with `open(userId)` only removes a second entry point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFile(join(root, path), 'utf8');

test('[SPEC G2 / F5 gate, optional] the gate opens the F4 surface instead of rendering its own copy of the end screen', async () => {
  const gate = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  assert.doesNotMatch(gate, /<AccountDeletionScreen \/>/u, 'one entry point: the surface outside the gate');
  assert.match(gate, /\.open\(/u, 'its 「利用終了・共通IDの管理」 link opens the surface for the person it shows');
});
