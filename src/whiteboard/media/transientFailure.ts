import { isCancellation } from '../../platform/workers/envelope';

export function isTransientPictureFailure(error: unknown): boolean {
    if (isCancellation(error)) return true;
    if (!(error instanceof Error)) return false;
    return error.name === 'Deadline' || /memory/i.test(error.message);
}
