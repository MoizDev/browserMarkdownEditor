import type { ContextMenuEntry } from '../../utils/contextMenu';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';

// The picture and card actions this module drives, described by shape: the host's MediaActions satisfies them, and
// an import of the whiteboard engine would make this component file a dark-zone importer (see eslint.config.ts).
// The node id the view's own playback port takes, read off its signature so this file names no engine module.
export type MediaRowId = Parameters<NativeViewLease['video']['shown']>[0];
export type PictureCropPreset = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
export interface MediaRowSelection {
    readonly id: MediaRowId;
    readonly kind: 'picture' | 'linkcard';
    readonly blocked: string | null;
    readonly replaceable: boolean;
    readonly video: boolean;
    readonly animated: boolean;
}
export interface MediaRowActions {
    replace(id: MediaRowId, file: Blob, name: string): Promise<void>;
    crop(id: MediaRowId, preset: PictureCropPreset): void;
    invert(id: MediaRowId): void;
    alternativeText(id: MediaRowId): string;
    setAlt(id: MediaRowId, text: string): void;
    downloadOriginal(id: MediaRowId): void;
    cardPreview(id: MediaRowId): Promise<void>;
}

const CROP_ROWS: readonly { readonly preset: PictureCropPreset; readonly label: string }[] = [
    { preset: 'original', label: 'Original' }, { preset: 'square', label: 'Square' }, { preset: 'circle', label: 'Circle' },
    { preset: 'landscape', label: 'Landscape 4:3' }, { preset: 'portrait', label: 'Portrait 3:4' }, { preset: 'wide', label: 'Wide 16:9' },
];

/** The App's own picker for a replacement: one image, chosen from the right-click that asked for it. */
export function chooseReplacementImage(): Promise<File | null> {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
        const finish = (file: File | null) => { input.onchange = null; input.oncancel = null; input.remove(); resolve(file); };
        input.onchange = () => finish(input.files?.[0] ?? null);
        input.oncancel = () => finish(null);
        document.body.append(input);
        input.click();
    });
}

export interface MediaRowOptions {
    readonly actions: MediaRowActions;
    readonly fail: (error: unknown) => void;
    readonly pick: () => Promise<File | null>;
    /** Alternative text is asked in the board's own text dialog; a view without one offers no alt row. */
    readonly requestText?: (question: BoardTextQuestion) => Promise<string | null>;
    /** Opens the crop editor for a picture; a view without one offers no editor row. */
    readonly openCrop?: (id: MediaRowId) => void;
    /** Clip and animation play rows, when the view can play them. */
    readonly playback?: NativeViewLease['video'];
    /** Whether the menu's selection is still the one it was raised over. */
    readonly current: () => boolean;
    readonly notice: (message: string) => void;
    /** A board's translated label for a key, or the fallback when that key has no translation. */
    readonly text?: (key: string, fallback: string) => string;
}

/** Rows for the one picture or card the menu was raised over. A blocked row stays on screen and says why. */
export function mediaRows(selection: MediaRowSelection, options: MediaRowOptions): ContextMenuEntry[] {
    const { actions, fail, pick, requestText, playback, current, notice, openCrop } = options;
    const label = (key: string, fallback: string) => options.text ? options.text(key, fallback) : fallback;
    const attempt = (action: () => void | Promise<void>) => () => {
        if (!current()) { notice('The selection changed; open the menu again.'); return; }
        try { void Promise.resolve(action()).catch(fail); } catch (error) { fail(error); }
    };
    const rowState: { disabled?: true; reason?: string } = selection.blocked === null ? {} : { disabled: true, reason: selection.blocked };
    if (selection.kind === 'linkcard') {
        return [{ kind: 'command', id: 'media-card-preview', label: 'Fetch link preview', ...rowState,
            run: attempt(() => actions.cardPreview(selection.id)) }];
    }
    const rows: ContextMenuEntry[] = [];
    if (selection.replaceable) {
        rows.push({ kind: 'command', id: 'media-replace', label: label('chrome.replaceMedia', 'Replace picture…'), ...rowState,
            run: attempt(async () => { const file = await pick(); if (file) await actions.replace(selection.id, file, file.name); }) });
    }
    if (openCrop) {
        rows.push({ kind: 'command', id: 'media-crop-editor', label: label('chrome.cropImage', 'Crop image'), ...rowState,
            run: attempt(() => openCrop(selection.id)) });
    }
    rows.push({ kind: 'submenu', id: 'media-crop', label: label('chrome.cropImage', 'Crop picture'), ...rowState,
        entries: CROP_ROWS.map(({ preset, label: presetLabel }) => ({ kind: 'command' as const, id: `media-crop-${preset}`, label: presetLabel, ...rowState,
            run: attempt(() => actions.crop(selection.id, preset)) })) });
    // Invert is a picture's own flag; a clip's frames are not inverted by it.
    if (!selection.video) {
        rows.push({ kind: 'command', id: 'media-invert', label: label('chrome.invertImage', 'Invert picture'), ...rowState,
            run: attempt(() => actions.invert(selection.id)) });
    }
    // The original bytes are a copy the user asked for, so this row stays open on a locked or read-only picture.
    rows.push({ kind: 'command', id: 'media-download-original', label: label('chrome.downloadOriginal', 'Download original'),
        run: attempt(() => actions.downloadOriginal(selection.id)) });
    if (requestText) {
        rows.push({ kind: 'command', id: 'media-alt-text', label: label('chrome.alternativeText', 'Alternative text…'), ...rowState,
            run: attempt(async () => {
                const initial = actions.alternativeText(selection.id);
                const value = await requestText({ title: label('chrome.alternativeText', 'Alternative text…'),
                    body: 'Describe the picture for people who cannot see it.', confirmLabel: 'Save',
                    input: { label: 'Alt text', initialValue: initial, validate: text => text.length > 10_000 ? 'The description is too long.' : null } });
                if (value !== null && value !== initial) actions.setAlt(selection.id, value);
            }) });
    }
    if (playback && (selection.video || selection.animated) && (playback.shown(selection.id) || playback.playing(selection.id))) {
        const playing = playback.playing(selection.id), noun = selection.video ? 'video' : 'animation';
        rows.push({ kind: 'command', id: 'media-playback', label: playing ? `Pause ${noun}` : `Play ${noun}`,
            run: () => { try { if (playing) playback.pause(selection.id); else playback.play(selection.id); } catch (error) { fail(error); } } });
    }
    return rows;
}
