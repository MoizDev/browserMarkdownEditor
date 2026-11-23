---
name: integrated-terminal
description: The built-in terminal — the VaultAgent helper's PTY session manager (helper/src/terminal/), where a new shell starts (helper/src/vaultPath.ts, utils/terminalStart.ts), the frozen macOS PTY host (helper/ptyhost/, vaultagent-pty), the terminal.* protocol and its version gate, and the lazy xterm.js dock (components/TerminalPanel/, TerminalDock, terminalLaunch, HelperGate). Load before touching any of those, the terminal's shell/env/font rules, its keyboard exemptions, its WebGL context, or anything that could restart the helper while shells are open.
---

# The terminal: the user's own shell, in a dock under the editor

```
TerminalDock (main chunk: handle + height)          helper (Bun)                        macOS installed only
  └ lazy TerminalPanel ─ terminalStore ─ agentBridge ═WS═▶ connection → TerminalManager ──▶ vaultagent-pty (LaunchAgent)
      xterm + fit/webgl/unicode11/web-links/clipboard      headless xterm mirror + serialize     forkpty → login shell
                                                           flow control, TTL, steal          (elsewhere: Bun.spawn {terminal})
```

## The user's decisions — the spec, do not "fix" them
- On by default, ships with VaultAgent, its own button beside the agent's.
- **Completely unconstrained**: no sandbox, allow-list or confirmation. The user accepted that anything
  running script on this origin can now run commands.
- **Independent of the agent**: nothing in `viewRegistry`/`agentContext`, no agent tool touches it, the
  manager shares no state with agent runs.
- A **new** shell starts in the folder of the file being looked at, falling back to `~`. A running shell
  owns its cwd; `cd`-ing it under the user was considered and refused.
- No folder picker or setup dialog. **No code-signing certificate, ever** (ad-hoc signing only).

## Where a shell starts (`helper/src/vaultPath.ts`, `utils/terminalStart.ts`)
The page cannot send a path — the File System Access API hands out handles, never `/Users/…` (the same
reason agent CLIs run in `~/.bme-agent-sessions/<uuid>`). `terminal.open` carries `vaultId` + a
vault-relative `dir` and answers with the `cwd` it used; the helper resolves the vault itself.
- **Found by MARKER, not name**: `.VaultAgent/vault.json` holds the vault id, so a same-named folder
  cannot impersonate it. `searchForVault` walks breadth-first from `$HOME` (depth 6, 2 s, 20,000 dirs,
  skipping hidden dirs, `Library`, `node_modules`, `.Trash`…, never following a symlink out) and opens no
  file but the marker. The answer is cached in `~/.bme-agent-sessions/vault-paths.json` and **re-checked
  against the marker every time**, so a moved vault never hands a shell someone else's directory.
- **Every fallback is one step out, never a failure**: a deleted folder, `..`, an absolute path or a file
  ends at the vault root; an unfindable vault ends at `~`.
- `utils/terminalStart.ts` is a one-function store App fills from the focused tab (not `viewRegistry`).
  The vault id comes from `useFileSystem().ensureVaultId` — the SAME minting the agent host uses (two
  would split one vault in two) — minted lazily on the first terminal or Settings visit, never merely
  because a vault was opened.
- `Settings → Terminal → Vault folder on disk` (`components/VaultFolderSetting.tsx`) shows what was found
  and takes a typed path. It asks the helper ONLY when a connection already exists — Settings must never
  be what raises Chrome's Local Network Access prompt.

## Protocol and gate (`shared/vaultAgentProtocol.ts`)
- Requests: `terminal.open {termId, cols, rows, vaultId?, dir?}` → `{shell, pid, backend, cwd}`,
  `terminal.attach` → `{snapshot, shell, exited}`, `terminal.resize`, `terminal.close` (idempotent),
  `terminal.fontHint`, `terminal.privacy`, `helper.openPrivacySettings`, `helper.revealPtyHost`, and
  `vault.path {vaultId, set?}` → `{path}` (the Settings row's read/override of the found folder).
  Fire-and-forget: `terminal.input` (≤ `TERMINAL_INPUT_MAX_CHARS` = 65,536; the panel splits pastes, more
  is dropped) and `terminal.ack {chars}`. Events: `terminal.output {data, reset?}`, `terminal.exit`,
  `terminal.detached`.
- All JSON text frames (the bridge drops binary). Output is decoded per session with a streaming
  `TextDecoder`, so a UTF-8 sequence split across PTY reads survives. xterm's `onBinary` is NOT
  forwarded: X10 mouse bytes > 127 would be mangled as UTF-8 (SGR mouse rides `onData`).
- **Gate:** `HelperInfo.terminal = version >= TERMINAL_VERSION` (0.2.0). `MIN_HELPER_VERSION` stays put (it
  gates the CHAT; raising it locks older helpers out of chat) and `PROTOCOL_VERSION` stays 1 (additive).
  `HelperGate` (`components/HelperGate/`, shared by both lazy chunks; `gatePasses(bridge,'terminal')`)
  shows install / connect / "Update VaultAgent to use the terminal".
- **LNA rule:** no 127.0.0.1 request on page load unless `autoConnect()`'s gate passes. The button and ⌃`
  are a gesture, so `app/useSidePanels.ts` calls `connectHelperForTerminal()` (`components/terminalLaunch.ts`,
  a dynamic import of the bridge) inside it; a dock restored open on load goes through `autoConnect`.

## Helper side (`helper/src/terminal/`)
- **Sessions belong to the helper, not a socket.** A socket close DETACHES (`detachAll`); the shell runs on
  for `TERMINAL_DETACHED_TTL_MS` (30 min) and any connection may `attach` — stealing it; the old owner gets
  `terminal.detached`. Caps: `MAX_TERMINALS` (10) per connection, 3× that in total including detached, so
  reconnect loops cannot pile shells up. Ids are client-minted UUIDs kept in the page's sessionStorage
  `terminalSessions`, so only that tab knows them.
- **Headless mirror, not a byte ring.** Each session feeds `@xterm/headless` + `addon-serialize`; attach and
  `reset` send ONE serialized snapshot (screen, `TERMINAL_SCROLLBACK` = 5000 lines, modes), so vim/htop
  come back intact. Serialize INSIDE `headless.write('', cb)` — serializing after the callback duplicated
  output parsed in later slices (measured). Output arriving during an attach is held and flushed after
  the response, so the snapshot always comes first.
- **Flow control without `pause()`** (Bun's PTY cannot pause reads): output is coalesced (5 ms / 64 KiB)
  and counted until acked; above `TERMINAL_ACK_HIGH` (512k chars) the helper stops streaming and lets the
  mirror absorb the flood, under `TERMINAL_ACK_LOW` (128k) it sends one `reset` snapshot and resumes.
  Memory stays bounded by scrollback and Ctrl-C still gets through. `server.ts`'s 8 MiB
  `backpressureLimit` is where Bun DROPS frames (`send` → 0): the manager's `dropped` path stops
  streaming and resyncs with a `reset`.
- **The shell is what a new terminal window runs** (`shell.ts`): `$SHELL` if executable, else the passwd
  shell, else `/bin/sh` (`nologin`/`false` → `/bin/bash`), as a LOGIN shell (`-l`). Windows: `pwsh.exe` →
  Windows PowerShell → `%COMSPEC%`, `-NoLogo`.
- **The env is built fresh by `terminalEnv`, never `agentEnv`** (that one injects PATH dirs for the agent):
  launchd/systemd/dev residue stripped (`XPC_SERVICE_NAME=0` as Terminal.app does — `update.ts` reads it to
  detect the launchd job — `INVOCATION_ID`, `npm_*`, `BUN_*`, every `VAULTAGENT_*`…); `HOME/USER/LOGNAME/
  SHELL` from the account (zsh set `LOGNAME=root` when missing, measured); `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `TERM_PROGRAM=VaultAgent`; `LANG` only when unset or not UTF-8 (launchd gives
  none; macOS derives it from `AppleLocale`). **No helper secret may ever be in `process.env`** — the MCP
  token is per-child env only. `VAULTAGENT_TERMINAL_SHELL` is a debugging override, stripped from the env.
- **Teardown:** hang up (SIGHUP to the session; zsh ignores SIGTERM), then `kill(-pid, SIGKILL)` after 2 s;
  Windows kills the tree (`taskkill /T /F`) first, dodging the pre-24H2 `ClosePseudoConsole` hang. A
  job-control job (`cmd &`) has its own process group and ends only because bash/zsh resend SIGHUP to their
  jobs — dash does not, as in any terminal app. Helper SIGTERM/SIGINT and the self-update restart run
  `closeAll()`. **Never log terminal bytes.**
- `font.ts` reads the user's terminal apps' configs (Ghostty, iTerm2/Terminal.app via `defaults export` +
  `plutil`, kitty, Alacritty, WezTerm, Windows Terminal, VS Code) — best effort, read-only, 2 s timeouts,
  names sanitized, ≤ 16 candidates.

## macOS protected folders: the frozen PTY host (`helper/ptyhost/`)
TCC attributes a shell's access to Documents/Desktop/Downloads/iCloud/Full Disk Access to its
**responsible process** — the launchd job above it. The helper is ad-hoc signed, so TCC keys grants by
path + **cdhash**, and every self-update silently dropped every grant. So on installed macOS helpers every
shell is a child of **`vaultagent-pty`**: a few hundred lines of libc C, its own LaunchAgent
`dev.bme.vaultagent.pty`, a pure byte relay on `<appDir>/pty.sock` (0600; framing documented at the top of
`ptyhost.c`), one forked handler per connection.
- **Its bytes are frozen.** The universal binary is COMMITTED, pinned in `PINNED.json` (sha256 + per-arch
  cdhash, checked by the release workflow's macOS step), embedded in every helper build
  (`with { type: 'file' }`), and written to the app dir only when missing or different
  (`install/ptyhost.ts` `ensurePtyHost`, on `install` and every installed `serve` start). **CI never
  rebuilds it.** Rebuild only deliberately with `build.sh`: every byte change costs each macOS user a
  re-grant. While an input frame is blocked on a full PTY the handler still reads its socket, so a client
  hang-up is always seen.
- Backend per spawn (`backend.ts` `chooseBackend`): the PTY host when macOS + installed + its socket
  answers; otherwise Bun's in-process PTY (Linux, Windows, `helper:dev`, `--no-register`), logging once per
  outage. `terminal.open` reports which. The FDA probe (`privacy.ts`) runs `test -r …/TCC.db` THROUGH the
  active backend, so it tests the host's identity; the panel's notice shows only for `ptyhost` with
  `fullDiskAccess === false` (dismissed via localStorage `terminalFdaNoticeDismissed`).
- Uninstall boots it out and removes its plist; the updater's leftover cleanup can never match it.
- **Still unverified on real Apple hardware:** that TCC attribution actually reaches the host. Confirm with
  `log stream --predicate 'subsystem == "com.apple.TCC"'` while a shell under the real LaunchAgent touches
  `~/Desktop` (it can raise a real prompt — warn the user first). Accepted residual: the first access per
  protected folder asks once, separately from the user's Terminal/iTerm2 grants.

## Page side (`components/TerminalPanel/`, lazy; `TerminalDock.tsx` + `terminalLaunch.ts`, main chunk)
- **xterm is reachable ONLY through `lazy(() => import('./TerminalPanel'))`** and is never prefetched; after
  a build the main entry chunk must contain no `xterm` / `Symbols Nerd`.
- **`terminalStore`** (module singleton, like `agentBridge`/`chatStore`): one xterm + one persistent host
  `<div>` per session, adopted/released by the panel idempotently (StrictMode), so hiding the dock, a vault
  switch or the welcome screen never kills a shell or loses scrollback. It `retain()`s the bridge while
  sessions exist, re-attaches after a reconnect ("[Reconnecting to VaultAgent…]"), acks per frame (50 ms
  timer fallback for background tabs), and publishes the session count to `utils/terminalCount.ts` —
  import-free, the ONE thing the agent chunk reads (update/uninstall ask first when shells are open; the
  helper also refuses `terminal.open` while updating).
- **WebGL context:** only the active, visible session holds one (Chrome caps contexts at ~16); context loss
  falls back to xterm's DOM renderer. The store reports it through `utils/terminalContext.ts` →
  `platform/terminalContext.ts`, an import-free flag the render platform's `surfaceBroker` reads: its
  context budget **always reserves the terminal's context** (`RENDER_CONSTANTS.reservedTerminalContexts`)
  so document panes never starve the shell. Keep that shim renderer-free on both sides.
- **Dock:** a sibling AFTER the main view inside `.workspace-main` (outside the graph/editor switch).
  Height in localStorage `terminalHeight`, clamped on read and drag (120 px … 70 %), the pane-divider
  pointer-capture pattern, ↑/↓ nudge, double-click reset. App owns only `terminalOpen` (localStorage),
  `terminalOpenedByUser` and the stable `toggleTerminal`/`hideTerminal` (`SidebarFooter` is memo'd).
- **Keyboard:** ⌃` (capture phase in `useSidePanels`, every OS) toggles even from inside the shell.
  `[data-terminal]` (dock, handle, panel root) is exempt from `useGlobalShortcuts`'s ⌘E and EditorPane's
  capture ⌥ chords — a new global shortcut must honour it too. xterm's key handler: macOS ⌘C/⌘V native,
  ⌘K clears, ⌥/⌘ arrows mapped; Windows/Linux Ctrl+C copies with a selection (else SIGINT),
  Ctrl+Shift+C/V. Ctrl+W cannot be intercepted, so a `beforeunload` guard runs while focus is inside
  (non-macOS) — AGENTS.md's one sanctioned native prompt. `macOptionIsMeta: false`. Links open on
  ⌘/Ctrl-click (http/https only).
- **Context menu:** the app's own (`openContextMenu`), raised only when the program has not enabled mouse
  tracking or Shift is held.
- **Fonts:** Settings (`utils/terminalSettings.ts`, clamped on read, Reset to Defaults) → `terminal.fontHint`
  candidates probed with `new FontFace(…, 'local("<name>")').load()` → none; never blocks open more than
  1.5 s, swaps later (re-set `fontFamily`, `clearTextureAtlas`, refit). The bundled **Symbols Nerd Font
  Mono** (`public/fonts/`, notices beside it) sits in every stack with a `unicode-range` of its real cmap and
  loads before `term.open()`, because xterm measures cells at open.
- **Colours** follow the app theme: background/foreground/cursor/selection from CSS variables resolved through
  a probe element, ANSI from `editor/codePalette.ts`, re-derived by a MutationObserver on `<html>`
  (`data-theme`/`style`) — a `[theme]` effect would read stale values. Terminal-app schemes are not imported.

## Verify
The real check is the helper: `npm run helper:dev`, then open the dock in the app (`verify-in-browser`), run
a command, hide/show the dock and switch vaults (the shell and scrollback survive), and flood it
(`yes | head -c 50M`) to see flow control hold. `bun helper/scripts/smoke.ts <compiled helper>` is the
release workflow's end-to-end check of a built binary (terminal included).
