type Checkpoint = () => Promise<boolean>;
let registered: Checkpoint | null = null;

export function setCrashCheckpoint(checkpoint: Checkpoint): void {
    registered = checkpoint;
}

export async function runCrashCheckpoint(): Promise<boolean> {
    if (!registered) return true;
    try { return await registered(); }
    catch (error) {
        console.error('Could not save pending work after the app failed:', error);
        return false;
    }
}
