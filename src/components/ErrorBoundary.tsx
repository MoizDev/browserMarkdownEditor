import { Component, Fragment, createContext, useContext, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { chunkFailureOf, classifyChunkFailure, type ChunkLoadError } from '../platform/chunkLoad';
import { retryFailedModuleSlots } from './moduleSlot';
import { runCrashCheckpoint } from '../utils/crashCheckpoint';

export interface AppRecovery {
    /** Resolves false (and reloads nothing) while edits are still unsaved. */
    saveAndReload(): Promise<boolean>;
}
const AppRecoveryContext = createContext<AppRecovery | null>(null);
export const AppRecoveryProvider = AppRecoveryContext.Provider;

interface BoundaryProps {
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

    retry = (): void => {
        retryFailedModuleSlots();
        this.setState(state => ({ failed: false, error: undefined, attempt: state.attempt + 1 }));
    };

    render(): ReactNode {
        if (this.state.failed) return this.props.fallback(this.state.error, this.retry);
        return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
}

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
    what: ReactNode;
}

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

export function PartFailureBox(props: FailureProps) {
    return (
        <div className="pdf-pane-message unread-pane part-failure" role="alert">
            <PartFailure {...props} />
        </div>
    );
}

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
