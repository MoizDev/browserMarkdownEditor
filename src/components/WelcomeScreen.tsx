import { useEffect, useState, type ReactNode } from 'react';
import type { RecentVault, VaultProblem } from '../types';
import { APP_TITLE } from '../utils/appTitle';
import { readStartup, STARTUP_SLOW_MS, type StartupSnapshot, type StartupStep } from '../utils/startupProgress';

interface WelcomeScreenProps {
  linkedVault: RecentVault | null;
  previousVault: FileSystemDirectoryHandle | null;
  onOpenLinkedVault: () => void;
  onPickDirectory: () => void;
  onRestoreVault: () => void;
  /** Drawn over the screen: the app's dialog and the update notice. */
  children?: ReactNode;
}

/** What shows before any vault is open. */
export function WelcomeScreen({ linkedVault, previousVault, onOpenLinkedVault, onPickDirectory, onRestoreVault, children }: WelcomeScreenProps) {
  return (
  <div className="welcome-screen">
    <div className="welcome-inner">
      <div className="welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </div>
      <h1 className="welcome-title">{APP_TITLE}</h1>
      {/* A link named a vault this browser knows, but the grant has lapsed.
          Browsers only let requestPermission ask from a user gesture, so
          the link cannot open itself — this button is that gesture. */}
      <p className="welcome-subtitle">
        {linkedVault
          ? <>This link opens <strong>{linkedVault.label}</strong>. Allow access to it to continue.</>
          : 'Open a vault to start editing your notes.'}
      </p>
      <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {linkedVault && (
          <button className="welcome-btn" style={{ margin: 0 }} onClick={onOpenLinkedVault}>
            Open '{linkedVault.label}'
          </button>
        )}
        <button
          className="welcome-btn"
          style={linkedVault
            ? { margin: 0, background: 'var(--background-modifier-border)', color: 'var(--text-normal)' }
            : { margin: 0 }}
          onClick={onPickDirectory}
        >
          Open Vault
        </button>
        {previousVault && (
          <button
            className="welcome-btn"
            style={{ margin: 0, background: 'var(--background-modifier-border)', color: 'var(--text-normal)' }}
            onClick={onRestoreVault}
          >
            Restore '{previousVault.name}'
          </button>
        )}
      </div>
    </div>
      {children}
    </div>
  );
}

/** Folder names and paths, as the screens show them: the vault's own top level has the empty path. */
function folderLabel(vault: string | null, path: string): string {
  return path ? path : (vault ?? 'the vault folder');
}

/** What the step is, in words, for the loading screen. */
function stepText(snapshot: StartupSnapshot): ReactNode {
  const vault = snapshot.vault ? <strong>{snapshot.vault}</strong> : 'your vault';
  switch (snapshot.step) {
    case 'recent-vaults': return 'Reading your recent vaults from the browser’s storage.';
    case 'stored-vault': return 'Reading your last vault from the browser’s storage.';
    case 'permission': return <>Asking the browser whether this site may still open {vault}.</>;
    case 'record': return <>Adding {vault} to your recent vaults in the browser’s storage.</>;
    case 'walk': return <>Reading {snapshot.vault ? 'its' : 'your vault’s'} folders: {snapshot.foldersRead.toLocaleString()} {snapshot.foldersRead === 1 ? 'folder' : 'folders'} and {snapshot.filesFound.toLocaleString()} {snapshot.filesFound === 1 ? 'file' : 'files'} so far.</>;
  }
}

/** Why a step can stall, and what helps — the part a person can act on. */
function stepHint(step: StartupStep): string {
  switch (step) {
    case 'recent-vaults':
    case 'stored-vault':
    case 'record':
      return 'The browser’s storage is not answering. Another tab of this site may be holding it: close the site’s other tabs, then reload.';
    case 'permission':
      return 'The browser has not answered. Reloading usually clears this.';
    case 'walk':
      return 'A folder that does not answer is usually on a cloud drive that has not downloaded it yet, on a network share, or on a disk that is asleep or disconnected. Opening it in Finder or File Explorer can wake it.';
  }
}

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** How long "Keep waiting" puts the choices away before offering them again. */
const KEEP_WAITING_MS = 30_000;

interface LoadingScreenProps {
  /** The picker: offered only while the wait is on the file system, which another folder can be free of. */
  onOpenOther: () => void;
  onReload: () => void;
  children?: ReactNode;
}

/**
 * While the vault last used is being reopened and walked. Every step of that waits on a browser call with no
 * deadline of its own, so after a few seconds this names the step (and the folder the walk is waiting on) and offers
 * a way on — drawn in the app's own buttons, never the browser's dialogs. utils/startupProgress.ts logs the same once.
 */
export function LoadingScreen({ onOpenOther, onReload, children }: LoadingScreenProps) {
  const [now, setNow] = useState(() => performance.now());
  const [waitUntil, setWaitUntil] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, []);
  // Polled, not subscribed (see startupProgress.ts): the tick above is what re-renders this.
  const snapshot = readStartup();
  const slow = !!snapshot && snapshot.stepMs >= STARTUP_SLOW_MS;
  // A walk is stalled when ONE folder has not answered, not when the walk is long: a healthy vault of many thousands
  // of folders takes longer than this to read, and it was told its folders were "usually on a cloud drive" and
  // offered a way out on every load while its counts were still climbing. Every other step is a single call.
  const stalled = slow && (snapshot.step !== 'walk' || snapshot.waitingMs >= STARTUP_SLOW_MS);
  const choices = stalled && now >= waitUntil;
  const fileSystem = snapshot?.step === 'walk' || snapshot?.step === 'permission';
  return (
    <div className="welcome-screen">
      <div className="welcome-inner startup-inner" role="status" aria-live="polite">
        <p className="welcome-subtitle">
          {slow && snapshot?.vault ? <>Still opening <strong>{snapshot.vault}</strong>…</> : 'Loading vault...'}
        </p>
        {slow && snapshot && (
          <>
            <p className="startup-detail">{stepText(snapshot)}</p>
            {snapshot.step === 'walk' && snapshot.waitingOn !== null && snapshot.waitingMs >= 1000 && (
              <p className="startup-detail">
                Waiting {seconds(snapshot.waitingMs)} for <code className="startup-path">{folderLabel(snapshot.vault, snapshot.waitingOn)}</code> to answer.
              </p>
            )}
            {choices ? (
              <>
                <p className="startup-hint">{stepHint(snapshot.step)}</p>
                <div className="startup-actions">
                  <button className="welcome-btn startup-btn is-secondary" onClick={() => setWaitUntil(now + KEEP_WAITING_MS)}>Keep waiting</button>
                  {fileSystem && <button className="welcome-btn startup-btn is-secondary" onClick={onOpenOther}>Open another vault…</button>}
                  <button className="welcome-btn startup-btn" onClick={onReload}>Reload</button>
                </div>
              </>
            ) : stalled && (
              <p className="startup-hint">Still waiting. The choices come back in half a minute if it has not finished.</p>
            )}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

interface VaultProblemScreenProps {
  problem: VaultProblem;
  onRetry: () => void;
  onOpenOther: () => void;
  children?: ReactNode;
}

/**
 * The vault's folder list could not be read. The tree is all-or-nothing (FileSystemContext's FolderReadError says
 * why), so instead of the empty sidebar this used to leave — no tabs, no word of why — the folder that failed is
 * named, with the browser's reason, and nothing is changed until the person picks a way on.
 */
export function VaultProblemScreen({ problem, onRetry, onOpenOther, children }: VaultProblemScreenProps) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="welcome-screen">
      <div className="welcome-inner startup-inner" role="alert">
        <p className="welcome-title startup-title">{problem.missing ? <>Couldn’t find {problem.vault}</> : <>Couldn’t open {problem.vault}</>}</p>
        <p className="startup-detail">
          {problem.missing
            ? <>The folder <code className="startup-path">{problem.vault}</code> is not where it was.</>
            : problem.folder === null
              ? <>Its folder list could not be read.</>
              : <>The folder <code className="startup-path">{folderLabel(problem.vault, problem.folder)}</code> could not be read, so the vault’s file list can’t be shown.</>}
          {' '}Nothing was changed{problem.missing ? ', and its saved tabs are kept' : ''}.
        </p>
        <p className="startup-error" data-tooltip={problem.message}>{problem.message}</p>
        <p className="startup-hint">
          {problem.missing
            ? 'It may have been moved, renamed or deleted, or be on a drive that is not connected. Reconnect the drive and try again, or open another vault.'
            : 'It may be protected by your system, moved or renamed while the app was reading it, or on a drive that is not available. Fix access to it, then try again.'}
        </p>
        <div className="startup-actions">
          <button className="welcome-btn startup-btn is-secondary" onClick={onOpenOther}>Open another vault…</button>
          <button
            className="welcome-btn startup-btn"
            disabled={retrying}
            onClick={() => { setRetrying(true); onRetry(); }}
          >
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
