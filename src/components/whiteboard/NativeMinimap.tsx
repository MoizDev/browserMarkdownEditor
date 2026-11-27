import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { Camera, Rect, Viewport } from '../../platform/types';
import './nativeMinimap.css';

export interface NativeMinimapBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface NativeMinimapThumbnail {
    readonly key: string;
    readonly blob: Blob | null;
    readonly worldBounds: Rect | null;
    readonly revision: number;
}

export interface NativeMinimapProps {
    readonly thumbnail: NativeMinimapThumbnail | null;
    readonly currentCamera: Camera;
    readonly viewport: Viewport;
    readonly isVisible: boolean;
    readonly currentOwner: () => boolean;
    readonly highlights: readonly NativeMinimapBox[];
    readonly onNavigate: (worldCentre: { x: number; y: number }, mode: 'glide' | 'jump') => void;
    readonly onFocus: () => void;
}

const CLICK_SLOP_PX = 2;


const BOX_WIDTH = 200, BOX_HEIGHT = 140;

export default function NativeMinimap({ thumbnail, currentCamera, viewport, isVisible, currentOwner, highlights, onNavigate, onFocus }: NativeMinimapProps) {
    const element = useRef<HTMLDivElement | null>(null);
    const frameElement = useRef<HTMLDivElement | null>(null);
    const drag = useRef<number | null>(null);
    const press = useRef<{ x: number; y: number; grab: { x: number; y: number } | null; moved: boolean;
        map: { left: number; top: number; width: number; height: number; frame: typeof frame } } | null>(null);
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

    const content = thumbnail?.worldBounds ?? null;
    if (!active || !thumbnail || (thumbnail.blob !== null && (!image || image.key !== key))
        || (content !== null && (!Number.isFinite(content.x) || !Number.isFinite(content.y) || !Number.isFinite(content.width)
            || !Number.isFinite(content.height) || content.width <= 0 || content.height <= 0))
        || !Number.isFinite(currentCamera.x) || !Number.isFinite(currentCamera.y) || !Number.isFinite(currentCamera.z)
        || currentCamera.z <= 0 || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
        || viewport.width <= 0 || viewport.height <= 0) return null;

    const viewWidth = viewport.width / currentCamera.z, viewHeight = viewport.height / currentCamera.z;
    const view = { x: currentCamera.x, y: currentCamera.y, width: viewWidth, height: viewHeight };
    const bounds = content ?? view;
    const picture = content !== null ? image : null;
    const left = Math.min(bounds.x, view.x), top = Math.min(bounds.y, view.y);
    const right = Math.max(bounds.x + bounds.width, view.x + viewWidth), bottom = Math.max(bounds.y + bounds.height, view.y + viewHeight);
    const margin = Math.max(right - left, bottom - top) * 0.05;
    const frame = { x: left - margin, y: top - margin, width: right - left + 2 * margin, height: bottom - top + 2 * margin };
    const fit = Math.min(BOX_WIDTH / frame.width, BOX_HEIGHT / frame.height);
    const frameWidth = frame.width * fit, frameHeight = frame.height * fit;
    const percent = (value: number, total: number) => `${value / total * 100}%`;

    const worldIn = (map: NonNullable<typeof press.current>['map'], clientX: number, clientY: number) => {
        const x = Math.max(0, Math.min(1, (clientX - map.left) / map.width));
        const y = Math.max(0, Math.min(1, (clientY - map.top) / map.height));
        return { x: map.frame.x + x * map.frame.width, y: map.frame.y + y * map.frame.height };
    };
    const mapNow = () => {
        const rect = frameElement.current?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, frame } : null;
    };
    const worldAt = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const map = mapNow();
        return map ? worldIn(map, clientX, clientY) : null;
    };
    const insideWindow = (point: { x: number; y: number }) => point.x >= view.x && point.x <= view.x + viewWidth
        && point.y >= view.y && point.y <= view.y + viewHeight;
    const release = () => {
        const pointer = drag.current;
        drag.current = null; press.current = null;
        if (pointer !== null && element.current?.hasPointerCapture(pointer)) element.current.releasePointerCapture(pointer);
    };
    const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current !== null || !currentOwner()) return;
        event.preventDefault(); event.stopPropagation();
        drag.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        onFocus();
        const map = mapNow();
        if (!map) return;
        const point = worldIn(map, event.clientX, event.clientY);
        const grab = insideWindow(point) ? { x: point.x - view.x, y: point.y - view.y } : null;
        press.current = { x: event.clientX, y: event.clientY, grab, moved: false, map };
        if (!grab) onNavigate(point, 'glide');
    };
    const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const pressed = press.current;
        if (drag.current !== event.pointerId || !pressed) return;
        event.preventDefault(); event.stopPropagation();
        if (!pressed.moved) {
            if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < CLICK_SLOP_PX) return;
            pressed.moved = true;
        }
        const point = worldIn(pressed.map, event.clientX, event.clientY);
        if (!currentOwner()) return;
        onNavigate(pressed.grab
            ? { x: point.x - pressed.grab.x + viewWidth / 2, y: point.y - pressed.grab.y + viewHeight / 2 }
            : point, 'jump');
    };
    const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current !== event.pointerId) return;
        release();
        event.stopPropagation();
    };
    const doubleClick = (event: MouseEvent<HTMLDivElement>) => {
        const point = worldAt(event.clientX, event.clientY);
        if (point && currentOwner()) onNavigate(point, 'glide');
    };
    const contextMenu = (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        release();
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
        onNavigate(centre, 'jump');
    };
    return <div ref={element} className="native-minimap" role="region" tabIndex={0}
        aria-label="Board minimap. Drag to navigate; use arrow keys, Home or End."
        data-tooltip="Drag or use arrow keys to navigate" data-tooltip-position="top"
        style={{ width: BOX_WIDTH, height: BOX_HEIGHT }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onDoubleClick={doubleClick} onContextMenu={contextMenu}
        onKeyDown={keyDown}>
        <div ref={frameElement} className="native-minimap-frame" style={{
            left: (BOX_WIDTH - frameWidth) / 2, top: (BOX_HEIGHT - frameHeight) / 2, width: frameWidth, height: frameHeight,
        }}>
            {picture && <img src={picture.url} alt="" draggable={false} style={{
                left: percent(bounds.x - frame.x, frame.width), top: percent(bounds.y - frame.y, frame.height),
                width: percent(bounds.width, frame.width), height: percent(bounds.height, frame.height),
            }} />}
            {highlights.map((box, index) => <div key={index} className="native-minimap-selected" aria-hidden="true" style={{
                left: percent(box.x - frame.x, frame.width), top: percent(box.y - frame.y, frame.height),
                width: percent(box.width, frame.width), height: percent(box.height, frame.height),
            }} />)}
            <div className="native-minimap-viewport" aria-hidden="true" style={{
                left: percent(view.x - frame.x, frame.width), top: percent(view.y - frame.y, frame.height),
                width: percent(view.width, frame.width), height: percent(view.height, frame.height),
            }} />
        </div>
    </div>;
}
