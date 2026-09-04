// Builds the .mcpb bundle Claude Desktop installs as an extension.
//
//   node scripts/pack-mcpb.mjs
//
// Staged from a clean tree with production dependencies only, then zipped. The output lands
// in out/ and is what a release attaches.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'out', 'stage');
const outDir = path.join(root, 'out');

// The system PATH on some Windows machines carries an unbalanced quote, which breaks any
// batch file npm shells out to. Strip it for the children.
const cleanPath = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((p) => p.replace(/"/g, '').trim())
  .filter(Boolean)
  .join(path.delimiter);
const childEnv = { ...process.env, PATH: cleanPath, Path: cleanPath };

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.js'))) {
  console.error('Nothing built. Run `npm run build` first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(dist, 'ui', 'card.html'))) {
  console.error('The card is not built. Run `npm run build` first.');
  process.exit(1);
}

fs.cpSync(dist, path.join(stage, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
for (const f of ['README.md', 'LICENSE', 'SECURITY.md']) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(stage, 'icon.png'));

// Runtime dependencies only. The Bitwarden CLI travels inside the bundle, so the extension
// works without anything installed globally.
const lock = path.join(root, 'package-lock.json');
if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(stage, 'package-lock.json'));
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
console.error('installing production dependencies…');
execFileSync(process.execPath, [npmCli, 'install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: stage,
  stdio: 'inherit',
  env: childEnv,
});

const manifest = {
  manifest_version: '0.3',
  name: 'vaultwarden',
  display_name: 'Vaultwarden',
  version: pkg.version,
  description: 'Read and write a self-hosted Vaultwarden vault. Secrets stay out of the conversation.',
  long_description:
    'Connects Claude to a self-hosted Vaultwarden (or Bitwarden) vault through the official Bitwarden CLI. ' +
    'Claude can search the vault, look items up, prepare new logins and stage edits — but it never receives a ' +
    'password, one-time code or note. Those are shown in an inline card for you, or copied straight to your ' +
    'clipboard by the server. Signing in and unlocking happen in a window on your desktop, so your master ' +
    'password never enters the conversation. Nothing is written to the vault until you confirm it, and deletes ' +
    'only ever move an item to the trash.',
  author: { name: 'ShadowsDistant', url: 'https://github.com/ShadowsDistant' },
  homepage: 'https://github.com/ShadowsDistant/Vaultwarden-MCP',
  documentation: 'https://github.com/ShadowsDistant/Vaultwarden-MCP#readme',
  support: 'https://github.com/ShadowsDistant/Vaultwarden-MCP/issues',
  repository: { type: 'git', url: 'https://github.com/ShadowsDistant/Vaultwarden-MCP' },
  license: 'MIT',
  keywords: ['vaultwarden', 'bitwarden', 'password manager', 'passwords', 'vault', 'security'],
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: {
        VW_MCP_SERVER_URL: '${user_config.server_url}',
        VW_MCP_EMAIL: '${user_config.email}',
        VW_MCP_IDLE_LOCK_MIN: '${user_config.idle_lock_minutes}',
        VW_MCP_MODEL_REVEAL: '${user_config.model_reveal}',
      },
    },
  },
  user_config: {
    server_url: {
      type: 'string',
      title: 'Vault address',
      description: 'Your Vaultwarden instance, for example https://vault.example.com. Set here rather than in chat, so nothing in a conversation can point the vault somewhere else.',
      required: true,
    },
    email: {
      type: 'string',
      title: 'Account email',
      description: 'Used to pre-fill the sign-in window. Optional.',
      required: false,
    },
    idle_lock_minutes: {
      type: 'number',
      title: 'Lock after (minutes of inactivity)',
      description: 'Leave at 0 to lock only when Claude Desktop closes, which is the default. Set a number of minutes to also lock after that long with nothing happening.',
      default: 0,
      required: false,
    },
    model_reveal: {
      type: 'string',
      title: 'Let Claude read a secret when you approve it',
      description: '"ask" lets Claude request one secret at a time, with a desktop window you must say yes to every time. "off" refuses outright; you can still reveal and copy values in the card.',
      default: 'ask',
      required: false,
    },
  },
  tools: [
    { name: 'vault_status', description: 'Show whether the vault is signed in, locked or unlocked' },
    { name: 'vault_login', description: 'Sign in, in a window on your desktop' },
    { name: 'vault_unlock', description: 'Unlock, in a window on your desktop' },
    { name: 'vault_lock', description: 'Lock the vault immediately' },
    { name: 'vault_sync', description: 'Pull the latest vault contents' },
    { name: 'vault_search', description: 'Find items by name, site or folder' },
    { name: 'vault_get_item', description: 'Show one item, without its secrets' },
    { name: 'vault_list_folders', description: 'List the vault folders' },
    { name: 'vault_reveal_secret', description: 'Ask you, in a desktop window, to release one secret into the conversation' },
    { name: 'vault_generate_password', description: 'Generate a password or passphrase, shown only in the card' },
    { name: 'vault_create_login', description: 'Prepare a new login for you to save' },
    { name: 'vault_edit_item', description: 'Prepare a change for you to confirm' },
    { name: 'vault_trash_item', description: 'Prepare to move an item to the trash' },
    { name: 'vault_restore_item', description: 'Bring an item back out of the trash' },
  ],
  tools_generated: false,
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: ['win32', 'darwin', 'linux'],
    runtimes: { node: '>=20.0.0' },
  },
};
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const target = path.join(outDir, `vaultwarden-mcp-${pkg.version}.mcpb`);
fs.rmSync(target, { force: true });

// A .mcpb is a zip. Neither Compress-Archive nor ZipFile.CreateFromDirectory can build one
// on Windows PowerShell 5.1 — both write backslash entry names, which are invalid in a zip
// and which Claude Desktop rejects. The mcpb CLI gets it right on every platform.
console.error('packing…');
const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
if (fs.existsSync(mcpbCli)) {
  execFileSync(process.execPath, [mcpbCli, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit', env: childEnv });
  execFileSync(process.execPath, [mcpbCli, 'pack', stage, target], { stdio: 'inherit', env: childEnv });
} else {
  execFileSync(process.execPath, [npmCli, 'exec', '--yes', '--', '@anthropic-ai/mcpb', 'pack', stage, target], {
    stdio: 'inherit',
    env: childEnv,
  });
}

const size = fs.statSync(target).size;
console.error(`wrote ${target} (${(size / 1024 / 1024).toFixed(1)} MB)`);
fs.rmSync(stage, { recursive: true, force: true });
