import type { ByteLease } from '../../platform/render/gfx/api';
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
    /** The layer's own deadline. The layer wakes the view; the paint that follows advances the clock. No timer of this driver's. */
    wakeAt(deadlineMs: number | null): void;
    error(node: NodeId, message: string): void;
}
interface Held { readonly media: MediaId; readonly decoder: ImageDecoder; readonly frameCount: number; readonly lease: ByteLease }
interface Frame { readonly bitmap: ImageBitmap; readonly lease: ByteLease; readonly frameCount: number; readonly durationMs: number }
/** No memory for the next decode. The frame waits for the view's next paint; it is not a failure to report. */
class Deferred extends Error {}

/** One clock for the view's animated pictures. A frame is decoded only while its picture plays and is visible. */
export class AnimatedPictureDriver {
    private readonly clock: PictureAnimations;
    private readonly decoders = new Map<NodeId, Promise<Held>>();
    private readonly decoderMedia = new Map<NodeId, MediaId>();
    private readonly decoding = new Map<NodeId, number>();
    private readonly shown = new Map<NodeId, number>();
    /** Decodes started and not yet settled: a source is dropped only after these have finished with it. */
    private readonly inflight = new Set<Promise<void>>();
    private demands: readonly AnimatedPictureDemand[] = [];
    private visible = true;
    private disposed = false;
    constructor(private readonly options: AnimatedPictureDriverOptions) {
        this.clock = new PictureAnimations({ invalidate: () => options.invalidate(), wakeAt: deadline => { if (!this.disposed) options.wakeAt(deadline); } });
    }
    /** Called whenever the view draws: the demands are the playing, visible animated pictures on the sheet. */
    sync(demands: readonly AnimatedPictureDemand[], now: number): void {
        if (this.disposed) return;
        this.demands = demands;
        // A layer wake only invalidates the view. The paint it causes is where the clock advances to the current time.
        this.clock.tick(now);
        this.clock.update(demands, now);
        this.ensure();
    }
    setVisible(visible: boolean, now: number): void {
        if (this.disposed || visible === this.visible) return;
        this.visible = visible;
        this.clock.setVisible(visible, now);
        if (visible) this.ensure(); else this.stopDecoders();
    }
    dispose(): void {
        if (this.disposed) return;
        // Clears the layer's deadline while the driver still forwards it; nothing is forwarded after this.
        this.clock.clear();
        this.disposed = true;
        this.demands = [];
        this.stopDecoders();
    }
    /** Decodes the frame the clock is on for each playing demand, unless that frame is already shown or on its way. */
    private ensure(): void {
        if (this.disposed || !this.visible) return;
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
            // The encoded bytes are charged before the decoder copies them in; the charge is the decoder's until it closes.
            const lease = this.options.registry.reserve(source.blob.size);
            if (!lease) throw new Deferred('Not enough memory for this animation');
            try {
                const decoder = new ImageDecoder({ data: source.blob.stream(), type: source.entry.mime });
                try {
                    await decoder.tracks.ready;
                    const track = decoder.tracks.selectedTrack;
                    if (!track) throw new Error('This picture has no image track');
                    return { media: source.entry.id, decoder, frameCount: track.frameCount, lease };
                } catch (error) { decoder.close(); throw error; }
            } catch (error) { this.options.registry.release(lease); throw error; }
        })();
        const previous = this.decoders.get(node);
        this.decoders.set(node, next);
        this.decoderMedia.set(node, source.entry.id);
        if (previous) void previous.then(held => { held.decoder.close(); this.options.registry.release(held.lease); }, () => {});
        next.catch(() => { if (this.decoders.get(node) === next) { this.decoders.delete(node); this.decoderMedia.delete(node); } });
        return next;
    }
    /**
     * Stops every decoder now, so nothing new is decoded for them. Each decoder's charge is returned only after the native
     * decodes already in flight have settled, and presented frames of the stopped pictures are retired.
     */
    private stopDecoders(): void {
        const decoders = [...this.decoders.values()];
        for (const node of this.shown.keys()) this.options.registry.retire(node);
        this.decoders.clear(); this.decoderMedia.clear(); this.decoding.clear(); this.shown.clear();
        const leases = decoders.map(pending => pending.then(held => { held.decoder.close(); return held.lease; }, () => null));
        const inflight = [...this.inflight];
        void Promise.allSettled(inflight).then(() => Promise.all(leases)).then(released => {
            for (const lease of released) if (lease) this.options.registry.release(lease);
        });
    }
    private decode(node: NodeId, source: AnimatedPictureSource, index: number): void {
        this.decoding.set(node, index);
        const finish = () => { if (this.decoding.get(node) === index) this.decoding.delete(node); };
        // The frame's pixels are charged before the decoder allocates them; a refused charge defers the frame to the next paint.
        const charged = source.entry.w * source.entry.h * 4;
        const work = async (): Promise<Frame | null> => {
            const held = await this.decoderFor(node, source);
            const lease = this.options.registry.reserve(charged);
            if (!lease) return null;
            let bitmap: ImageBitmap | undefined;
            try {
                const result = await held.decoder.decode({ frameIndex: index });
                try {
                    if (result.image.displayWidth * result.image.displayHeight * 4 > charged) throw new Error('This picture frame is larger than its entry');
                    const durationMs = Math.max(10, (result.image.duration ?? 100_000) / 1000);
                    bitmap = await createImageBitmap(result.image);
                    return { bitmap, lease, frameCount: held.frameCount, durationMs };
                } finally { result.image.close(); }
            } catch (error) { bitmap?.close(); this.options.registry.release(lease); throw error; }
        };
        const settled: Promise<void> = work().then(frame => {
            finish();
            if (!frame) return; // Deferred: the view's next paint asks for this frame again.
            const demanded = this.demands.some(item => item.node === node && item.playing && item.media === source.entry.id);
            if (this.disposed || !this.visible || !demanded || !this.options.current() || this.clock.frame(node) !== index) {
                frame.bitmap.close(); this.options.registry.release(frame.lease); this.ensure(); return;
            }
            this.shown.set(node, index);
            this.options.registry.present(node, frame.bitmap, frame.lease);
            this.clock.decoded(source.entry.id, index, frame.durationMs, frame.frameCount, performance.now());
            this.ensure();
        }, error => {
            finish();
            // A decode stopped or superseded by another picture is the normal end of that work, not a failure to report.
            if (error instanceof Deferred || this.disposed || !this.visible || !this.options.current() || this.decoderMedia.get(node) !== source.entry.id) return;
            this.decoders.delete(node); this.decoderMedia.delete(node);
            this.options.error(node, error instanceof Error ? error.message : 'This picture animation could not be shown');
        }).catch(() => undefined);
        this.inflight.add(settled);
        void settled.then(() => { this.inflight.delete(settled); });
    }
}
