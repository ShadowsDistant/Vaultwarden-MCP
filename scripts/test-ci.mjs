// Runs the test suite for CI and turns each failure into a GitHub annotation, so the reason a
// run failed is readable on the run page (and through the public API) without the full log.
//
//   node scripts/test-ci.mjs

import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', '--test-timeout=120000', 'test/unit/*.test.mjs', 'test/e2e/*.test.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('close', (code) => {
  if (code !== 0) {
    const lines = out.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/^\s*not ok \d+ - /.test(line)) return;
      const detail = lines
        .slice(i + 1, i + 25)
        .filter((l) => /^\s+(error|expected|actual|location|code):/.test(l) || /^\s+at .*\.test\.mjs/.test(l))
        .map((l) => l.trim())
        .join(' | ')
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
      console.log(`::error title=${line.trim().replace(/[:,]/g, ' ').slice(0, 120)}::${detail.slice(0, 900)}`);
    });
  }
  process.exit(code ?? 1);
});
