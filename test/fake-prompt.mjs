// A stand-in for the native dialog, so login, confirm and reveal flows can be driven with
// no window on screen and no human.
//
//   FAKE_PROMPT_ANSWER=ok|cancel          what the user "pressed" (default ok)
//   FAKE_PROMPT_CONFIRM_ANSWER=ok|cancel  overrides the above for yes/no prompts only, so a
//                                         test can sign in successfully and still refuse a
//                                         reveal
//   FAKE_PROMPT_<FIELD>=value             the value typed into that field, upper-cased name
//   FAKE_PROMPT_LOG=<path>                append each spec, so tests can assert what was asked
//
// Reading the spec and answering from the environment keeps the contract identical to the
// real helpers: JSON in on stdin, JSON out on stdout.

import fs from 'node:fs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const start = raw.indexOf('{');
  const spec = start >= 0 ? JSON.parse(raw.slice(start)) : {};

  if (process.env.FAKE_PROMPT_LOG) {
    try {
      fs.appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify(spec) + '\n');
    } catch {
      /* logging is best effort */
    }
  }

  const answer =
    spec.kind === 'confirm' && process.env.FAKE_PROMPT_CONFIRM_ANSWER
      ? process.env.FAKE_PROMPT_CONFIRM_ANSWER
      : (process.env.FAKE_PROMPT_ANSWER ?? 'ok');
  if (answer.toLowerCase() !== 'ok') {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exit(1);
  }

  const values = {};
  for (const f of spec.fields ?? []) {
    const key = `FAKE_PROMPT_${String(f.name).toUpperCase()}`;
    values[f.name] = process.env[key] ?? f.value ?? '';
  }
  process.stdout.write(JSON.stringify({ ok: true, values }));
  process.exit(0);
});
