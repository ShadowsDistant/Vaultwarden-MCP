# Changelog

## 0.2.0 — 2026-09-04

### The reveal button did nothing

A real bug, and an instructive one. A secret is deliberately kept out of `structuredContent`,
since that field is assumed to be model-visible — so the value travelled in `content` alone.
The card read `structuredContent` and stopped there, found no value, and showed an error. The
server had done the work; the card threw it away.

The card now merges both halves of a result. A new test asserts exactly this for the reveal
path: absent from `structuredContent`, present to a card that reads both. The old test passed
throughout, because it read the text half — the half the card was ignoring.

### Unlocking takes you into the vault

Unlocking left you on a card that said "your vault is open" and nothing else, so getting at a
password meant asking again for what you were already after. Unlocking from the card now shows
the vault. The list is already in memory from the decrypt that proves the unlock worked, so it
costs nothing extra. The unlocked status card also grew an **Open vault** button.

### The vault stays open until Claude Desktop closes

That is now the default: `VW_MCP_IDLE_LOCK_MIN` is `0`, and the session ends with the process.
An idle timer that fires mid-conversation is a password prompt in the middle of something. Set
the variable to a number of minutes if you want the old behaviour as well.

### Site icons

The card shows each item's site icon, from your own instance's icon service — the same one the
web vault uses, and the only origin the card is allowed to load anything from. An item with no
icon keeps its initial, and a request that fails leaves the initial showing rather than a
broken-image mark. The card still cannot make a request of its own to anywhere.

### The whole vault, in a sensible order

The card's list was capped at twenty-five. It now shows everything, sorted favourites-first
then alphabetically, with a count that reflects the real total. The model's own search stays
capped at fifty: a long list of usernames is worth something to an attacker, and the person
reading the card is not the threat.

Searching also matches the way a search box is expected to — any word, anywhere, any case —
rather than deferring to the CLI's narrower matching.

### Faster again

The remaining cost was `bw list items` at about four seconds, paid on every search. The whole
vault is now fetched once and filtered in memory, which also populates the per-item cache, so
after unlocking there is nothing left to fetch. `bw status` is no longer called at all while a
session is held; the status card was paying two seconds for facts this server already knew.
Caches last five minutes now that the vault stays unlocked, and are emptied on every write, on
sync, and the instant the vault locks.

## 0.1.1 — 2026-09-04

Cards behaved badly in two ways that were obvious in use and invisible in the tests.

### Cards no longer rewrite themselves

A card kept repainting to show a newer, unrelated result, so older messages appeared to
change their minds. `ui/notifications/tool-result` carries only the result — the protocol gives
a card no way to tell whose result it is being handed — and in practice a later call's result
reaches every live card of the same server.

- A card now takes the first result it is given and keeps it. Nothing changes it afterwards
  except someone pressing a button on that card.
- The same rule covers a later call's tool-input, which used to blank older cards to a
  loading skeleton, and its cancellation.
- The status card's fifteen-second background poll is gone. It meant every status card still
  sitting in the transcript quietly rewrote itself long after the moment it described, and
  each one spawned a CLI process to do it. The countdown to the automatic lock is now
  arithmetic on the number the card was given.

### Buttons respond

Every button ends in a Bitwarden CLI call, which spawns a process. A reveal was three of them
in sequence — check the session, fetch the item, fetch the password — for about ten seconds
during which the card looked exactly as it had before the click. It read as broken, and got
clicked again; the log shows the same reveal three times over.

- Buttons now show a spinner for exactly as long as the work takes, and refuse a second press
  while running. The card dims and stops taking input.
- The session state is no longer re-checked against the CLI on every call. This server's own
  key was already the authority, and a key that has gone stale surfaces from the real call.
- A password or note is read out of the item the server already had to fetch, rather than
  through a second invocation.
- Items are cached for twenty seconds, emptied the moment the vault locks or anything is
  written. Revealing and then copying now costs no CLI calls at all.

Together: opening an item went from three process spawns to one, and revealing or copying
from three to none. Measured against the real vault beforehand, those spawns cost about two
seconds for a session check and just under four for an item read.

### Also

- A session key the CLI has stopped accepting is now dropped rather than held. Two server
  processes can share a machine — Claude Desktop and a terminal session each run their own —
  and whichever unlocks second retires the first one's key; the first used to keep failing
  while insisting the vault was open.
- Opening a link the host refuses says so instead of doing nothing.
- Nine tests count CLI invocations rather than measure time, since the count is what the wall
  clock is made of. A browser self-test at `/selftest.html` drives the card's real host
  handlers and asserts that a foreign result cannot repaint a card.

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
