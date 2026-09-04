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
| **Trusted** | The install-time configuration: the vault address, the settings. |
| **Not trusted** | The model. |
| **Not trusted** | Everything in the vault: item names, usernames, URLs, notes, folder names. Any of it can be set by whoever shared or imported an item. |
| **Not trusted** | Any other MCP server or app connected to the same client. |
| **Relied upon** | The host, to enforce that app-only tools are not offered to the model. See the caveat below. |
| **Relied upon** | The Bitwarden CLI, and the machine it runs on. |

## The four rules

### 1. No secret in a model-visible result

`vault_search` and `vault_get_item` report that an item has a password, never what it is. The
password, one-time code, notes, and the values of custom fields are absent from every field of
the result — `content`, `structuredContent`, and `_meta` alike, because the MCP Apps specification
does not promise the latter two stay away from the model.

Secrets reach a person by exactly three routes:

- **the card**, on a click, through a tool the model cannot call;
- **the clipboard**, written by the server, which the model never sees;
- **`vault_reveal_secret`**, which opens a desktop window naming the item and the stated reason,
  and does nothing without a yes.

That last one is limited to five a minute, refuses items you marked "master password re-prompt",
and can be turned off entirely with `VW_MCP_MODEL_REVEAL=off`.

A test plants a sentinel string in every secret of a fake vault, calls every model-visible tool,
and fails if that string appears anywhere in the serialised result. It is the single most
important test in the suite.

### 2. No write without a human click

`vault_create_login`, `vault_edit_item`, and `vault_trash_item` change nothing. They stage the
intended change under an unguessable id and return it. The change happens when the card calls
`vault_ui_confirm` with that id, which happens when you press the button.

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
- Windows are single-flight and capped at five in ten minutes, so a model looping on `vault_unlock`
  cannot stack prompts until one is clicked out of fatigue.
- The session key lives in memory only. It is dropped on lock, on `VW_MCP_IDLE_LOCK_MIN` minutes of
  inactivity (15 by default), and when the process ends.

### 4. The vault address cannot be reached from a conversation

There is no tool to set the server URL, and no tool takes a hostname in any argument. This is the
one that is easy to miss: a model that could repoint the CLI at an attacker's host could then ask
for a sign-in, and you would type your master password into a window that looks exactly right. The
attacker would get the server-auth hash and could replay it against your real vault.

So the address is set at install time — extension settings, `scripts/install.mjs`, or
`VW_MCP_SERVER_URL` — and nothing in a conversation can change it. Plain http is refused unless the
host is loopback or you pass `--allow-http` yourself.

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
- **Nothing secret is logged.** Items appear in the log by id, never by name — the log is a
  plaintext file that outlives the session, and Claude Desktop keeps a copy of the server's stderr.
- **Clipboard copies are tagged** with the formats that exclude them from Windows clipboard history
  and cloud clipboard, and cleared after 30 seconds — but only if the clipboard still holds the
  value, so anything you copied in the meantime survives.

## What this does not protect against

- **Anything running as you on your machine.** A process with your user account can read this
  server's memory, the CLI's `data.json`, and a child's environment. That is also the Bitwarden
  desktop client's threat model. File permissions only keep out *other* users.
- **A compromised Bitwarden CLI.** The CLI holds the vault key; a malicious version is game over
  regardless of anything here. The dependency is pinned to an exact version with a committed
  lockfile, installed with `npm ci`, and it has happened before: `@bitwarden/cli` 2026.4.0 was
  malicious on npm for 93 minutes in April 2026.
- **A host that ignores the MCP Apps specification.** App-only tools are marked
  `visibility: ["app"]`, which the host is required to honour by keeping them out of the model's
  list and rejecting model calls to them. A server cannot tell the two callers apart on one
  session. What this server does instead is refuse to register those tools at all unless the client
  declares MCP Apps support at startup — so a plain host gets a smaller, safer surface rather than a
  silently unenforced one. On a host that claims support and does not enforce it, `vault_ui_reveal`
  would be reachable by the model.
- **A host that shows `structuredContent` or `_meta` to the model.** Assumed, and the reason no
  secret is placed in either.
- **You approving something you should not have.** The windows name the item and the reason, and
  destructive ones default to Cancel, but the last decision is yours.

## Reporting a problem

Open an issue at <https://github.com/ShadowsDistant/Vaultwarden-MCP/issues>. If it is a way to get
a secret out through a model-visible path, or to write to the vault without a click, say so and I
will treat it as the priority. Please do not include real vault contents in a report.
