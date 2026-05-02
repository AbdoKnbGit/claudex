#!/usr/bin/env node
// Recursively syntax-check every .js file under src/ using `node --check`.
// Replaces the inline one-liner that only read the top-level src/ dir and
// missed the new companion/ tree.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const root = path.resolve(__dirname, '..', 'src');
const files = walk(root, []);

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Lint OK — ${files.length} file(s) checked.`);
