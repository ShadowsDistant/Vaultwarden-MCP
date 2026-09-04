// Clipboard helper for Vaultwarden MCP (Linux), via wl-copy or xclip.
//   -Set        secret on stdin -> clipboard, prints the SHA-256 of what was written
//   -Clear <h>  clears the clipboard only if it still holds that value

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const which = (cmd) =>
  new Promise((resolve) =>
    execFile('sh', ['-c', `command -v ${cmd}`], (err, out) => resolve(!err && Boolean(String(out).trim()))),
  );

const read = () =>
  new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });

const wayland = await which('wl-copy');
const x11 = wayland ? false : await which('xclip');
if (!wayland && !x11) process.exit(1);

const paste = () =>
  new Promise((resolve) => {
    const cmd = wayland ? ['wl-paste', ['--no-newline']] : ['xclip', ['-selection', 'clipboard', '-o']];
    execFile(cmd[0], cmd[1], (err, out) => resolve(err ? '' : String(out)));
  });

const copy = (text) =>
  new Promise((resolve) => {
    // wl-copy's --sensitive keeps the value out of clipboard managers that honour it.
    const p = wayland ? spawn('wl-copy', ['--sensitive']) : spawn('xclip', ['-selection', 'clipboard']);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
    p.stdin.write(text);
    p.stdin.end();
  });

const args = process.argv.slice(2);
const i = args.findIndex((a) => a === '-Clear');

if (i >= 0) {
  const want = String(args[i + 1] ?? '').toLowerCase();
  const current = await paste();
  if (current && sha(current) === want) {
    await copy('');
    process.stdout.write('cleared');
  } else {
    process.stdout.write('kept');
  }
  process.exit(0);
}

const secret = (await read()).replace(/\r?\n$/, '');
if (!secret) process.exit(1);
const ok = await copy(secret);
if (!ok) process.exit(1);
process.stdout.write(sha(secret));
