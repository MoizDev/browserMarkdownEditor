export interface MatchConfig {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    maxResults: number;
}

export interface MatchFile {
    path: string;
    name: string;
    text?: string;
}

export interface MatchBatch {
    path: string;
    name: string;
    first: boolean;
    last: boolean;
    textFile: boolean;
    text: string;
}

export interface MatchProgress {
    out: string[];
    count: number;
    fileCount: number;
    stopped: boolean;
    doneFile: boolean;
}

export interface MatchAnswer extends Omit<MatchProgress, 'doneFile'> {
    incomplete: boolean;
    reason?: string;
}
