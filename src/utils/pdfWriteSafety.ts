// Worker-only, conservative write safety. pdf-lib never runs in the privileged UI.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import type { PdfWriteSafety } from './pdfRole';
const key = PDFName.of, MAX = 1_000_000, DEPTH = 128;
const unknown = (reason: string): PdfWriteSafety => ({ kind: 'unknown', reason });

/** Refuse uncertain policies rather than treating an unrecognized field as unsigned. */
export function inspectPdfDocumentWriteSafety(doc: PDFDocument): PdfWriteSafety {
    try {
        if (doc.isEncrypted) return { kind: 'encrypted', reason: 'The PDF is encrypted.' };
        const perms = doc.catalog.lookup(key('Perms'));
        if (perms !== undefined) {
            if (!(perms instanceof PDFDict)) return unknown('The PDF permissions dictionary is unreadable.');
            if (perms.has(key('DocMDP')) || perms.has(key('UR')) || perms.has(key('UR3'))) return { kind: 'signed', reason: 'The PDF carries certification or usage rights.' };
            if (perms.entries().length) return unknown('The PDF contains an unsupported permissions policy.');
        }
        const form = doc.catalog.lookup(key('AcroForm'));
        if (form !== undefined) {
            if (!(form instanceof PDFDict)) return unknown('The PDF form dictionary is unreadable.');
            if (form.has(key('XFA'))) return unknown('XFA form policy cannot be safely rewritten.');
            const flags = form.lookup(key('SigFlags'));
            if (flags !== undefined && (!(flags instanceof PDFNumber) || !Number.isSafeInteger(flags.asNumber()) || flags.asNumber() < 0)) return unknown('The PDF signature flags are unreadable.');
            if (flags instanceof PDFNumber && flags.asNumber() !== 0) return { kind: 'signed', reason: 'The PDF carries signature flags.' };
            const roots = form.lookup(key('Fields'));
            if (!(roots instanceof PDFArray) || roots.size() > MAX) return unknown('The PDF field tree is unreadable.');
            const seen = new Set<PDFDict>(), stack: Array<{ raw: PDFObject; inherited?: PDFName; parent?: PDFDict; depth: number }> = [];
            for (let i = 0; i < roots.size(); i++) stack.push({ raw: roots.get(i), depth: 0 });
            while (stack.length) {
                const { raw, inherited, parent, depth } = stack.pop()!, field = doc.context.lookup(raw);
                if (!(field instanceof PDFDict) || depth > DEPTH || seen.has(field) || seen.size >= MAX) return unknown('The PDF field tree is ambiguous.');
                seen.add(field);
                const declaredParent = field.lookup(key('Parent'));
                if (declaredParent !== undefined && declaredParent !== parent) return unknown('The PDF field parent is ambiguous.');
                const declared = field.lookup(key('FT'));
                if (declared !== undefined && !(declared instanceof PDFName)) return unknown('The PDF field type is unreadable.');
                const type = declared ?? inherited;
                if (type === key('Sig')) return { kind: 'signed', reason: 'The PDF contains a signature field.' };
                if (type && ![key('Btn'), key('Tx'), key('Ch')].includes(type)) return unknown('The PDF field type is unsupported.');
                const kids = field.lookup(key('Kids'));
                if (kids !== undefined) {
                    if (!(kids instanceof PDFArray) || kids.size() > MAX - seen.size - stack.length) return unknown('The PDF field tree is unreadable.');
                    for (let i = 0; i < kids.size(); i++) stack.push({ raw: kids.get(i), inherited: type, parent: field, depth: depth + 1 });
                } else if (!type) return unknown('The PDF field type cannot be established.');
            }
        }
        // Signatures can sit outside AcroForm, including direct objects inside indirect containers. Every indirect
        // object is a root of its own, so a reference is only checked to resolve, never followed: following them made
        // `depth` count a chain of references rather than nesting, and refused a 370-page book whose outline is a /Next
        // chain of several hundred items ("exceeds its safety bound") though no object in it nests deeply.
        const seen = new Set<PDFObject>(), stack: Array<{ raw: PDFObject; depth: number }> = doc.context.enumerateIndirectObjects().map(([, raw]) => ({ raw, depth: 0 }));
        while (stack.length) {
            const { raw, depth } = stack.pop()!;
            if (raw instanceof PDFRef) {
                if (!doc.context.lookup(raw)) return unknown('A PDF object reference is unreadable.');
                if (depth > 0) continue;
            }
            const value = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
            if (!value) return unknown('A PDF object reference is unreadable.');
            if (seen.has(value)) continue;
            if (depth > DEPTH || seen.size >= MAX) return unknown('The PDF object inventory exceeds its safety bound.');
            seen.add(value);
            const dict = value instanceof PDFRawStream ? value.dict : value instanceof PDFDict ? value : undefined;
            if (dict) {
                if (dict.has(key('ByteRange')) || dict.lookup(key('Type')) === key('Sig') || dict.lookup(key('FT')) === key('Sig')) {
                    return { kind: 'signed', reason: 'The PDF contains signature data.' };
                }
                for (const [, child] of dict.entries()) stack.push({ raw: child, depth: depth + 1 });
            } else if (value instanceof PDFArray) {
                for (let i = 0; i < value.size(); i++) stack.push({ raw: value.get(i), depth: depth + 1 });
            }
            if (stack.length > MAX) return unknown('The PDF object inventory exceeds its safety bound.');
        }
        return { kind: 'safe' };
    } catch { return unknown('The PDF write policy could not be established.'); }
}

export async function inspectPdfBytesWriteSafety(bytes: Uint8Array): Promise<PdfWriteSafety> {
    try {
        const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false, throwOnInvalidObject: true });
        return inspectPdfDocumentWriteSafety(doc);
    } catch (error) {
        return error instanceof Error && /encrypt/i.test(error.message)
            ? { kind: 'encrypted', reason: 'The PDF is encrypted.' }
            : unknown('The PDF write policy could not be established.');
    }
}
