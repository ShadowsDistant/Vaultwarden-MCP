// Mirrors the source tree into the build tree outside OneDrive, then (optionally) builds.
//
// Two reasons the build does not happen in place: OneDrive tries to sync node_modules,
// which is tens of thousands of files it has no business touching; and Claude Desktop is an
// MSIX package whose children get AppData writes redirected, so the runtime tree has to
// live under the user profile root instead.
//
//   node scripts/sync-build.mjs            copy only
//   node scripts/sync-build.mjs --install  copy, then npm install
//   node scripts/sync-build.mjs --build    copy, then tsc + build-ui

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = process.env.VW_MCP_BUILD_DIR ?? path.join(os.homedir(), '.vaultwarden-mcp', 'build');
const args = process.argv.slice(2);

const COPY = ['src', 'ui', 'scripts', 'assets', 'test', 'package.json', 'tsconfig.json', '.npmrc'];

fs.mkdirSync(build, { recursive: true });
for (const entry of COPY) {
  const from = path.join(root, entry);
  if (!fs.existsSync(from)) continue;
  const to = path.join(build, entry);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}
// The lockfile is copied only when it exists and matches; a stale one makes `npm ci` fail
// in a way that reads like a network error.
const lock = path.join(root, 'package-lock.json');
if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(build, 'package-lock.json'));
console.error(`sync: ${root} -> ${build}`);

/**
 * Where npm's CLI actually lives.
 *
 * It is not next to the node binary on every platform: a Linux tarball install (which is
 * what CI uses) keeps it under lib/node_modules, while a Windows install keeps it beside
 * node.exe. npm itself sets npm_execpath when it runs a script, so that is checked first and
 * is right whenever this was started by `npm run`. Calling the npm shim by name instead
 * would need a shell, which is exactly what the malformed PATH on some Windows machines
 * breaks.
 */
function findNpmCli() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Could not find npm. Run this through `npm run`, or install npm alongside node.');
  return found;
}

const npmCli = findNpmCli();

// This machine's system PATH contains an unbalanced quote. cmd.exe expands %PATH% while
// parsing, so any batch file npm shells out to dies with "operable program or batch file"
// and no useful diagnostic. Strip quotes and empty entries for the child only; editing the
// real PATH would need admin rights on someone else's machine.
const cleanPath = (process.env.PATH ?? '')
  .split(';')
  .map((p) => p.replace(/"/g, '').trim())
  .filter(Boolean)
  .join(';');
const childEnv = { ...process.env, PATH: cleanPath, Path: cleanPath };

const runNpm = (...a) => execFileSync(process.execPath, [npmCli, ...a], { cwd: build, stdio: 'inherit', env: childEnv });

if (args.includes('--install')) {
  // --legacy-peer-deps: ext-apps declares react as a peer and this server never renders any.
  runNpm('install', '--legacy-peer-deps', '--no-audit', '--no-fund');
  fs.copyFileSync(path.join(build, 'package-lock.json'), lock);
  console.error('sync: lockfile copied back to the repo');
}

if (args.includes('--build')) {
  execFileSync(process.execPath, [path.join(build, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: build,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [path.join(build, 'scripts', 'build-ui.mjs')], { cwd: build, stdio: 'inherit' });
}
