// Adapted from AICSS's CodeBlock (MIT, © 2026 AICSS — see LICENSE-aicss;
// https://www.aicss.dev/components/code-block). Changed: copies through the
// app's clipboard helper (which resolves instead of throwing when Chrome
// refuses); an optional height cap for long tool output; a visible thin
// scrollbar, because a long line must be reachable without a trackpad and the
// original hid it; line numbers optional.

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../../utils/clipboard';

export interface CodeBlockProps {
    lang: string;
    code: string;
    /** Cap the body's height (px) and scroll inside it. */
    maxHeight?: number;
    lineNumbers?: boolean;
}

export function CodeBlock({ lang, code, maxHeight, lineNumbers = true }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const lines = code.split('\n');
    const copy = async () => {
        if (!(await copyText(code))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };
    return (
        <div className="aic-cb">
            <div className="aic-cb-head">
                <span className="aic-cb-file">
                    <svg className="aic-cb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m8 6-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span className="aic-cb-lang">{lang}</span>
                </span>
                <button type="button" className="aic-cb-copy" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'}>
                    {copied ? (
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 12.75 6 6 9-13.5" /></svg>
                    ) : (
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" /></svg>
                    )}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
            </div>
            <div className="aic-cb-body" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
                <div className={'aic-cb-lines' + (lineNumbers ? '' : ' no-numbers')}>
                    {lines.map((line, i) => (
                        <div className="aic-cb-row" key={i}>
                            {lineNumbers && <span className="aic-cb-ln">{i + 1}</span>}
                            <code className="aic-cb-code">{line || ' '}</code>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
