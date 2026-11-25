/* The page validator (map-validate.js) and tools/validate_ai_map.py must report the
   same issues. Runs both over every manifest map and every tools/fixtures/*.json and
   compares the multiset of severity|code|id. */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { validate } = require('../map-validate.js');

const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'maps', 'manifest.json'), 'utf8')).maps;
const fixtures = fs.readdirSync(path.join(__dirname, 'fixtures')).filter(name => name.endsWith('.json')).map(name => `tools/fixtures/${name}`);
const files = [...manifest.map(entry => entry.file), ...fixtures];

const keys = result => [
  ...result.errors.map(item => `error|${item.code}|${item.id ?? ''}`),
  ...result.warnings.map(item => `warn|${item.code}|${item.id ?? ''}`),
].sort();

let failed = 0;
for (const file of files) {
  let output;
  try {
    output = execFileSync(python, ['tools/validate_ai_map.py', file, '--json'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    output = error.stdout; // exit code 1 when the map has errors
  }
  const py = keys(JSON.parse(output));
  const js = keys(validate(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^﻿/, ''))));
  const same = py.length === js.length && py.every((key, index) => key === js[index]);
  const errors = py.filter(key => key.startsWith('error')).length;
  console.log(`${same ? 'same' : 'DIFF'}  ${file}  (${errors} errors, ${py.length - errors} warnings)`);
  if (!same) {
    failed += 1;
    console.log('  python only:', py.filter(key => !js.includes(key)));
    console.log('  js only:    ', js.filter(key => !py.includes(key)));
  }
}
// Every issue code must be explained in AI_GUIDE.md (section 7) so AIs can fix it.
const codes = new Set([...fs.readFileSync(path.join(root, 'map-validate.js'), 'utf8').matchAll(/(?:error|warn)\('([a-z-]+)'/g)].map(match => match[1]));
const guide = fs.readFileSync(path.join(root, 'AI_GUIDE.md'), 'utf8');
const undocumented = [...codes].filter(code => !guide.includes(`\`${code}\``));
console.log(`${undocumented.length ? 'DIFF' : 'same'}  AI_GUIDE.md documents ${codes.size - undocumented.length}/${codes.size} codes`);
if (undocumented.length) {
  console.log('  undocumented:', undocumented);
  failed += 1;
}
if (failed) {
  console.log(`validator parity FAILED for ${failed} file(s)`);
  process.exit(1);
}
console.log('validator parity ok');
