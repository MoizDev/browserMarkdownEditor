import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Camera, Rect, Viewport } from '../../platform/types';
import './nativeMinimap.css';

export interface NativeMinimapThumbnail {
    readonly key: string;
    readonly blob: Blob;
    readonly worldBounds: Rect;
    readonly revision: number;
}

export interface NativeMinimapProps {
    readonly thumbnail: NativeMinimapThumbnail | null;
    readonly currentCamera: Camera;
    readonly viewport: Viewport;
    readonly isVisible: boolean;
    readonly currentOwner: () => boolean;
    readonly onNavigate: (worldCentre: { x: number; y: number }) => void;
    readonly onFocus: () => void;
}

/** Presents an engine-produced scene capture; it never creates a preview of its own. */
export default function NativeMinimap({ thumbnail, currentCamera, viewport, isVisible, currentOwner, onNavigate, onFocus }: NativeMinimapProps) {
    const element = useRef<HTMLDivElement | null>(null);
    const drag = useRef<number | null>(null);
    const blob = useRef(thumbnail?.blob);
    const [image, setImage] = useState<{ key: string; url: string } | null>(null);
    useLayoutEffect(() => { blob.current = thumbnail?.blob; }, [thumbnail?.blob]);
    const key = thumbnail?.key;
    const active = isVisible && currentOwner();
    useLayoutEffect(() => {
        if (!active || key === undefined || !blob.current) return;
        const url = URL.createObjectURL(blob.current);
        const target = element.current;
        setImage({ key, url });
        return () => {
            const pointer = drag.current;
            drag.current = null;
            if (pointer !== null && target?.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
            URL.revokeObjectURL(url);
        };
    }, [active, key]);
    useLayoutEffect(() => {
        if (active) return;
        const pointer = drag.current;
        drag.current = null;
        if (pointer !== null && element.current?.hasPointerCapture(pointer)) element.current.releasePointerCapture(pointer);
    }, [active]);

    const bounds = thumbnail?.worldBounds;
    if (!active || !thumbnail || !bounds || !image || image.key !== key
        || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width)
        || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0
        || !Number.isFinite(currentCamera.x) || !Number.isFinite(currentCamera.y) || !Number.isFinite(currentCamera.z)
        || currentCamera.z <= 0 || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
        || viewport.width <= 0 || viewport.height <= 0) return null;

    const width = Math.min(200, 140 * bounds.width / bounds.height);
    const visibleWidth = viewport.width / currentCamera.z, visibleHeight = viewport.height / currentCamera.z;
    const left = Math.max(bounds.x, currentCamera.x), top = Math.max(bounds.y, currentCamera.y);
    const right = Math.min(bounds.x + bounds.width, currentCamera.x + visibleWidth);
    const bottom = Math.min(bounds.y + bounds.height, currentCamera.y + visibleHeight);
    const navigate = (clientX: number, clientY: number) => {
        if (!currentOwner()) return;
        const rect = element.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        onNavigate({ x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height });
    };
    const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current !== null || !currentOwner()) return;
        event.preventDefault(); event.stopPropagation();
        drag.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        onFocus();
        navigate(event.clientX, event.clientY);
    };
    const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        navigate(event.clientX, event.clientY);
    };
    const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        event.stopPropagation();
    };
    const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!currentOwner()) return;
        const centre = { x: currentCamera.x + visibleWidth / 2, y: currentCamera.y + visibleHeight / 2 };
        const factor = event.shiftKey ? 1 : 0.25;
        switch (event.key) {
            case 'ArrowLeft': centre.x -= visibleWidth * factor; break;
            case 'ArrowRight': centre.x += visibleWidth * factor; break;
            case 'ArrowUp': centre.y -= visibleHeight * factor; break;
            case 'ArrowDown': centre.y += visibleHeight * factor; break;
            case 'Home': centre.x = bounds.x; centre.y = bounds.y; break;
            case 'End': centre.x = bounds.x + bounds.width; centre.y = bounds.y + bounds.height; break;
            default: return;
        }
        event.preventDefault(); event.stopPropagation();
        onNavigate(centre);
    };
    return <div ref={element} className="native-minimap" role="region" tabIndex={0}
        aria-label="Board minimap. Drag to navigate; use arrow keys, Home or End."
        data-tooltip="Drag or use arrow keys to navigate" data-tooltip-position="top"
        style={{ width, aspectRatio: `${bounds.width} / ${bounds.height}` }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onKeyDown={keyDown}>
        <img src={image.url} alt="" draggable={false} />
        {right > left && bottom > top && <div className="native-minimap-viewport" aria-hidden="true" style={{
            left: `${(left - bounds.x) / bounds.width * 100}%`, top: `${(top - bounds.y) / bounds.height * 100}%`,
            width: `${(right - left) / bounds.width * 100}%`, height: `${(bottom - top) / bounds.height * 100}%`,
        }} />}
    </div>;
}
