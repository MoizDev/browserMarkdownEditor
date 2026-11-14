import type { NodeId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import { PictureAnimations, type AnimatedPictureDemand } from './animation';
import type { VideoFrameRegistry } from './videoFrames';

// Provenance: picture animation clock (media MD-4) driven by real per-frame decoding; independent
// driver that presents each decoded frame through the view's own frame registry.

export interface AnimatedPictureSource { readonly entry: MediaEntry; readonly blob: Blob }
/** Whether this view can decode the picture's frames at all. Without it an animated picture is simply not animated. */
// ImageDecoder answers its support question asynchronously; the answer is cached per type, and
// until it arrives the picture is simply not offered as animated.
const probes = new Map<string, boolean>();
export function canAnimatePicture(mime: string): boolean {
    const known = probes.get(mime);
    if (known !== undefined) return known;
    if (typeof ImageDecoder !== 'function') { probes.set(mime, false); return false; }
    void ImageDecoder.isTypeSupported(mime).then(value => { probes.set(mime, value); }, () => { probes.set(mime, false); });
    return false;
}
for (const mime of ['image/gif', 'image/webp', 'image/png', 'image/avif']) canAnimatePicture(mime);
export interface AnimatedPictureDriverOptions {
    readonly registry: VideoFrameRegistry;
    /** Only session-owned bytes already verified against an animated entry may be returned. */
    source(node: NodeId): AnimatedPictureSource | null;
    current(): boolean;
    invalidate(): void;
    error(node: NodeId, message: string): void;
}
interface Held { readonly media: MediaId; readonly decoder: ImageDecoder; readonly frameCount: number }

/** One clock for the view's animated pictures. A frame is decoded only while its picture plays and is visible. */
export class AnimatedPictureDriver {
    private readonly clock: PictureAnimations;
    private readonly decoders = new Map<NodeId, Promise<Held>>();
    private readonly decoderMedia = new Map<NodeId, MediaId>();
    private readonly decoding = new Map<NodeId, number>();
    private readonly shown = new Map<NodeId, number>();
    private demands: readonly AnimatedPictureDemand[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    constructor(private readonly options: AnimatedPictureDriverOptions) {
        this.clock = new PictureAnimations({ invalidate: () => options.invalidate(), wakeAt: deadline => this.arm(deadline) });
    }
    /** Called whenever the view draws: the demands are the playing, visible animated pictures on the sheet. */
    sync(demands: readonly AnimatedPictureDemand[], now: number): void {
        if (this.disposed) return;
        this.demands = demands;
        this.clock.update(demands, now);
        this.ensure();
    }
    setVisible(visible: boolean, now: number): void {
        if (this.disposed) return;
        this.clock.setVisible(visible, now);
        this.ensure();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.clock.clear();
        for (const pending of this.decoders.values()) void pending.then(held => held.decoder.close(), () => {});
        this.decoders.clear(); this.decoding.clear(); this.shown.clear(); this.demands = [];
    }
    private arm(deadline: number | null): void {
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
        if (deadline === null || this.disposed) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.disposed) return;
            this.clock.tick(performance.now());
            this.ensure();
        }, Math.max(0, deadline - performance.now()));
    }
    /** Decodes the frame the clock is on for each playing demand, unless that frame is already shown or on its way. */
    private ensure(): void {
        for (const demand of this.demands) {
            if (!demand.playing) continue;
            const source = this.options.source(demand.node);
            if (!source || source.entry.id !== demand.media) continue;
            const index = this.clock.frame(demand.node);
            if (this.shown.get(demand.node) === index || this.decoding.get(demand.node) === index) continue;
            this.decode(demand.node, source, index);
        }
    }
    private decoderFor(node: NodeId, source: AnimatedPictureSource): Promise<Held> {
        const cached = this.decoders.get(node);
        if (cached && this.decoderMedia.get(node) === source.entry.id) return cached;
        const next = (async (): Promise<Held> => {
            const decoder = new ImageDecoder({ data: source.blob.stream(), type: source.entry.mime });
            try {
                await decoder.tracks.ready;
                const track = decoder.tracks.selectedTrack;
                if (!track) throw new Error('This picture has no image track');
                return { media: source.entry.id, decoder, frameCount: track.frameCount };
            } catch (error) { decoder.close(); throw error; }
        })();
        const previous = this.decoders.get(node);
        this.decoders.set(node, next);
        this.decoderMedia.set(node, source.entry.id);
        if (previous) void previous.then(held => held.decoder.close(), () => {});
        next.catch(() => { if (this.decoders.get(node) === next) { this.decoders.delete(node); this.decoderMedia.delete(node); } });
        return next;
    }
    private decode(node: NodeId, source: AnimatedPictureSource, index: number): void {
        this.decoding.set(node, index);
        const finish = () => { if (this.decoding.get(node) === index) this.decoding.delete(node); };
        const work = async () => {
            const held = await this.decoderFor(node, source);
            const result = await held.decoder.decode({ frameIndex: index });
            try {
                const bitmap = await createImageBitmap(result.image);
                return { bitmap, frameCount: held.frameCount, durationMs: Math.max(10, (result.image.duration ?? 100_000) / 1000) };
            } finally { result.image.close(); }
        };
        work().then(({ bitmap, frameCount, durationMs }) => {
            finish();
            const demanded = this.demands.some(item => item.node === node && item.playing && item.media === source.entry.id);
            if (this.disposed || !demanded || !this.options.current() || this.clock.frame(node) !== index) { bitmap.close(); this.ensure(); return; }
            this.shown.set(node, index);
            this.options.registry.present(node, bitmap);
            this.clock.decoded(source.entry.id, index, durationMs, frameCount, performance.now());
            this.ensure();
        }, error => {
            finish();
            if (this.disposed || !this.options.current()) return;
            this.decoders.delete(node); this.decoderMedia.delete(node);
            this.options.error(node, error instanceof Error ? error.message : 'This picture animation could not be shown');
        });
    }
}
