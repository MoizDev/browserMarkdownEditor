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

/** The map's fixed box, in CSS pixels, excluding its 1px border. */
const BOX_WIDTH = 200, BOX_HEIGHT = 140;

/** Presents an engine-produced scene capture; it never creates a preview of its own. */
export default function NativeMinimap({ thumbnail, currentCamera, viewport, isVisible, currentOwner, onNavigate, onFocus }: NativeMinimapProps) {
    const element = useRef<HTMLDivElement | null>(null);
    const frameElement = useRef<HTMLDivElement | null>(null);
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

    // The map shows the whole board AND the visible window, so the viewport rectangle is always
    // inside it: a board smaller than the window shows small, with the window drawn around it.
    const viewWidth = viewport.width / currentCamera.z, viewHeight = viewport.height / currentCamera.z;
    const view = { x: currentCamera.x, y: currentCamera.y, width: viewWidth, height: viewHeight };
    const left = Math.min(bounds.x, view.x), top = Math.min(bounds.y, view.y);
    const right = Math.max(bounds.x + bounds.width, view.x + viewWidth), bottom = Math.max(bounds.y + bounds.height, view.y + viewHeight);
    const margin = Math.max(right - left, bottom - top) * 0.05;
    const frame = { x: left - margin, y: top - margin, width: right - left + 2 * margin, height: bottom - top + 2 * margin };
    // The frame is fitted into the fixed box, keeping its aspect and centring the spare space.
    const fit = Math.min(BOX_WIDTH / frame.width, BOX_HEIGHT / frame.height);
    const frameWidth = frame.width * fit, frameHeight = frame.height * fit;
    const percent = (value: number, total: number) => `${value / total * 100}%`;

    const navigate = (clientX: number, clientY: number) => {
        if (!currentOwner()) return;
        const rect = frameElement.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        onNavigate({ x: frame.x + x * frame.width, y: frame.y + y * frame.height });
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
        const centre = { x: currentCamera.x + viewWidth / 2, y: currentCamera.y + viewHeight / 2 };
        const factor = event.shiftKey ? 1 : 0.25;
        switch (event.key) {
            case 'ArrowLeft': centre.x -= viewWidth * factor; break;
            case 'ArrowRight': centre.x += viewWidth * factor; break;
            case 'ArrowUp': centre.y -= viewHeight * factor; break;
            case 'ArrowDown': centre.y += viewHeight * factor; break;
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
        style={{ width: BOX_WIDTH, height: BOX_HEIGHT }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onKeyDown={keyDown}>
        <div ref={frameElement} className="native-minimap-frame" style={{
            left: (BOX_WIDTH - frameWidth) / 2, top: (BOX_HEIGHT - frameHeight) / 2, width: frameWidth, height: frameHeight,
        }}>
            <img src={image.url} alt="" draggable={false} style={{
                left: percent(bounds.x - frame.x, frame.width), top: percent(bounds.y - frame.y, frame.height),
                width: percent(bounds.width, frame.width), height: percent(bounds.height, frame.height),
            }} />
            <div className="native-minimap-viewport" aria-hidden="true" style={{
                left: percent(view.x - frame.x, frame.width), top: percent(view.y - frame.y, frame.height),
                width: percent(view.width, frame.width), height: percent(view.height, frame.height),
            }} />
        </div>
    </div>;
}
