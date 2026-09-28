---
name: vault-agent
description: The AI agent panel ("VaultAgent") — the right-docked chat that runs Claude Code, Codex or OpenCode through a local background helper, its containment to the vault, the WebSocket/MCP protocol, the per-message context snapshot, the tool executor, the chat index in `.VaultAgent/`, and the installers/release. Load before touching shared/, helper/, components/AgentPanel/, utils/agent*.ts, utils/vaultAgent*.ts, utils/viewRegistry.ts, canvasAgentOps.ts, or anything the agent can read or change.
---

# VaultAgent: an agent CLI that can only touch the open vault

```
Chrome (the editor)                          the user's machine
AgentPanel (lazy) ─ agentBridge ──WS──▶ 127.0.0.1:47823-47827  helper (Bun exe, login item)
      ▲                                     │ spawns, per message/vault
      │ tool.call / tool.result             ▼
executeTool (utils/vaultAgentTools.ts)   claude -p │ codex app-server │ opencode serve
      │                                     │ cwd ~/.bme-agent-sessions/<vault-uuid>/
agentHost (utils/agentHost.ts) → App     ◀──┘ MCP tools/call → POST /mcp/<runToken>
```

## Containment is the whole point — never weaken it

- **The helper never touches the vault; the CLI never gets a path into it.** Every CLI runs with
  its built-in file, shell, patch and image tools OFF. Its only file access is our `vault` MCP server
  (served by the helper), whose `tools/call` is forwarded to the browser, which executes it against
  the vault's `FileSystemDirectoryHandle` through App's own handlers. Nothing names a disk path.
- What IS on: web search (the user's explicit decision; plus Claude's WebFetch), and skills (instruction
  text). A fetch tool is a door to every unauthenticated LOCAL http service (a dev server's `/@fs/`
  reads any file): Claude's WebFetch is https-only, follows no cross-host redirect and is denied the
  loopback/metadata hosts (`--disallowedTools WebFetch(domain:…)`); OpenCode's `webfetch` does plain
  http AND follows redirects (verified: it read our `/health` through a public redirect), so it is denied.
- Per CLI (verified against claude 2.1.283, codex 0.157.x, opencode 1.18.29; each flag has a why-comment
  in `helper/src/agents/*.ts`, and `helper/test/adapters.test.ts` asserts the argv/env — a regression
  guard; keep it green):
  - **Claude**: `--tools Skill,WebSearch,WebFetch`, `--allowedTools mcp__vault,…`, `--permission-mode
    dontAsk`, `--disallowedTools WebFetch(domain:<loopback>)…`, `--strict-mcp-config --mcp-config <inline>` (token via `${VAR}` in env, never argv),
    `--settings '{"disableAllHooks":true,"autoMemoryEnabled":false}'`. **Never `--bare`** (breaks OAuth).
  - **Codex** (`app-server`, JSON-RPC): `environments: []` on the thread AND every turn (a resume brings
    the local environment back; the helper re-reads the thread after each turn and refuses the run if
    it came back); `-c` overrides for features, `web_search="live"`, the user's own MCP servers
    disabled. Accepted versions `CODEX_TESTED` (0.157.0 ≤ v < 0.170.0); anything else →
    `AgentStatus.incompatible` and the run is REFUSED, never silently degraded.
  - **OpenCode**: one `opencode serve` per vault folder (loopback, an explicit free port — `--port 0`
    means 4096 — and a random password), permission `*` deny with our tools/skill/websearch allowed,
    `OPENCODE_PURE=1` (no plugins), `OPENCODE_DISABLE_PROJECT_CONFIG=1`; any `permission.asked` is
    rejected. Only the adapter talks to it. The folder is made its own OpenCode project (a hand-laid
    `.git` with an `opencode` id file, `ensureOpencodeProject`) — else every non-git folder shares one
    "global" project and panel chats appeared in the user's own `opencode session list`.
- **Zero interference with the user's own CLI use** (a user requirement): every setting is a flag,
  env var or inline config for that one process. Nothing writes `~/.claude/settings.json`,
  `~/.claude.json` MCP entries, `~/.codex/config.toml` or OpenCode's config; nothing is registered
  globally. The CLIs' own session stores gain only the panel's sessions (cwd under
  `~/.bme-agent-sessions`). Known residue: Codex still reads `~/.agents/skills`; OpenCode still loads
  (but denies) global custom tools, and its `opencode.log` and project list gain the panel's folders.
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

The app has no external-change detection: a write it did not make is clobbered by the next autosave.
So text edits (`vault_edit`/`vault_write`, refused as stale unless the text still equals what the agent
read) go live view → cached `EditorState`s + buffer → disk + `afterWrite`; create/mkdir refuse taken
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
  each (`bun helper/scripts/smoke.ts <binary>`), publishes `RELEASE_ASSETS` to GitHub Releases (the
  panel links `releases/latest/download/<asset>` — the repo must stay public and publish no other
  "latest" release). Bump `MIN_HELPER_VERSION` when the panel needs a newer helper.

## Verifying

`npm run typecheck`, `npm run lint`, `npm run helper:test`. Behaviour: `npm run helper:dev` plus the
dev server (loopback → loopback: no LNA prompt) and the `verify-in-browser` harness. Containment
checks worth repeating after any adapter change: ask the agent to read `/etc/hosts`, `~/.ssh/config`
and `../` — every one must fail.
