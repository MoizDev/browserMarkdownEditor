import type { english } from './i18n/english';

type English = typeof english;
export type MessageKey = keyof English;

export interface EnglishTerm { readonly key: string; readonly text: string; readonly reason: string }

type Placeholders<S> = S extends `${string}{${infer N}}${infer R}` ? N | Placeholders<R> : never;
type SamePlaceholders<A, B> = [Placeholders<A>] extends [Placeholders<B>]
    ? ([Placeholders<B>] extends [Placeholders<A>] ? true : false) : false;

type PluralBase = { [K in MessageKey]: K extends `${infer B}.one` ? B : never }[MessageKey];
type PluralExtra<T, C extends string> = {
    readonly [B in PluralBase as `${B}.${C}`]?: `${B}.${C}` extends keyof T
        ? (SamePlaceholders<T[`${B}.${C}` & keyof T], English[`${B}.other` & MessageKey]> extends true ? string : never)
        : string;
};
type PluralExtras<T> = PluralExtra<T, 'zero'> & PluralExtra<T, 'two'> & PluralExtra<T, 'few'> & PluralExtra<T, 'many'>;

type StringsCheck<T> = {
    readonly [K in MessageKey]: K extends keyof T
        ? (SamePlaceholders<T[K], English[K]> extends true ? string : never)
        : never;
} & PluralExtras<T>;

type EnglishEqual<T> = {
    readonly [K in MessageKey]: K extends keyof T
        ? (T[K] extends English[K] ? (English[K] extends T[K] ? K : never) : never)
        : never;
}[MessageKey];
type ReviewedKey<T> = T extends { readonly englishTerms: infer E }
    ? (E extends readonly { readonly key: infer K }[] ? K : never) : never;

type TermsCheck<T extends { readonly strings: object; readonly englishTerms: unknown }> =
    [Exclude<EnglishEqual<T['strings']>, ReviewedKey<T>>] extends [never] ? readonly EnglishTerm[] : never;

export interface BoardLanguageShape {
    readonly dir: 'ltr' | 'rtl';
    readonly englishTerms: readonly EnglishTerm[];
    readonly strings: { readonly [key: string]: string };
}

export function defineBoardLanguage<const T extends BoardLanguageShape>(
    table: T & { readonly strings: StringsCheck<T['strings']>; readonly englishTerms: TermsCheck<T> },
): T {
    return table;
}
