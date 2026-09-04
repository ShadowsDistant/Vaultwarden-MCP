# Changelog

## 0.1.0 — 2026-09-03

First release.

### Vault access

- Search, view items, list folders, and sync, through the bundled Bitwarden CLI 2026.8.0.
- Sign in and unlock in a native desktop window: a WPF dialog on Windows, `osascript` on macOS,
  `zenity` or `kdialog` on Linux. The master password never enters the conversation.
- The vault locks itself after 15 idle minutes by default, on request, and when the process ends.
- `BW_SESSION` is adopted at startup for machines with no desktop to draw a window on.

### The card

- An inline MCP Apps card with six views: status, search results, item, new-login draft, change
  confirmation, and the password generator.
- Follows the host's light and dark themes through its CSS variables, with a Claude-like palette as
  a fallback.
- Reveal shows a secret for 30 seconds. Copy never displays it at all — the server writes it to the
  clipboard and clears it 30 seconds later, tagged to skip Windows clipboard history and cloud
  clipboard.
- One-time codes show a countdown ring and disappear when the step ends.
- Items marked "master password re-prompt" ask for the password again before a reveal or a copy.

### Security

- No secret appears in any model-visible tool result, in any field. A test plants a sentinel in
  every secret of a fake vault and fails if it surfaces anywhere.
- Creating, editing, and trashing stage the change under an unguessable, single-use, ten-minute id
  and wait for a click. Deletes only ever move an item to the trash.
- `vault_reveal_secret` opens a desktop confirmation naming the item and the reason, is capped at
  five a minute, refuses re-prompt items, and can be switched off entirely.
- The vault address is set at install time and cannot be reached from a conversation, which closes
  a sign-in phishing route.
- Vault text is stripped of invisible characters, length-capped, and screened for
  instruction-shaped content before the model sees it. URLs are reduced to scheme and host, and
  bulk search omits usernames.
- Card-only tools stay unregistered unless the client declares MCP Apps support at startup.
- No secret is ever passed as a command-line argument, and the CLI child's environment is built
  from scratch rather than inherited.

### Packaging

- A `.mcpb` extension bundle with the CLI inside it, so there is nothing else to install.
- `scripts/install.mjs` for a config-file install, and `scripts/setup.ps1` on Windows, which builds
  outside OneDrive and outside the AppData path Claude Desktop's packaging redirects.
- 64 tests: unit tests for the sanitiser and the staging store, and end-to-end tests that drive the
  real server over stdio against a fake Bitwarden CLI which reproduces two of the real one's
  shipped bugs.
