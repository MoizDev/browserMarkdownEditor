export type BoardThemePreference = 'light' | 'dark' | 'system';
export type ResolvedBoardTheme = 'light' | 'dark';
export type BoardThemeKind = 'whiteboard' | 'notebook' | 'pdf-ink';

export function readBoardThemePreference(value: unknown): BoardThemePreference {
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveBoardTheme(kind: BoardThemeKind, preference: BoardThemePreference, systemDark: boolean): ResolvedBoardTheme {
    if (kind !== 'whiteboard') return 'light';
    return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export interface BoardThemeSnapshot {
    readonly preference: BoardThemePreference;
    readonly systemDark: boolean;
}

/** Theme is session/browser state. It changes palette consumers, never board transactions. */
export class BoardThemeState {
    private readonly listeners = new Set<() => void>();
    private snapshot: BoardThemeSnapshot;

    constructor(preference: BoardThemePreference, systemDark: boolean,
        private readonly persist: (value: BoardThemePreference) => void) {
        this.snapshot = { preference, systemDark };
    }

    getSnapshot = (): BoardThemeSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    setPreference(preference: BoardThemePreference): void {
        if (this.snapshot.preference === preference) return;
        this.snapshot = { ...this.snapshot, preference };
        this.persist(preference);
        this.notify();
    }

    setSystemDark(systemDark: boolean): void {
        if (this.snapshot.systemDark === systemDark) return;
        this.snapshot = { ...this.snapshot, systemDark };
        this.notify();
    }

    toggleWhiteboard(): void {
        this.setPreference(resolveBoardTheme('whiteboard', this.snapshot.preference, this.snapshot.systemDark) === 'dark'
            ? 'light' : 'dark');
    }

    appThemeChanged(theme: ResolvedBoardTheme): void { this.setPreference(theme); }

    private notify(): void { for (const listener of this.listeners) listener(); }
}
