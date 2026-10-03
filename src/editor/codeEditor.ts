// A code file's editor: what a `.py`, `.c`, `.js` or `.rkt` tab gets instead of
// the live-preview stack a note gets.
//
// SMALL ON PURPOSE. This is a notes app that can hold code, not an IDE: no
// language server, no diagnostics, no formatter, no run button — each of those
// is a daemon or a toolchain, and the app has no backend. What it does give is
// what makes code readable and editable by hand: line numbers, the user's own
// syntax colours, brackets that match, folds, several cursors, and completion
// from the identifiers already in the file plus the language's own keywords.
//
// THE LANGUAGE LOADS LAZILY, which is why there is a compartment. Every grammar
// in `@codemirror/language-data` is a dynamic import (lang-python alone is tens
// of kB), so a vault with no code files fetches none of them: a state is built
// with an empty slot that `loadCodeLanguage` fills a tick later, and the loaded
// `LanguageSupport` is cached by name so a second `.py` tab costs nothing.
//
// React-free, like the rest of src/editor.

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

/** Holds the grammar, which arrives after the state is built. */
export const codeLanguageCompartment = new Compartment();

/** Holds the depth-coloured brackets, which Settings can turn off while a pane
 *  is open — the same arrangement the theme and the indent width use. */
export const bracketColourCompartment = new Compartment();

/* ── Racket ───────────────────────────────────────────────────────────────
   Not in `@codemirror/language-data` at all, and it is the vault owner's course
   language, so it is defined here on top of the legacy Scheme mode.

   THE MODE ALONE IS NOT ENOUGH, which is what the first attempt got wrong. It
   answers with four token names — `builtin` for everything in a 300-word list,
   `variable` for every other symbol, plus `atom`, `number`, `string`, `comment`,
   `bracket` — and CodeMirror resolves both of the first two toward
   `variableName`. The result was a Racket file in ONE colour: `(define (add a
   b) (+ a b))` came out uniformly red.

   So two things happen below. The token table splits `builtin` (library
   procedures: `list`, `map`, `append`) from plain `variable`s, which stay the
   base text colour as they do in any editor. And the wrapper promotes the
   SPECIAL FORMS to keywords, because the mode cannot tell `define` from
   `string-length` — both are merely "in the list". The set is written out: it is
   the syntax of the language, which does not grow, and the alternative is
   reading a `cond` in the same colour as `cons`. */

/** The forms that are syntax, not procedures. Includes the teaching language's
 *  own (`check-expect`, `define-struct`, `local`) — a BSL file is mostly these. */
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

/**
 * Mode token name → the tag this app's palette styles.
 *
 * THE NAMES ARE OURS, and they have to be: CodeMirror's `TokenTable` is seeded
 * with a default map (`variable` → variableName, `builtin` → variableName.standard,
 * …) and consults it BEFORE the table a parser supplies, so remapping either of
 * those names is silently ignored. Measured: `list` and `first` stayed red
 * whatever this table said. A name of our own is never in that default.
 */
const RACKET_TOKENS: Record<string, typeof tags.name> = {
    // The head of an s-expression: in a Lisp that is the call, and the editor
    // the user came from paints it as one.
    bmeCall: tags.function(tags.variableName),
    // A quoted symbol ('alice) — a value, and read as one.
    bmeSymbol: tags.special(tags.string),
};

/**
 * A number literal, including the forms Racket adds to Scheme's: rationals
 * (`1/2`), exponents, and radix prefixes (`#x1f`).
 */
const NUMBER = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?(?:e[+-]?\d+)?|#[xbo][0-9a-f]+)$/i;

/**
 * Racket's own token pass over the Scheme mode's.
 *
 * Four things the mode cannot know, in the order they are decided:
 *  1. SPECIAL FORMS are keywords. The mode has one 300-word list and calls all
 *     of it `builtin`, so `cond` and `cons` came out identical.
 *  2. THE HEAD OF A FORM IS A CALL. `(count-bunch b)` names a function and
 *     passes a variable, and colouring both red is the thing that made a Racket
 *     file unreadable — one tone from top to bottom. Tracked with a flag on the
 *     mode's own state object, which CodeMirror copies for us.
 *  3. A NUMBER IN SQUARE BRACKETS is still a number (the mode says otherwise).
 *  4. A QUOTED SYMBOL is a value, not a number.
 * Everything else is left exactly as the mode said.
 */
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

            // Whitespace and comments do not end the head position: `(  define`
            // and a comment between the paren and the name are both normal.
            if (!text.trim() || type === 'comment') return type;

            if (type === 'bracket') {
                // `(` and `[` open a form; `)` and `]` close one and leave the
                // next token in argument position.
                holder.bmeHead = /[([]/.test(text);
                return type;
            }

            const wasHead = holder.bmeHead === true;
            holder.bmeHead = false;

            if (type === 'builtin' || type === 'variable') {
                // The mode reads a number inside SQUARE brackets as a symbol,
                // and square brackets are exactly where a Racket `cond` puts its
                // answers — so `[(empty? b) 0]` had its 0 in the variable colour
                // (measured: the mode returns "variable" for it, "number" for
                // the same 0 inside parens).
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
    const { scheme } = await import('@codemirror/legacy-modes/mode/scheme');
    return new LanguageSupport(StreamLanguage.define(racketParser(scheme as StreamParser<unknown>)));
}

const RACKET = LanguageDescription.of({
    name: 'Racket',
    alias: ['racket', 'rkt', 'bsl', 'isl'],
    // `.racket` is in the list because people write it: the course's handouts
    // say Racket, and a file saved as `goon.racket` was opening as a NOTE —
    // no gutter, no colours, no brackets, because `isCodeFile` had never heard
    // of the spelling.
    extensions: ['rkt', 'racket', 'rktl', 'rktd', 'scrbl'],
    load: loadRacket,
});

/**
 * Extensions `@codemirror/language-data` has no filename rule for. Racket is
 * handled above; these are extensions the table missed, not languages it lacks.
 */
const BY_EXTENSION: Record<string, string> = {
    ss: 'Scheme',
    hpp: 'C++', hh: 'C++', hxx: 'C++', cxx: 'C++', ipp: 'C++',
    mjs: 'JavaScript', cjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript',
    zsh: 'Shell', bash: 'Shell', fish: 'Shell',
};

/** Languages written with tabs by convention, whatever the Settings width says. */
const TAB_INDENTED = new Set(['Go', 'Makefile']);

export interface CodeLanguage {
    /** Display name. Shown to the AI agent and in the pane's status, not styled. */
    name: string;
    description: LanguageDescription;
}

/** Which language a filename is, or null when nothing matches. */
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

/** Grammars already fetched, keyed by the descriptor's own name. */
const loaded = new Map<string, Extension>();

/**
 * Load `language` into `view`'s compartment, once.
 *
 * A view that already holds a grammar is left alone: a pane re-adopting a
 * cached EditorState has one, and reconfiguring would drop the folds and the
 * completion state that state is carrying.
 */
export async function loadCodeLanguage(view: EditorView, language: CodeLanguage): Promise<void> {
    const present = codeLanguageCompartment.get(view.state);
    if (Array.isArray(present) ? present.length > 0 : present != null) return;

    let support = loaded.get(language.description.name);
    if (!support) {
        try {
            support = await language.description.load();
        } catch (err) {
            // A grammar that will not load leaves plain, editable text. A pane
            // must not break over colour.
            console.warn(`Could not load the ${language.name} grammar:`, err);
            return;
        }
        loaded.set(language.description.name, support);
    }
    // The pane may have gone while the chunk was in flight.
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: codeLanguageCompartment.reconfigure(support) });
}

/* ── Completion from the file itself ──────────────────────────────────────── */

/** Past this many characters the document is not scanned for words: a generated
 *  file would otherwise be re-read on every keystroke. */
const MAX_SCANNED = 200_000;
/** Enough to be useful, few enough that the list stays filterable. */
const MAX_WORDS = 300;
const WORD = /[A-Za-z_$][\w$-]{2,}/g;

/**
 * The identifiers already in this file.
 *
 * Why it exists: with no language server, the completions worth having in a code
 * file are the names it already uses — a function defined forty lines up, a
 * variable spelled `accumulator`. The language's own source (keywords, builtins)
 * comes from the grammar through `language.data`, and `autocompletion()` merges
 * the two, so neither needs to know about the other.
 */
const identifierCompletions: CompletionSource = context => {
    const word = context.matchBefore(/[\w$-]+/);
    // Two characters before it opens on its own: one letter matches half the
    // file, which is the "dumb" version of this — a list of everything.
    if (!word || (word.to - word.from < 2 && !context.explicit)) return null;
    const doc = context.state.doc;
    if (doc.length > MAX_SCANNED) return null;

    // The identifier being TYPED, in full — its tail included. Without this the
    // list offers the word back to you: typing `add` suggested `add`, because
    // the cached list was built when the prefix was `a`.
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
        // No `validFor`, so this is re-queried on every keystroke rather than
        // filtered from a cache: the word under the cursor changes as it is
        // typed, and it is the one word that must never be in the list.
    };
};

export interface CodeExtensionOptions {
    /** Spaces per indent — the Settings value a note's Tab also uses. */
    tabSize: number;
    language: CodeLanguage | null;
    /** Settings → Colour brackets by depth. */
    rainbow: boolean;
}

/**
 * What a code pane adds on top of the editor the app already builds (its theme,
 * read-only compartment, search, scroll memory and save listener).
 *
 * Keymap ORDER decides the keys: completion first, so Enter takes a completion
 * before it opens a line; then brackets, search, history and folds; the defaults
 * after them; and `indentWithTab` last, because in a code file Tab indents where
 * in a note it steps into the text.
 */
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
        // Depth-coloured brackets. In a Lisp they are the structure, and this
        // app's one Lisp is the vault owner's course language.
        bracketColourCompartment.of(rainbow ? rainbowBrackets : []),
        closeBrackets(),
        highlightSelectionMatches(),
        autocompletion({ activateOnTyping: true, icons: true, closeOnBlur: true }),
        // Offered for every language, beside whatever the grammar itself offers.
        EditorState.languageData.of(() => [{ autocomplete: identifierCompletions }]),
        // NOT optional here: the app's theme hides the native caret
        // (`caret-color: transparent`) because every caret setting styles
        // `.cm-cursor` instead — so without this a code pane has no visible
        // cursor at all. Measured by its absence.
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        // Option-click adds a cursor and Option-Shift-drag selects a column —
        // what VS Code, Zed and Sublime do on this machine. CodeMirror's default
        // is Cmd, which this app already spends on other things.
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
