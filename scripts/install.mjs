// Adds (or removes) Bitwarden MCP in an AI app's MCP config file, for installs built from source.
// (Claude Desktop users normally install the .mcpb from the releases page instead.)
//
//   node scripts/install.mjs                       Claude Desktop
//   node scripts/install.mjs --client cursor       Cursor (~/.cursor/mcp.json)
//   node scripts/install.mjs --client windsurf     Windsurf (~/.codeium/windsurf/mcp_config.json)
//   node scripts/install.mjs --config <path>       any app that reads an "mcpServers" JSON file
//   node scripts/install.mjs --print               just print the entry, for anything else
//   node scripts/install.mjs --remove [--client …]
//
// Options: --server <url>, --email <address>, --allow-http, --ca <file>
//
// --server is optional. Without it the vault is chosen when you first sign in: in the Settings
// app on Windows, or in the sign-in window elsewhere. With it, the address is pinned in the
// config and cannot be changed from anywhere else, which suits a managed machine.
//
// The vault address is never taken from a tool argument. A model that could repoint the CLI at
// another host could then ask for a sign-in, and the user would type their master password into
// a window that looks exactly right.

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

/** The key this server is listed under. Older installs used "vaultwarden"; that entry is replaced. */
const KEY = 'bitwarden';
const OLD_KEYS = ['vaultwarden'];

const CLIENTS = {
  'claude-desktop': () => {
    if (process.platform === 'win32') return path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  },
  cursor: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
  windsurf: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
};

function configPath() {
  const explicit = opt('--config');
  if (explicit) return explicit;
  const client = opt('--client') ?? 'claude-desktop';
  const find = CLIENTS[client];
  if (!find) {
    console.error(`Unknown --client "${client}". Use one of: ${Object.keys(CLIENTS).join(', ')}; or --config <path>; or --print.`);
    process.exit(2);
  }
  return find();
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

const remove = has('--remove');

let serverUrl;
if (!remove && opt('--server')) {
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

const env = {};
if (process.env.VW_MCP_HOME) env.VW_MCP_HOME = home;
if (serverUrl) env.VW_MCP_SERVER_URL = serverUrl;
if (opt('--email')) env.VW_MCP_EMAIL = opt('--email');
if (has('--allow-http')) env.VW_MCP_ALLOW_HTTP = '1';
if (opt('--ca')) env.VW_MCP_CA_FILE = opt('--ca');

const entry = {
  // The absolute path on Windows: a PATH with a stray quote in it breaks the `node` shim.
  command: process.platform === 'win32' ? process.execPath : 'node',
  args: [entryPoint],
  ...(Object.keys(env).length ? { env } : {}),
};

if (has('--print')) {
  console.log(JSON.stringify({ mcpServers: { [KEY]: entry } }, null, 2));
  process.exit(0);
}

const cfgPath = configPath();

if (!fs.existsSync(cfgPath)) {
  if (remove) {
    console.error(`No config at ${cfgPath}; nothing to remove.`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { [KEY]: entry } }, null, 2) + '\n', 'utf8');
  console.error(`Created ${cfgPath}`);
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = cfgPath.replace(/\.json$/i, `.backup-${stamp}.json`);
  fs.copyFileSync(cfgPath, backup);
  // A byte-order mark makes JSON.parse throw on a file that is otherwise perfectly good.
  const raw = fs.readFileSync(cfgPath, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xfeff)), '');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`Could not read ${cfgPath} as JSON (${e.message}). A copy is at ${backup}; nothing was changed.`);
    process.exit(1);
  }
  cfg.mcpServers ??= {};
  for (const k of OLD_KEYS) delete cfg.mcpServers[k];
  if (remove) delete cfg.mcpServers[KEY];
  else cfg.mcpServers[KEY] = entry;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.error(`Updated ${cfgPath} (backup: ${path.basename(backup)})`);
}

// Recorded beside the vault data too, so a run started any other way points at the same vault.
if (!remove && (serverUrl || opt('--email'))) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  if (serverUrl) stored.serverUrl = serverUrl;
  if (opt('--email')) stored.email = opt('--email');
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  if (serverUrl) console.error(`Vault address set to ${serverUrl}`);
}

if (!remove) console.error('Fully quit and reopen the app to pick this up. Then ask it to "unlock my vault".');
