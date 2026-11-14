declare module 'virtual:pdfjs-classic-assets' {
    export const classicAssets: {
        version: string;
        manifestHash: string;
        directories: { wasm: string; cmaps: string; standard_fonts: string; iccs: string };
        files: Record<string, string>;
    };
}
