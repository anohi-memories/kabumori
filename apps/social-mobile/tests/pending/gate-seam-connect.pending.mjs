// PENDING (F5): connecting the ServiceEnrollmentGate's lifecycle input to F4's ServiceLifecycleProvider.
// NOT part of `npm test`. Run: `node --test tests/pending/gate-seam-connect.pending.mjs`.
// The gate reads the signal ONLY through src/features/service-enrollment/lifecycle-epoch.ts (an F5-owned seam). F4's
// provider is not in this stack, so the seam answers 0 for everybody and LIFECYCLE_SIGNAL_CONNECTED is false. This spec
// FAILS until F4's provider exists and the seam is switched to it (one line; see the status comment in the seam).
// When it passes, delete this file, add the seam module to F4's tests/pending/service-end-gate.pending.mjs module map
// (one line, see docs/f5-postona-service-end-entitlement-epoch.md section 6) and activate F4's [SPEC G1 / F5 gate] specs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFile(join(root, path), 'utf8');

test('[SPEC seam / F5 gate] F4\'s provider exists and exports the per-person epoch hook the seam re-exports', async () => {
  const provider = await read('src/features/service-lifecycle/service-lifecycle.tsx');   // fails before: F4 has not added it yet
  assert.match(provider, /export function useServiceLifecycleEpoch\(/u, 'F4 confirms the exact export and signature (userId -> number)');
  const seam = await read('src/features/service-enrollment/lifecycle-epoch.ts');
  assert.match(seam, /export \{ useServiceLifecycleEpoch as useLifecycleEpoch \} from '@\/features\/service-lifecycle\/service-lifecycle';/u);
  assert.match(seam, /LIFECYCLE_SIGNAL_CONNECTED = true;/u);
});
