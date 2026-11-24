import { isCancellation } from '../../platform/workers/envelope';

/** A picture request that failed for this moment, not for good: a cancelled or retired request (DOM AbortError, the worker host's
 * 'Cancelled'), a worker deadline, or a memory refusal. It is retried by the next frame and is not reported to the person; anything
 * else (unreadable bytes) is the picture's own failure. Measured: a zoom cancelled a tile decode in the worker ('bme-worker-host-v1:
 * Request aborted'), which was shown as 'A picture could not be shown' and left the picture a placeholder for good. */
export function isTransientPictureFailure(error: unknown): boolean {
    if (isCancellation(error)) return true;
    if (!(error instanceof Error)) return false;
    return error.name === 'Deadline' || /memory/i.test(error.message);
}
