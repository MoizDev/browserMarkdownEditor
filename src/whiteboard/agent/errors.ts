// Semantic refusals isolate one operation; unexpected errors abort the batch.
export class AgentOpRefused extends Error {}
export class AgentApplyCancelled extends Error {
    constructor() { super('Canvas edit cancelled'); }
}
export class AgentApplyReadOnly extends Error {
    constructor(reason: string) { super(reason); }
}
