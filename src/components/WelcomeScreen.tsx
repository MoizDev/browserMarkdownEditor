import type { ReactNode } from 'react';
import type { RecentVault } from '../types';
import { APP_TITLE } from '../utils/appTitle';

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

/** While the vault last used is being reopened and walked. */
export function LoadingScreen({ children }: { children?: ReactNode }) {
  return (
    <div className="welcome-screen">
      <div className="welcome-inner">
        <p className="welcome-subtitle">Loading vault...</p>
      </div>
      {children}
    </div>
  );
}
