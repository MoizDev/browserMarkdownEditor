import type { FontSpec } from '../engine/types';

// Pinned upstream byte inventory: planning/00-evidence/planning-run/pdf/pdf-build/font-inventory.json.
// The actual assets and their OFL notices must be supplied by the build; missing files fail closed.
const entries = {
    'sans-regular': ['NotoSans-Regular.ttf', 569208, 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'],
    'sans-bold': ['NotoSans-Bold.ttf', 575740, 'c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a'],
    'sans-italic': ['NotoSans-Italic.ttf', 552776, '36cff144df01309dab648bea71baff9bb074026914afe63aeacc8bc90b67a28b'],
    'sans-bold-italic': ['NotoSans-BoldItalic.ttf', 555292, '6edf4227ef0fa846aca70e86a307804ca4401741830f5b3af0f2554abe2b8466'],
    'jp-regular': ['NotoSansJP-Regular.otf', 4533028, 'dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073'],
    'jp-bold': ['NotoSansJP-Bold.otf', 4656448, '1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f'],
    'kr-regular': ['NotoSansKR-Regular.otf', 4644748, '69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68'],
    'kr-bold': ['NotoSansKR-Bold.otf', 4816044, '5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda'],
    'sc-regular': ['NotoSansSC-Regular.otf', 8331336, 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9'],
    'sc-bold': ['NotoSansSC-Bold.otf', 8543168, 'c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0'],
    'tc-regular': ['NotoSansTC-Regular.otf', 5683368, '5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537'],
    'tc-bold': ['NotoSansTC-Bold.otf', 5839972, '55420b259eb119bf5f2a0aadba10cf9d736c12d64ab93e78546d69ef5f43558b'],
    'hk-regular': ['NotoSansHK-Regular.otf', 5688384, '8a43afea92bb58dfd9027bd7ac6f5b0b2662e2ffb3e7c1edc02c62b2b21924f1'],
    'hk-bold': ['NotoSansHK-Bold.otf', 5840928, '4bce16fbed09278cbdfb4d57749500038cdda70737925a846e3f6c59327ab46e'],
} as const;
export type PdfFontId = keyof typeof entries;
export const PDF_FONT_CATALOGUE: Readonly<Record<PdfFontId, Readonly<{ path: string; bytes: number; sha256: string }>>> = Object.freeze(
    Object.fromEntries(Object.entries(entries).map(([id, [file, bytes, sha256]]) =>
        [id, Object.freeze({ path: `pdf-fonts/${file}`, bytes, sha256 })])) as Record<PdfFontId, { path: string; bytes: number; sha256: string }>,
);

/** null means PDFium's built-in Base-14 face or an unsupported charset, not a network URL. */
export function resolvePdfFont(spec: FontSpec, language?: string): PdfFontId | null {
    if (typeof spec.family !== 'string' || !spec.family.length || spec.family.length > 128 ||
        !Number.isFinite(spec.weight) || spec.weight < 1 || spec.weight > 1000 || typeof spec.italic !== 'boolean' ||
        (spec.charset !== undefined && (!Number.isInteger(spec.charset) || spec.charset < 0 || spec.charset > 255)) ||
        (language !== undefined && (typeof language !== 'string' || language.length > 64))) return null;
    if (/^(?:Helvetica(?:-(?:Bold|Oblique|BoldOblique))?|Times-(?:Roman|Bold|Italic|BoldItalic)|Courier(?:-(?:Bold|Oblique|BoldOblique))?|Symbol|ZapfDingbats)$/i.test(spec.family)) return null;
    const bold = spec.weight >= 600;
    let region: 'jp' | 'kr' | 'sc' | 'tc' | 'hk' | undefined;
    switch (spec.charset) {
        case 128: region = 'jp'; break; // SHIFTJIS_CHARSET
        case 129: case 130: region = 'kr'; break;
        case 134: region = 'sc'; break;
        case 136: region = 'tc'; break;
        case undefined: case 0: case 1: case 2: case 161: case 162: case 163: case 186: case 204: case 238: break;
        default: return null;
    }
    const hk = /^(?:noto sans (?:cjk )?hk|notosans(?:cjk)?hk|microsoft jhenghei hk)$/i.test(spec.family.trim()) || /^zh-hk(?:-|$)/i.test(language ?? '');
    if (hk && (!region || region === 'tc')) region = 'hk';
    if (region) return `${region}-${bold ? 'bold' : 'regular'}`;
    return bold ? (spec.italic ? 'sans-bold-italic' : 'sans-bold') : (spec.italic ? 'sans-italic' : 'sans-regular');
}
