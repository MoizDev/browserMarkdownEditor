// Reading mode for a `.tex` file: what utils/texDoc.ts parsed, drawn.
//
// A .tex file used to open as markdown, which is the wrong reading of every line
// in it — `$x_1$` italicised half a formula, `\section{…}` was a paragraph, and a
// `verbatim` listing was reflowed prose. Now ⌘E is the seam: reading mode is this
// (the document), edit mode is the source, plain and unstyled.
//
// MATHS IS RENDERED LAZILY, and that is the whole performance story. A problem
// set is hundreds of formulae; KaTeX costs ~0.3ms each, and a 600-formula file
// rendered eagerly blocks the frame the tab is opened on for a fifth of a second.
// Each formula instead renders when it comes near the view, through ONE shared
// IntersectionObserver, and shows its source until then — so opening a file costs
// what is on screen, and scrolling stays at 60fps.
//
// No innerHTML anywhere: the maths goes through editor/mathWidget's renderMath,
// which is KaTeX building DOM nodes, and everything else is React elements
// (AGENTS.md — the app has exactly two innerHTML sinks and this is not a third).

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { renderMath } from '../editor/mathWidget';
import { parseTex, type TexBlock, type TexDoc, type TexInline } from '../utils/texDoc';

/** How far outside the view a formula is rendered, so scrolling never catches
 *  one mid-render. Two screens' worth at a typical pane height. */
const MATH_MARGIN = '1200px';

/** One observer for every formula in every open .tex pane: an observer per
 *  formula is what made the lazy path cost more than the eager one. */
let observer: IntersectionObserver | null = null;
const shown = new WeakMap<Element, () => void>();

function observe(el: Element, onShown: () => void): () => void {
    observer ??= new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            shown.get(entry.target)?.();
            observer?.unobserve(entry.target);
            shown.delete(entry.target);
        }
    }, { rootMargin: MATH_MARGIN });
    shown.set(el, onShown);
    observer.observe(el);
    return () => {
        observer?.unobserve(el);
        shown.delete(el);
    };
}

function TexMath({ tex, display }: { tex: string; display: boolean }) {
    const ref = useRef<HTMLSpanElement | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el || visible) return;
        return observe(el, () => setVisible(true));
    }, [visible]);

    useEffect(() => {
        const el = ref.current;
        if (!el || !visible) return;
        renderMath(el, tex, display);
    }, [visible, tex, display]);

    // The source is the placeholder, so a formula waiting its turn still reads
    // as the formula it is — and a reader scrolling fast sees text, not a gap
    // that collapses the scroll height under them.
    return (
        <span ref={ref} className={display ? 'tex-math-display' : 'tex-math'}>
            {visible ? null : tex}
        </span>
    );
}

function Inline({ spans }: { spans: readonly TexInline[] }) {
    return (
        <>
            {spans.map((span, i) => {
                switch (span.kind) {
                    case 'text': return span.text;
                    case 'math': return <TexMath key={i} tex={span.tex} display={false} />;
                    case 'break': return <br key={i} />;
                    case 'raw': return <span key={i} className="tex-raw">{span.text}</span>;
                    case 'styled': {
                        const inner = <Inline spans={span.spans} />;
                        if (span.style === 'bold') return <strong key={i}>{inner}</strong>;
                        if (span.style === 'italic') return <em key={i}>{inner}</em>;
                        if (span.style === 'mono') return <code key={i}>{inner}</code>;
                        return <u key={i}>{inner}</u>;
                    }
                }
            })}
        </>
    );
}

/** `\section` → h2, and so on down: h1 is the document's title, which is drawn
 *  once at the top. A `\part` and a `\chapter` share h2's level for the same
 *  reason a pane is not a printed book. */
function Heading({ level, spans }: { level: number; spans: readonly TexInline[] }) {
    const inner = <Inline spans={spans} />;
    if (level <= 2) return <h2 className="tex-heading">{inner}</h2>;
    if (level === 3) return <h3 className="tex-heading">{inner}</h3>;
    if (level === 4) return <h4 className="tex-heading">{inner}</h4>;
    return <h5 className="tex-heading">{inner}</h5>;
}

function Blocks({ blocks }: { blocks: readonly TexBlock[] }) {
    return (
        <>
            {blocks.map((block, i) => {
                switch (block.kind) {
                    case 'heading':
                        return <Heading key={i} level={block.level} spans={block.spans} />;
                    case 'para':
                        return <p key={i} className="tex-para"><Inline spans={block.spans} /></p>;
                    case 'math':
                        return <div key={i} className="tex-display"><TexMath tex={block.tex} display /></div>;
                    case 'code':
                        return <pre key={i} className="tex-code"><code>{block.text}</code></pre>;
                    case 'list': {
                        const items = block.items.map((item, j) => <li key={j}><Blocks blocks={item} /></li>);
                        return block.ordered
                            ? <ol key={i} className="tex-list">{items}</ol>
                            : <ul key={i} className="tex-list">{items}</ul>;
                    }
                    case 'table':
                        return (
                            <div key={i} className="tex-table-wrap">
                                <table className="tex-table">
                                    {block.head && block.rows.length > 0 && (
                                        <thead>
                                            <tr>{block.rows[0].map((cell, c) => <th key={c}><Inline spans={cell} /></th>)}</tr>
                                        </thead>
                                    )}
                                    <tbody>
                                        {block.rows.slice(block.head ? 1 : 0).map((row, r) => (
                                            <tr key={r}>{row.map((cell, c) => <td key={c}><Inline spans={cell} /></td>)}</tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        );
                    case 'env':
                        // Unnamed = alignment only (`center`, `document`). A named
                        // one keeps its name: `proof`, `theorem`, `figure` are what
                        // the reader is looking for, and an environment this app
                        // has no idea about still shows its contents rather than
                        // vanishing.
                        return (
                            <div key={i} className={`tex-env${block.name ? '' : ' is-bare'}`}>
                                {block.name && <span className="tex-env-name">{block.name}</span>}
                                <Blocks blocks={block.blocks} />
                            </div>
                        );
                }
            })}
        </>
    );
}

function TexDocument({ doc }: { doc: TexDoc }) {
    return (
        <>
            {(doc.title || doc.author || doc.date) && (
                <header className="tex-title-block">
                    {doc.title && <h1 className="tex-title">{doc.title}</h1>}
                    {(doc.author || doc.date) && (
                        <p className="tex-byline">{[doc.author, doc.date].filter(Boolean).join(' · ')}</p>
                    )}
                </header>
            )}
            <Blocks blocks={doc.blocks} />
            {doc.preamble && (
                // Shut by default and kept: a preamble is instructions to the
                // compiler, but it is also where a missing package turns out to
                // be, so it is one click away rather than dropped.
                <details className="tex-preamble">
                    <summary>Preamble</summary>
                    <pre className="tex-code"><code>{doc.preamble}</code></pre>
                </details>
            )}
        </>
    );
}

/**
 * Draw `source` as a LaTeX document.
 *
 * Parsed during render and memoized on the text: reading mode never edits, so
 * the parse happens once per open and once per save-from-elsewhere, not per
 * keystroke. Edit mode is the CodeMirror pane, which is where typing goes.
 */
function TexView({ source }: { source: string }) {
    const doc = useMemo(() => parseTex(source), [source]);

    return (
        <div className="tex-view">
            <div className="tex-page">
                {doc.tooBig && (
                    <p className="tex-note" role="status">
                        This file is too large to typeset in a pane, so it is shown as source.
                        Press ⌘E to edit it.
                    </p>
                )}
                <TexDocument doc={doc} />
            </div>
        </div>
    );
}

export default memo(TexView);
