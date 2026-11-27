import type { JobContext } from '../security/admission';
import { insertClipboardText, type InsertClipboardTextOptions } from './insertText';

export async function pasteClipboardTextInJob(options: InsertClipboardTextOptions, context: JobContext): Promise<string | null> {
    const { runtime } = options;
    runtime.jobs.assertContext(context); context.assertCurrent();
    if (options.signal && options.signal !== context.signal) throw new TypeError('In-job text paste must use the job signal');
    return insertClipboardText({ ...options, signal: context.signal,
        current: target => runtime.jobs.isCurrent(context.job) && options.current(target) });
}
export function pasteClipboardText(options: InsertClipboardTextOptions, signal?: AbortSignal): Promise<string | null> {
    return options.runtime.jobs.run(context => pasteClipboardTextInJob({ ...options, signal: context.signal }, context),
        { signal, deadlineMs: 120_000 });
}
