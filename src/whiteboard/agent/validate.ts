import type { CanvasOp, CanvasPoint } from '../../../shared/vaultAgentProtocol';
import { FIGURE_SHAPES } from '../model/styles';
import { AgentOpRefused } from './errors';

const WORLD_LIMIT = 1_000_000;
const TEXT_LIMIT = 10_000;

function coordinate(value: number): void {
    if (!Number.isFinite(value) || Math.abs(value) > WORLD_LIMIT) throw new AgentOpRefused('coordinate must be finite and within ±1000000');
}
function dimension(value: number, name: string, notes: string[]): number {
    if (!Number.isFinite(value) || value <= 0) throw new AgentOpRefused(`${name} must be positive and finite`);
    const clamped = Math.max(1, Math.min(20_000, value));
    if (clamped !== value) notes.push(`${name} clamped to ${clamped}`);
    return clamped;
}
function text(value: string, required: boolean): void {
    if (typeof value !== 'string' || value.length > TEXT_LIMIT || (required && !value.trim())) {
        throw new AgentOpRefused(required ? 'text must be nonblank and at most 10000 characters' : 'text must be at most 10000 characters');
    }
}
function points(value: CanvasPoint[], pressure: boolean, notes: string[]): CanvasPoint[] {
    if (!Array.isArray(value) || value.length < 2 || value.length > 5000) throw new AgentOpRefused('points must contain 2 to 5000 coordinates');
    let adjusted = false;
    const hasPressure = pressure && value.some(point => Array.isArray(point) && point.length === 3);
    const result = value.map(point => {
        if (!Array.isArray(point) || point.length < 2 || point.length > 3) throw new AgentOpRefused('invalid point');
        coordinate(point[0]); coordinate(point[1]);
        if (!hasPressure) return [point[0], point[1]] as CanvasPoint;
        const p = point[2] ?? 0.5;
        if (!Number.isFinite(p)) throw new AgentOpRefused('pressure must be finite');
        const clamped = Math.max(0, Math.min(1, p));
        adjusted ||= clamped !== p;
        return [point[0], point[1], clamped] as CanvasPoint;
    });
    if (adjusted) notes.push('pressure clamped to 0…1');
    return result;
}

/** Validates all numeric/text constraints before an op can grow a notebook or stage edits. */
export function validateAgentOp(op: CanvasOp): { readonly op: CanvasOp; readonly notes: readonly string[] } {
    const notes: string[] = [];
    if ('page' in op && op.page !== undefined && (!Number.isSafeInteger(op.page) || op.page < 1)) throw new AgentOpRefused('page must be a positive integer');
    if (op.op === 'delete') return { op, notes };
    if (op.op === 'update') {
        if (op.x !== undefined) coordinate(op.x);
        if (op.y !== undefined) coordinate(op.y);
        if (op.rotation !== undefined && !Number.isFinite(op.rotation)) throw new AgentOpRefused('rotation must be finite');
        if (op.text !== undefined) text(op.text, false);
        return { op: { ...op, ...(op.w === undefined ? {} : { w: dimension(op.w, 'width', notes) }),
            ...(op.h === undefined ? {} : { h: dimension(op.h, 'height', notes) }) }, notes };
    }
    switch (op.type) {
        case 'text':
            coordinate(op.x); coordinate(op.y); text(op.text, true);
            return { op: { ...op, ...(op.w === undefined ? {} : { w: dimension(op.w, 'width', notes) }) }, notes };
        case 'note':
            coordinate(op.x); coordinate(op.y); text(op.text, true);
            return { op, notes };
        case 'geo':
            coordinate(op.x); coordinate(op.y);
            if (!(FIGURE_SHAPES as readonly string[]).includes(op.geo)) throw new AgentOpRefused(`unknown figure ${op.geo}`);
            if (op.text !== undefined) text(op.text, false);
            if (op.rotation !== undefined && !Number.isFinite(op.rotation)) throw new AgentOpRefused('rotation must be finite');
            return { op: { ...op, w: dimension(op.w, 'width', notes), h: dimension(op.h, 'height', notes) }, notes };
        case 'line': case 'draw':
            return { op: { ...op, points: points(op.points, op.type === 'draw', notes) }, notes };
        case 'arrow':
            for (const end of [op.start, op.end]) if ('x' in end) { coordinate(end.x); coordinate(end.y); }
            if (op.text !== undefined) text(op.text, false);
            if (op.bend !== undefined) coordinate(op.bend);
            return { op, notes };
    }
}
