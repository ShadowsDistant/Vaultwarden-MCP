// A stand-in for the clipboard helper. Writes what it was given to FAKE_CLIP_FILE so tests
// can assert that a copy really carried the secret, and that a clear removed it.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.env.FAKE_CLIP_FILE ?? 'fake-clipboard.txt';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const args = process.argv.slice(2);
const clearAt = args.indexOf('-Clear');

if (clearAt >= 0) {
  const want = String(args[clearAt + 1] ?? '').toLowerCase();
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = '';
  }
  if (current && sha(current) === want) {
    fs.writeFileSync(file, '');
    process.stdout.write('cleared');
  } else {
    process.stdout.write('kept');
  }
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const secret = raw.replace(/\r?\n$/, '');
  if (!secret) process.exit(1);
  fs.writeFileSync(file, secret);
  process.stdout.write(sha(secret));
  process.exit(0);
});
