import type { Rect } from '../../types';
import type { RenderToken } from '../types';
import { renderTokenKey, sameTileContent, tileKeyString, validateTileRect } from './geometry';
import type { TileContentIdentity, TileKey } from './geometry';

export type CoverageIntent = 'screen' | 'capture' | 'export' | 'selection' | 'agent';
export type CoverageClass = 'exact' | 'standin' | 'stale-version' | 'expired-fallback' | 'hole';

/** Issued/leased by the document session, never authorized or extended by the compositor (§5.1:486).
 * geometryDigest covers page/region count, sizes and rotations. The session sets the immutable
 * deadline using the shared versionBridgeDurationMs policy, not a fresh deadline on every frame.
 */
export interface VersionBridge {
    readonly fromToken: RenderToken;
    readonly toToken: RenderToken;
    readonly fromSourceRole: string;
    readonly toSourceRole: string;
    readonly reason: string;
    readonly geometryDigest: string;
    readonly deadline: number;
}

export interface BridgeCompatibility {
    /** Consumer checks appearance semantics for this candidate, including emphasis mode. */
    readonly appearanceCompatible: boolean;
    /** False immediately when an erase/transform/recolour makes this region misleading. */
    readonly regionCompatible: boolean;
}

export interface CoverageRequest {
    readonly region: Readonly<Rect>;
    readonly current: TileContentIdentity;
    readonly scale: number;
    readonly geometryDigest: string;
    readonly intent: CoverageIntent;
    readonly now: number;
}

/** One healthy, budgeted publication, not merely an arrived or queued cache entry. */
export interface CoverageProvider extends BridgeCompatibility {
    /** Unique publication id, including resource generation; two replacements cannot alias it. */
    readonly id: string;
    readonly key: TileKey;
    readonly region: Readonly<Rect>;
    readonly scale: number;
    readonly available: boolean;
    readonly preview: boolean;
    readonly bridge?: VersionBridge;
}

export interface CoverageRegion {
    readonly region: Readonly<Rect>;
    readonly provider: CoverageProvider | null;
    readonly class: CoverageClass;
    /** Expired pixels may remain labelled fallback, but cannot prove usable/sharp coverage. */
    readonly covers: boolean;
    readonly sharp: boolean;
}

export function admitVersionBridge(bridge: VersionBridge, source: TileKey, request: CoverageRequest,
    compatibility: BridgeCompatibility): 'active' | 'expired-fallback' | 'refused' {
    const from = bridge.fromToken;
    const to = bridge.toToken;
    if (request.intent !== 'screen' || !Number.isFinite(request.now) || !Number.isFinite(bridge.deadline) ||
        !bridge.reason || !bridge.geometryDigest || bridge.geometryDigest !== request.geometryDigest ||
        !compatibility.appearanceCompatible || !compatibility.regionCompatible ||
        from.vaultEpoch !== to.vaultEpoch || from.documentId !== to.documentId ||
        renderTokenKey(from) !== source.documentToken || renderTokenKey(to) !== request.current.documentToken ||
        bridge.fromSourceRole !== source.sourceRole || bridge.toSourceRole !== request.current.sourceRole ||
        source.pageOrRegion !== request.current.pageOrRegion || source.colourVersion !== request.current.colourVersion ||
        source.tileSchema !== request.current.tileSchema) return 'refused';
    return request.now < bridge.deadline ? 'active' : 'expired-fallback';
}

export function intersectRegions(a: Readonly<Rect>, b: Readonly<Rect>): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Disjoint half-open remainders; no epsilon can erase a real narrow strip (§5.4:535). */
function subtract(region: Readonly<Rect>, covered: Readonly<Rect>): Rect[] {
    const overlap = intersectRegions(region, covered);
    if (!overlap) return [{ ...region }];
    const pieces: Rect[] = [];
    const right = region.x + region.width;
    const bottom = region.y + region.height;
    const overlapRight = overlap.x + overlap.width;
    const overlapBottom = overlap.y + overlap.height;
    if (overlap.y > region.y) pieces.push({ x: region.x, y: region.y, width: region.width, height: overlap.y - region.y });
    if (overlapBottom < bottom) pieces.push({ x: region.x, y: overlapBottom, width: region.width, height: bottom - overlapBottom });
    if (overlap.x > region.x) pieces.push({ x: region.x, y: overlap.y, width: overlap.x - region.x, height: overlap.height });
    if (overlapRight < right) pieces.push({ x: overlapRight, y: overlap.y, width: right - overlapRight, height: overlap.height });
    return pieces;
}

interface RankedProvider {
    readonly provider: CoverageProvider;
    readonly class: Exclude<CoverageClass, 'hole'>;
    readonly rank: number;
    readonly distance: number;
    readonly key: string;
}

function rank(provider: CoverageProvider, request: CoverageRequest): RankedProvider | null {
    if (!provider.available || !intersectRegions(provider.region, request.region)) return null;
    const distance = Math.abs(Math.log(provider.scale) - Math.log(request.scale));
    if (sameTileContent(provider.key, request.current)) {
        if (provider.scale === request.scale) return { provider, class: 'exact', rank: 0, distance, key: tileKeyString(provider.key) };
        if (request.intent !== 'screen') return null;
        return { provider, class: 'standin', rank: provider.scale > request.scale ? 1 : provider.preview ? 3 : 2,
            distance, key: tileKeyString(provider.key) };
    }
    if (!provider.bridge) return null;
    const status = admitVersionBridge(provider.bridge, provider.key, request, provider);
    if (status === 'refused') return null;
    return { provider, class: status === 'active' ? 'stale-version' : 'expired-fallback',
        rank: status === 'active' ? 4 : 5, distance, key: tileKeyString(provider.key) };
}

function stable(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Choose exactly one provider per rectangle: never blend coarse/fine or old/new alpha together.
 * This is preparation metadata, NOT C9's authoritative every-frame pixel coverage mask (§14.1).
 */
export function coverRegion(request: CoverageRequest, providers: readonly CoverageProvider[]): readonly CoverageRegion[] {
    validateTileRect(request.region);
    if (!Number.isFinite(request.scale) || request.scale <= 0 || !Number.isFinite(request.now)) throw new RangeError('Invalid coverage request');
    if (!request.region.width || !request.region.height) return [];
    const ids = new Set<string>();
    const candidates: RankedProvider[] = [];
    for (const provider of providers) {
        validateTileRect(provider.region);
        if (!provider.id || ids.has(provider.id) || !Number.isFinite(provider.scale) || provider.scale <= 0) {
            throw new RangeError('Invalid or duplicated coverage publication');
        }
        ids.add(provider.id);
        const candidate = rank(provider, request);
        if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => a.rank - b.rank || a.distance - b.distance || stable(a.key, b.key) || stable(a.provider.id, b.provider.id));
    let uncovered: Rect[] = [{ ...request.region }];
    const result: CoverageRegion[] = [];
    for (const candidate of candidates) {
        const remaining: Rect[] = [];
        for (const region of uncovered) {
            const overlap = intersectRegions(region, candidate.provider.region);
            if (!overlap) { remaining.push(region); continue; }
            result.push({ region: overlap, provider: candidate.provider, class: candidate.class,
                covers: candidate.class !== 'expired-fallback', sharp: candidate.class === 'exact' });
            remaining.push(...subtract(region, overlap));
        }
        uncovered = remaining;
        if (!uncovered.length) break;
    }
    for (const region of uncovered) result.push({ region, provider: null, class: 'hole', covers: false, sharp: false });
    return result;
}

export interface PublishedReplacement {
    readonly reserved: boolean;
    readonly published: boolean;
    readonly providers: readonly CoverageProvider[];
}

/** Reserve replacement bytes, publish, THEN release (§3 rule 3; §6.3:644).
 * Pointwise comparison matters: equal total covered area can hide a newly moved hole.
 */
export function mayReleaseCoverage(request: CoverageRequest, current: readonly CoverageProvider[],
    releasing: ReadonlySet<string>, replacement?: PublishedReplacement): boolean {
    if (replacement && (!replacement.reserved || !replacement.published)) return false;
    const before = coverRegion(request, current).filter(region => region.covers);
    const after = coverRegion(request, [
        ...current.filter(provider => !releasing.has(provider.id)), ...(replacement?.providers ?? []),
    ]).filter(region => region.covers);
    for (const existing of before) {
        let missing: Rect[] = [{ ...existing.region }];
        for (const next of after) {
            const remaining: Rect[] = [];
            for (const region of missing) remaining.push(...subtract(region, next.region));
            missing = remaining;
            if (!missing.length) break;
        }
        if (missing.length) return false;
    }
    return true;
}
