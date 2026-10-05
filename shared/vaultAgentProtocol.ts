// The contract between the editor (browser) and VaultAgent (the local helper).
//
// Imported by BOTH sides — `src/` (Vite, browser) and `helper/` (Bun) — so it
// must stay pure data and types: no DOM, no Node/Bun APIs, no imports.
//
// Shape of the system (see .agents/skills/vault-agent):
//
//   editor ⇄ WebSocket 127.0.0.1:<port>/ws ⇄ helper ⇄ agent CLI (claude/codex/opencode)
//                                              ▲
//                        CLI → MCP tools/call ─┘ → forwarded to the editor as `tool.call`
//
// The helper never touches the vault. Every vault operation the agent makes is
// an MCP call the helper forwards to the editor, which executes it against the
// vault's FileSystemDirectoryHandle and answers with `tool.result`. The agent
// CLI itself runs with its normal tools on the user's machine, but is told to
// use these vault tools for everything in the vault.
//
// The same helper also runs the editor's terminal (`terminal.*`): the user's own
// login shell in a PTY, unconstrained by the user's decision. It is a separate
// feature — no agent run ever sees, reads or drives a terminal session.

/* ───────────────────────── identity, ports, versions ───────────────────────── */

/** What `/health` answers in `app`, so another program on the port is told apart. */
export const HELPER_APP_ID = 'vaultagent';
/** Human name: installers, login items, the panel. */
export const HELPER_NAME = 'VaultAgent';
/** Bumped on any incompatible change to the messages below. */
export const PROTOCOL_VERSION = 1;
/** The panel offers the download again when `/health.version` is older.
 *  0.1.2 is the first helper whose CLIs run unrestricted, with no Codex
 *  version gate — older ones would keep refusing and contradict the panel. */
export const MIN_HELPER_VERSION = '0.1.2';
/** The helper binds the first free one; the panel probes them in order.
 *  The IP literal, never `localhost`: Chrome treats `http://127.0.0.1` as a
 *  secure context, and `localhost` may resolve to ::1 where nothing listens. */
export const HELPER_HOST = '127.0.0.1';
export const HELPER_PORTS: readonly number[] = [47823, 47824, 47825, 47826, 47827];
/** The deployed editor. Baked into the helper as an allowed Origin; release
 *  builds may add more through the VAULTAGENT_ALLOWED_ORIGINS repo variable. */
export const PRODUCTION_ORIGIN = 'https://notes.moizhashmi.com';
/** The GitHub Releases page the release workflow publishes to. */
export const RELEASES_BASE = 'https://github.com/MoizDev/browserMarkdownEditor/releases';
/** Where the release workflow publishes the installers. */
export const RELEASE_DOWNLOAD_BASE = `${RELEASES_BASE}/latest/download`;
/** Published beside the installers: `{app, version, assets: {<name>: {sha256, size}}}`
 *  for the raw per-OS binaries an installed helper updates itself from. */
export const RELEASE_MANIFEST = 'vaultagent-release.json';
/** The first helper that answers `helper.update`. Older ones cannot update
 *  themselves, so the panel keeps offering them the manual installer download. */
export const SELF_UPDATE_VERSION = '0.1.3';
/** The first helper with a terminal (`terminal.*`). The terminal dock gates on
 *  it on its own; MIN_HELPER_VERSION stays put, because the CHAT needs nothing
 *  new and raising it would lock every older helper out of the chat too. */
export const TERMINAL_VERSION = '0.2.0';
export const RELEASE_ASSETS = {
    macos: 'VaultAgent.pkg',
    windows: 'VaultAgent-Setup.exe',
    'linux-x64': 'vaultagent-linux-x64',
    'linux-arm64': 'vaultagent-linux-arm64',
} as const;

/* ───────────────────────── limits ───────────────────────── */

/** One WebSocket frame (images ride inside `run.start`). */
export const MAX_WS_MESSAGE_BYTES = 25 * 1024 * 1024;
/** One MCP request body from a CLI. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;
/** One tool result the editor sends back (text + base64 images). */
export const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
/** Text returned by one tool call. Claude Code spills MCP results over ~25k
 *  tokens to a file the agent then has to read back; stay under. */
export const MAX_TOOL_TEXT_CHARS = 60_000;
/** How long the helper waits for the editor to answer a `tool.call`. Opening a
 *  closed canvas in a side pane waits up to 15 s for it to mount. */
export const TOOL_CALL_TIMEOUT_MS = 90_000;
/** Pasted/attached images per message, and bytes each. */
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Mirrored instruction/skill files (CLAUDE.md, AGENTS.md, skills). */
export const MAX_MIRROR_FILE_BYTES = 256 * 1024;
export const MAX_MIRROR_TOTAL_BYTES = 4 * 1024 * 1024;

/** Open terminals per helper connection — a runaway `+` loop must not fork
 *  shells until the machine runs out of ptys (macOS defaults to 511). */
export const MAX_TERMINALS = 10;
/** One `terminal.input` frame. A paste larger than this is split by the panel;
 *  the helper drops anything over it rather than buffering without bound. */
export const TERMINAL_INPUT_MAX_CHARS = 65_536;
/** Clamp for `cols`/`rows`: a bogus size would make the headless mirror
 *  allocate a screen buffer of that many cells. */
export const TERMINAL_MAX_COLS = 1000;
export const TERMINAL_MAX_ROWS = 500;
/** A shell whose page went away (reload, closed tab, sleep) keeps running this
 *  long so the page can re-attach to it; then it is killed. */
export const TERMINAL_DETACHED_TTL_MS = 30 * 60_000;
/** Flow control: Bun's PTY cannot pause its reads, so the helper counts output
 *  the panel has not yet acknowledged (`terminal.ack`, from xterm's write
 *  callback). Above HIGH it stops streaming and lets the headless mirror absorb
 *  the flood; once acks bring it under LOW it sends one `reset` snapshot and
 *  resumes. Keeps `yes` from growing the helper or freezing the tab. */
export const TERMINAL_ACK_HIGH = 512_000;
export const TERMINAL_ACK_LOW = 128_000;
/** Scrollback lines the helper's headless mirror keeps, and so the most a
 *  re-attach or a `reset` snapshot can restore. */
export const TERMINAL_SCROLLBACK = 5000;

/* ───────────────────────── agents ───────────────────────── */

export type AgentId = 'claude' | 'codex' | 'opencode';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'opencode'];
export const AGENT_LABELS: Record<AgentId, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
};

export type HelperPlatform = 'macos' | 'windows' | 'linux';

/** `GET /health`. Answered with CORS for the allowed origins only. */
export interface HealthResponse {
    app: typeof HELPER_APP_ID;
    version: string;
    protocol: number;
    platform: HelperPlatform;
}

export interface AgentStatus {
    agent: AgentId;
    installed: boolean;
    version: string | null;
    /** null = could not tell (the check itself failed or timed out). */
    loggedIn: boolean | null;
    /** What the user types in a terminal to log in, e.g. `codex login`. */
    loginCommand: string;
    /** How to install it, e.g. `npm i -g @openai/codex`. */
    installCommand: string;
}

export interface ModelInfo {
    /** Passed back verbatim in `run.start.model`. */
    id: string;
    label: string;
    /** Effort levels this model accepts, low → high; empty = no effort control. */
    efforts: string[];
    defaultEffort: string | null;
    /** Whether it accepts image input. When false the panel sends no image and
     *  the context block says so. */
    images: boolean;
    isDefault?: boolean;
}

/* ───────────────────────── the agent's normalized event stream ───────────────────────── */

/** Every adapter (claude/codex/opencode) normalizes its CLI's output to these. */
export type AgentEvent =
    /** The CLI's own session/thread id — known as soon as the run starts. */
    | { type: 'session'; sessionId: string }
    | { type: 'text-delta'; text: string }
    | { type: 'reasoning-delta'; text: string }
    /**
     * A tool the agent used that is NOT one of ours — any of the CLI's own
     * tools: shell, file reads/edits, web, skills, sub-agents… Our own `vault_*`/`canvas_*` calls reach the panel as
     * `tool.call` messages and are never repeated here.
     */
    | { type: 'tool'; callId: string; name: string; input?: unknown; status: 'running' | 'done' | 'error'; output?: string }
    /** Something the user should see that is not the agent's reply. */
    | { type: 'notice'; message: string };

/** The stages of a self-update, in order, as `update.progress` reports them. */
export type UpdatePhase = 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting';

/** `helper.checkUpdate`. */
export interface UpdateCheck {
    current: string;
    /** null = the check failed (see `error`) or the helper cannot update itself. */
    latest: string | null;
    available: boolean;
    /** false = no updater: a source run or `serve --no-register`. */
    installed: boolean;
    error?: string;
}

/** One font the user's own terminal app is set to, as `terminal.fontHint`
 *  found it. The browser takes the first candidate that is installed. */
export interface TerminalFontCandidate {
    /** Where it came from: 'ghostty', 'iterm2', 'kitty', 'alacritty', 'wezterm',
     *  'windows-terminal', 'terminal-app', 'vscode'. */
    source: string;
    family?: string;
    /** e.g. `MesloLGS-NF-Regular` — CSS `local()` accepts it directly. */
    postscript?: string;
    /** Points, as the terminal app stores it. */
    size?: number;
}

/** How a terminal's shell ended. */
export interface TerminalExit {
    code: number | null;
    signal: string | null;
}

/** Which PTY spawned the shell: macOS installed helpers use the frozen
 *  `vaultagent-pty` host (so privacy grants survive updates); everything else
 *  is Bun's in-process PTY. */
export type TerminalBackend = 'ptyhost' | 'inprocess';

export interface RunUsage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}

export type RunErrorReason =
    | 'busy'            // a run is already in flight on this connection
    | 'agent-missing'   // CLI not found
    | 'logged-out'      // CLI found, not logged in
    | 'agent-changed'   // the CLI answered in a shape this helper does not understand
    | 'bad-request'     // invalid ids, sizes, model…
    | 'crashed'         // CLI exited abnormally / protocol error
    | 'cancelled';

/* ───────────────────────── history (read back from the CLI's own store) ───────────────────────── */

export type HistoryItem =
    /** `text` still carries the <bme-context> block; the panel strips it. */
    | { kind: 'user'; text: string; imageCount: number }
    | { kind: 'assistant'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'tool'; name: string; input?: unknown; output?: string; isError?: boolean };

export interface SessionHistory {
    /** false = no such session on THIS machine (a chat started on another computer). */
    found: boolean;
    items: HistoryItem[];
}

/* ───────────────────────── tool results (MCP content) ───────────────────────── */

export type ToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string /* base64 */; mimeType: string };

export interface ToolResult {
    content: ToolContent[];
    isError?: boolean;
}

/* ───────────────────────── WebSocket messages ───────────────────────── */

export interface RunImage {
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    /** base64, no data: prefix. */
    data: string;
}

/** A vault file copied into the agent's working folder (instructions/skills). */
export interface MirrorFile {
    /** Vault-relative, `/`-separated: `CLAUDE.md`, `AGENTS.md`,
     *  `.claude/skills/**`, `.agents/skills/**` — nothing else is accepted. */
    path: string;
    text: string;
}

/** Request name → [params, result]. Every request carries a `reqId` and gets
 *  exactly one `response` with the same `reqId`. */
export interface RequestMap {
    hello: [{ protocol: number }, { version: string; protocol: number; platform: HelperPlatform; sessionsDir: string }];
    'agents.status': [{ refresh?: boolean }, AgentStatus[]];
    'models.list': [{ agent: AgentId }, ModelInfo[]];
    /** Replace the mirrored instruction/skill files of one vault's working folder. */
    'vault.sync': [{ vaultId: string; files: MirrorFile[] }, { written: number; removed: number }];
    /**
     * Start one turn. `sessionId` null = a new chat. Resolves once the CLI is
     * spawned; the turn itself streams as `run.event` and ends with exactly one
     * `run.done` or `run.error` for `runId`.
     */
    'run.start': [{
        runId: string;
        vaultId: string;
        agent: AgentId;
        sessionId: string | null;
        model: string | null;
        effort: string | null;
        /** The <bme-context> block followed by what the user typed. */
        text: string;
        images: RunImage[];
    }, { accepted: true }];
    'run.cancel': [{ runId: string }, { cancelled: boolean }];
    'session.history': [{ vaultId: string; agent: AgentId; sessionId: string }, SessionHistory];
    /** Delete the CLI's own record of the session (so it leaves `--resume` too). */
    'session.delete': [{ vaultId: string; agent: AgentId; sessionId: string }, { deleted: boolean }];
    /** Remove the login registration, the binary and the logs, then exit.
     *  `~/.bme-agent-sessions` is kept. Responds before it goes. */
    'helper.uninstall': [Record<string, never>, { ok: true }];
    /** Is a newer release published? Cached by the helper; `force` skips the cache. */
    'helper.checkUpdate': [{ force?: boolean }, UpdateCheck];
    /** Download, check and install the latest release, then restart into it.
     *  Progress streams as `update.progress` to the asking connection only.
     *  Responds once the new binary is in place, before the helper restarts;
     *  a failure response means the running helper and its binary are untouched. */
    'helper.update': [Record<string, never>, { from: string; to: string }];
    /** Start a new shell in a PTY under the client-minted `termId` (a UUID).
     *  Its output streams as `terminal.output`, its end as `terminal.exit`. */
    'terminal.open': [{ termId: string; cols: number; rows: number }, { shell: string; pid: number; backend: TerminalBackend }];
    /** Take over an existing shell — after a reload, or from another window
     *  (which then gets `terminal.detached`). `snapshot` is the serialized
     *  screen + scrollback to write into a freshly reset xterm. */
    'terminal.attach': [{ termId: string; cols: number; rows: number }, { snapshot: string; shell: string; exited: TerminalExit | null }];
    'terminal.resize': [{ termId: string; cols: number; rows: number }, Record<string, never>];
    /** Kill the shell (and its process group) and forget the session. */
    'terminal.close': [{ termId: string }, Record<string, never>];
    /** The fonts the user's terminal apps are configured with, best first. */
    'terminal.fontHint': [Record<string, never>, { candidates: TerminalFontCandidate[] }];
    /** Which backend new shells get, and (macOS, PTY host only) whether that
     *  host has Full Disk Access; null = not macOS, or could not tell. */
    'terminal.privacy': [Record<string, never>, { backend: TerminalBackend; fullDiskAccess: boolean | null }];
    /** macOS: open System Settings → Privacy & Security → Full Disk Access. */
    'helper.openPrivacySettings': [Record<string, never>, Record<string, never>];
    /** macOS: reveal the installed `vaultagent-pty` in Finder. */
    'helper.revealPtyHost': [Record<string, never>, Record<string, never>];
}

export type RequestName = keyof RequestMap;
export type RequestParams<N extends RequestName> = RequestMap[N][0];
export type RequestResult<N extends RequestName> = RequestMap[N][1];

export type ClientRequest = {
    [N in RequestName]: { type: N; reqId: string } & RequestParams<N>
}[RequestName];

/** Panel → helper. */
export type ClientMessage =
    | ClientRequest
    | { type: 'tool.result'; runId: string; callId: string; result: ToolResult }
    /** Keystrokes/paste for a terminal; at most TERMINAL_INPUT_MAX_CHARS. */
    | { type: 'terminal.input'; termId: string; data: string }
    /** How many characters of `terminal.output` xterm has finished parsing. */
    | { type: 'terminal.ack'; termId: string; chars: number };

export type ErrorCode = RunErrorReason | 'not-found' | 'internal' | 'unsupported' | 'limit';

/** Helper → panel. */
export type HelperMessage =
    | { type: 'response'; reqId: string; ok: true; result: unknown }
    | { type: 'response'; reqId: string; ok: false; error: { code: ErrorCode; message: string } }
    | { type: 'run.event'; runId: string; event: AgentEvent }
    | { type: 'run.done'; runId: string; sessionId: string | null; status: 'ok' | 'cancelled'; usage?: RunUsage }
    | { type: 'run.error'; runId: string; reason: RunErrorReason; message: string }
    | { type: 'tool.call'; runId: string; callId: string; name: ToolName; args: Record<string, unknown> }
    /** Sent only to the connection that asked for `helper.update`. */
    | { type: 'update.progress'; phase: UpdatePhase; received?: number; total?: number }
    /** Shell output, UTF-8-decoded. `reset` = `data` is a whole-screen snapshot:
     *  reset the xterm, then write it (after flow control caught up). */
    | { type: 'terminal.output'; termId: string; data: string; reset?: true }
    /** The shell ended; the session stays until `terminal.close` or the TTL. */
    | { type: 'terminal.exit'; termId: string; code: number | null; signal: string | null }
    /** Another connection attached to this terminal; this one no longer owns it. */
    | { type: 'terminal.detached'; termId: string };

/* ───────────────────────── the agent's tools ───────────────────────── */

/** The MCP server name every CLI sees. Claude names the tools `mcp__vault__<name>`. */
export const MCP_SERVER_NAME = 'vault';

export type ToolName =
    | 'vault_list' | 'vault_read' | 'vault_view' | 'vault_search'
    | 'vault_edit' | 'vault_write' | 'vault_create' | 'vault_mkdir' | 'vault_move' | 'vault_trash'
    | 'canvas_shapes' | 'canvas_apply';

// The tool table itself (names, JSON schemas, agent-facing descriptions) is
// ./vaultAgentTools.ts: only the lazy panel and the helper need it, and a module
// the editor's main chunk imports keeps every binding ANY chunk uses.

/* ───────────────────────── canvas ops (TS mirror of CANVAS_OP) ───────────────────────── */

export type CanvasColor = 'black' | 'grey' | 'light-violet' | 'violet' | 'blue' | 'light-blue' | 'yellow' | 'orange' | 'green' | 'light-green' | 'light-red' | 'red' | 'white';
export type CanvasSize = 's' | 'm' | 'l' | 'xl';
export type CanvasFill = 'none' | 'semi' | 'solid' | 'pattern';
export type CanvasDash = 'draw' | 'solid' | 'dashed' | 'dotted';
export type CanvasPoint = [number, number] | [number, number, number];
export type CanvasEnd = { x: number; y: number } | { shapeId: string };

export type CanvasOp =
    | { op: 'create'; type: 'text'; page?: number; x: number; y: number; text: string; w?: number; color?: CanvasColor; size?: CanvasSize; align?: 'start' | 'middle' | 'end' }
    | { op: 'create'; type: 'note'; page?: number; x: number; y: number; text: string; color?: CanvasColor; size?: CanvasSize }
    | { op: 'create'; type: 'geo'; geo: string; page?: number; x: number; y: number; w: number; h: number; text?: string; color?: CanvasColor; fill?: CanvasFill; dash?: CanvasDash; size?: CanvasSize; rotation?: number }
    | { op: 'create'; type: 'line'; page?: number; points: CanvasPoint[]; color?: CanvasColor; dash?: CanvasDash; size?: CanvasSize }
    | { op: 'create'; type: 'arrow'; page?: number; start: CanvasEnd; end: CanvasEnd; text?: string; color?: CanvasColor; dash?: CanvasDash; size?: CanvasSize; bend?: number }
    | { op: 'create'; type: 'draw'; page?: number; points: CanvasPoint[]; color?: CanvasColor; size?: CanvasSize; closed?: boolean }
    | { op: 'update'; id: string; page?: number; x?: number; y?: number; w?: number; h?: number; rotation?: number; color?: CanvasColor; fill?: CanvasFill; dash?: CanvasDash; size?: CanvasSize; text?: string }
    | { op: 'delete'; ids: string[] };

/* ───────────────────────── small shared helpers ───────────────────────── */

/** Compare dotted versions numerically ("0.10.0" > "0.9.3"). Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Vault ids and Claude session ids are UUIDs; the helper builds paths from them. */
export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

/** Opens the agent-facing context block prefixed to each user message. */
export const CONTEXT_OPEN_TAG = '<bme-context>';
export const CONTEXT_CLOSE_TAG = '</bme-context>';
