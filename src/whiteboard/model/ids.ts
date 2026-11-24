// document-model.md §2, M-2: imported ids are opaque; only new ids use this alphabet.
declare const nodeIdBrand: unique symbol;
declare const sheetIdBrand: unique symbol;

export type NodeId = string & { readonly [nodeIdBrand]: true };
export type SheetId = string & { readonly [sheetIdBrand]: true };
export type ParentId = NodeId | SheetId;

export interface IdTables {
    readonly nodes: { has(id: NodeId): boolean };
    readonly sheets: { has(id: SheetId): boolean };
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function isValidId(id: string): boolean {
    if (id.length === 0 || id.length > 128) return false;
    for (let i = 0; i < id.length; i++) {
        const code = id.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return false;
    }
    return true;
}

export function nodeId(id: string): NodeId {
    if (!isValidId(id)) throw new RangeError('Invalid node id');
    return id as NodeId;
}

export function sheetId(id: string): SheetId {
    if (!isValidId(id)) throw new RangeError('Invalid sheet id');
    return id as SheetId;
}

function unusedId(tables: IdTables): string {
    const bytes = new Uint8Array(16);
    for (;;) {
        let id = '';
        while (id.length < 10) {
            crypto.getRandomValues(bytes);
            for (const byte of bytes) {
                // Four complete copies of base62 fit below 248; modulo is unbiased there.
                if (byte < 248) id += ALPHABET[byte % 62];
                if (id.length === 10) break;
            }
        }
        if (!tables.nodes.has(id as NodeId) && !tables.sheets.has(id as SheetId)) return id;
    }
}

export function newNodeId(tables: IdTables): NodeId {
    return unusedId(tables) as NodeId;
}

export function newSheetId(tables: IdTables): SheetId {
    return unusedId(tables) as SheetId;
}
