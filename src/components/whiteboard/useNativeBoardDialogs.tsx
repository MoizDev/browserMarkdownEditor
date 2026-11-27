import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import ConfirmDialog from '../ConfirmDialog';

export interface BoardQuestion {
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
    readonly danger?: boolean;
    readonly list?: { readonly label: string; readonly items: readonly string[] };
}
export interface BoardTextQuestion extends BoardQuestion {
    readonly altLabel?: string;
    readonly input: {
        readonly label: string;
        readonly initialValue: string;
        readonly placeholder?: string;
        readonly validate?: (value: string) => string | null;
    };
}
type Answer = { accepted: boolean; value?: string; alt?: boolean };
type Question = BoardQuestion & { id: number; kind: 'confirm' | 'text' | 'info'; input?: BoardTextQuestion['input']; altLabel?: string };
type Pending = { question: Question; documentId: string; session: number; resolve(answer: Answer): void };

/** Dialog answers belong to the view and owner which asked. A hidden/replaced view
 * cancels its question, rather than letting a later click mutate another document. */
export function useNativeBoardDialogs(options: {
    readonly documentId: string;
    readonly session: number;
    readonly isVisible: boolean;
    currentOwner(): boolean;
}) {
    const [question, setQuestion] = useState<Question | null>(null);
    const latest = useRef(options), pending = useRef<Pending | null>(null), serial = useRef(0), mounted = useRef(false);
    const cancel = useCallback(() => {
        const request = pending.current;
        if (!request) return;
        pending.current = null;
        if (mounted.current) setQuestion(null);
        request.resolve({ accepted: false });
    }, []);
    useLayoutEffect(() => {
        latest.current = options;
        const request = pending.current;
        if (request && (!options.isVisible || !options.currentOwner() || request.documentId !== options.documentId || request.session !== options.session)) cancel();
    }, [options, cancel]);
    useLayoutEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; cancel(); };
    }, [cancel]);
    const ask = useCallback((value: Omit<Question, 'id'>): Promise<Answer> => {
        const owner = latest.current;
        if (!mounted.current || !owner.isVisible || !owner.currentOwner()) return Promise.resolve({ accepted: false });
        if (pending.current) return Promise.reject(new Error('Finish the open canvas dialog first.'));
        return new Promise(resolve => {
            const request = { ...value, id: ++serial.current };
            pending.current = { question: request, documentId: owner.documentId, session: owner.session, resolve };
            setQuestion(request);
        });
    }, []);
    const finish = useCallback((id: number, answer: Answer) => {
        const request = pending.current, owner = latest.current;
        if (!request || request.question.id !== id) return;
        let current = false;
        try { current = mounted.current && owner.isVisible && owner.currentOwner() && request.documentId === owner.documentId && request.session === owner.session; }
        finally {
            pending.current = null;
            setQuestion(null);
            request.resolve(current ? answer : { accepted: false });
        }
    }, []);
    const confirm = useCallback(async (value: BoardQuestion): Promise<boolean> => (await ask({ ...value, kind: 'confirm' })).accepted, [ask]);
    const requestText = useCallback(async (value: BoardTextQuestion): Promise<string | null> => {
        const answer = await ask({ ...value, kind: 'text' });
        return answer.accepted && !answer.alt ? answer.value ?? '' : null;
    }, [ask]);
    const requestTextChoice = useCallback(async (value: BoardTextQuestion): Promise<{ readonly value: string } | 'alt' | null> => {
        const answer = await ask({ ...value, kind: 'text' });
        if (!answer.accepted) return null;
        return answer.alt ? 'alt' : { value: answer.value ?? '' };
    }, [ask]);
    const chooseOne = useCallback(async (value: BoardQuestion & { readonly altLabel: string }): Promise<'confirm' | 'alt' | null> => {
        const answer = await ask({ ...value, kind: 'confirm' });
        if (!answer.accepted) return null;
        return answer.alt ? 'alt' : 'confirm';
    }, [ask]);
    const inform = useCallback(async (value: BoardQuestion): Promise<void> => { await ask({ ...value, kind: 'info' }); }, [ask]);
    const dialogs = question && <ConfirmDialog questionId={question.id} title={question.title}
        confirmLabel={question.confirmLabel} danger={question.danger} input={question.input}
        onConfirm={value => finish(question.id, { accepted: true, value })}
        onCancel={question.kind === 'info' ? undefined : () => finish(question.id, { accepted: false })}
        altLabel={question.altLabel} onAlt={question.altLabel ? () => finish(question.id, { accepted: true, alt: true }) : undefined}>
        {question.body}
        {question.list && <span className="confirm-list" role="list" aria-label={question.list.label}>
            <span className="confirm-list-label" aria-hidden="true">{question.list.label}</span>
            {question.list.items.map(item => <span className="confirm-list-item" role="listitem" key={item}>{item}</span>)}
        </span>}
    </ConfirmDialog>;
    return { confirm, requestText, requestTextChoice, chooseOne, inform, cancel, dialogs };
}
