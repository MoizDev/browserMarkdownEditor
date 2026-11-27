import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { renderMath } from '../editor/mathWidget';
import { parseTex, type TexBlock, type TexDoc, type TexInline } from '../utils/texDoc';

const MATH_MARGIN = '1200px';

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
                <details className="tex-preamble">
                    <summary>Preamble</summary>
                    <pre className="tex-code"><code>{doc.preamble}</code></pre>
                </details>
            )}
        </>
    );
}

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
