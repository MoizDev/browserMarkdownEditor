// The agent's tools: names, JSON schemas and the descriptions the model reads.
//
// Served by the helper as the MCP server's `tools/list`, and used by the editor
// (utils/vaultAgentTools.ts) to validate every call against the SAME schemas.
// Split from vaultAgentProtocol.ts for bundle size: App imports that module for
// a few constants, and whatever lives there ships in the main chunk; this table
// only ever loads with the agent panel. Pure data, no imports beyond types.

import type { ToolName } from './vaultAgentProtocol';

export interface ToolDef {
    name: ToolName;
    description: string;
    /** JSON Schema (draft 2020-12 subset) served as MCP `inputSchema`. */
    inputSchema: Record<string, unknown>;
    /** Changes the vault — the panel shows a change card for these. */
    mutates: boolean;
}

const PATH = { type: 'string', description: 'Vault-relative path with "/" separators, e.g. "Notes/Ideas.md". "" or "." is the vault root.' };
const PAGE = { type: 'integer', minimum: 1, description: '1-based page number (notebooks and PDFs).' };

// Canvas op vocabulary — the TS types below mirror this schema exactly.
const COLOR = { type: 'string', enum: ['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white'] };
const SIZE = { type: 'string', enum: ['s', 'm', 'l', 'xl'] };
const FILL = { type: 'string', enum: ['none', 'semi', 'solid', 'pattern'] };
const DASH = { type: 'string', enum: ['draw', 'solid', 'dashed', 'dotted'] };
const GEO = { type: 'string', enum: ['rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart', 'cloud'] };
const POINT = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3, description: '[x, y] or, for freehand, [x, y, pressure 0..1].' };
const END = {
    description: 'A free point {x, y} or a shape to attach to {shapeId} (a connector that follows the shape).',
    oneOf: [
        { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
        { type: 'object', properties: { shapeId: { type: 'string' } }, required: ['shapeId'], additionalProperties: false },
    ],
};

const CANVAS_OP = {
    oneOf: [
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'x', 'y', 'text'],
            properties: { op: { const: 'create' }, type: { const: 'text' }, page: PAGE, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, w: { type: 'number', description: 'Wrap width; omit to auto-size.' }, color: COLOR, size: SIZE, align: { type: 'string', enum: ['start', 'middle', 'end'] } },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'x', 'y', 'text'],
            properties: { op: { const: 'create' }, type: { const: 'note' }, page: PAGE, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, color: COLOR, size: SIZE },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'geo', 'x', 'y', 'w', 'h'],
            properties: { op: { const: 'create' }, type: { const: 'geo' }, geo: GEO, page: PAGE, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 }, text: { type: 'string' }, color: COLOR, fill: FILL, dash: DASH, size: SIZE, rotation: { type: 'number', description: 'Degrees, clockwise.' } },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'points'],
            properties: { op: { const: 'create' }, type: { const: 'line' }, page: PAGE, points: { type: 'array', items: POINT, minItems: 2 }, color: COLOR, dash: DASH, size: SIZE },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'start', 'end'],
            properties: { op: { const: 'create' }, type: { const: 'arrow' }, page: PAGE, start: END, end: END, text: { type: 'string' }, color: COLOR, dash: DASH, size: SIZE, bend: { type: 'number', description: 'Curve, in canvas units; 0 = straight.' } },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'type', 'points'],
            properties: { op: { const: 'create' }, type: { const: 'draw' }, page: PAGE, points: { type: 'array', items: POINT, minItems: 2, maxItems: 5000 }, color: COLOR, size: SIZE, closed: { type: 'boolean' } },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'id'],
            properties: { op: { const: 'update' }, id: { type: 'string' }, page: PAGE, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 }, rotation: { type: 'number' }, color: COLOR, fill: FILL, dash: DASH, size: SIZE, text: { type: 'string' } },
        },
        {
            type: 'object', additionalProperties: false,
            required: ['op', 'ids'],
            properties: { op: { const: 'delete' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        },
    ],
};

export const VAULT_TOOLS: readonly ToolDef[] = [
    {
        name: 'vault_list',
        mutates: false,
        description: 'List the files and folders in the vault (or in one folder of it), as a tree. The app\'s own hidden folders (.VaultAgent, .Garbage trash, .Assets images) are left out unless includeHidden is true.',
        inputSchema: {
            type: 'object', additionalProperties: false,
            properties: { path: PATH, depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 }, includeHidden: { type: 'boolean', default: false } },
        },
    },
    {
        name: 'vault_read',
        mutates: false,
        description: 'Read a file in the vault. Text and markdown come back as numbered lines ("<n>\\t<line>") — from the open tab\'s live buffer when the file is open, so unsaved edits are included — plus a `hash` of the whole current text, which vault_write needs. Long files are paginated with offset/limit (lines, 1-based). A PDF returns the text of a page range; an image returns the image; a .tldraw drawing or .notebook returns a summary of its shapes (use canvas_shapes for full detail).',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH, offset: { type: 'integer', minimum: 1, description: 'First line (text) or first page (PDF).' }, limit: { type: 'integer', minimum: 1, description: 'How many lines (text) or pages (PDF).' } },
        },
    },
    {
        name: 'vault_view',
        mutates: false,
        description: 'Look at a file as a picture: a rendered PDF page, a notebook page, a drawing, or an image file. Use it to see handwriting, diagrams and layout that text cannot convey.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH, page: PAGE },
        },
    },
    {
        name: 'vault_search',
        mutates: false,
        description: 'Search the text of every note and text file in the vault (and file names). Returns matching files with line numbers and the matching lines.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['query'],
            properties: { query: { type: 'string', minLength: 1 }, regex: { type: 'boolean', default: false }, caseSensitive: { type: 'boolean', default: false }, path: { ...PATH, description: 'Limit the search to this folder.' }, maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
    },
    {
        name: 'vault_edit',
        mutates: true,
        description: 'Replace an exact piece of text in a text/markdown file. `old_string` must match the file exactly (whitespace included) and be unique unless replace_all is true. The change lands immediately in the user\'s open editor (undoable with ⌘Z). If the text changed since you read it the edit is refused: read the file again and retry.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'],
            properties: { path: PATH, old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' }, replace_all: { type: 'boolean', default: false } },
        },
    },
    {
        name: 'vault_write',
        mutates: true,
        description: 'Replace the whole text of an EXISTING text/markdown file. `base_hash` must be the hash vault_read returned for the current text; if the file changed since, the write is refused — read it again and retry. Prefer vault_edit for small changes.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path', 'content', 'base_hash'],
            properties: { path: PATH, content: { type: 'string' }, base_hash: { type: 'string' } },
        },
    },
    {
        name: 'vault_create',
        mutates: true,
        description: 'Create a NEW file (a note is a .md file) with optional content. Refused if a file or folder already has that name. Parent folders must exist (see vault_mkdir). Create an empty .tldraw drawing or .notebook by name, then add to it with canvas_apply.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH, content: { type: 'string', default: '' } },
        },
    },
    {
        name: 'vault_mkdir',
        mutates: true,
        description: 'Create a new folder (one level; its parent must exist). Refused if the name is taken.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH },
        },
    },
    {
        name: 'vault_move',
        mutates: true,
        description: 'Rename or move a file or folder. `to` is the full new path. Refused if something already has that name. Open tabs follow the move.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['from', 'to'],
            properties: { from: PATH, to: PATH },
        },
    },
    {
        name: 'vault_trash',
        mutates: true,
        description: 'Delete a file or folder by moving it to the vault\'s trash (the user can restore it). Nothing is ever erased.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH },
        },
    },
    {
        name: 'canvas_shapes',
        mutates: false,
        description: 'List the shapes on a .tldraw drawing, a .notebook, or a PDF\'s annotation layer: id, type, position and size, text, colour and style. On notebooks and PDFs coordinates are page-relative: x/y in page units from that page\'s top-left corner, with `page` saying which page.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: { path: PATH, page: { ...PAGE, description: 'Only this page (notebooks/PDFs).' } },
        },
    },
    {
        name: 'canvas_apply',
        mutates: true,
        description: 'Draw on a .tldraw drawing, a .notebook, or a PDF (as annotations): create text, sticky notes, geometric shapes, lines, arrows/connectors (bound to shapes by id) and freehand strokes; move, resize, restyle or delete shapes. All ops apply as ONE undo step. Notebook/PDF coordinates are page-relative (x/y from the top-left of `page`, which defaults to the page the user is looking at); drawing coordinates are the canvas\'s own. An op may refer to a shape created earlier in the same call as "$N" (N = that op\'s 1-based position in `ops`), e.g. an arrow from "$1" to "$2". An update with only `page` moves the shape to the same spot on that page. A document that is not open is opened beside the user\'s current tab. Returns the ids of created shapes, in op order.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['path', 'ops'],
            properties: { path: PATH, ops: { type: 'array', items: CANVAS_OP, minItems: 1, maxItems: 200 } },
        },
    },
];

export const MUTATING_TOOLS: ReadonlySet<ToolName> = new Set(VAULT_TOOLS.filter(t => t.mutates).map(t => t.name));
