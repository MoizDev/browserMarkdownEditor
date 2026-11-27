import { AgentOpError } from '../change/agentBatch';

export class AgentOpRefused extends AgentOpError {}
export class AgentApplyCancelled extends Error {
    constructor() { super('Canvas edit cancelled'); }
}
export class AgentApplyReadOnly extends Error {
    constructor(reason: string) { super(reason); }
}
