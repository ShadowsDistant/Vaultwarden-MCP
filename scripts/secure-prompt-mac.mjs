// Native dialog for Vaultwarden MCP (macOS), via osascript.
//
// Reads a JSON spec on stdin, writes {"ok":true,"values":{…}} or {"ok":false} on stdout.
// AppleScript has no multi-field form, so a spec with several fields becomes several
// dialogs in sequence; cancelling any one of them cancels the whole request.
//
// Every string that reaches AppleScript is passed as an argument to `osascript -e` with the
// script itself built through a quoting helper. AppleScript string literals only need
// backslash and double-quote escaped, and nothing else in a spec can break out.

import { execFile } from 'node:child_process';

function q(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function osa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 175_000 }, (err, stdout) => {
      // A cancelled dialog exits non-zero with "User canceled." on stderr.
      resolve({ ok: !err, out: String(stdout ?? '').trim() });
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

if (spec.kind === 'confirm') {
  const okLabel = String(spec.confirmLabel ?? 'Confirm');
  const cancelLabel = String(spec.cancelLabel ?? 'Cancel');
  // The safe answer is the default on a destructive prompt.
  const def = spec.danger ? cancelLabel : okLabel;
  const script = `display dialog ${q(message)} with title ${q(title)} buttons {${q(cancelLabel)}, ${q(okLabel)}} default button ${q(def)}${spec.danger ? ' with icon caution' : ''}`;
  const r = await osa(script);
  answer(r.ok && r.out.includes(okLabel) ? { ok: true, values: {} } : { ok: false });
}

const values = {};
const fields = Array.isArray(spec.fields) ? spec.fields : [];
for (const f of fields) {
  const label = String(f.label ?? f.name ?? 'Value');
  const prompt = `${message}\n\n${label}:`;
  const hidden = f.secret ? ' with hidden answer' : '';
  const preset = f.value ? q(String(f.value)) : '""';
  const script =
    `display dialog ${q(prompt)} with title ${q(title)} default answer ${preset}${hidden} ` +
    `buttons {${q(String(spec.cancelLabel ?? 'Cancel'))}, ${q(String(spec.confirmLabel ?? 'OK'))}} ` +
    `default button ${q(String(spec.confirmLabel ?? 'OK'))} with icon note`;
  const r = await osa(script);
  if (!r.ok) answer({ ok: false });
  const m = r.out.match(/text returned:([\s\S]*?)(?:, button returned:.*)?$/);
  const text = m ? m[1] : '';
  if (!text && !f.optional) answer({ ok: false });
  values[String(f.name)] = text;
}

answer({ ok: true, values });
