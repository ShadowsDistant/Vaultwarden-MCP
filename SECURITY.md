# Security

This server hands a language model an interface to a password vault. That is a genuinely
dangerous thing to build, and the design starts from the assumption that the model will at some
point be talked into doing the wrong thing — by a web page, a document, a note inside the vault
itself, or simply by misreading a request.

The defence is not to make the model trustworthy. It is to make sure that a model doing exactly
what an attacker asks still cannot leak a secret or destroy anything.

## What is trusted

| | |
| --- | --- |
| **Trusted** | The person at the keyboard, answering a window drawn by this server. |
| **Trusted** | The install-time configuration (the vault address), and `settings.json`, written by the Settings app. |
| **Not trusted** | The model. |
| **Not trusted** | Everything in the vault: item names, usernames, URLs, notes, folder names. Any of it can be set by whoever shared or imported an item. |
| **Not trusted** | Any other MCP server or app connected to the same client. |
| **Relied upon** | The host, to enforce that app-only tools are not offered to the model. See the caveat below. |
| **Relied upon** | The Bitwarden CLI, and the machine it runs on. |

## The five rules

### 1. No secret in a model-visible result unless the user's settings allow it

`vault_search` and `vault_get_item` report that an item has a password, never what it is. The
password, one-time code, notes, and the values of custom fields are absent from every field of
the result — `content`, `structuredContent`, and `_meta` alike, because the MCP Apps specification
does not promise the latter two stay away from the model. Freshly generated passwords are held to
the same rule: the model-visible result carries an unguessable id, and the card trades it for the
value through an app-only tool.

Secrets reach a person by exactly three routes:

- **the card**, on a click, through a tool the model cannot call;
- **the clipboard**, written by the server, which the model never sees — either from the card's
  Copy button or from `vault_copy_secret`;
- **`vault_reveal_secret`**, the only route into the conversation itself.

The last two are requested by the model, so both pass through one gate, `authorize()` in
`src/tools.ts`, which applies the policy in `src/policy.ts` in this order:

1. An item marked "master password re-prompt" is refused outright, with no window. That flag is
   the user's own instruction about that item, and no setting overrides it.
2. A password or one-time code whose item is on a trusted site is released without asking (see
   [Trusted sites](#trusted-sites)). Notes never are.
3. If the user chose *Never*, it is refused.
4. If the user chose *Ask once per login* and already said yes to this item and field since the
   vault was unlocked, it is released.
5. Otherwise a desktop window names the item, the account and the model's stated reason, and
   nothing happens without a yes.

Every request, trusted or not, counts against a limit of five a minute, and every decision is
written to the audit log by item id.

A test plants a sentinel string in every secret of a fake vault, calls every model-visible tool,
and fails if that string appears anywhere in the serialised result. It is the single most
important test in the suite. Further tests cover each step of the policy above, including
lookalike hosts, items with a second untrusted address, and a settings file that will not parse.

### 2. No write without a human click

`vault_create_login`, `vault_edit_item`, and `vault_trash_item` change nothing. They stage the
intended change under an unguessable id and return it. The change happens when the card calls
`vault_ui_confirm` with that id, which happens when you press the button. On a host that draws no
card, or with cards switched off, the same tools ask in a desktop window instead, and write only
on a yes.

Everything that would be saved is shown before it is saved, including notes the model drafted:
a field the person never sees is a field the model could fill with anything. When an edit would
move a login onto a trusted site, the confirmation says that Claude will then be able to read its
password without asking.

With *Let Claude prepare changes* switched off, every write tool refuses, and so does the card's
confirm for anything staged before the switch.

Staged actions are single-use and expire after ten minutes, so a card sitting in an old transcript
cannot be replayed, and a locked vault discards them all. Edits are read-modify-write against the
current item, because `bw edit` replaces the whole record and a careless patch would silently
destroy the password; a test asserts every untouched field survives.

**There is no permanent delete.** Deletes move an item to the trash, where your server keeps it
for 30 days. An irreversible action taken on a model's say-so has no acceptable failure mode, and
the web vault is two clicks away for the rare time it is genuinely wanted.

### 3. The master password never crosses the wire

Signing in and unlocking open a real OS window drawn by this server: a WPF dialog on Windows,
`osascript` on macOS, `zenity` or `kdialog` on Linux. What you type goes down a pipe into the
server process and straight into the environment of one `bw` child. It is never in an MCP message,
so it is never in the transcript, the model's context, or a host log.

Consequences worth stating plainly:

- **This server will never ask for your master password in chat.** If something does, it is not
  this server.
- The window names the account and the instance, so you can tell what you are unlocking.
- Windows are single-flight and capped at ten in ten minutes, so a model looping on requests
  cannot keep a window in front of you until one is clicked out of fatigue.
- The session key lives in memory only. It is dropped on lock, when the process ends — which is
  when Claude Desktop closes — and after the idle time in the Settings app if you set one. It is
  never written to disk, so it cannot outlive the process whatever happens.

### 4. The vault address cannot be reached from a conversation

There is no tool to set the server URL, and no tool takes a hostname in any argument. This is the
one that is easy to miss: a model that could repoint the CLI at an attacker's host could then ask
for a sign-in, and you would type your master password into a window that looks exactly right. The
attacker would get the server-auth hash and could replay it against your real vault.

So the address is set at install time — extension settings, `scripts/install.mjs`, or
`VW_MCP_SERVER_URL` — and nothing in a conversation can change it. Plain http is refused unless the
host is loopback or you pass `--allow-http` yourself.

### 5. The model cannot change its own permissions

What Claude may do lives in `~/.vaultwarden-mcp/settings.json`, written by the Settings app. No
tool writes that file, no tool takes a setting as an argument, and a test fails if any tool grows
a parameter that looks like one. `vault_open_settings` opens the app on the desktop and nothing
more; the change is made by a person, in a window the model cannot see into.

The server re-reads the file before every request (one `stat`, and a parse only when it changed),
so a tightened setting applies to the very next call. The app writes the whole file to a temporary
name and renames it into place, so the server never reads half of one.

A file that exists but will not parse puts the server in its strictest state: *Never* for secrets,
no trusted sites, no changes. A torn or tampered file must never leave the server looser than the
user configured it, and without knowing what they configured, the only safe guess is the strictest
one. The app and the status card both say so until the file is fixed.

"Ask once per login" approvals last until the vault locks, and are also forgotten whenever the
settings change, so a yes given under one set of rules does not carry over to another.

## Trusted sites

A trusted site is a deliberate loosening, and the rules around it are written to keep it as narrow
as the user meant it:

- **Every address on the item must be trusted.** An item listing `github.com` and `evil.example`
  is not trusted. The trust is meant to cover one account at one site; an extra address is either
  a mistake or someone hoping to borrow it.
- **Hosts are compared, not strings.** Addresses are parsed, reduced to their host, and compared
  in punycode, so a lookalike written in another script never equals the ASCII name. An entry
  matches itself and its subdomains: `github.com` covers `gist.github.com` but not `notgithub.com`
  or `github.com.evil.example`. IP addresses and `localhost` match exactly.
- **Shared suffixes are refused.** Entries are checked against the Public Suffix List, private
  section included, so `co.uk`, `github.io` and `herokuapp.com` cannot be trusted as a whole:
  every subdomain of those belongs to someone different. The server reports what it refused, and
  the Settings app shows it.
- **Only passwords and one-time codes.** Notes are not tied to a site and are where recovery codes
  end up, so they always follow the general setting.
- **Re-prompt items are never released**, trusted or not.
- **The rate limit still applies**, and each release is audited.

The trade-off is plain: a trusted site's password, once read, is in the conversation, and from
there in the host's history. Trust only sites whose password you would be comfortable having in a
transcript. Copying (`vault_copy_secret`) is the better habit even for trusted sites, because the
value never enters the conversation at all.

An item shared into your vault by someone else could list a trusted site. Claude would then be
able to read that item's password without asking, but that password belongs to the person who
shared it and is already known to them; nothing of yours is exposed by it.

## Handling vault content

Every string that reaches the model is stripped of control characters, bidirectional overrides and
zero-width characters, capped at 200 characters, and screened against a short list of
instruction-shaped patterns. A value that matches is replaced with a fixed notice — never echoed
back, since that would just move the injection into the warning. The result carries a standing
notice that vault content is data, not instructions, and the server's startup instructions say the
same before anything is read.

Two narrowings matter more than the screen:

- **URLs reach the model as scheme and host only.** The path and query of a stored URL are
  attacker-controlled, and handing one to a model that also holds a browser tool is the cleanest
  exfiltration route there is. The card gets the whole URL, because the card only renders it.
- **`vault_search` omits usernames.** They are mostly email addresses, and a single search
  returning fifty of them is the one genuinely useful thing to talk a model into fetching.
  `vault_get_item`, one item at a time, includes it.

The screen is defence in depth. The real control is that a hijacked model has nothing worth
hijacking it for.

## Process handling

- **No secret is ever a command-line argument.** Item JSON goes to the CLI over stdin; passwords go
  through `--passwordenv` in that child's own environment. An argv is readable by every process on
  the machine and is captured by command-line auditing.
- **The CLI child's environment is built from scratch**, not inherited. `NODE_OPTIONS` in
  particular cannot reach it, which would otherwise let a preload script into the process holding
  the vault key.
- **Vault data lives at `~/.vaultwarden-mcp`**, outside OneDrive and outside the AppData path that
  Claude Desktop's MSIX packaging redirects.
- **Decrypted items are cached in memory for five minutes** so that opening an item and then
  revealing its password does not pay for two CLI invocations. The cache is emptied the instant the
  vault locks, on sync and on every write. It holds nothing the session key could not already
  produce.
- **`VW_MCP_BW_ENV` cannot re-open the environment.** It exists to pass one extra variable to the
  CLI on an unusual self-hosted setup, and names such as `NODE_OPTIONS`, `PATH` and `BW_SESSION`
  are dropped from it.
- **Nothing secret is logged.** Items appear in the log by id, never by name — the log is a
  plaintext file that outlives the session, and Claude Desktop keeps a copy of the server's stderr.
- **Clipboard copies are tagged** with the formats that exclude them from Windows clipboard history
  and cloud clipboard, and cleared after 30 seconds — but only if the clipboard still holds the
  value, so anything you copied in the meantime survives.

## What this does not protect against

- **Anything running as you on your machine.** A process with your user account can read this
  server's memory, the CLI's `data.json`, and a child's environment, and it can rewrite
  `settings.json`. That is also the Bitwarden desktop client's threat model. File permissions only
  keep out *other* users.
- **The Settings app is not code-signed.** Download it only from this repository's releases, and
  compare it against `SHA256SUMS.txt` on the release page if you want to be sure.
- **A compromised Bitwarden CLI.** The CLI holds the vault key; a malicious version is game over
  regardless of anything here. The dependency is pinned to an exact version with a committed
  lockfile, installed with `npm ci`, and it has happened before: `@bitwarden/cli` 2026.4.0 was
  malicious on npm for 93 minutes in April 2026.
- **A host that ignores the MCP Apps specification.** App-only tools are marked
  `visibility: ["app"]`, which the host is required to honour by keeping them out of the model's
  list and rejecting model calls to them. A server cannot tell the two callers apart on one
  session. What this server does instead is keep those tools switched off unless the client
  declares MCP Apps support at startup, and not register them at all when cards are turned off in
  the Settings app — so a plain host gets a smaller, safer surface rather than a silently
  unenforced one. On a host that claims support and does not enforce it, `vault_ui_reveal` would be
  reachable by the model. If you use such a host, turn cards off.
- **A host that shows `structuredContent` or `_meta` to the model.** Assumed, and the reason no
  secret is placed in either.
- **You approving something you should not have.** The windows name the item and the reason, and
  destructive ones default to Cancel, but the last decision is yours.

## Reporting a problem

Open an issue at <https://github.com/ShadowsDistant/Vaultwarden-MCP/issues>. If it is a way to get
a secret out through a model-visible path, or to write to the vault without a click, say so and I
will treat it as the priority. Please do not include real vault contents in a report.
