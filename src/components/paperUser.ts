import { computed, createTLCurrentUser } from 'tldraw';
import type { TLUserPreferences } from 'tldraw';

// tldraw's user record is shared across editors. A stored dark preference (or a
// whiteboard changing it later) must not recolour ink against white paper, nor
// may opening a paper host overwrite the whiteboard's own preference.
const sharedUser = createTLCurrentUser();
const paperPreferences = computed('paper user preferences', () => ({
    ...sharedUser.userPreferences.get(), colorScheme: 'light' as const,
}));
export const PAPER_USER = createTLCurrentUser({
    userPreferences: paperPreferences,
    setUserPreferences(next: TLUserPreferences) {
        const current = sharedUser.userPreferences.get();
        const updated = { ...next, colorScheme: current.colorScheme };
        if (Object.keys(updated).some(key => updated[key as keyof TLUserPreferences] !== current[key as keyof TLUserPreferences])) {
            sharedUser.setUserPreferences(updated);
        }
    },
});
