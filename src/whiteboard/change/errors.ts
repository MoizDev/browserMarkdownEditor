import type { ValidationRefusal } from '../model/validate';

export class ApplyRefused extends Error {
    readonly code: ValidationRefusal['code'];
    readonly opIndex: number;
    readonly nodeId: string | null;
    readonly reason: string;
    constructor(refusal: ValidationRefusal) {
        super(refusal.reason);
        this.name = 'ApplyRefused';
        this.code = refusal.code;
        this.opIndex = refusal.opIndex;
        this.nodeId = refusal.nodeId;
        this.reason = refusal.reason;
    }
}
export class ApplyFailed extends Error {
    constructor(readonly code: string, message: string, readonly unsafe = false, cause?: unknown) {
        super(message, { cause });
        this.name = 'ApplyFailed';
    }
}

export function refuseChange(code: ValidationRefusal['code'], reason: string, nodeId: string | null = null): never {
    throw new ApplyRefused({ ok: false, code, reason, nodeId, opIndex: -1 });
}
