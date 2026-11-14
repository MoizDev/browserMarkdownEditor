/** First-party registry data, never document-provided iframe attributes or saved consent. */
export interface EmbedFrameManifest {
    readonly version: 1;
    readonly origins: readonly string[];
}

export type EmbedContainmentFailure = 'unavailable' | 'configuration' | 'handshake' | 'navigation' | 'protocol' | 'blocked';

export interface EmbedContainmentOptions {
    readonly container: HTMLElement;
    /** Exact canonical registry-built URL. The platform binds this lease to this URL only. */
    readonly url: string;
    readonly manifest: EmbedFrameManifest;
    readonly signal?: AbortSignal;
    readonly className?: string;
    readonly ariaLabel?: string;
    readonly onFailure?: (reason: EmbedContainmentFailure) => void;
}

export interface EmbedContainment {
    readonly element: HTMLIFrameElement;
    readonly url: string;
    /** Navigates only after the private profile handshake. This acknowledges frame creation,
     * not provider playback or its cross-origin final location. */
    load(): Promise<void>;
    /** Both revoke the whole consent lease; another Load requires a new constructor call. */
    unload(): void;
    dispose(): void;
}

/** Invoke only for the current embed's explicit Load action; never at restore/prefetch. */
export type EmbedContainmentFactory = (options: EmbedContainmentOptions) => Promise<EmbedContainment>;
/** Implemented by the platform's private runtime registry, not a caller-supplied true/certificate. */
export type EmbedContainmentApproval = (value: unknown) => value is EmbedContainment;
