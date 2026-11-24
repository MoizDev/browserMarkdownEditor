/** Capture before the first await; a directory/path can be reused by a later activation. */
export interface IndexPathToken {
    readonly activation: number;
    readonly generation: number;
    readonly path: string;
    readonly revision: number;
}

export class IndexSessionGuard {
    readonly pathRevisions = new Map<string, number>();
    generation = 1;
    disposed = false;

    constructor(readonly activation: number, private readonly active: () => boolean) {}

    current(): boolean { return !this.disposed && this.active(); }

    capture(path: string): IndexPathToken {
        return { activation: this.activation, generation: this.generation,
            path, revision: this.pathRevisions.get(path) ?? 0 };
    }

    acceptsPath(token: IndexPathToken): boolean {
        return this.current() && token.activation === this.activation && token.generation === this.generation
            && token.revision === (this.pathRevisions.get(token.path) ?? 0);
    }

    advance(path: string): void {
        this.pathRevisions.set(path, (this.pathRevisions.get(path) ?? 0) + 1);
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.pathRevisions.clear();
    }
}
