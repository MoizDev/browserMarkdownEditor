// Imported by BOTH sides — `src/` (Vite, browser) and `helper/` (Bun) — so it
// must stay pure data and types: no DOM, no Node/Bun APIs, no imports.

export const HELPER_APP_ID = 'vaultagent';
export const HELPER_NAME = 'VaultAgent';
export const PROTOCOL_VERSION = 1;
export const MIN_HELPER_VERSION = '0.1.2';
export const HELPER_HOST = '127.0.0.1';
export const HELPER_PORTS: readonly number[] = [47823, 47824, 47825, 47826, 47827];
export const PRODUCTION_ORIGIN = 'https://notes.moizhashmi.com';
export const RELEASES_BASE = 'https://github.com/MoizDev/browserMarkdownEditor/releases';
export const RELEASE_DOWNLOAD_BASE = `${RELEASES_BASE}/latest/download`;
export const RELEASE_MANIFEST = 'vaultagent-release.json';
export const SELF_UPDATE_VERSION = '0.1.3';
export const TERMINAL_VERSION = '0.2.0';
export const CANVAS_PAGING_VERSION = '0.2.2';
export const RELEASE_ASSETS = {
    macos: 'VaultAgent.pkg',
    windows: 'VaultAgent-Setup.exe',
    'linux-x64': 'vaultagent-linux-x64',
    'linux-arm64': 'vaultagent-linux-arm64',
} as const;

export const MAX_WS_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_MCP_BODY_BYTES = 1024 * 1024;
export const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_TEXT_CHARS = 60_000;
export const TOOL_CALL_TIMEOUT_MS = 90_000;
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MIRROR_FILE_BYTES = 256 * 1024;
export const MAX_MIRROR_TOTAL_BYTES = 4 * 1024 * 1024;

export const MAX_TERMINALS = 10;
export const TERMINAL_INPUT_MAX_CHARS = 65_536;
export const TERMINAL_MAX_COLS = 1000;
export const TERMINAL_MAX_ROWS = 500;
export const TERMINAL_DETACHED_TTL_MS = 30 * 60_000;
export const TERMINAL_ACK_HIGH = 512_000;
export const TERMINAL_ACK_LOW = 128_000;
export const TERMINAL_SCROLLBACK = 5000;

export type AgentId = 'claude' | 'codex' | 'opencode';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'opencode'];
export const AGENT_LABELS: Record<AgentId, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
};

export type HelperPlatform = 'macos' | 'windows' | 'linux';

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
    loggedIn: boolean | null;
    loginCommand: string;
    installCommand: string;
}

export interface ModelInfo {
    id: string;
    label: string;
    efforts: string[];
    defaultEffort: string | null;
    images: boolean;
    isDefault?: boolean;
}

export type AgentEvent =
    | { type: 'session'; sessionId: string }
    | { type: 'text-delta'; text: string }
    | { type: 'reasoning-delta'; text: string }
    | { type: 'tool'; callId: string; name: string; input?: unknown; status: 'running' | 'done' | 'error'; output?: string }
    | { type: 'notice'; message: string };

export type UpdatePhase = 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting';

export interface UpdateCheck {
    current: string;
    latest: string | null;
    available: boolean;
    installed: boolean;
    error?: string;
}

export interface TerminalFontCandidate {
    source: string;
    family?: string;
    postscript?: string;
    size?: number;
}

export interface TerminalExit {
    code: number | null;
    signal: string | null;
}

export type TerminalBackend = 'ptyhost' | 'inprocess';

export interface RunUsage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}

export type RunErrorReason =
    | 'busy'
    | 'agent-missing'
    | 'logged-out'
    | 'agent-changed'
    | 'bad-request'
    | 'crashed'
    | 'cancelled';

export type HistoryItem =
    | { kind: 'user'; text: string; imageCount: number }
    | { kind: 'assistant'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'tool'; name: string; input?: unknown; output?: string; isError?: boolean };

export interface SessionHistory {
    found: boolean;
    items: HistoryItem[];
}

export type ToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
    content: ToolContent[];
    isError?: boolean;
}

export interface RunImage {
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
}

export interface MirrorFile {
    path: string;
    text: string;
}

export interface RequestMap {
    hello: [{ protocol: number }, { version: string; protocol: number; platform: HelperPlatform; sessionsDir: string }];
    'agents.status': [{ refresh?: boolean }, AgentStatus[]];
    'models.list': [{ agent: AgentId }, ModelInfo[]];
    'vault.sync': [{ vaultId: string; files: MirrorFile[] }, { written: number; removed: number }];
    'run.start': [{
        runId: string;
        vaultId: string;
        agent: AgentId;
        sessionId: string | null;
        model: string | null;
        effort: string | null;
        text: string;
        images: RunImage[];
    }, { accepted: true }];
    'run.cancel': [{ runId: string }, { cancelled: boolean }];
    'session.history': [{ vaultId: string; agent: AgentId; sessionId: string }, SessionHistory];
    'session.delete': [{ vaultId: string; agent: AgentId; sessionId: string }, { deleted: boolean }];
    'helper.uninstall': [Record<string, never>, { ok: true }];
    'helper.checkUpdate': [{ force?: boolean }, UpdateCheck];
    'helper.update': [Record<string, never>, { from: string; to: string }];
    'terminal.open': [
        { termId: string; cols: number; rows: number; vaultId?: string; dir?: string },
        { shell: string; pid: number; backend: TerminalBackend; cwd: string },
    ];
    'vault.path': [{ vaultId: string; set?: string }, { path: string | null }];
    'terminal.attach': [{ termId: string; cols: number; rows: number }, { snapshot: string; shell: string; exited: TerminalExit | null }];
    'terminal.resize': [{ termId: string; cols: number; rows: number }, Record<string, never>];
    'terminal.close': [{ termId: string }, Record<string, never>];
    'terminal.fontHint': [Record<string, never>, { candidates: TerminalFontCandidate[] }];
    'terminal.privacy': [Record<string, never>, { backend: TerminalBackend; fullDiskAccess: boolean | null }];
    'helper.openPrivacySettings': [Record<string, never>, Record<string, never>];
    'helper.revealPtyHost': [Record<string, never>, Record<string, never>];
}

export type RequestName = keyof RequestMap;
export type RequestParams<N extends RequestName> = RequestMap[N][0];
export type RequestResult<N extends RequestName> = RequestMap[N][1];

export type ClientRequest = {
    [N in RequestName]: { type: N; reqId: string } & RequestParams<N>
}[RequestName];

export type ClientMessage =
    | ClientRequest
    | { type: 'tool.result'; runId: string; callId: string; result: ToolResult }
    | { type: 'terminal.input'; termId: string; data: string }
    | { type: 'terminal.ack'; termId: string; chars: number };

export type ErrorCode = RunErrorReason | 'not-found' | 'internal' | 'unsupported' | 'limit';

export type HelperMessage =
    | { type: 'response'; reqId: string; ok: true; result: unknown }
    | { type: 'response'; reqId: string; ok: false; error: { code: ErrorCode; message: string } }
    | { type: 'run.event'; runId: string; event: AgentEvent }
    | { type: 'run.done'; runId: string; sessionId: string | null; status: 'ok' | 'cancelled'; usage?: RunUsage }
    | { type: 'run.error'; runId: string; reason: RunErrorReason; message: string }
    | { type: 'tool.call'; runId: string; callId: string; name: ToolName; args: Record<string, unknown> }
    | { type: 'update.progress'; phase: UpdatePhase; received?: number; total?: number }
    | { type: 'terminal.output'; termId: string; data: string; reset?: true }
    | { type: 'terminal.exit'; termId: string; code: number | null; signal: string | null }
    | { type: 'terminal.detached'; termId: string };

export const MCP_SERVER_NAME = 'vault';

export type ToolName =
    | 'vault_list' | 'vault_read' | 'vault_view' | 'vault_search'
    | 'vault_edit' | 'vault_write' | 'vault_create' | 'vault_mkdir' | 'vault_move' | 'vault_trash'
    | 'canvas_shapes' | 'canvas_apply';

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
export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

export const CONTEXT_OPEN_TAG = '<bme-context>';
export const CONTEXT_CLOSE_TAG = '</bme-context>';
