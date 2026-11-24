export const now = (): number => performance.now();

// Only hang clocks restart after suspension. A caller's deadline still includes time in the queue.
export function watchClock(tick: (time: number, restarted: boolean, suspended: boolean) => void): () => void {
    let previous = now();
    let restart = false;
    let suspended = false;
    let hidden = typeof document !== 'undefined' && document.hidden;
    const freeze = () => { suspended = true; };
    const resume = () => { suspended = false; restart = true; };
    const visibility = () => {
        if (document.hidden) hidden = true;
        else if (hidden) { hidden = false; restart = true; }
    };
    const timer = setInterval(() => {
        const time = now();
        const restarted = restart || time - previous > 5000;
        previous = time;
        restart = false;
        tick(time, restarted, suspended);
    }, 250);
    if (typeof document !== 'undefined') {
        document.addEventListener('freeze', freeze);
        document.addEventListener('resume', resume);
        document.addEventListener('visibilitychange', visibility);
    }
    return () => {
        clearInterval(timer);
        if (typeof document !== 'undefined') {
            document.removeEventListener('freeze', freeze);
            document.removeEventListener('resume', resume);
            document.removeEventListener('visibilitychange', visibility);
        }
    };
}
