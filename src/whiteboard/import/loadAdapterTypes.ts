import type { BoardDocInput } from '../model/doc';
import type { LoadRepairPort, LoadRepairResult } from '../model/loadTypes';
import type { SampleStore } from '../ink/samples';
import type { ReportBuilder } from './report';
import type { RootMapper } from './repair';

export interface LegacyLoadAdapterOptions {
    readonly port: LoadRepairPort;
    readonly declaredMaxScale: number;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export type LegacyLoadAdmit = (input: BoardDocInput, samples: SampleStore, root: RootMapper,
    report: ReportBuilder) => Promise<LoadRepairResult>;
