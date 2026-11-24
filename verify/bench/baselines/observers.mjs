// Init-script instrumentation only. No app module, editor instance or paused target.
export function installObservation({ startup, kind, target, drop, expectedText }) {
    if (window !== window.top) return;
    const state = window.__v08 = { firstPixels: null, readable: null, raf: [], longTasks: [],
        input: null, save: { armed: false, closedAt: null, retiredAt: null, done: null }, fs: [] };
    new PerformanceObserver(list => {
        state.longTasks.push(...list.getEntries().map(x => ({ startTime: x.startTime, duration: x.duration })));
    }).observe({ type: 'longtask', buffered: true });
    const shown = element => element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    state.documentPromise = new Promise(resolve => { state.documentResolve = resolve; });
    const observeDocument = () => {
        let previousBox = null, stable = 0;
        const tick = t => {
            state.raf.push(t);
            const element = kind === 'pdf' ? document.querySelector('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page canvas') : document.querySelector('.cm-content');
            const content = shown(element) && (kind === 'pdf' ? element.width > 0 && element.height > 0 : element.textContent.includes(expectedText));
            if (content) {
                if (state.firstPixels === null) { state.firstPixels = performance.now(); performance.mark('bme-v08-first-pixels'); }
                const box = element.getBoundingClientRect(), key = `${box.x}/${box.y}/${box.width}/${box.height}`;
                stable = key === previousBox ? stable + 1 : 0; previousBox = key;
                const textReady = kind !== 'pdf' || [...document.querySelectorAll('.pdf-viewer-page .textLayer span')].some(el => el.textContent.trim());
                if (stable >= 1 && textReady && document.fonts.status === 'loaded') {
                    state.readable = performance.now(); performance.mark('bme-v08-readable'); state.documentResolve(); return;
                }
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };
    if (startup && location.pathname !== '/__bench_reset') observeDocument();
    addEventListener('pointerdown', event => {
        if (!state.armOpen || !event.target.closest?.('.tree-item')) return;
        state.armOpen = false; state.openStart = event.timeStamp;
        performance.mark('bme-v08-open-start', { startTime: event.timeStamp }); observeDocument();
    }, true);
    addEventListener('wheel', event => {
        const scroll = state.scroll;
        if (!scroll || !event.target.closest?.('.pdf-viewer-scroll')) return;
        scroll.lastInput = performance.now();
        if (scroll.started) return;
        scroll.started = true; scroll.start = event.timeStamp;
        const tick = t => {
            scroll.times.push(t);
            if (scroll.finish && performance.now() - scroll.lastInput >= 250) {
                scroll.end = performance.now(); scroll.resolve();
            } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, { capture: true, passive: true });
    addEventListener('keydown', event => {
        const input = state.input;
        if (!input?.armed || !event.target.closest?.('.cm-content')) return;
        input.armed = false; input.key = event.key; input.start = event.timeStamp;
        performance.mark('bme-v08-keydown');
        const tick = () => {
            const text = document.querySelector('.cm-content')?.textContent;
            if (text !== input.beforeText) requestAnimationFrame(() => {
                input.end = performance.now(); input.afterText = text;
                input.resolve({ start: input.start, end: input.end, key: input.key });
            });
            else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, true);
    addEventListener('keyup', event => {
        if (state.input?.key === event.key) performance.mark('bme-v08-keyup');
    }, true);
    const complete = () => {
        if (state.save.armed && state.save.closedAt !== null && (!drop || state.save.retiredAt !== null)) {
            state.save.done = Math.max(state.save.closedAt, state.save.retiredAt ?? 0);
            performance.mark('bme-v08-save-complete'); state.save.resolve?.(state.save.done);
        }
    };
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const stream = await createWritable.apply(this, args), name = this.name, close = stream.close;
        stream.close = async function (...closeArgs) {
            const result = await close.apply(this, closeArgs);
            if (state.save.armed && name === target) {
                state.save.closedAt = performance.now(); state.fs.push({ op: 'close', name, t: state.save.closedAt }); complete();
            }
            return result;
        };
        return stream;
    };
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (name, ...args) {
        const result = await remove.call(this, name, ...args);
        if (state.save.armed && this.name === '.Assets' && name === 'save-only.png') {
            state.save.retiredAt = performance.now(); state.fs.push({ op: 'remove', name, t: state.save.retiredAt }); complete();
        }
        return result;
    };
}
export function inputPromise() {
    return new Promise(resolve => {
        window.__v08.input = { armed: true, beforeText: document.querySelector('.cm-content')?.textContent, resolve };
    });
}
export function savePromise() {
    return new Promise(resolve => { window.__v08.save.armed = true; window.__v08.save.resolve = resolve; });
}
export function hookSnapshot() {
    const root = window.__perf;
    if (!root) return { applicable: false, reason: 'Production build has no C9 hooks' };
    const plain = value => JSON.parse(JSON.stringify(value, (_key, x) => typeof x === 'function' ? undefined : x));
    return { applicable: true, plant: root.plant, vault: root.vault?.reports?.() ?? [],
        editor: root.editor ? plain(root.editor) : null, tree: root.tree ? plain(root.tree) : null,
        graph: root.graph ? plain(root.graph) : null };
}
