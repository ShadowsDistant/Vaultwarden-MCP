// Native dialog for Vaultwarden MCP (Linux), via zenity or kdialog.
//
// Reads a JSON spec on stdin, writes {"ok":true,"values":{…}} or {"ok":false} on stdout.
// Values reach the tools as argv here, which is safe in this direction: labels and titles
// are not secret. What the user types comes back on the child's stdout and goes no further.

import { execFile } from 'node:child_process';

function which(cmd) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${cmd}`], (err, stdout) => resolve(!err && Boolean(String(stdout).trim())));
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 175_000 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '').replace(/\n$/, '') });
    });
  });
}

const read = () =>
  new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });

const answer = (v) => {
  process.stdout.write(JSON.stringify(v));
  process.exit(v.ok ? 0 : 1);
};

const raw = await read();
const start = raw.indexOf('{');
if (start < 0) answer({ ok: false });
let spec;
try {
  spec = JSON.parse(raw.slice(start));
} catch {
  answer({ ok: false });
}

const title = String(spec.title ?? 'Vault');
const message = String(spec.message ?? '');
const hasZenity = await which('zenity');
const hasKdialog = hasZenity ? false : await which('kdialog');
if (!hasZenity && !hasKdialog) answer({ ok: false });

if (spec.kind === 'confirm') {
  const r = hasZenity
    ? await run('zenity', [
        '--question',
        `--title=${title}`,
        `--text=${message}`,
        `--ok-label=${spec.confirmLabel ?? 'Confirm'}`,
        `--cancel-label=${spec.cancelLabel ?? 'Cancel'}`,
        ...(spec.danger ? ['--default-cancel'] : []),
      ])
    : await run('kdialog', ['--title', title, '--warningyesno', message]);
  answer(r.ok ? { ok: true, values: {} } : { ok: false });
}

const values = {};
for (const f of Array.isArray(spec.fields) ? spec.fields : []) {
  const label = String(f.label ?? f.name ?? 'Value');
  const text = `${message}\n\n${label}:`;
  let r;
  if (hasZenity) {
    r = f.secret
      ? await run('zenity', ['--password', `--title=${title}`])
      : await run('zenity', ['--entry', `--title=${title}`, `--text=${text}`, `--entry-text=${f.value ?? ''}`]);
  } else {
    r = f.secret
      ? await run('kdialog', ['--title', title, '--password', text])
      : await run('kdialog', ['--title', title, '--inputbox', text, String(f.value ?? '')]);
  }
  if (!r.ok) answer({ ok: false });
  if (!r.out && !f.optional) answer({ ok: false });
  values[String(f.name)] = r.out;
}

answer({ ok: true, values });
