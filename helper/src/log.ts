// Errors only — and never the user's words. Nothing that passes through the
// helper (note text, prompts, tool arguments, tool results, a CLI's stderr,
// which can echo any of those) is ever written here; callers pass a fixed
// context string and at most an error's name/code/message from our own code.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | null = null;
const MAX_LOG_BYTES = 1024 * 1024;

/** null = stderr only (dev / --no-register runs). */
export function setLogFile(path: string | null): void {
    logFile = path;
}

function describe(err: unknown): string {
    if (err instanceof Error) {
        const code = (err as NodeJS.ErrnoException).code;
        return `${err.name}${code ? ` ${code}` : ''}: ${err.message}`.slice(0, 500);
    }
    if (typeof err === 'string') return err.slice(0, 500);
    return '';
}

export function logError(context: string, err?: unknown): void {
    const line = `${new Date().toISOString()} ERROR ${context}${err === undefined ? '' : ` — ${describe(err)}`}\n`;
    if (!logFile) {
        process.stderr.write(line);
        return;
    }
    try {
        mkdirSync(dirname(logFile), { recursive: true });
        try {
            // One rotation step keeps a busy failure loop from filling the disk.
            if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
        } catch { /* no log yet */ }
        appendFileSync(logFile, line);
    } catch {
        process.stderr.write(line);
    }
}
