export interface EmbedFrameManifest {
    readonly version: 1;
    readonly origins: readonly string[];
}

export type EmbedContainmentFailure = 'unavailable' | 'configuration' | 'handshake' | 'navigation' | 'protocol' | 'blocked';

export interface EmbedContainmentOptions {
    readonly container: HTMLElement;
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
    load(): Promise<void>;
    unload(): void;
    dispose(): void;
}

/** Invoke only for the current embed's explicit Load action; never at restore/prefetch. */
export type EmbedContainmentFactory = (options: EmbedContainmentOptions) => Promise<EmbedContainment>;
export type EmbedContainmentApproval = (value: unknown) => value is EmbedContainment;
