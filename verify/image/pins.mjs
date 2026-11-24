// Observed pull/download identities, not registry tags or a host browser that updates itself.
// First acquisition: 2026-11-13; local raw metadata is retained in scratch/v-b/image/.
export const PINS = {
    schema: 1,
    platform: 'linux/amd64',
    base: 'node:26.0.0-bookworm-slim@sha256:52d70d606181ef3b3c2137a190196a8c452e0358e6d0971573d0e59135ada9fc',
    basePulledAt: '2026-11-13',
    node: '26.0.0',
    playwright: '1.63.0',
    pngjs: '7.0.0',
    browser: {
        product: 'Chrome for Testing', version: '157.0.8103.39', platform: 'linux64',
        url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.39/linux64/chrome-linux64.zip',
        sha256: 'e4cffe4c057c8dd96832e0ac3060e79eecc3b1c7fb5cd18cdf2e23702a13ac55',
        bytes: 203505426, executable: '/opt/chrome-linux64/chrome',
    },
};
