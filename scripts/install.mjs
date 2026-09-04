// Adds (or removes) this server in Claude Desktop's config file, and records the vault
// address it should point at.
//
//   node scripts/install.mjs --server https://vault.example.com [--email you@example.com]
//   node scripts/install.mjs --remove
//
// Options: --config <path>, --idle-lock <minutes>, --no-reveal, --allow-http, --ca <file>
//
// The vault address is written here, at install time, and never taken from a tool argument.
// A model that could repoint the CLI at another host could then ask for a sign-in, and the
// user would type their master password into a window that looks exactly right.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

function configPath() {
  const explicit = opt('--config');
  if (explicit) return explicit;
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function validateServerUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: 'Not a valid URL. Use the full address, for example https://vault.example.com' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https URLs are supported.' };
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback && !has('--allow-http')) {
    return { error: 'Refusing a plain-http address. Use https, or pass --allow-http if this is a trusted local network.' };
  }
  if (u.username || u.password) return { error: 'The URL must not contain credentials.' };
  return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')) };
}

const cfgPath = configPath();
const remove = has('--remove');

if (!remove && !opt('--server')) {
  console.error('Usage: node scripts/install.mjs --server https://vault.example.com [--email you@example.com]');
  console.error('       node scripts/install.mjs --remove');
  process.exit(2);
}

let serverUrl;
if (!remove) {
  const checked = validateServerUrl(opt('--server'));
  if (checked.error) {
    console.error(checked.error);
    process.exit(2);
  }
  serverUrl = checked.url;
}

const home = process.env.VW_MCP_HOME ?? path.join(os.homedir(), '.vaultwarden-mcp');
const entryPoint = fs.existsSync(path.join(root, 'dist', 'index.js'))
  ? path.join(root, 'dist', 'index.js')
  : path.join(home, 'build', 'dist', 'index.js');

if (!remove && !fs.existsSync(entryPoint)) {
  console.error(`Nothing built at ${entryPoint}. Run the build first (npm run build, or scripts/setup.ps1 on Windows).`);
  process.exit(1);
}

const env = { VW_MCP_HOME: home, VW_MCP_SERVER_URL: serverUrl };
if (opt('--email')) env.VW_MCP_EMAIL = opt('--email');
if (opt('--idle-lock')) env.VW_MCP_IDLE_LOCK_MIN = String(opt('--idle-lock'));
if (has('--no-reveal')) env.VW_MCP_MODEL_REVEAL = 'off';
if (has('--allow-http')) env.VW_MCP_ALLOW_HTTP = '1';
if (opt('--ca')) env.VW_MCP_CA_FILE = opt('--ca');

const entry = {
  command: process.platform === 'win32' ? process.execPath : 'node',
  args: [entryPoint],
  env,
};

if (!fs.existsSync(cfgPath)) {
  if (remove) {
    console.error(`No config at ${cfgPath}; nothing to remove.`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { vaultwarden: entry } }, null, 2) + '\n', 'utf8');
  console.error(`Created ${cfgPath}`);
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = cfgPath.replace(/\.json$/i, `.backup-${stamp}.json`);
  fs.copyFileSync(cfgPath, backup);
  // A byte-order mark makes JSON.parse throw on a file that is otherwise perfectly good.
  const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`Could not read ${cfgPath} as JSON (${e.message}). A copy is at ${backup}; nothing was changed.`);
    process.exit(1);
  }
  cfg.mcpServers ??= {};
  if (remove) delete cfg.mcpServers.vaultwarden;
  else cfg.mcpServers.vaultwarden = entry;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.error(`Updated ${cfgPath} (backup: ${path.basename(backup)})`);
}

// The same settings are written beside the vault data, so a run started any other way — the
// test harness, a manual launch — points at the same instance.
if (!remove) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  stored.serverUrl = serverUrl;
  if (opt('--email')) stored.email = opt('--email');
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  console.error(`Vault address set to ${serverUrl}`);
}

console.error('Fully quit and relaunch Claude Desktop to pick this up.');
