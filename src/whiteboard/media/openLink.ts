import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';

// Provenance: media §10a/§11 explicit link activation and SEC-6 click policy;
// independent browser gesture, no upstream engine source.
/** Invoke only in the user's explicit Open link gesture, never during rendering. */
export function openMediaLink(value: string, environment: UrlEnvironment): void {
    const decision = checkContentUrl(value, 'click', environment);
    if (!decision.ok) throw new TypeError(`Cannot open this link: ${decision.reason}`);
    const link = document.createElement('a');
    link.href = decision.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
}
