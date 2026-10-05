---
name: vault-agent
description: The AI agent panel ("VaultAgent") — the right-docked chat that runs Claude Code, Codex or OpenCode through a local background helper, how each CLI is launched (never-ask, full tools), the WebSocket/MCP protocol, the per-message context snapshot, the tool executor, the chat index in `.VaultAgent/`, and the installers/release. Load before touching shared/, helper/, components/AgentPanel/, utils/agent*.ts, utils/vaultAgent*.ts, utils/viewRegistry.ts, canvasAgentOps.ts, or anything the agent can read or change.
---

# VaultAgent: an agent CLI whose vault edits go through the editor

```
Chrome (the editor)                          the user's machine
AgentPanel (lazy) ─ agentBridge ──WS──▶ 127.0.0.1:47823-47827  helper (Bun exe, login item)
      ▲                                     │ spawns, per message/vault
      │ tool.call / tool.result             ▼
executeTool (utils/vaultAgentTools.ts)   claude -p │ codex app-server │ opencode serve
      │                                     │ cwd ~/.bme-agent-sessions/<vault-uuid>/
agentHost (utils/agentHost.ts) → App     ◀──┘ MCP tools/call → POST /mcp/<runToken>
```

The same helper also runs the editor's **terminal** (`terminal.*` messages, a separate feature with
its own skill, `integrated-terminal`): no run ever sees a terminal session, and nothing in this
skill's context, tools or chat index reads one.

## How the CLIs run

- **The decision (the user's; do not re-restrict):** each CLI runs with its full normal tools — shell,
  file read/write, web, skills, sub-agents — in its never-ask mode (nobody can answer a prompt in the
  panel), with no version gate and no tripwire that ends a run on some tool. The security trade-off
  (prompt injection reaching the whole machine) was explained and accepted. The vault is still reached
  only through our `vault` MCP server (served by the helper, forwarded to the browser, run against the
  vault's `FileSystemDirectoryHandle` through App's handlers); `helper/src/prompt.ts` and the MCP
  `initialize` instructions forbid touching vault files any other way. The agent is never told the
  vault's disk path (the browser cannot know it). Its own tool calls reach the panel as `tool` events
  (`ToolCallCard.describeForeign`: "Ran …", "Read …", "Edited …").
- **Exclusions only where ONE stable switch exists — never a name list tracked per CLI version**
  (Codex's per-feature deny-list, which broke on each release, is exactly what was removed):
  - Claude: `--strict-mcp-config` (user/project/plugin MCP servers), `disableAllHooks`, and every id in
    the user's `<CLAUDE_CONFIG_DIR|~/.claude>/settings.json` `enabledPlugins` set `false` in `--settings`
    (`--safe-mode` would also drop our vault tools; `{}` disables nothing).
  - OpenCode: `OPENCODE_PURE=1`/`--pure` (plugins), `OPENCODE_DISABLE_PROJECT_CONFIG=1`, the user's MCP
    servers `enabled: false` by the names in their config.
  - Codex: the user's MCP servers `{enabled:false}` inside the thread `config` JSON — NOT argv: argv
    `-c mcp_servers.*` is ignored once the thread config has `mcp_servers`, and a dotted name in a `-c`
    key is fatal at startup.
  - Let through on purpose: Codex hooks, plugins and apps (only `features.<name>` keys exist), and
    OpenCode's global custom tools.
- Per CLI (verified against claude 2.1.289, codex 0.160.0, opencode 1.18.34; each flag has a why-comment
  in `helper/src/agents/*.ts`, and `helper/test/adapters.test.ts` asserts the argv/params/env — keep it
  green):
  - **Claude**: `--permission-mode bypassPermissions`, `--strict-mcp-config --mcp-config <inline>`
    (token via `${VAR}` in env, never argv), `--settings '{"disableAllHooks":true,…}'`. **Never `--bare`**
    (breaks OAuth).
  - **Codex** (`app-server`, JSON-RPC): `sandbox: 'danger-full-access'`, `approvalPolicy: 'never'`, the
    default (local) environment; `-c web_search="live"`. A stray approval request is approved, an
    elicitation or user-input request declined.
  - **OpenCode**: one `opencode serve` per vault folder (loopback, an explicit free port — `--port 0`
    means 4096 — and a random password), permission `{'*':'allow', question:'deny'}` (`question` deny is
    OpenCode's own default, which `*` would override — as it overrides the user's own deny/ask rules,
    unlike Claude, whose `permissions.deny` still applies in bypass mode); a stray `permission.asked` is
    answered `once`, a `question.asked` rejected. Only the adapter talks to it. The folder is made its own OpenCode project
    (a hand-laid `.git` with an `opencode` id file, `ensureOpencodeProject`) — else every non-git folder
    shares one "global" project and panel chats appeared in the user's own `opencode session list`.
- **Zero interference with the user's own CLI use** (a user requirement): every setting is a flag,
  env var or inline config for that one process. Nothing writes `~/.claude/settings.json`,
  `~/.claude.json` MCP entries, `~/.codex/config.toml` or OpenCode's config; nothing is registered
  globally. The CLIs' own session stores gain only the panel's sessions (cwd under
  `~/.bme-agent-sessions`). Known residue: Codex still reads `~/.agents/skills`; OpenCode's `opencode.log`
  and project list gain the panel's folders.
- **Browser side**: paths are normalized by `checkPath` (no absolute, `..`, `\`, NUL, empty
  segments) and then spelled as the tree spells them (`canonicalPath`: APFS/NTFS ignore case, the
  app's path keys do not); tool calls run one at a time (`chatStore.toolQueue`), none after Stop; `.VaultAgent/` is invisible and unwritable; anything inside a `.Garbage` is read-only;
  every call re-checks `vaultToken` (the run's vault) and refuses after a switch.
- **Helper HTTP**: binds 127.0.0.1 only; `/ws` upgrades only for an allowed `Origin`
  (`PRODUCTION_ORIGIN` + build-time `VAULTAGENT_ALLOWED_ORIGINS`; `--dev` adds `http://localhost:*`)
  AND `Host` = `127.0.0.1|localhost:<port>` (DNS rebinding); `/mcp/<token>` needs the matching Bearer,
  per-run random token, and REJECTS any request with an `Origin` (browsers always send one, CLIs never).
  Size caps in `shared/vaultAgentProtocol.ts`. Logs are errors only — never note text, prompts or args.

## The contract

- `shared/vaultAgentProtocol.ts` — WS messages (`RequestMap`: one `response` per `reqId`; a run
  streams `run.event` and ends in exactly one `run.done`/`run.error`), `AgentEvent`, ports, limits,
  `CanvasOp`. `shared/vaultAgentTools.ts` — the tool table (schemas + the descriptions the model
  reads), split out so the main chunk does not carry it. Pure data; both sides import them.
- `src/types/vaultAgent.ts` — `AgentHost`/`VaultToolHost` (implemented once by `utils/agentHost.ts`,
  built in the panel chunk from App's `getHostDeps`, stable for the page's life, reading App through
  `agentDepsRef`), `ChatMeta`, `AgentChange`.
- `utils/viewRegistry.ts` — see `tabs-and-panes`; each mounted pane's reporter (`describe`,
  `capture`, `pdfText`, `renderPage`, `applyTextChanges`, `canvas`).

## Context: fresh, per message, from live panes (`utils/agentContext.ts`)

`<bme-context>` … `</bme-context>` is prefixed to the user's text and stripped when history is shown.
Order, against `CONTEXT_CHAR_BUDGET` (60k): vault + time; pane layout and focus; one line per open tab
with its exact position (live reporter, else the stored record via `workspace.remembered`); the
FOCUSED document (markdown in full with `⟦sel⟧…⟦/sel⟧`/`⟦cursor⟧`; PDF page text; canvas shapes in
view); other visible panes' on-screen slice only. No file tree (the agent lists/searches). A PNG of
the focused drawing/notebook/PDF view rides along ONLY when its SHA-256 differs from the chat's
`lastImageHash`. Typed `<bme-context>` in a note is defused (`<` → `‹`).

## Edits go through the app, never behind it

A write the app did not make is no longer clobbered — every document save is versioned and an outside
change reloads the note or raises a conflict bar (`tabs-and-panes` → "Outside changes") — but it costs
the reader exactly that interruption, which is why the prompt still forbids the agent's own tools on
vault files. So text edits
(`vault_edit`/`vault_write`, refused as stale unless the text still equals what the agent read) go live view → cached `EditorState`s + buffer → disk + `afterWrite`; create/mkdir refuse taken
names (`entryNames.nameTaken`) and never truncate; move REFUSES a taken target; trash is
`App.performTrash` without the question; canvas ops land in the live tldraw editor (`pdf-and-drawings`),
opening a closed canvas beside the user via `openInSidePane` without moving the focus.

## How replies are shaped (brevity + teaching)

Two layers, split by what can change mid-chat:

- **`helper/src/prompt.ts`** carries the durable contract — answer first, 2-4 sentences, bullets only for 3+
  parallel things, never paste a diff the panel already shows, one clarifying question at most — and the
  definition of both cadences. It CANNOT hold the per-message choice: Claude records the system prompt on a
  chat's first request and reuses it on resume, so a change here reaches new chats only.
  It also demands LaTeX for maths — the panel renders replies through the editor's own KaTeX, models
  otherwise reach for ∑ and √, and `\(…\)` (Claude's habit) renders as literal backslashes here.
  Both this and the mode lines are kept lean deliberately: every clause competes for attention, so
  what is there is the fix or a fact the model cannot guess, and guesses get cut.
- **`utils/agentReplyMode.ts`** decides, per message, between `direct` and `teach`, and
  `agentContext.ts` appends `REPLY_MODE_LINE[mode]` as the LAST line of `<bme-context>` (closest to the
  user's words, and self-contained, so an old chat still gets the cadence).

**The editor decides, not the model**: the cap in the composer lights on exactly the messages that were sent
as `teach`, and a badge the model controlled would mean parsing a marker out of a stream it may not emit.
`ReplyModePref` (`auto`/`teach`/`direct`, localStorage `agentReplyMode`, app-wide) pins it; in `auto`,
`looksLikeLearning` matches understanding-shaped wording and a TASK regex beats it ("explain this in a note"
is a writing job). Teaching is **sticky per conversation** (`ChatStoreState.teaching`, in memory) — mid-lesson
"yes" and "why?" carry no cues of their own — and only a task breaks out of it.

## Chats

- `.VaultAgent/vault.json` = the vault's permanent uuid (created on first send, serialized); it names
  the working folder `~/.bme-agent-sessions/<uuid>/`, so a vault maps to the same folder in every
  browser and machine. `.VaultAgent/chats.json` = `{chatId, agent, sessionId, title, model, effort,
  timestamps, lastImageHash}` only — read-modify-write through one queue, unknown keys preserved.
  Conversations live in each CLI's own store; history is read back through the helper.
- Before each run the panel sends `vault.sync` (skipped when unchanged this connection): the vault's
  `CLAUDE.md`, `AGENTS.md`, `.claude/skills/**`, `.agents/skills/**`, mirrored into the working folder
  (whitelisted, size-capped, stale files removed). Nothing else — never settings, `.mcp.json`,
  `opencode.json`, hooks.
- Delete is permanent (after `ask`): the CLI's session (`session.delete`) and then the index entry.

## Panel (`components/AgentPanel/`, lazy with its CSS)

- One bridge (`utils/agentBridge.ts`) and one chat store (`chatStore.ts`) per page, outside React:
  closing the panel mid-reply keeps the run and its tool calls going; 5 s grace before the socket
  closes; in dev a hot reload unhooks the old store (two would each answer every tool call).
- **No request to 127.0.0.1 before the user clicks Connect** — any request raises Chrome's Local
  Network Access prompt. Later loads auto-connect only if `vaultAgentConnectedOnce` is set AND the
  permission query (`loopback-network`, then `local-network-access`/`local-network`) says granted — or
  the page itself is on loopback (dev), where no prompt exists and a 'denied' reading is ignored.
- App: `⌘⇧X` is a CAPTURE-phase listener — a Mod-Shift letter no keymap here (CodeMirror,
  tldraw), Chrome or Edge claims; never ⌘⇧K (the user keeps it as deleteLine). `⌘E` is ignored
  inside `[data-agent-panel]` (dropdowns are portalled and carry it too).
- Header: the app's AI glyph (`StatusMark`, tinted and pulsed by `data-state`), the chat switcher,
  New chat, ⋯, close. **Which CLI runs the next chat is a pick-one section of the ⋯ menu** (`checked`
  rows + its health caption), not a header chip: it is chosen once, and the panel is 400px wide.
  The menu opens on the connected helper's version (a `label` entry, absent unless connected).
- The model list opens SHORT (`ModelPicker.shortlist`): the default, then family aliases (an id with no
  digit — `opus`, `sonnet` — which is what someone picking a model means), then the agent's own order,
  three in all plus whatever is chosen; `Show all N models` opens the rest. Claude reports a dozen, most
  of them pinned old versions.
- Replies render through `editor/replyView.ts` (read mode) — no new `innerHTML` sink. A reply's
  `.cm-content` is pinned to the scroller's width: one 493px formula in a 371px reply otherwise laid
  EVERY line out at 493px, and the prose ran off the edge instead of the formula scrolling. aicss free
  components are copied under `aicss/` (MIT, `LICENSE-aicss`); the composer and change cards are our
  own — the aicss Pro components must never be copied.

## Helper, installers, release (`helper/`)

- Subcommands: `serve [--dev] [--no-register]`, `install [--root]`, `uninstall [--root]`,
  `uninstall-service`, `--version`. `npm run helper:dev` runs it from source; `helper:build` compiles.
- macOS: unsigned `VaultAgent.pkg` (pkgbuild/productbuild) → postinstall runs `vaultagent install` as
  the console user → `~/Library/Application Support/VaultAgent/`, LaunchAgent `dev.bme.vaultagent`,
  errors to `~/Library/Logs/VaultAgent.log`. Windows: per-user Inno Setup, `%LOCALAPPDATA%\VaultAgent`,
  a logon task. Linux: the binary self-installs to `~/.local/share/vaultagent` + a systemd user unit
  (XDG autostart fallback). `helper.uninstall` removes registration, binary and logs, keeps
  `~/.bme-agent-sessions`; reinstall overwrites the same paths.
- `.github/workflows/vaultagent-release.yml` on tags `vaultagent-v*` builds all three, smoke-tests
  each (`bun helper/scripts/smoke.ts <binary>`, then `update-smoke.ts`), publishes `RELEASE_ASSETS` +
  the self-update assets + `vaultagent-release.json` (`helper/scripts/release-manifest.ts`) to GitHub
  Releases (the panel links `releases/latest/download/<asset>` — the repo must stay public and publish
  no other "latest" release). "Run workflow" = the same builds and checks, publishing nothing.
  **Release checklist:** bump `SOURCE_VERSION` in `helper/src/buildInfo.ts` (source runs report it; the
  tag sets a release build's; 0.2.0 = the first with a terminal), push, dispatch once on the branch,
  tag that commit, then check `latest/download/vaultagent-release.json` names the new version. Bump
  `MIN_HELPER_VERSION` (now 0.1.2, the first unrestricted helper) only when the CHAT needs a newer
  helper — a feature with its own gate (`TERMINAL_VERSION`, `SELF_UPDATE_VERSION`) never raises it,
  or every older helper is locked out of the chat too. `PROTOCOL_VERSION` stays 1 for additive changes.
  The macOS job also checks `helper/ptyhost/vaultagent-pty` against `PINNED.json` (CI never rebuilds
  it; see `integrated-terminal`). The release notes mention the terminal; there are no new assets.
  Every job that tests or compiles the helper runs `npm ci --ignore-scripts` first: since the terminal
  it bundles npm packages (`@xterm/headless` + addons), and a bare checkout cannot resolve them.
- **Self-update** (`helper/src/update.ts`; helpers ≥ `SELF_UPDATE_VERSION` 0.1.3, installed `serve`
  only — source / `--no-register` have no updater and answer `installed:false` / `unsupported`):
  - `helper.checkUpdate {force?}` → `UpdateCheck` (cached 10 min, a failure 30 s); `helper.update`
    streams `update.progress` to the asker, replies `{from,to}` once the new binary is in place, then
    restarts 300 ms later. Refused (`busy`) while any run is active; `run.start`, `terminal.open` and
    `helper.uninstall` refused while updating. A restart ends every terminal shell, so the panel asks
    first when `utils/terminalCount.ts` says any are open (update and uninstall alike). A copy not running from `installLayout`'s path answers `installed:false`.
  - Source of truth is baked at build time — `RELEASES_BASE_URL` (`--releases-base` for tests, never
    from the wire): manifest from `latest/download/`, the asset from the VERSIONED tag URL. Assets are
    raw per-OS binaries (`UPDATE_ASSET_NAMES`: ad-hoc-signed single-arch macOS, the Windows exe, the
    Linux binaries) — not the installers (a pkg needs root; Inno kills the running helper first).
  - Stages, nothing touched until the last: download into `<appDir>/vaultagent.update-<pid>` with
    size + sha256 → `--version` and a `serve --no-register` /health probe of the staged file →
    swap (POSIX rename = new inode; Windows renames the running exe aside, rolls back on failure,
    best-effort Apps & Features `DisplayVersion`) → restart: exit 75 under launchd
    (`XPC_SERVICE_NAME`) or the systemd unit (its cgroup), `schtasks /Run` on Windows, a detached
    `serve` otherwise. Leftovers are cleaned at the next installed start. Trust root = HTTPS to
    GitHub, as for the manual download; the sha guards corruption, not a compromised repo.
  - Panel (`agentBridge`): outdated helpers (< MIN) still connect, so they can be updated or
    uninstalled; `helperReady` gates the chat. The bridge owns the update (`update()`, `retain`s
    itself; a socket close while restarting is not "lost"; 90 s deadline → `update-lost`, kept across redials; an undismissed updated/failed outcome survives a
    disconnect and is shown on the next connection to that version). Download
    is offered only when no helper is known to be installed (plus `foreign`); a connected self-
    updatable helper gets the Update bar / ⋯ row instead; Uninstall is in the menu in every state.
  - **On every load** (once connected before), `components/agentUpdateHint.ts` runs
    `agentBridge.checkInBackground()` at idle (a dynamic import: the bridge stays out of the main
    chunk) — gated exactly like `autoConnect`, so no LNA prompt; `utils/agentUpdateNotice.ts` (a tiny
    store, imports nothing) puts a dot on the sidebar's agent button and the collapsed rail's expand
    button. The dot ignores the bar's per-version dismissal. Helpers below 0.1.3 cannot be asked, so get no dot unless outdated.
  - `CI=true bun helper/scripts/update-smoke.ts` (or `--replace-installed` locally — it replaces the
    user's install) runs bad-sha / broken-binary / good updates against a fake release on the real
    service manager.

## Verifying

`npm run typecheck`, `npm run lint`, `npm run helper:test`. Behaviour: `npm run helper:dev` plus the
dev server (loopback → loopback: no LNA prompt) and the `verify-in-browser` harness. Worth checking
after any adapter change: a shell call shows as a "Ran …" row, a vault edit arrives as a `vault_edit`
diff card in the open editor, and the CLI driven against a fake model server with scratch
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_*` still starts only our MCP server.
