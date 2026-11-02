// Lazy entry point: importing the pane is the first acquisition of parser/frame/worker.
// The parser is Foliate metadata + CFI only; no stock engine renderer is reachable.
export { createEpubSession as openEpubSession } from './session';
export type { EpubSession, ReaderAdapter, SessionOptions } from './types';
