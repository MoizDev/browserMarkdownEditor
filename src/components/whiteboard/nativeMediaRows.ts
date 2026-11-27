import type { MenuRow } from './chrome/boardCommands';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';

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

const CROP_ROWS: readonly { readonly preset: PictureCropPreset; readonly key: string }[] = [
    { preset: 'original', key: 'crop.aspect.original' }, { preset: 'square', key: 'crop.aspect.square' },
    { preset: 'circle', key: 'crop.aspect.circle' }, { preset: 'landscape', key: 'crop.aspect.landscape' },
    { preset: 'portrait', key: 'crop.aspect.portrait' }, { preset: 'wide', key: 'crop.aspect.wide' },
];

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
    readonly requestText?: (question: BoardTextQuestion) => Promise<string | null>;
    readonly openCrop?: (id: MediaRowId) => void;
    readonly playback?: NativeViewLease['video'];
    readonly current: () => boolean;
    readonly notice: (message: string) => void;
    readonly text: (key: string) => string;
}

export function mediaRows(selection: MediaRowSelection, options: MediaRowOptions): MenuRow[] {
    const { actions, fail, pick, requestText, playback, current, notice, openCrop, text } = options;
    const attempt = (action: () => void | Promise<void>) => () => {
        if (!current()) { notice(text('menu.selectionChanged')); return; }
        try { void Promise.resolve(action()).catch(fail); } catch (error) { fail(error); }
    };
    const rowState: { disabled?: true; reason?: string } = selection.blocked === null ? {} : { disabled: true, reason: selection.blocked };
    if (selection.kind === 'linkcard') {
        return [{ kind: 'command', id: 'media-card-preview', label: text('menu.fetchLinkPreview'), ...rowState,
            run: attempt(() => actions.cardPreview(selection.id)) }];
    }
    const rows: MenuRow[] = [];
    if (selection.replaceable) {
        rows.push({ kind: 'command', id: 'media-replace', label: text('chrome.replaceMedia'), ...rowState,
            run: attempt(async () => { const file = await pick(); if (file) await actions.replace(selection.id, file, file.name); }) });
    }
    if (openCrop) {
        rows.push({ kind: 'command', id: 'media-crop-editor', label: text('chrome.cropImage'), ...rowState,
            run: attempt(() => openCrop(selection.id)) });
    }
    rows.push({ kind: 'submenu', id: 'media-crop', label: text('chrome.cropToAspect'), ...rowState,
        entries: CROP_ROWS.map(({ preset, key }) => ({ kind: 'command' as const, id: `media-crop-${preset}`, label: text(key), ...rowState,
            run: attempt(() => actions.crop(selection.id, preset)) })) });
    if (!selection.video) {
        rows.push({ kind: 'command', id: 'media-invert', label: text('chrome.invertImage'), ...rowState,
            run: attempt(() => actions.invert(selection.id)) });
    }
    rows.push({ kind: 'command', id: 'media-download-original', label: text('chrome.downloadOriginal'),
        run: attempt(() => actions.downloadOriginal(selection.id)) });
    if (requestText) {
        rows.push({ kind: 'command', id: 'media-alt-text', label: text('chrome.alternativeText'), ...rowState,
            run: attempt(async () => {
                const initial = actions.alternativeText(selection.id);
                const value = await requestText({ title: text('chrome.alternativeText'), body: text('crop.altBody'), confirmLabel: text('chrome.save'),
                    input: { label: text('chrome.altLabel'), initialValue: initial, validate: value => value.length > 10_000 ? text('chrome.altTooLong') : null } });
                if (value !== null && value !== initial) actions.setAlt(selection.id, value);
            }) });
    }
    if (playback && (selection.video || selection.animated) && (playback.shown(selection.id) || playback.playing(selection.id))) {
        const playing = playback.playing(selection.id);
        const label = playing ? text(selection.video ? 'menu.pauseVideo' : 'menu.pauseAnimation') : text(selection.video ? 'menu.playVideo' : 'menu.playAnimation');
        rows.push({ kind: 'command', id: 'media-playback', label,
            run: () => { try { if (playing) playback.pause(selection.id); else playback.play(selection.id); } catch (error) { fail(error); } } });
    }
    return rows;
}
