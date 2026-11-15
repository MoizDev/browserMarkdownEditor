import { english } from './english';

/** English is the source table itself: complete by construction, so it has no reviewed exceptions. */
export default {
    dir: 'ltr',
    englishTerms: [],
    strings: english,
} as const;
