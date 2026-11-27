import { pageAt, pageStack, type PageStack } from '../../platform/render/pageStack';
import type { Affine, Rect } from '../../platform/types';
import { paperPageSize } from '../../utils/paper';
import type { HostBlock } from './doc';

const stacks = new WeakMap<object, PageStack>();

export function boardPageStack(host: HostBlock): Readonly<PageStack> | undefined {
    if (host.kind === 'whiteboard') return undefined;
    const key = host.kind === 'notebook' ? host.paper : host.pages;
    const cached = stacks.get(key);
    if (cached) return cached;
    const dimensions = host.kind === 'notebook'
        ? Array.from({ length: host.paper.pageCount }, () => paperPageSize(host.paper))
        : host.pages.map(([width, height]) => ({ width, height }));
    const result = pageStack(dimensions);
    stacks.set(key, result);
    return result;
}

export interface PageAnchor {
    readonly page: number;
    readonly x: number;
    readonly y: number;
}

export type PageMove = PageAnchor;

export function pageOrigin(stack: Readonly<PageStack>, page: number): Rect | undefined {
    if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Invalid page index');
    return stack.rects[Math.min(page, stack.rects.length - 1)];
}

export function pageWorldTransform(
    stack: Readonly<PageStack>, anchor: PageAnchor & { readonly rotation: number },
): Affine | undefined {
    const origin = pageOrigin(stack, anchor.page);
    if (!origin) return undefined;
    const cos = Math.cos(anchor.rotation), sin = Math.sin(anchor.rotation);
    return [cos, sin, -sin, cos, origin.x + anchor.x, origin.y + anchor.y];
}

export function reanchorPage(
    stack: Readonly<PageStack>, anchor: PageAnchor, worldBounds: Readonly<Rect>,
): PageMove | undefined {
    const origin = pageOrigin(stack, anchor.page);
    if (!origin) return undefined;
    const page = pageAt(stack, worldBounds.y + worldBounds.height / 2);
    const target = stack.rects[page];
    return { page, x: anchor.x + origin.x - target.x, y: anchor.y + origin.y - target.y };
}
