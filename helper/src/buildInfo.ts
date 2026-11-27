// Allowed origins are compile-time on purpose: an origin read from the
// environment or a file at runtime would let anything that can write there
// widen who may drive the agent. The releases base self-update downloads from
// is compile-time for the same reason: whatever could write an env var or a file
// at runtime would otherwise choose which binary gets installed and run.

import { PRODUCTION_ORIGIN, RELEASES_BASE } from '../../shared/vaultAgentProtocol.ts';

declare const __VAULTAGENT_VERSION__: string | undefined;
declare const __VAULTAGENT_EXTRA_ORIGINS__: string | undefined;
declare const __VAULTAGENT_RELEASES_BASE__: string | undefined;

const SOURCE_VERSION = '0.2.2';

export const HELPER_VERSION: string =
    typeof __VAULTAGENT_VERSION__ === 'string' && __VAULTAGENT_VERSION__ ? __VAULTAGENT_VERSION__ : SOURCE_VERSION;

const extraOrigins: string =
    typeof __VAULTAGENT_EXTRA_ORIGINS__ === 'string' ? __VAULTAGENT_EXTRA_ORIGINS__ : '';

export const BAKED_ORIGINS: readonly string[] = [
    PRODUCTION_ORIGIN,
    ...extraOrigins.split(/[\s,]+/).filter(Boolean),
];

export const RELEASES_BASE_URL: string =
    typeof __VAULTAGENT_RELEASES_BASE__ === 'string' && __VAULTAGENT_RELEASES_BASE__ ? __VAULTAGENT_RELEASES_BASE__ : RELEASES_BASE;
