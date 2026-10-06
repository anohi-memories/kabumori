// Executes the actual workflow validator, not a duplicated validation model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/ai-lab-diary-snapshot.yml', 'utf8');
const block = workflow.match(/<<'NODE'\n([\s\S]*?)\n          NODE/);
assert.ok(block, 'workflow validator must exist');
const validator = block[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const valid = '## 2026-10-01\nevent_id: 20261001-account-selection-check\nchanged: 接続先のアカウントが重複していた\n';
function validate(markdown) {
  const code = markdown === undefined ? validator : validator.replace('await readFile(path, "utf8")', JSON.stringify(markdown));
  return execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module'], { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
test('H1 CI CONTROL: actual canonical eight-event validator passes', () => assert.match(validate(), /Validated 8/));
test('H1 CI CONTROL: missing, invalid and repeated entries fail before generation', () => {
  for (const fixture of [valid.replace(/^event_id:.*\n/m, ''), valid.replace('20261001-account', '20260930-account'), valid + valid]) {
    assert.throws(() => validate(fixture));
  }
});
test('H1 CI REQUIRED: duplicate event_id labels must not silently rewrite identity', () => {
  const bad = valid.replace('changed:', 'event_id: 20261001-account-selection-recheck\nchanged:');
  assert.throws(() => validate(bad), 'actual workflow accepts last-wins event_id rename');
});
