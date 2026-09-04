// Clipboard helper for Vaultwarden MCP (macOS).
//   -Set        secret on stdin -> clipboard, prints the SHA-256 of what was written
//   -Clear <h>  clears the clipboard only if it still holds that value

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const read = () =>
  new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });

const pbpaste = () =>
  new Promise((resolve) => execFile('pbpaste', (err, out) => resolve(err ? '' : String(out))));

const pbcopy = (text) =>
  new Promise((resolve) => {
    const p = spawn('pbcopy');
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
    p.stdin.write(text);
    p.stdin.end();
  });

const args = process.argv.slice(2);
const i = args.findIndex((a) => a === '-Clear');

if (i >= 0) {
  const want = String(args[i + 1] ?? '').toLowerCase();
  const current = await pbpaste();
  if (current && sha(current) === want) {
    await pbcopy('');
    process.stdout.write('cleared');
  } else {
    process.stdout.write('kept');
  }
  process.exit(0);
}

const secret = (await read()).replace(/\r?\n$/, '');
if (!secret) process.exit(1);
const ok = await pbcopy(secret);
if (!ok) process.exit(1);
process.stdout.write(sha(secret));
