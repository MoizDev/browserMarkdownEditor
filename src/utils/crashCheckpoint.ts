// The way main.tsx's last-resort error boundary reaches App's save machinery after App itself has failed.
//
// An error inside App's own hooks unmounts App before any fallback can draw, and with it every listener that would
// have written pending edits on the way out. The function registered here closes over App's stores (tab list,
// document sessions, buffers), which outlive the unmount, so the root boundary can still write what is pending
// before it offers a reload. It is deliberately NOT cleared when App unmounts: in production the only unmount of App
// is the crash this exists for (StrictMode's dev re-run simply registers again).

type Checkpoint = () => Promise<boolean>;
let registered: Checkpoint | null = null;

/** App registers "write everything pending; resolve whether nothing is left unsaved". */
export function setCrashCheckpoint(checkpoint: Checkpoint): void {
    registered = checkpoint;
}

/** Resolves true when nothing is left unsaved, false when something is or nothing could be asked. */
export async function runCrashCheckpoint(): Promise<boolean> {
    if (!registered) return false;
    try { return await registered(); }
    catch (error) {
        console.error('Could not save pending work after the app failed:', error);
        return false;
    }
}
