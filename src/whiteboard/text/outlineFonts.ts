import { fontDescriptor, type FontKey } from './fonts';

const urls: Readonly<Record<string, string>> = {
    'Shantell_Sans-Informal_Regular.woff2': new URL('./outlineFonts/Shantell_Sans-Informal_Regular.otf', import.meta.url).href,
    'Shantell_Sans-Informal_Bold.woff2': new URL('./outlineFonts/Shantell_Sans-Informal_Bold.otf', import.meta.url).href,
    'Shantell_Sans-Informal_Regular_Italic.woff2': new URL('./outlineFonts/Shantell_Sans-Informal_Regular_Italic.otf', import.meta.url).href,
    'Shantell_Sans-Informal_Bold_Italic.woff2': new URL('./outlineFonts/Shantell_Sans-Informal_Bold_Italic.otf', import.meta.url).href,
    'IBMPlexSans-Medium.woff2': new URL('./outlineFonts/IBMPlexSans-Medium.ttf', import.meta.url).href,
    'IBMPlexSans-Bold.woff2': new URL('./outlineFonts/IBMPlexSans-Bold.ttf', import.meta.url).href,
    'IBMPlexSans-MediumItalic.woff2': new URL('./outlineFonts/IBMPlexSans-MediumItalic.ttf', import.meta.url).href,
    'IBMPlexSans-BoldItalic.woff2': new URL('./outlineFonts/IBMPlexSans-BoldItalic.ttf', import.meta.url).href,
    'IBMPlexSerif-Medium.woff2': new URL('./outlineFonts/IBMPlexSerif-Medium.ttf', import.meta.url).href,
    'IBMPlexSerif-Bold.woff2': new URL('./outlineFonts/IBMPlexSerif-Bold.ttf', import.meta.url).href,
    'IBMPlexSerif-MediumItalic.woff2': new URL('./outlineFonts/IBMPlexSerif-MediumItalic.ttf', import.meta.url).href,
    'IBMPlexSerif-BoldItalic.woff2': new URL('./outlineFonts/IBMPlexSerif-BoldItalic.ttf', import.meta.url).href,
    'IBMPlexMono-Medium.woff2': new URL('./outlineFonts/IBMPlexMono-Medium.ttf', import.meta.url).href,
    'IBMPlexMono-Bold.woff2': new URL('./outlineFonts/IBMPlexMono-Bold.ttf', import.meta.url).href,
    'IBMPlexMono-MediumItalic.woff2': new URL('./outlineFonts/IBMPlexMono-MediumItalic.ttf', import.meta.url).href,
    'IBMPlexMono-BoldItalic.woff2': new URL('./outlineFonts/IBMPlexMono-BoldItalic.ttf', import.meta.url).href,
};
export function outlineFontUrl(key: FontKey): string { return urls[fontDescriptor(key).file]; }
