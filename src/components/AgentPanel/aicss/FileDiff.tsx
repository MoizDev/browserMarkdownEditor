// Adapted from AICSS's FileDiff (MIT, © 2026 AICSS — see LICENSE-aicss;
// https://www.aicss.dev/components/file-diff). Changed: takes the executor's
// real `DiffLine[]` (with "gap" rows for skipped unchanged runs) instead of
// sample rows; the JS-keyword colouring runs only on code files — on prose it
// painted every "if", "for" and "this" in a note red; the header can carry an
// "Open" action; colours come from the panel's tokens (aicss.css).

import type { ReactNode } from 'react';
import type { DiffLine } from '../../../types/vaultAgent';

const KEYWORDS = new Set([
    'export', 'function', 'return', 'const', 'let', 'var', 'if', 'else', 'throw', 'new',
    'import', 'from', 'async', 'await', 'class', 'extends', 'typeof', 'void', 'true',
    'false', 'null', 'undefined', 'for', 'while', 'switch', 'case', 'break', 'continue',
    'try', 'catch', 'finally', 'this', 'super', 'static', 'type', 'interface', 'enum', 'as', 'of', 'in',
    'def', 'elif', 'lambda', 'None', 'True', 'False', 'fn', 'pub', 'impl', 'struct',
]);

const CODE_EXT = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|lua|sql|json|ya?ml|toml|css|scss|html?)$/i;

type Tok = { t: 'txt' | 'cm' | 'str' | 'num' | 'kw' | 'fn'; v: string };

function tokenize(line: string): Tok[] {
    const raw: Array<{ kind: 'txt' | 'cm' | 'str' | 'num' | 'id'; v: string }> = [];
    const re = /(\s+)|(\/\/.*|(?<=^|\s)#\s.*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(\S)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        if (m[1]) raw.push({ kind: 'txt', v: m[1] });
        else if (m[2] || m[3]) raw.push({ kind: 'cm', v: m[0] });
        else if (m[4]) raw.push({ kind: 'str', v: m[0] });
        else if (m[5]) raw.push({ kind: 'num', v: m[0] });
        else if (m[6]) raw.push({ kind: 'id', v: m[0] });
        else raw.push({ kind: 'txt', v: m[0] });
    }
    const out: Tok[] = [];
    for (let i = 0; i < raw.length; i++) {
        const cur = raw[i];
        if (cur.kind !== 'id') { out.push({ t: cur.kind, v: cur.v }); continue; }
        if (KEYWORDS.has(cur.v)) { out.push({ t: 'kw', v: cur.v }); continue; }
        let j = i + 1;
        while (j < raw.length && raw[j].kind === 'txt' && /^\s+$/.test(raw[j].v)) j++;
        const next = raw[j];
        out.push({ t: next && next.v.startsWith('(') ? 'fn' : 'txt', v: cur.v });
    }
    return out;
}

const ROW_CLASS: Record<DiffLine['type'], string> = { context: 'ctx', add: 'add', del: 'del', gap: 'gap' };

export interface FileDiffProps {
    file: string;
    lines: DiffLine[];
    added: number;
    removed: number;
    /** Extra header content (the "Open" button). */
    action?: ReactNode;
    /** Cap the body's height and scroll inside it. */
    maxHeight?: number;
}

export function FileDiff({ file, lines, added, removed, action, maxHeight }: FileDiffProps) {
    const code = CODE_EXT.test(file);
    return (
        <div className="aic-diff">
            <div className="aic-diff-head">
                <span className="aic-diff-file-wrap">
                    <svg className="aic-diff-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                        <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="aic-diff-file">{file}</span>
                </span>
                <span className="aic-diff-stat">
                    <span className="add">+{added}</span>
                    <span className="del">-{removed}</span>
                </span>
                {action}
            </div>
            <div className="aic-diff-body" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
                <div className="aic-diff-lines">
                    {lines.map((r, i) => r.type === 'gap' ? (
                        <div key={i} className="aic-diff-row gap">
                            <span className="ln" />
                            <span className="ln" />
                            <span className="sign" />
                            <code>{r.text || '⋯'}</code>
                        </div>
                    ) : (
                        <div key={i} className={'aic-diff-row ' + ROW_CLASS[r.type]}>
                            <span className="ln old">{r.oldLine ?? ''}</span>
                            <span className="ln new">{r.newLine ?? ''}</span>
                            <span className="sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ''}</span>
                            <code>
                                {code
                                    ? tokenize(r.text).map((tok, j) => (
                                        <span key={j} className={tok.t === 'txt' ? undefined : tok.t}>{tok.v}</span>
                                    ))
                                    : (r.text || '\u00A0')}
                            </code>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
