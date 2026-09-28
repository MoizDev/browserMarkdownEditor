// The one interface the three CLI adapters implement. Everything above this
// (server.ts, runs.ts) is agent-agnostic.

import type {
    AgentEvent, AgentId, AgentStatus, ModelInfo, RunErrorReason, RunImage, RunUsage, SessionHistory,
} from '../../../shared/vaultAgentProtocol.ts';

export interface RunContext {
    runId: string;
    /** The vault's working folder, `~/.bme-agent-sessions/<vaultId>` — created. */
    cwd: string;
    sessionId: string | null;
    model: string | null;
    effort: string | null;
    text: string;
    images: RunImage[];
    /** Our MCP endpoint for this run, e.g. `http://127.0.0.1:47823/mcp/<token>`. */
    mcpBaseUrl: string;
    /** The run's bearer token; adapters pass it by env var, never on argv. */
    mcpToken: string;
    emit(event: AgentEvent): void;
}

export type RunOutcome =
    | { kind: 'done'; status: 'ok' | 'cancelled'; sessionId: string | null; usage?: RunUsage }
    | { kind: 'error'; reason: RunErrorReason; message: string };

export interface RunHandle {
    /** Settles exactly once, whatever happens to the CLI. Never rejects. */
    outcome: Promise<RunOutcome>;
    cancel(): void;
}

export class RunRefused extends Error {
    constructor(public reason: RunErrorReason, message: string) {
        super(message);
        this.name = 'RunRefused';
    }
}

export interface AgentAdapter {
    id: AgentId;
    status(refresh: boolean): Promise<AgentStatus>;
    models(refresh: boolean): Promise<ModelInfo[]>;
    /** Resolves once the CLI is spawned and the turn is under way; throws RunRefused before that. */
    start(ctx: RunContext): Promise<RunHandle>;
    history(cwd: string, sessionId: string): Promise<SessionHistory>;
    deleteSession(cwd: string, sessionId: string): Promise<boolean>;
    /** Session ids reach file paths and argv; each CLI has its own shape. */
    isValidSessionId(id: unknown): id is string;
    /** Model ids reach argv / request bodies. */
    isValidModel(id: unknown): id is string;
}

/** The env var the adapters pass the run's MCP token in (never argv: `ps` shows argv to every user). */
export const MCP_TOKEN_ENV = 'VAULTAGENT_MCP_TOKEN';

/** Conservative shared check for model ids / effort names before they reach a CLI. */
export const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;
export const SAFE_EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * JSON from the CLIs (stream-json lines, JSON-RPC notifications, SSE events):
 * walked defensively, field by field, with every value type-checked where it is
 * used. Spelling each step as `unknown` + a cast would triple these parsers
 * without adding a single check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Foreign = any;

export function truncate(text: string, max = 4000): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
