---
name: integrated-terminal
description: The built-in terminal — the VaultAgent helper's PTY session manager (helper/src/terminal/), the frozen macOS PTY host (helper/ptyhost/, vaultagent-pty), the terminal.* protocol and its version gate, and the lazy xterm.js dock (components/TerminalPanel/, TerminalDock, terminalLaunch, HelperGate). Load before touching any of those, the terminal's shell/env/font rules, its keyboard exemptions, or anything that could restart the helper while shells are open.
---

# The terminal: the user's own shell, in a dock under the editor

```
TerminalDock (main chunk: handle + height)          helper (Bun)                        macOS installed only
  └ lazy TerminalPanel ─ terminalStore ─ agentBridge ═WS═▶ connection → TerminalManager ──▶ vaultagent-pty (LaunchAgent)
      xterm + fit/webgl/unicode11/web-links/clipboard      headless xterm mirror + serialize     forkpty → login shell
                                                           flow control, TTL, steal          (elsewhere: Bun.spawn {terminal})
```

**The user's decisions, which are the spec — do not "fix" them:** on by default, ships with VaultAgent,
a button beside the agent's; starts in `~` and knows nothing about the vault; **completely
unconstrained** (no sandbox, allow-list or confirmation — the user accepted that anything running
script on this origin can now run commands); no folder picker or setup dialog; **independent of the
agent** (nothing in `viewRegistry`/`agentContext`, no agent tool touches it, the manager shares no
state with runs); **no code-signing certificate, ever** (ad-hoc signing only).

## Protocol and gate (`shared/vaultAgentProtocol.ts`)

- Requests: `terminal.open {termId, cols, rows}` → `{shell, pid, backend}`, `terminal.attach` →
  `{snapshot, shell, exited}`, `terminal.resize`, `terminal.close` (idempotent), `terminal.fontHint`,
  `terminal.privacy`, `helper.openPrivacySettings`, `helper.revealPtyHost`. Fire-and-forget client
  messages `terminal.input` (≤ `TERMINAL_INPUT_MAX_CHARS`, the panel splits pastes; more is dropped) and
  `terminal.ack {chars}`. Helper events `terminal.output {data, reset?}`, `terminal.exit`, `terminal.detached`.
- All JSON text frames (the bridge drops binary ones). Output is decoded per session with a streaming
  `TextDecoder`, so a UTF-8 sequence split across PTY reads survives. `onBinary` is NOT forwarded: X10
  mouse bytes > 127 would be mangled as UTF-8 (SGR mouse rides `onData`).
- **Gate:** `HelperInfo.terminal = version >= TERMINAL_VERSION` (0.2.0). `MIN_HELPER_VERSION` stays put
  (it gates the CHAT; raising it would lock older helpers out of the chat) and `PROTOCOL_VERSION` stays 1
  (additive). `HelperGate` (`components/HelperGate/`, shared by both lazy chunks; `gatePasses(bridge,
  'terminal')`) shows install / connect / "Update VaultAgent to use the terminal".
- **LNA rule kept:** no 127.0.0.1 request on page load unless `autoConnect()`'s gate passes. The button
  and ⌃` are a gesture, so App calls `connectHelperForTerminal()` (`components/terminalLaunch.ts`, a
  dynamic import of the bridge) inside it; a dock restored open on load goes through `autoConnect`.

## Helper side (`helper/src/terminal/`)

- **Sessions belong to the helper, not to a socket.** A socket close DETACHES (`detachAll`); the shell
  runs on `TERMINAL_DETACHED_TTL_MS` (30 min) and any connection may `attach` — stealing it, the old owner
  gets `terminal.detached`. Caps: `MAX_TERMINALS` (10) per connection → `limit`; 3× that in total, detached
  included, so reconnect loops cannot pile shells up. Ids are client-minted UUIDs (sessionStorage
  `terminalSessions` in the page, so only that tab knows them).
- **Headless mirror, not a byte ring.** Every session feeds `@xterm/headless` + `addon-serialize`; attach
  and `reset` send ONE serialized snapshot (screen, scrollback `TERMINAL_SCROLLBACK`, modes), so vim/htop
  come back intact. Serialize INSIDE `headless.write('', cb)` — after the callback, output already parsed
  in later time slices was duplicated (measured). Output arriving during an attach is held and flushed
  after the response, so the snapshot always precedes it.
- **Flow control without `pause()`** (Bun's PTY cannot pause reads): output is coalesced (~5 ms / 64 KiB)
  and counted until acked; above `TERMINAL_ACK_HIGH` the helper stops streaming and lets the mirror
  absorb the flood, and under `TERMINAL_ACK_LOW` it sends one `reset` snapshot and resumes. Memory stays
  bounded by the scrollback; Ctrl-C still gets through. The PTY host only reads the PTY while its socket
  takes output, but `ptyHostBackend` always drains that socket, so the ack scheme is the real control.
  `server.ts`'s 8 MiB `backpressureLimit` is a ceiling past which Bun DROPS frames (`send` → 0): the owner's
  `send` returns `false`, and `TerminalManager.dropped` stops streaming and resyncs with a `reset` snapshot.
- **The shell is what a new terminal window runs** (`shell.ts`): `$SHELL` if executable, else the passwd
  shell, else `/bin/sh` (`nologin`/`false` → `/bin/bash`), as a LOGIN shell (`-l`), cwd `os.homedir()`.
  Windows: `pwsh.exe` → Windows PowerShell → `%COMSPEC%`, `-NoLogo`. The env is built fresh by
  `terminalEnv`, **never `agentEnv`** (that one injects PATH dirs for the agent): launchd/systemd/dev-run
  residue stripped (`XPC_SERVICE_NAME=0` as Terminal.app does — `update.ts` reads it to detect the launchd
  job — `INVOCATION_ID`, `npm_*`, `BUN_*`, every `VAULTAGENT_*`…), `HOME/USER/LOGNAME/SHELL` from the
  account (zsh set `LOGNAME=root` when missing, measured), `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `TERM_PROGRAM=VaultAgent`, and `LANG` only when unset or not UTF-8 (launchd gives none, and p10k/starship
  glyphs break without one; macOS derives it from `AppleLocale`). No helper secret may ever be in
  `process.env` — the MCP token is per-child env only. `VAULTAGENT_TERMINAL_SHELL` is a TEST-ONLY override
  (smoke, tests) and is stripped from the shell's env.
- **Teardown:** in-process → `terminal.close()` (SIGHUP to the session; zsh ignores SIGTERM), then
  `kill(-pid, SIGKILL)` after 2 s; Windows kills the tree (`taskkill /T /F`) first, dodging the pre-24H2
  `ClosePseudoConsole` hang. A job-control job (`cmd &`) has its own process group, out of reach of
  the hang-up and of either backend's group kill: it ends only because bash/zsh resend SIGHUP to their
  jobs. dash (Ubuntu's `/bin/sh`) does not, as in any terminal app, so the real-PTY test runs bash
  (macOS's `/bin/sh` IS bash, which hid it). `terminal.closed` stays false after exit, so the code closes it. Helper
  SIGTERM/SIGINT and the self-update restart run `closeAll()`. Never log terminal bytes.
- `font.ts` reads the user's terminal apps' configs (Ghostty, iTerm2 and Terminal.app via `defaults
  export` + `plutil`, kitty, Alacritty, WezTerm, Windows Terminal, VS Code) — best effort, 2 s timeouts,
  read-only, names sanitized, ≤ 16 candidates.

## macOS protected folders: the frozen PTY host (`helper/ptyhost/`)

TCC attributes a shell's access to Documents/Desktop/Downloads/iCloud Drive/Full Disk Access to its
**responsible process** — the launchd job above it. The helper is ad-hoc signed, so TCC keys its grants
by path + **cdhash**, and every self-update silently dropped every grant. So on installed macOS helpers
every shell is a child of **`vaultagent-pty`**: ~380 lines of libc C, its own LaunchAgent
`dev.bme.vaultagent.pty`, a pure byte relay on `<appDir>/pty.sock` (0600; framing in the header of
`ptyhost.c`), one forked handler per connection.

- **Its bytes are frozen:** the universal binary is COMMITTED, pinned (`PINNED.json`: sha256 + per-arch
  cdhash, asserted by `helper/test/ptyhost.test.ts` and the release workflow's macOS step), embedded in
  every helper build (`with { type: 'file' }`), and written to the app dir only when missing or different
  (`install/ptyhost.ts` `ensurePtyHost`, on `install` and every installed `serve` start — which covers
  helpers that self-updated from 0.1.3). **CI never rebuilds it.** Rebuild only deliberately with
  `build.sh` (reproducible with this Mac's Apple clang): every byte change costs each macOS user one re-grant
  — free only until the first release that ships it (0.2.0). While an input frame is blocked on a full PTY
  the handler still reads its socket (into `rbuf`'s free room), so a client hang-up is always seen.
- Backend choice per spawn (`backend.ts` `chooseBackend`): PTY host when macOS + installed + its socket
  answers; otherwise Bun's in-process PTY (Linux, Windows, `helper:dev`, `--no-register`), logging once per
  outage. `terminal.open` reports which. The FDA probe (`privacy.ts`) runs `test -r …/TCC.db` THROUGH the
  active backend, so it is the host's identity being tested; the panel's notice shows only for `ptyhost`
  with `fullDiskAccess === false` (dismissal: localStorage `terminalFdaNoticeDismissed`).
- Uninstall boots it out and removes its plist (the binary goes with the app dir); the updater's
  leftover cleanup can never match it. **Unverified Apple behaviour:** that attribution reaches the host
  must be confirmed with `log stream --predicate 'subsystem == "com.apple.TCC"'` while a shell under the
  real LaunchAgent touches `~/Desktop` (it can raise a real prompt — warn the user first). If it does not,
  keep the in-process backend and say requirement 9 is unmet. Residual, accepted: the first access per
  protected folder asks once (or FDA once), separately from the user's Terminal/iTerm2 grants.

## Page side (`components/TerminalPanel/`, lazy; `TerminalDock.tsx` + `terminalLaunch.ts`, main)

- **xterm is reachable ONLY through `lazy(() => import('./TerminalPanel'))`** and is never prefetched;
  after a build the main entry chunk must contain no `xterm` / `Symbols Nerd`.
- **`terminalStore`** (module singleton, like `agentBridge`/`chatStore`): one xterm + one persistent host
  `<div>` per session, adopted/released by the panel idempotently (StrictMode), so hiding the dock, a vault
  switch or the welcome screen never kills a shell or loses scrollback. It `retain()`s the bridge while
  sessions exist, re-attaches after a reconnect ("[Reconnecting to VaultAgent…]"), acks per frame (50 ms
  timer fallback for background tabs), and publishes the count to `utils/terminalCount.ts` — import-free,
  the ONE thing the agent chunk reads (update/uninstall ask first when shells are open; the helper also
  refuses `terminal.open` while updating). **Only the active, visible session holds a WebGL context**
  (Chrome caps them ~16); context loss falls back to the DOM renderer.
- **Dock:** a sibling AFTER the main view inside `.workspace-main` (outside the graph/editor ternary).
  Height in localStorage `terminalHeight`, clamped on read and drag (120 px … 70%), the pane-divider
  pointer-capture pattern, ↑/↓ nudge, double-click reset. App owns only `terminalOpen` (localStorage),
  `terminalOpenedByUser` and the stable `toggleTerminal`/`hideTerminal` (`SidebarFooter` is memo'd).
- **Keyboard:** ⌃` (capture phase in App, every OS) toggles even from inside the shell. `[data-terminal]`
  (on the dock, handle and panel root) is exempt from App's ⌘E and EditorPane's capture ⌥ chords. xterm's
  custom key handler: macOS ⌘C/⌘V native, ⌘K clears, ⌥/⌘ arrows mapped; Windows/Linux Ctrl+C copies with a
  selection (else SIGINT), Ctrl+Shift+C/V. Ctrl+W cannot be intercepted, so a `beforeunload` guard runs
  while focus is inside (non-mac). `macOptionIsMeta: false`. Links open on ⌘/Ctrl-click (http/https).
- **Context menu:** the app's own (`openContextMenu`), raised only when the program has not enabled mouse
  tracking or Shift is held.
- **Fonts:** Settings (`utils/terminalSettings.ts`, import-free store, clamped, Reset to Defaults) →
  `terminal.fontHint` candidates probed with `new FontFace(…, 'local("<name>")').load()` (PostScript names
  work) → none; never blocks open > ~1.5 s, swaps later (re-set `fontFamily`, `clearTextureAtlas`, refit).
  The bundled **Symbols Nerd Font Mono** (`public/fonts/`, upstream notices beside it; mixed MIT / CC BY 4.0
  / OFL / Apache icon licences) sits in every stack with a `unicode-range` of the real cmap, and is loaded
  before `term.open()` because xterm measures cells at open.
- **Colours** follow the app theme: background/foreground/cursor/selection from CSS variables resolved
  through a probe element, ANSI from `editor/codePalette.ts`, re-derived by a MutationObserver on `<html>`
  (`data-theme`/`style`) — a `[theme]` effect would read stale values. Terminal-app schemes are not imported.
