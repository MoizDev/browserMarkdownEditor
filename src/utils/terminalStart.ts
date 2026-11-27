export interface TerminalStart {
    vaultId: string | null;
    dir: string;
}

const NOWHERE: TerminalStart = { vaultId: null, dir: '' };

let source: (() => Promise<TerminalStart>) | null = null;

export function setTerminalStartSource(fn: () => Promise<TerminalStart>): void {
    source = fn;
}

export async function terminalStart(): Promise<TerminalStart> {
    if (!source) return NOWHERE;
    try {
        return await source();
    } catch {
        return NOWHERE;
    }
}
