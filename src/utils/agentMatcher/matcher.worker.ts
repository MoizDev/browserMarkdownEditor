import { serve } from '../../platform/workers/serve';
import { createMatching } from './matching';
import type { MatchBatch, MatchConfig } from './types';

let match: ReturnType<typeof createMatching> | undefined;
serve({
    protocol: 1,
    buildId: 'agent-matcher-v1',
    handlers: {
        async configure(args) {
            const config = args as MatchConfig;
            match = createMatching(config);
            // Queries have no schema length cap. A short retry identity avoids hashing/serialising
            // a megabyte of pattern text on the main thread for every file in the vault.
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([config.query, config.regex, config.caseSensitive])));
            return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        },
        batch(args, context) {
            if (!match) throw new Error('Search worker has not been configured');
            return match(args as MatchBatch, context);
        },
    },
});
