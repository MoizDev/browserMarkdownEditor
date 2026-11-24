// The frozen PTY host binary, embedded with `import … with { type: 'file' }`: a
// path string (the repo file under `bun`, a /$bunfs path in a compiled helper).
declare module '*/vaultagent-pty' {
    const path: string;
    export default path;
}
