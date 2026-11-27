import {
    autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
    type CompletionSource,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
    LanguageDescription, LanguageSupport, StreamLanguage, bracketMatching, codeFolding, foldGutter,
    foldKeymap, indentOnInput, indentUnit, type StreamParser,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
    EditorView, crosshairCursor, drawSelection, highlightActiveLine, highlightActiveLineGutter,
    keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { rainbowBrackets } from './rainbowBrackets';
import { loadChunk } from '../platform/chunkLoad';

export const codeLanguageCompartment = new Compartment();

export const bracketColourCompartment = new Compartment();

const RACKET_SPECIAL = new Set([
    'define', 'define-values', 'define-syntax', 'define-syntax-rule', 'define-struct', 'struct',
    'lambda', 'λ', 'case-lambda', 'let', 'let*', 'letrec', 'let-values', 'let*-values', 'local',
    'cond', 'else', 'if', 'when', 'unless', 'case', 'match', 'begin', 'begin0', 'do',
    'and', 'or', 'not', 'set!', 'quote', 'quasiquote', 'unquote', 'unquote-splicing',
    'require', 'provide', 'module', 'module+', 'module*', 'lang', '#lang',
    'for', 'for*', 'for/list', 'for*/list', 'for/fold', 'for/sum', 'for/and', 'for/or', 'for/vector',
    'check-expect', 'check-within', 'check-error', 'check-member-of', 'check-range', 'check-random',
    'define/contract', 'define/public', 'parameterize', 'with-handlers', 'delay', 'force',
]);

const RACKET_TOKENS: Record<string, typeof tags.name> = {
    bmeCall: tags.function(tags.variableName),
    bmeSymbol: tags.special(tags.string),
};

const NUMBER = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?(?:e[+-]?\d+)?|#[xbo][0-9a-f]+)$/i;

function racketParser(scheme: StreamParser<unknown>): StreamParser<unknown> {
    return {
        ...scheme,
        startState(indentUnit: number) {
            return { ...(scheme.startState?.(indentUnit) as object), bmeHead: false };
        },
        token(stream, state) {
            const from = stream.pos;
            const type = scheme.token(stream, state);
            const text = stream.string.slice(from, stream.pos);
            const holder = state as { bmeHead?: boolean };

            if (!text.trim() || type === 'comment') return type;

            if (type === 'bracket') {
                holder.bmeHead = /[([]/.test(text);
                return type;
            }

            const wasHead = holder.bmeHead === true;
            holder.bmeHead = false;

            if (type === 'builtin' || type === 'variable') {
                if (NUMBER.test(text)) return 'number';
                if (RACKET_SPECIAL.has(text)) return 'keyword';
                return wasHead ? 'bmeCall' : type;
            }
            if (type === 'atom' && text.startsWith("'")) return 'bmeSymbol';
            return type;
        },
        tokenTable: RACKET_TOKENS,
    };
}

async function loadRacket(): Promise<LanguageSupport> {
    const { scheme } = await loadChunk(() => import('@codemirror/legacy-modes/mode/scheme'));
    return new LanguageSupport(StreamLanguage.define(racketParser(scheme as StreamParser<unknown>)));
}

const RACKET = LanguageDescription.of({
    name: 'Racket',
    alias: ['racket', 'rkt', 'bsl', 'isl'],
    extensions: ['rkt', 'racket', 'rktl', 'rktd', 'scrbl'],
    load: loadRacket,
});

const BY_EXTENSION: Record<string, string> = {
    ss: 'Scheme',
    hpp: 'C++', hh: 'C++', hxx: 'C++', cxx: 'C++', ipp: 'C++',
    mjs: 'JavaScript', cjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript',
    zsh: 'Shell', bash: 'Shell', fish: 'Shell',
};

const TAB_INDENTED = new Set(['Go', 'Makefile']);

export interface CodeLanguage {
    name: string;
    description: LanguageDescription;
}

export function codeLanguageFor(fileName: string): CodeLanguage | null {
    const racket = LanguageDescription.matchFilename([RACKET], fileName);
    if (racket) return { name: 'Racket', description: racket };

    const byFilename = LanguageDescription.matchFilename(languages, fileName);
    if (byFilename) return { name: byFilename.name, description: byFilename };

    const ext = fileName.toLowerCase().split('.').pop() ?? '';
    const borrowed = BY_EXTENSION[ext];
    if (!borrowed) return null;
    const description = LanguageDescription.matchLanguageName(languages, borrowed, true);
    if (!description) return null;
    return { name: borrowed, description };
}

const loaded = new Map<string, Extension>();
const languageRequests = new WeakMap<EditorView, { generation: number; descriptor: LanguageDescription | null }>();

export async function loadCodeLanguage(view: EditorView, language: CodeLanguage | null, replace = false): Promise<void> {
    const request = { generation: (languageRequests.get(view)?.generation ?? 0) + 1, descriptor: language?.description ?? null };
    languageRequests.set(view, request);
    const present = codeLanguageCompartment.get(view.state);
    const hasGrammar = Array.isArray(present) ? present.length > 0 : present != null;
    if (!language) {
        if (replace && hasGrammar && view.dom.isConnected) view.dispatch({ effects: codeLanguageCompartment.reconfigure([]) });
        return;
    }

    let support = loaded.get(language.description.name);
    if (!support) {
        try {
            support = await language.description.load();
        } catch (err) {
            console.warn(`Could not load the ${language.name} grammar:`, err);
            return;
        }
        loaded.set(language.description.name, support);
    }
    const latest = languageRequests.get(view);
    if (!view.dom.isConnected || latest?.generation !== request.generation || latest.descriptor !== language.description) return;
    const current = codeLanguageCompartment.get(view.state);
    if (current === support) return;
    view.dispatch({ effects: codeLanguageCompartment.reconfigure(support) });
}

const MAX_SCANNED = 200_000;
const MAX_WORDS = 300;
const WORD = /[A-Za-z_$][\w$-]{2,}/g;

const identifierCompletions: CompletionSource = context => {
    const word = context.matchBefore(/[\w$-]+/);
    if (!word || (word.to - word.from < 2 && !context.explicit)) return null;
    const doc = context.state.doc;
    if (doc.length > MAX_SCANNED) return null;

    const line = doc.lineAt(context.pos);
    const tail = /^[\w$-]*/.exec(line.text.slice(context.pos - line.from))?.[0] ?? '';
    const current = word.text + tail;

    const seen = new Set<string>();
    for (const match of doc.toString().matchAll(WORD)) {
        const found = match[0];
        if (found === current || seen.has(found)) continue;
        seen.add(found);
        if (seen.size >= MAX_WORDS) break;
    }
    seen.delete(word.text);
    return {
        from: word.from,
        options: [...seen].map(label => ({ label, type: 'variable', boost: -10 })),
    };
};

export interface CodeExtensionOptions {
    tabSize: number;
    language: CodeLanguage | null;
    rainbow: boolean;
}

export function codeExtensions({ tabSize, language, rainbow }: CodeExtensionOptions): Extension[] {
    return [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        codeFolding(),
        foldGutter(),
        indentOnInput(),
        indentUnit.of(TAB_INDENTED.has(language?.name ?? '') ? '\t' : ' '.repeat(tabSize)),
        bracketMatching(),
        bracketColourCompartment.of(rainbow ? rainbowBrackets : []),
        closeBrackets(),
        highlightSelectionMatches(),
        autocompletion({ activateOnTyping: true, icons: true, closeOnBlur: true }),
        EditorState.languageData.of(() => [{ autocomplete: identifierCompletions }]),
        // NOT optional here: the app's theme hides the native caret
        // (`caret-color: transparent`) because every caret setting styles
        // `.cm-cursor` instead — so without this a code pane has no visible
        // cursor at all. Measured by its absence.
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        EditorView.clickAddsSelectionRange.of(event => event.altKey && !event.shiftKey),
        rectangularSelection({ eventFilter: event => event.altKey && event.shiftKey }),
        crosshairCursor({ key: 'Alt' }),
        history(),
        keymap.of([
            ...completionKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...defaultKeymap,
            indentWithTab,
        ]),
        codeLanguageCompartment.of([]),
    ];
}
