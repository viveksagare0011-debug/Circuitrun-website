// Runs every test file and prints one summary. Usage: npm test
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ['browser.test.js', 'sql-rules.test.mjs', 'sql-concurrency.test.mjs'];
let failed = 0; const rows = [];
for (const f of files) {
  console.log('\n######## ' + f);
  const r = spawnSync('node', [path.join(dir, f)], { stdio: 'inherit', env: process.env });
  rows.push([f, r.status === 0 ? 'PASS' : 'FAIL']); if (r.status !== 0) failed++;
}
console.log('\n==== summary');
for (const [f, s] of rows) console.log((s === 'PASS' ? 'PASS ' : 'FAIL ') + f);
process.exit(failed ? 1 : 0);
