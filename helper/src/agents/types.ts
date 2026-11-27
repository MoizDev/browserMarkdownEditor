import type {
    AgentEvent, AgentId, AgentStatus, ModelInfo, RunErrorReason, RunImage, RunUsage, SessionHistory,
} from '../../../shared/vaultAgentProtocol.ts';

export interface RunContext {
    runId: string;
    cwd: string;
    sessionId: string | null;
    model: string | null;
    effort: string | null;
    text: string;
    images: RunImage[];
    mcpBaseUrl: string;
    mcpToken: string;
    emit(event: AgentEvent): void;
}

export type RunOutcome =
    | { kind: 'done'; status: 'ok' | 'cancelled'; sessionId: string | null; usage?: RunUsage }
    | { kind: 'error'; reason: RunErrorReason; message: string };

export interface RunHandle {
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
    start(ctx: RunContext): Promise<RunHandle>;
    history(cwd: string, sessionId: string): Promise<SessionHistory>;
    deleteSession(cwd: string, sessionId: string): Promise<boolean>;
    isValidSessionId(id: unknown): id is string;
    isValidModel(id: unknown): id is string;
}

/** The env var the adapters pass the run's MCP token in (never argv: `ps` shows argv to every user). */
export const MCP_TOKEN_ENV = 'VAULTAGENT_MCP_TOKEN';

export const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;
export const SAFE_EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Foreign = any;

export function truncate(text: string, max = 4000): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
