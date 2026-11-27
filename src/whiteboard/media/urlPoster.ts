const PROVIDER_NAMES: readonly { readonly name: string; readonly hosts: readonly string[] }[] = [
    { name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] }, { name: 'Vimeo', hosts: ['vimeo.com'] },
    { name: 'Figma', hosts: ['figma.com'] }, { name: 'Canva', hosts: ['canva.com'] },
    { name: 'Google Maps', hosts: ['google.com', 'maps.google.com'] }, { name: 'Val Town', hosts: ['val.town'] },
    { name: 'CodeSandbox', hosts: ['codesandbox.io'] }, { name: 'CodePen', hosts: ['codepen.io'] },
    { name: 'Scratch', hosts: ['scratch.mit.edu'] }, { name: 'Google Calendar', hosts: ['calendar.google.com'] },
    { name: 'Google Slides', hosts: ['docs.google.com'] }, { name: 'Replit', hosts: ['replit.com'] },
    { name: 'Felt', hosts: ['felt.com'] }, { name: 'Spotify', hosts: ['open.spotify.com'] },
    { name: 'Observable', hosts: ['observablehq.com'] }, { name: 'Desmos', hosts: ['desmos.com'] },
    { name: 'tldraw', hosts: ['tldraw.com'] },
];

export function urlPoster(url: string): { readonly title: string; readonly address: string } {
    let host = url, path = '';
    try {
        const source = new URL(url);
        host = source.hostname.replace(/^www\./, '');
        path = `${source.pathname === '/' ? '' : source.pathname}${source.search}`;
    } catch { /* Shown as written: the link is kept even when it does not parse. */ }
    const title = PROVIDER_NAMES.find(item => item.hosts.includes(host))?.name ?? host;
    return { title, address: `${host}${path}` };
}
