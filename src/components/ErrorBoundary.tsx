import { Component, Fragment, createContext, useContext, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { chunkFailureOf, classifyChunkFailure, type ChunkLoadError } from '../platform/chunkLoad';
import { retryFailedModuleSlots } from './moduleSlot';
import { runCrashCheckpoint } from '../utils/crashCheckpoint';

/*
 * Error boundaries, so one part that fails to draw takes down only itself.
 *
 * Before these there was none in the app, and React 19 unmounts the whole root on an uncaught render error: a lazy
 * chunk that 404'd after a redeploy (Settings, a board's pane) or any render-time bug left a BLANK PAGE, with every
 * open document's unsaved edits gone with it (measured: Settings' chunk 404, one click → `#root` empty). Now each
 * document pane and each lazy panel has its own boundary with Try again; the workspace has one that keeps App — and
 * with it the save machinery — mounted; and main.tsx has a last one for App itself.
 */

/** What a failure screen can do with the app's save machinery: write out pending work, then reload — never over
 *  work that is still unsaved. Provided by App (useUpdateNotice); absent above App, where main.tsx's root boundary
 *  goes through utils/crashCheckpoint.ts instead. */
export interface AppRecovery {
    /** Resolves false (and reloads nothing) while edits are still unsaved. */
    saveAndReload(): Promise<boolean>;
}
const AppRecoveryContext = createContext<AppRecovery | null>(null);
export const AppRecoveryProvider = AppRecoveryContext.Provider;

interface BoundaryProps {
    /** Named in the console line, so a report says which part failed. */
    label: string;
    fallback: (error: unknown, retry: () => void) => ReactNode;
    children?: ReactNode;
}

interface BoundaryState { failed: boolean; error: unknown; attempt: number }

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { failed: false, error: undefined, attempt: 0 };

    static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
        return { failed: true, error };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        console.error(`${this.props.label} failed to draw:`, error, info.componentStack);
    }

    /** Remount the children: lazy modules that failed load again (moduleSlot), everything else renders afresh. */
    retry = (): void => {
        retryFailedModuleSlots();
        this.setState(state => ({ failed: false, error: undefined, attempt: state.attempt + 1 }));
    };

    render(): ReactNode {
        if (this.state.failed) return this.props.fallback(this.state.error, this.retry);
        return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
}

/** The failure, classified once: a chunk that is gone, one that did not arrive, or a bug. A worker whose script could not
 *  be delivered carries that as its error's `cause` (platform/workers/client.ts). */
function useClassified(error: unknown): ChunkLoadError | null {
    const [classified, setClassified] = useState<ChunkLoadError | null>(() => chunkFailureOf(error));
    useEffect(() => {
        if (chunkFailureOf(error)) return;
        let live = true;
        void classifyChunkFailure(error).then(result => { if (live && result) setClassified(result); });
        return () => { live = false; };
    }, [error]);
    return classified;
}

function errorText(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    if (!error.message) return error.name;
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
}

interface FailureProps {
    error: unknown;
    retry: () => void;
    /** What failed, in the person's words: "Settings", "Notes.md". */
    what: ReactNode;
}

/** A pane's or panel's failure, in the unreadable pane's own look (DocumentPane's `.unread-pane`). */
export function PartFailure({ error, retry, what }: FailureProps) {
    const chunk = useClassified(error);
    const recovery = useContext(AppRecoveryContext);
    const [reloadRefused, setReloadRefused] = useState(false);
    if (chunk?.failure === 'gone') return (
        <>
            <span className="unread-pane-title">A new version of the app is available</span>
            <span className="unread-pane-hint">This page’s version of the app no longer has what {what} needs on the server. Reload to open it in the new version.</span>
            {reloadRefused && <span className="unread-pane-detail">Finish saving your changes, then reload.</span>}
            <button
                className="pdf-pane-action"
                onClick={() => {
                    if (recovery) void recovery.saveAndReload().then(done => setReloadRefused(!done));
                    else window.location.reload();
                }}
            >
                Reload
            </button>
        </>
    );
    return (
        <>
            <span className="unread-pane-title">
                {chunk ? <>Couldn’t load {what}</> : <>Something went wrong showing {what}</>}
            </span>
            <span className="unread-pane-hint">
                {chunk
                    ? `${chunk.message} Check your connection, then try again.`
                    : 'Nothing was changed, and the rest of the app keeps working.'}
            </span>
            {!chunk && <span className="unread-pane-detail" data-tooltip={errorText(error)}>{errorText(error)}</span>}
            <button className="pdf-pane-action" onClick={retry}>Try again</button>
        </>
    );
}

/** `PartFailure` filling the box it is put in (a pane's body, a panel). */
export function PartFailureBox(props: FailureProps) {
    return (
        <div className="pdf-pane-message unread-pane part-failure" role="alert">
            <PartFailure {...props} />
        </div>
    );
}

/** The workspace's last line: App stays mounted, so its pending saves can still be written before a reload. */
export function AppFailure({ error, retry }: { error: unknown; retry: () => void }) {
    const recovery = useContext(AppRecoveryContext);
    const [state, setState] = useState<'idle' | 'saving' | 'unsaved'>('idle');
    return (
        <div className="welcome-screen">
            <div className="welcome-inner startup-inner" role="alert">
                <p className="welcome-title startup-title">Something went wrong</p>
                <p className="startup-detail">The app hit an error it could not draw past. Your files were not changed.</p>
                <p className="startup-error" data-tooltip={errorText(error)}>{errorText(error)}</p>
                {state === 'unsaved' && <p className="startup-hint">Some changes are still being saved. Try again in a moment.</p>}
                <div className="startup-actions">
                    <button className="welcome-btn startup-btn is-secondary" onClick={retry}>Try again</button>
                    <button
                        className="welcome-btn startup-btn"
                        disabled={state === 'saving'}
                        onClick={() => {
                            setState('saving');
                            if (!recovery) { window.location.reload(); return; }
                            void recovery.saveAndReload().then(done => { if (!done) setState('unsaved'); });
                        }}
                    >
                        {state === 'saving' ? 'Saving…' : 'Save and reload'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * main.tsx's last line, for a failure in App itself (its hooks) or above it. App is already unmounted when this draws,
 * so its pending work is written through the checkpoint App registered (utils/crashCheckpoint.ts) before a reload —
 * and a reload over work that could not be written is only ever the person's explicit choice.
 */
export function RootFailure({ error }: { error: unknown }) {
    const [state, setState] = useState<'idle' | 'saving' | 'unsaved'>('idle');
    const saveThenReload = () => {
        setState('saving');
        void runCrashCheckpoint().then(saved => {
            if (saved) window.location.reload();
            else setState('unsaved');
        });
    };
    return (
        <div className="welcome-screen">
            <div className="welcome-inner startup-inner" role="alert">
                <p className="welcome-title startup-title">Something went wrong</p>
                <p className="startup-detail">The app hit an error and stopped. Your files were not changed.</p>
                <p className="startup-error" data-tooltip={errorText(error)}>{errorText(error)}</p>
                {state === 'unsaved' && (
                    <p className="startup-hint">Some changes could not be saved to their files. Reloading now would lose them; the app offers what its recovery storage kept after it starts again.</p>
                )}
                <div className="startup-actions">
                    {state === 'unsaved' && <button className="welcome-btn startup-btn is-secondary" onClick={() => window.location.reload()}>Reload anyway</button>}
                    <button className="welcome-btn startup-btn" disabled={state === 'saving'} onClick={saveThenReload}>
                        {state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Try saving again' : 'Save and reload'}
                    </button>
                </div>
            </div>
        </div>
    );
}
