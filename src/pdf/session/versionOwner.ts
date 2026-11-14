import type { RenderToken } from '../../platform/render';
import { getSessionIdentity, registerBeforeBytesChange } from '../../utils/sessionIdentity';
import { beginPdfVersionBridge, finishPdfVersionBridge } from '../layer/versionBridge';
import type { PdfVersionBridge } from '../layer/versionBridge';
import type { PdfSessionMirrors } from '../layer/tileMirror';
import { pdfGeometryDigest } from './documentSession';
import type { OpenTiledDocument, PdfTiledDocumentSession } from './documentSession';
import { pdfMirrorProfilePrefix } from '../fonts/profiles';

export function pdfMirrorRevision(enabled: boolean, docKey: string, proofRevision: number): string {
    return `${pdfMirrorProfilePrefix(enabled ? 'emphasis' : 'plain', docKey)}${enabled ? proofRevision : 0}`;
}

type Role = 'outer' | 'original';
type Source = { session: PdfTiledDocumentSession; document: OpenTiledDocument; mirror: PdfSessionMirrors };
export interface PdfVersionTransitionOwner {
    adopt(value: Source, variant: string | (() => string), signal: AbortSignal): Promise<PdfVersionBridge | null>;
    subscribe(listener: () => void): () => void;
    isActive(bridge: PdfVersionBridge): boolean;
    dispose(): void;
}
const outerSlot = Symbol('outer PDF version transition'), originalSlot = Symbol('original PDF version transition');
const same = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
    a.bytesGeneration === b.bytesGeneration && a.session === b.session;
const stale = () => new DOMException('PDF version transition is stale', 'AbortError');

/** The App slot, not an old pane or old source session, owns the mirror borrow. */
export function pdfVersionTransitionOwner(documentId: string, source: Role): PdfVersionTransitionOwner {
    const identity = getSessionIdentity(documentId);
    if (!identity || (source !== 'outer' && source !== 'original')) throw stale();
    const slot = source === 'outer' ? outerSlot : originalSlot;
    const existing = identity.getSlot<PdfVersionTransitionOwner>(slot);
    if (existing) return existing;
    let active: Source | undefined, candidate: PdfVersionBridge | null = null, disposed = false, serial = 0;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Other observers still need the transition. */ } } };
    const drop = () => { const old = candidate; candidate = null; old?.release(); };
    const unsubscribe = registerBeforeBytesChange(documentId, next => {
        serial++;
        const hadCandidate = !!candidate;
        drop();
        if (hadCandidate) notify();
        const old = active;
        if (!old || disposed || !old.session.isCurrent() || old.document.poolDocument.closed ||
            old.session.source !== source || old.document.poolDocument.source !== source ||
            !same(old.session.token, old.document.poolDocument.token) || !Number.isSafeInteger(next) || next < 0) return;
        const target = { ...old.session.token, bytesGeneration: next };
        let bridge: PdfVersionBridge | null = null;
        try {
            bridge = beginPdfVersionBridge({ previous: old.mirror, target, targetSource: source,
                pageCount: old.document.poolDocument.info.pageCount, geometry: page => old.document.poolDocument.peekGeometry(page),
                currentTarget: () => {
                    const current = getSessionIdentity(documentId);
                    return current ? { ...target, session: current.serial, bytesGeneration: current.bytesGeneration } : null;
                },
                onExpired: () => { if (candidate === bridge) { candidate = null; notify(); } } });
        } catch { bridge = null; }
        candidate = bridge;
        if (bridge) notify();
    });
    const owner: PdfVersionTransitionOwner = {
        async adopt(value, variant, signal) {
            const token = value.session.token, pdf = value.document.poolDocument;
            const guard = () => {
                signal.throwIfAborted();
                const live = getSessionIdentity(documentId);
                if (disposed || !live || live.serial !== token.session || live.bytesGeneration !== token.bytesGeneration ||
                    token.documentId !== documentId || value.session.source !== source || pdf.source !== source ||
                    !same(token, pdf.token) || !value.session.isCurrent() || pdf.closed) throw stale();
            };
            try { guard(); } catch {
                if (candidate && same(candidate.target, token)) { drop(); notify(); }
                return null;
            }
            const attempt = ++serial, bridge = candidate;
            let accepted: PdfVersionBridge | null = null;
            if (bridge) {
                try {
                    if (!same(bridge.target, token)) throw stale();
                    for (const page of bridge.requiredPages) {
                        guard();
                        await pdf.resolveGeometry(page, { priority: 0, signal });
                        guard();
                        if (attempt !== serial || candidate !== bridge) throw stale();
                    }
                    accepted = finishPdfVersionBridge({ bridge, token, source, variant: typeof variant === 'function' ? variant() : variant,
                        geometryDigest: pdfGeometryDigest(value.document.pages), pageCount: pdf.info.pageCount,
                        geometry: page => pdf.peekGeometry(page) });
                } catch { accepted = null; }
                if (!accepted && attempt === serial && candidate === bridge) { drop(); notify(); }
            }
            try { guard(); } catch { if (accepted && attempt === serial && candidate === accepted) { drop(); notify(); } return null; }
            if (attempt !== serial || disposed) return null;
            active = { session: value.session, document: value.document, mirror: value.mirror };
            return accepted;
        },
        subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
        isActive(bridge) { return !disposed && candidate === bridge; },
        dispose() { if (disposed) return; disposed = true; serial++; unsubscribe(); drop(); active = undefined; listeners.clear(); },
    };
    try { identity.setSlot(slot, owner, value => value.dispose()); }
    catch (error) { owner.dispose(); throw error; }
    return owner;
}
