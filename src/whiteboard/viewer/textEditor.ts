import type { Affine, Rect, Viewport } from '../../platform/types';
import type { CameraController } from '../../platform/render/camera';
import { cameraTransform, surfaceToWorld } from '../../platform/render/camera';
import { pageAt } from '../../platform/render/pageStack';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import { worldPose } from '../change/coordinates';
import type { Op, Transaction } from '../change/ops';
import type { HistoryStepInfo, TextSelectionSnapshot } from '../change/historyTypes';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { compose, inverse, transformPoint } from '../geom/affine';
import { transformBox } from '../geom/bounds';
import { figureLabelRequest } from '../geom/providers';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack, pageOrigin, reanchorPage } from '../model/pages';
import { prepareBoardVectorGeometryNow } from '../render/vectorGeometry';
import { colourCss } from '../render/colour';
import type { createBoardRenderServices } from '../render/services';
import { textCreation } from '../text/edit/createText';
import { createTextEditGrowth } from '../text/edit/growth';
import type { EditSelection } from '../text/edit/host';
import { createTextInputBridge } from '../text/edit/inputBridge';
import { createTextEditingManager } from '../text/edit/manager';
import type { TextEditViewServices } from '../text/edit/bindingTypes';
import { editableTextRequest } from '../text/edit/request';
import type { FaceTable, TextLayoutRequest, TextPaint } from '../text/paint';
import type { BoardSpellClient } from '../text/spell/client';
import { SpellingMenuRequest, type Misspelling, type SpellMenuRows } from '../text/spell/menu';
import { validUserWord } from '../text/spell/dictionary';
import { spellingAtOffset, visibleSpellingPaths } from '../text/spell/visible';
import { EMPTY_RICH_TEXT, sliceRichText, spliceRichText, type RichFragment, type RichText } from '../text/richText';
import type { FragmentSnapshotOptions } from '../text/fragmentSnapshot';
import { insertionFragment, linkRangeAt, plain } from '../text/richOperations';
import type { ViewerEngine } from './types';
import type { BoardPreview } from './preview';
import type { createBoardPointQuery } from './pointQuery';
import { isCancellation } from '../../platform/workers/envelope';

export interface BoardTextEditorOptions {
    /** The node whose text is being edited, or null: its paint is exact while the editor holds it. */
    readonly editingChanged?: (id: NodeId | null) => void;
    readonly runtime: BoardRuntime;
    readonly render: ReturnType<typeof createBoardRenderServices>;
    readonly engine: ViewerEngine;
    readonly preview: BoardPreview;
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hit'>;
    readonly camera: CameraController;
    readonly viewport: () => Viewport;
    readonly overlay: HTMLElement;
    readonly current: () => boolean;
    readonly interaction: { invalidate(): void; cameraChanged(): void };
    readonly inputFrames: { schedule(callback: () => void): () => void };
    readonly mac: boolean;
    readonly onError: (error: unknown) => void;
    /** App-wide persisted dictionary; its owner also propagates cross-window changes. */
    readonly spelling: { words(): readonly string[]; subscribe(listener: () => void): () => void; add(word: string): void };
    /** App-owned UI, never geometry or transaction authorities. */
    readonly ui: {
        menu(x: number, y: number): void;
        spellingMenu(x: number, y: number, rows: SpellMenuRows | null): void;
        openLink(url: string): void;
        /** Opens the directional neighbour of the edited note once its own edit has committed. */
        stickyNeighbour?(direction: 'left' | 'right' | 'up' | 'down'): boolean;
        command(name: string, selection: EditSelection): void;
        selectionChanged(node: NodeId | null, selection: EditSelection | null): void;
        touchHandles(show: boolean): void;
        reducedMotion(): boolean;
        dynamicTextSize(): boolean;
    };
}
type ConnectorMetrics = { readonly anchorWorld: { x: number; y: number }; readonly bodyLength: number };
const svgNS = 'http://www.w3.org/2000/svg';
function transformObject(m: Affine) { return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; }
const frameNames = new WeakMap<Readonly<Node>, RichText>();
function nodeText(node: Readonly<Node>): RichText | null {
    if (node.kind === 'text' || node.kind === 'sticky') return node.text;
    if (node.kind === 'figure' || node.kind === 'connector') return node.label ?? EMPTY_RICH_TEXT;
    if (node.kind !== 'frame') return null;
    let value = frameNames.get(node);
    if (!value) {
        value = { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: node.name, marks: {} }] }] };
        frameNames.set(node, value);
    }
    return value;
}
function poseMatrix(runtime: BoardRuntime, id: NodeId): Affine {
    const pose = worldPose(runtime.session.doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
function translated(m: Affine, x: number, y: number, scale = 1): Affine { return compose(m, [scale, 0, 0, scale, x, y]); }

export function createBoardTextEditor(options: BoardTextEditorOptions) {
    const { runtime, render, engine, preview, camera, overlay } = options, session = runtime.session, doc = session.doc;
    if (engine.session !== session) throw new Error('Text editing needs the existing board session');
    let disposed = false, active: NodeId | null = null, paint: TextPaint | null = null, faces: FaceTable | null = null;
    let currentWorld: Affine | null = null, handles = false, scroll: { x: number; y: number } | null = null;
    let editingEpoch = 0, ownBaseRevision = -1;
    const metrics = new Map<NodeId, { revision: number; font: number; value: ConnectorMetrics }>();
    // The stale metrics a refresh is already preparing (id:revision:font), so a frame that reads one again starts no second prepare.
    const refreshing = new Set<string>();
    let svg: SVGSVGElement | null = null, toolbar: HTMLElement | null = null, lastZoom = camera.camera.z;
    let spell: BoardSpellClient | null = null, spellLoad: Promise<BoardSpellClient> | null = null;
    let misspellings: readonly Misspelling[] = [], spellGeneration = 0;
    let spellSource: RichText | null = null, spellNode: NodeId | null = null;
    let spellTimer: ReturnType<typeof setTimeout> | null = null;
    let spellingMenu: SpellingMenuRequest | null = null;
    const checkSpelling = () => {
        const id = active, node = id && doc.nodes.get(id), value = node && nodeText(node);
        if (!id || !value || (spellNode === id && spellSource === value)) return;
        spellNode = id; spellSource = value;
        const generation = ++spellGeneration;
        if (spellTimer !== null) clearTimeout(spellTimer);
        misspellings = [];
        spellLoad ??= import('../text/spell/client').then(({ BoardSpellClient }) => {
            if (disposed) throw new DOMException('Text editor disposed', 'AbortError');
            return spell = new BoardSpellClient(options.spelling.words());
        }).catch(error => { spellLoad = null; throw error; });
        const loading = spellLoad;
        void loading.catch(() => {});
        spellTimer = setTimeout(() => {
            spellTimer = null;
            void loading.then(client => {
                if (disposed || active !== id || generation !== spellGeneration) return;
                const text = value.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
                client.check(text, ranges => {
                    if (active !== id || generation !== spellGeneration) return;
                    misspellings = ranges; requestFrame();
                }, error => { spellSource = null; report(error); }, 0);
            }).catch(error => { spellSource = null; if (!disposed) report(error); });
        }, 300);
    };
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
    Object.assign(live.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)' });
    overlay.append(live);
    const report = (error: unknown) => { try { options.onError(error); } catch { /* reporting cannot interrupt cleanup */ } };
    const replaceMisspelling = (range: Misspelling & { readonly revision: number; readonly node: NodeId }, suggestion: string): boolean => {
        const editor = manager.current?.editor, node = active && doc.nodes.get(active), text = node && nodeText(node);
        if (!editor || !text || active !== range.node || doc.rev !== range.revision || plain(text).slice(range.from, range.to) !== range.word) return false;
        const fragment = insertionFragment(text, range.from, suggestion, null);
        editor.restoreSelection({ anchor: range.from, focus: range.to });
        const applied = editor.replaceSelection(fragment); editor.focus();
        return applied;
    };
    const openTextMenu = (x: number, y: number) => {
        spellingMenu?.cancel(); spellingMenu = null;
        const editor = manager.current?.editor, node = active;
        if (!editor || !node) { options.ui.menu(x, y); return; }
        const offset = editor.offsetAtClient(x, y), range = spellingAtOffset(misspellings, offset, true);
        if (!range) { options.ui.menu(x, y); return; }
        const revision = doc.rev;
        const request = new SpellingMenuRequest({
            revision: () => doc.rev,
            suggest: word => spell ? spell.suggest(word) : Promise.resolve([]),
            canAdd: validUserWord,
            add: word => { options.spelling.add(word); manager.current?.editor.focus(); },
            replace: (match, suggestion) => { replaceMisspelling({ ...match, revision, node }, suggestion); },
            open: rows => options.ui.spellingMenu(x, y, rows),
        });
        spellingMenu = request;
        void request.open(range).catch(report);
    };
    const current = () => !disposed && options.current() && engine.getView().visible;
    const requestFrame = () => options.interaction.invalidate();
    const stopDictionary = options.spelling.subscribe(() => {
        spellSource = null; spellGeneration++;
        const words = options.spelling.words();
        misspellings = [];
        if (spellTimer !== null) { clearTimeout(spellTimer); spellTimer = null; }
        spellingMenu?.cancel();
        spellingMenu = null;
        options.ui.spellingMenu(0, 0, null);
        requestFrame();
        if (spell) void spell.setDictionary(words).then(checkSpelling, report);
        else checkSpelling();
    });
    const clientMatrix = (world: Affine): Affine => {
        const bounds = overlay.getBoundingClientRect(), vp = options.viewport();
        if (!(bounds.width > 0 && bounds.height > 0 && vp.width > 0 && vp.height > 0)) throw new Error('Text overlay has no viewport');
        return compose([bounds.width / vp.width, 0, 0, bounds.height / vp.height, bounds.left, bounds.top], compose(cameraTransform(camera.camera), world));
    };
    const clientWorld = (x: number, y: number) => {
        const bounds = overlay.getBoundingClientRect(), vp = options.viewport();
        if (!(bounds.width > 0 && bounds.height > 0)) throw new Error('Text overlay has no viewport');
        return surfaceToWorld({ x: (x - bounds.left) * vp.width / bounds.width, y: (y - bounds.top) * vp.height / bounds.height }, camera.camera);
    };
    const worldClient = (x: number, y: number) => transformPoint(clientMatrix([1, 0, 0, 1, 0, 0]), { x, y });
    const metric = (node: Readonly<Node>): ConnectorMetrics | undefined => {
        if (node.kind !== 'connector') return undefined;
        let entry = metrics.get(node.id);
        if (entry && active === node.id && entry.revision === ownBaseRevision && doc.rev === ownBaseRevision + 1
            && entry.font === render.text.fonts.epoch) {
            entry = { ...entry, revision: doc.rev }; metrics.set(node.id, entry); ownBaseRevision = -1;
        }
        if (!entry) throw new Error('Connector text geometry is not ready');
        // Behind the document or the fonts (the label's first character loads its face: the font epoch moves, and the frame that load
        // asks for can come before the refresh it started): the last metrics serve until the refresh lands and lays the label out again.
        // Thrown here, the editor's overlay write failed inside the frame and the board closed ('Could not open canvas'; on WebGL2
        // earlier, the pane fell back to canvas2d on the compositor's invalid-input): kinds kit arrow-label, DPR 2 dark, 2 of 6 runs.
        if (entry.revision !== doc.rev || entry.font !== render.text.fonts.epoch) {
            const key = `${node.id}:${doc.rev}:${render.text.fonts.epoch}`;
            if (!refreshing.has(key)) { refreshing.add(key); refreshConnector(node.id, () => refreshing.delete(key)); }
        }
        return entry.value;
    };
    const request = (node: Readonly<Node>, text: RichText, serial: number): TextLayoutRequest => {
        const connector = metric(node);
        return editableTextRequest(node, text, { revision: `edit:${node.id}:${doc.rev}:${serial}`, fontEpoch: render.text.fonts.epoch,
            zoom: 1, ...(connector ? { connectorLength: connector.bodyLength } : {}) });
    };
    const placement = (node: Readonly<Node>, result: TextPaint): Affine => {
        if (node.kind === 'connector') {
            const value = metric(node)!;
            return [1, 0, 0, 1, value.anchorWorld.x - result.box.w / 2, value.anchorWorld.y - result.box.h / 2];
        }
        const world = poseMatrix(runtime, node.id);
        if (node.kind === 'frame') return translated(world, 0, -result.box.h);
        if (node.kind === 'figure') {
            const label = figureLabelRequest({ ...node, label: node.label ?? EMPTY_RICH_TEXT }, 'edit-placement', result.fontEpoch)!;
            return translated(world, label.x, label.y);
        }
        if (node.kind === 'text' || node.kind === 'sticky') return translated(world, 0, 0, node.scale);
        throw new Error('Node has no text placement');
    };
    const prepareMetric = async (id: NodeId, signal: AbortSignal): Promise<void> => {
        const node = doc.nodes.get(id); if (!node) throw new Error('Text node is unavailable');
        if (node.kind !== 'connector') return;
        const rev = doc.rev, font = render.text.fonts.epoch, old = metrics.get(id);
        if (old && old.revision === rev && old.font === font) return;
        const value = await render.prepareForPick(node, signal); signal.throwIfAborted();
        if (!current() || doc.rev !== rev || render.text.fonts.epoch !== font || !value.connector?.editMetrics) throw new DOMException('Connector text geometry changed', 'AbortError');
        metrics.set(id, { revision: rev, font, value: value.connector.editMetrics });
    };
    const stagedNode = (id: NodeId, transaction: Transaction): Node | null => {
        let node = doc.nodes.get(id); if (!node) return null;
        for (const op of transaction.ops) {
            if (op.t === 'delete' && op.id === id) return null;
            if (op.t === 'set' && op.id === id) node = { ...node, [op.key]: op.value } as Node;
            else if (op.t === 'splice' && op.id === id) {
                const old = op.key === 'text' && (node.kind === 'text' || node.kind === 'sticky') ? node.text
                    : op.key === 'label' && (node.kind === 'figure' || node.kind === 'connector') ? node.label ?? EMPTY_RICH_TEXT : null;
                if (old) node = { ...node, [op.key]: spliceRichText(old, op.from, op.to, op.insert, op.wholeBlocks === true || op.replaceBlocks === true).text } as Node;
            }
        }
        return node;
    };
    const prepareTransaction = (id: NodeId, transaction: Transaction): Transaction => {
        ownBaseRevision = doc.rev;
        let result = createTextEditGrowth(doc, id, render.text.layout, (node, text) => request(node, text, 0))(transaction);
        const node = stagedNode(id, result);
        if (!node || (node.kind !== 'text' && node.kind !== 'sticky' && node.kind !== 'figure') || doc.host.kind === 'whiteboard') return result;
        const geometry = prepareBoardVectorGeometryNow(node, { text: render.text, revision: `edit-growth:${doc.rev}`, zoom: 1 });
        const rect = geometry.selectBoundsLocal, m = poseMatrix(runtime, id), output = new Float64Array(4);
        transformBox(output, 0, [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height], 0, m, 0);
        const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, output[3]) : undefined;
        const ops: Op[] = [...result.ops];
        if (growth) ops.push(growth);
        if (isSheetParent(doc, node.parent) && node.page >= 0) {
            const host = doc.host.kind === 'notebook' && growth && growth.key === 'host.paper' ? { ...doc.host, paper: growth.value } : doc.host;
            const stack = boardPageStack(host);
            const moved = stack && reanchorPage(stack, { page: node.page, x: node.x, y: node.y },
                { x: output[0], y: output[1], width: output[2] - output[0], height: output[3] - output[1] });
            if (moved && moved.page !== node.page) {
                ops.push({ t: 'set', id, key: 'page', value: moved.page }, { t: 'set', id, key: 'x', value: moved.x }, { t: 'set', id, key: 'y', value: moved.y });
            }
        }
        result = { ...result, ops }; return result;
    };
    const create = textCreation({ doc, zoom: () => camera.camera.z, dynamicSize: options.ui.dynamicTextSize,
        place(x, y) {
            const parent = runtime.selection.getSnapshot().focus, root = isSheetParent(doc, parent), stack = boardPageStack(doc.host);
            const page = root && stack ? pageAt(stack, y) : -1, origin = page >= 0 && stack ? pageOrigin(stack, page) : undefined;
            const pose = root ? { x: origin?.x ?? 0, y: origin?.y ?? 0, rotation: 0 } : worldPose(doc, parent);
            const dx = x - pose.x, dy = y - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
            const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, y) : undefined;
            return { parent, page, x: c * dx + s * dy, y: -s * dx + c * dy, ...(growth ? { before: [growth] } : {}) };
        } });
    // The edge-scroll step carries no state of its own: stopping the scroll makes a queued step a no-op. The input host
    // may drop a queued callback when input is disabled, so a guard that only that callback clears would stay set and
    // later scroll requests would be skipped (the same fault as the marquee overlay: 11b74174). Requesting again is
    // cheap: the host de-duplicates the same callback reference.
    const stepScroll = () => {
        if (!scroll || !current()) return;
        const rect = overlay.getBoundingClientRect(), margin = 32;
        const dx = scroll.x < rect.left + margin ? scroll.x - rect.left - margin : scroll.x > rect.right - margin ? scroll.x - rect.right + margin : 0;
        const dy = scroll.y < rect.top + margin ? scroll.y - rect.top - margin : scroll.y > rect.bottom - margin ? scroll.y - rect.bottom + margin : 0;
        if (dx || dy) { camera.panBy({ x: Math.max(-24, Math.min(24, dx)), y: Math.max(-24, Math.min(24, dy)) });
            options.interaction.cameraChanged(); manager.refresh(); requestFrame(); scheduleScroll(); }
    };
    const scheduleScroll = () => { if (!scroll || !current()) return; options.inputFrames.schedule(stepScroll); };
    const stopScroll = () => { scroll = null; };
    const manager = createTextEditingManager({ session, createText: create, select: id => runtime.selection.replace([id]), error: report,
        binding(id, key, initialSelection, creationToken) {
            active = id; options.editingChanged?.(id); editingEpoch++; misspellings = []; queueMicrotask(checkSpelling); let latest: TextPaint | null = null;
            const layoutEngine = render.text.layout;
            const view: TextEditViewServices = {
                setSelection(selection) { options.ui.selectionChanged(id, selection); },
                changed(selection) { options.ui.selectionChanged(id, selection); checkSpelling(); requestFrame(); },
                requestChrome: requestFrame, reducedMotion: options.ui.reducedMotion, reportError: report,
                announce(message) { live.textContent = message; },
                compositionFormat() { requestFrame(); },
                command: options.ui.command,
                autoScroll(x, y) { scroll = { x, y }; scheduleScroll(); }, stopAutoScroll: stopScroll,
                touchHandles(value) { handles = value; options.ui.touchHandles(value); requestFrame(); },
                menu: openTextMenu, openLink: options.ui.openLink, stickyNeighbour: direction => stickyNeighbour(direction),
                finish() { stopScroll(); layoutEngine.releaseEditingCache(); spellingMenu?.cancel(); spellingMenu = null; options.ui.spellingMenu(0, 0, null); spellGeneration++; if (spellTimer !== null) clearTimeout(spellTimer); spellTimer = null; spell?.suspend(); misspellings = []; spellSource = null; spellNode = null; if (active === id) { active = null; options.editingChanged?.(null); paint = null; faces = null; currentWorld = null; }
                    options.ui.selectionChanged(null, null); requestFrame(); },
            };
            return { container: overlay, label: 'Edit board text', node: id, key, initialSelection, creationToken,
                mac: options.mac, session, layoutEngine, view,
                request: (node, text, serial) => request(node, text, serial),
                transforms() {
                    const node = doc.nodes.get(id); if (!node || !latest) throw new Error('Text layout is unavailable');
                    const world = placement(node, latest), local = clientMatrix(world), back = inverse(local, 1e12);
                    if (!back) throw new Error('Text transform is not invertible');
                    currentWorld = world; return { localToClient: transformObject(local), clientToLocal: transformObject(back) };
                },
                paintChanged(next, nextFaces) {
                    const node = doc.nodes.get(id); if (!node) throw new Error('Text node is unavailable');
                    latest = paint = next; faces = nextFaces; currentWorld = placement(node, next);
                    preview.showTextPaint(node, next, nextFaces, currentWorld); requestFrame();
                },
                clearPaint() { preview.clear(); paint = null; faces = null; currentWorld = null; requestFrame(); },
                prepareTransaction: transaction => prepareTransaction(id, transaction),
            };
        },
    });
    const controller = new AbortController();
    const editText = async (id: NodeId): Promise<boolean> => {
        if (!current()) return false;
        const revision = doc.rev, generation = ++editingEpoch;
        try { await prepareMetric(id, controller.signal); if (!current() || revision !== doc.rev || generation !== editingEpoch) return false; return manager.start(id); }
        catch (error) { if (!isCancellation(error)) report(error); return false; }
    };
    const routedInput = createTextInputBridge({ manager, selected: () => runtime.selection.getSnapshot().active,
        isCurrent: current, error: report, clientToWorld: clientWorld, worldToClient: worldClient,
        captureHit() {
            const rev = doc.rev, font = render.text.fonts.epoch, cam = { ...camera.camera }, state = runtime.selection.getSnapshot();
            return () => current() && rev === doc.rev && font === render.text.fonts.epoch && camera.camera.x === cam.x && camera.camera.y === cam.y
                && camera.camera.z === cam.z && state.sheet === runtime.selection.getSnapshot().sheet && state.focus === runtime.selection.getSnapshot().focus;
        },
        hitHandle(x, y) {
            if (!handles || !manager.current) return null;
            const chrome = manager.current.editor.chrome(performance.now(), options.ui.reducedMotion(), options.viewport().dpr, { selection: false });
            const a = Math.hypot(x - chrome.handles.anchor.x, y - chrome.handles.anchor.y);
            const b = Math.hypot(x - chrome.handles.focus.x, y - chrome.handles.focus.y);
            if (Math.min(a, b) > 22) return null;
            return a <= b ? 'anchor' : 'focus';
        },
        containsActive(x, y) {
            if (!active || !paint || !currentWorld) return false;
            const back = inverse(clientMatrix(currentWorld), 1e12); if (!back) return false;
            const point = transformPoint(back, { x, y }), box = paint.ink;
            return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
        },
        async locate(x, y, signal) {
            const world = clientWorld(x, y), id = await options.point.hit(world, 'mouse', signal);
            if (!id) return 'blank';
            const node = doc.nodes.get(id), text = node && nodeText(node);
            if (!node || !text) return null;
            await prepareMetric(id, signal);
            const req = request(node, text, 0), textPaint = render.text.layout.layout(req);
            const back = inverse(clientMatrix(placement(node, textPaint)), 1e12); if (!back) throw new Error('Text hit transform is not invertible');
            const local = transformPoint(back, { x, y });
            return { node: id, offset: render.text.layout.caretIndex(req, textPaint).hitTest(local.x, local.y).offset };
        },
    });
    const input = { ...routedInput,
        enter() {
            const id = runtime.selection.getSnapshot().active, node = id && doc.nodes.get(id);
            if (!id || node?.kind !== 'connector') return routedInput.enter();
            void editText(id); return true;
        },
        type(text: string) {
            const id = runtime.selection.getSnapshot().active, node = id && doc.nodes.get(id);
            if (!text || !id || node?.kind !== 'connector') return routedInput.type(text);
            const generation = ++editingEpoch, revision = doc.rev;
            void prepareMetric(id, controller.signal).then(() => {
                if (current() && generation === editingEpoch && doc.rev === revision) manager.type(id, text);
            }, report);
            return true;
        },
    };
    const refreshConnector = (id: NodeId, settled?: () => void) => {
        void prepareMetric(id, controller.signal).then(() => {
            if (current() && active === id && manager.current) { manager.refresh(); requestFrame(); }
        }, error => { if (!isCancellation(error)) report(error); }).finally(settled);
    };
    const stopFonts = render.text.fonts.subscribe(() => {
        if (!active || !manager.current) return;
        if (doc.nodes.get(active)?.kind === 'connector') refreshConnector(active);
        else { manager.refresh(); requestFrame(); }
    });
    const stopSession = session.subscribe(() => {
        if (!active || !manager.current || doc.nodes.get(active)?.kind !== 'connector') return;
        const entry = metrics.get(active);
        if (!entry || entry.revision !== doc.rev || entry.font !== render.text.fonts.epoch) refreshConnector(active);
    });
    const rect = (parent: SVGElement, value: Rect, fill: string, stroke?: string) => {
        const item = document.createElementNS(svgNS, 'rect');
        item.setAttribute('x', String(value.x)); item.setAttribute('y', String(value.y)); item.setAttribute('width', String(Math.max(0, value.width)));
        item.setAttribute('height', String(Math.max(0, value.height))); item.setAttribute('fill', fill); if (stroke) item.setAttribute('stroke', stroke); parent.append(item);
    };
    /** The floating "Text formatting" toolbar (F-TEXT-011/012). Its buttons run the same command bridge as the
     * text menu and the shortcuts; pointerdown is kept from the editor so the selection survives the click. */
    const formatToolbar = (): HTMLElement => {
        if (toolbar) return toolbar;
        const bar = document.createElement('div');
        bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Text formatting'); bar.hidden = true;
        bar.style.cssText = 'position:absolute;left:0;top:0;display:flex;gap:2px;padding:3px;z-index:2;pointer-events:auto;'
            + 'background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:6px;'
            + 'box-shadow:0 2px 8px rgba(0,0,0,0.25);white-space:nowrap;transform:translate(-50%,-100%);';
        const items: readonly (readonly [string, string])[] = [['bold', 'Bold'], ['italic', 'Italic'], ['code', 'Code'], ['link', 'Link'],
            ['bullet-list', 'Bulleted list'], ['highlight', 'Highlight']];
        for (const [name, label] of items) {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = label; button.dataset.command = name;
            button.style.cssText = 'font:inherit;font-size:12px;padding:3px 7px;border:0;border-radius:4px;cursor:pointer;'
                + 'background:transparent;color:var(--text-normal);';
            button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); command(name); });
            bar.append(button);
        }
        overlay.append(bar); toolbar = bar;
        return bar;
    };
    const placeToolbar = (matrix: Affine, viewport: { readonly width: number; readonly height: number }, selection: { readonly anchor: number; readonly focus: number }) => {
        const active_ = manager.current, from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        const rects = active_ && from !== to && !session.isReadOnly ? active_.editor.rangeRects(from, to) : [];
        if (!rects.length) { if (toolbar) toolbar.hidden = true; return; }
        const top = rects.reduce((best, rect) => (rect.y < best.y ? rect : best));
        const point = transformPoint(matrix, { x: top.x + top.width / 2, y: top.y });
        const bounds = overlay.getBoundingClientRect(), bar = formatToolbar();
        if (!(bounds.width > 0 && viewport.width > 0)) { bar.hidden = true; return; }
        const scale = bounds.width / viewport.width;
        bar.style.left = `${point.x * scale}px`; bar.style.top = `${point.y * scale - 8}px`; bar.hidden = false;
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.documentId !== session.owner.documentId || frame.token.session !== session.owner.session
            || !manager.current || !paint || !faces || !currentWorld) { svg?.remove(); svg = null; if (toolbar) toolbar.hidden = true; return; }
        if (lastZoom !== frame.view.camera.z) { lastZoom = frame.view.camera.z; manager.refresh(); }
        const matrix = compose(cameraTransform(frame.view.camera), currentWorld), back = inverse(matrix, 1e12);
        const viewport = frame.view.viewport;
        const corners = back ? [transformPoint(back, { x: 0, y: 0 }), transformPoint(back, { x: viewport.width, y: 0 }),
            transformPoint(back, { x: 0, y: viewport.height }), transformPoint(back, { x: viewport.width, y: viewport.height })] : [];
        const visible = corners.length ? { top: Math.min(...corners.map(point => point.y)), bottom: Math.max(...corners.map(point => point.y)) }
            : { top: Infinity, bottom: -Infinity };
        const chrome = manager.current.editor.chrome(frame.timestamp, options.ui.reducedMotion(), frame.view.viewport.dpr, { visible });
        if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; overlay.append(svg); }
        svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${frame.view.viewport.width} ${frame.view.viewport.height}`);
        const group = document.createElementNS(svgNS, 'g');
        group.setAttribute('transform', `matrix(${matrix.join(' ')})`); svg.append(group);
        const spelling: string[] = []; let spellingStroke = 0;
        for (const item of visibleSpellingPaths(paint, misspellings, matrix, frame.view.viewport,
            (from, to) => manager.current!.editor.rangeRects(from, to))) { spelling.push(item.d); spellingStroke = item.strokeWidth; }
        if (spelling.length) {
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', spelling.join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#e34d4d');
            path.setAttribute('stroke-width', String(spellingStroke)); group.append(path);
        }
        const selection = manager.current.editor.getSelection(), edited = active && doc.nodes.get(active);
        placeToolbar(matrix, viewport, selection);
        const fallbackSwatch = edited?.kind === 'text' ? edited.color
            : edited?.kind === 'sticky' || edited?.kind === 'figure' || edited?.kind === 'connector' ? edited.labelColor
                : edited?.kind === 'frame' ? edited.color ?? 'black' : 'black';
        let caretColour = colourCss(engine.getSnapshot().palette.stroke[fallbackSwatch]);
        outer: for (const line of paint.lines) for (const fragment of line.fragments) {
            if (selection.focus >= fragment.src[0] && selection.focus <= fragment.src[1]) {
                caretColour = colourCss(engine.getSnapshot().palette.stroke[fragment.ink.swatch]);
                break outer;
            }
        }
        for (const item of chrome.selection) rect(group, item, 'color-mix(in srgb, var(--interactive-accent) 30%, transparent)');
        if (chrome.caret) rect(group, chrome.caret, caretColour);
        for (const item of chrome.composition) {
            if (item.style === 'none') continue;
            const unit = 1 / frame.view.camera.z, y = item.rect.y + item.rect.height - unit;
            const stroke = item.thickness === 'thick' ? 2 * unit : unit;
            if (item.style === 'solid') rect(group, { x: item.rect.x, y, width: item.rect.width, height: stroke }, caretColour);
            else {
                const path = document.createElementNS(svgNS, 'path');
                let d = `M ${item.rect.x} ${y}`;
                if (item.style === 'wavy') {
                    for (let x = item.rect.x + 2 * unit, n = 0; x < item.rect.x + item.rect.width; x += 2 * unit, n++)
                        d += ` L ${x} ${y + (n % 2 ? -unit : unit)}`;
                } else d += ` L ${item.rect.x + item.rect.width} ${y}`;
                path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', caretColour);
                path.setAttribute('stroke-width', String(stroke));
                if (item.style === 'dotted') path.setAttribute('stroke-dasharray', `${unit} ${unit}`);
                else if (item.style === 'dashed') path.setAttribute('stroke-dasharray', `${3 * unit} ${2 * unit}`);
                group.append(path);
            }
        }
        if (handles) for (const position of [chrome.handles.anchor, chrome.handles.focus]) {
            const bounds = overlay.getBoundingClientRect(), x = (position.x - bounds.left) * frame.view.viewport.width / bounds.width;
            const y = (position.y - bounds.top) * frame.view.viewport.height / bounds.height;
            const circle = document.createElementNS(svgNS, 'circle'); circle.setAttribute('cx', String(x)); circle.setAttribute('cy', String(y));
            circle.setAttribute('r', '5'); circle.setAttribute('fill', 'var(--interactive-accent)'); svg.append(circle);
        }
    };
    const captureText = (): TextSelectionSnapshot | undefined => {
        if (!active || !manager.current) return undefined;
        const selection = manager.current.editor.getSelection(); return { node: active, anchor: selection.anchor, head: selection.focus };
    };
    const command = (id: string): boolean => {
        const editor = manager.current?.editor;
        if (!current() || !editor || !active || !doc.nodes.has(active) || session.isReadOnly) return false;
        const handled = editor.command(id);
        if (handled && manager.current?.editor === editor && current()
            && id !== 'link' && id !== 'finish' && !id.startsWith('paste-')) editor.focus();
        return handled;
    };
    const stickyNeighbour = (direction: 'left' | 'right' | 'up' | 'down'): boolean => {
        const node = active && doc.nodes.get(active);
        if (!current() || !manager.current || !node || node.kind !== 'sticky' || session.isReadOnly || !options.ui.stickyNeighbour) return false;
        if (!command('finish')) return false;
        return options.ui.stickyNeighbour(direction);
    };
    return { manager, input, editText, writeOverlays, captureText, command, stickyNeighbour,
        selectAll(): boolean {
            const editor = manager.current?.editor;
            if (!current() || !editor || !active || !doc.nodes.has(active)) return false;
            const handled = editor.selectAll();
            if (handled && manager.current?.editor === editor && current()) editor.focus();
            return handled;
        },
        clipboardContext() {
            const editor = manager.current?.editor, node = active && doc.nodes.get(active), text = node && nodeText(node);
            return editor && editor.canEdit() && node && text ? { node, revision: doc.rev, selection: { ...editor.getSelection() }, text } : null;
        },
        clipboardSelection() {
            const editor = manager.current?.editor, node = active && doc.nodes.get(active), transform = currentWorld;
            if (!editor || !editor.canEdit() || !node || !transform) return null;
            const selection = editor.getSelection(), from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
            if (from === to) return null;
            const world = new Float64Array(4);
            let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
            editor.visitRange(from, to, box => {
                transformBox(world, 0, [box.x, box.y, box.x + box.width, box.y + box.height], 0, transform, 0);
                left = Math.min(left, world[0]); top = Math.min(top, world[1]);
                right = Math.max(right, world[2]); bottom = Math.max(bottom, world[3]);
            });
            if (left === Infinity) return null;
            return { revision: doc.rev, node, selection: { ...selection }, fragment: editor.copySelection(),
                bounds: { x: left, y: top, w: right - left, h: bottom - top } };
        },
        linkContext() {
            const editor = manager.current?.editor, node = active && doc.nodes.get(active), text = node && nodeText(node);
            if (!editor || !editor.canEdit() || !node || !text) return null;
            const selection = { ...editor.getSelection() }, from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
            let href: string | null = null, target: EditSelection | undefined;
            if (from === to) {
                const link = linkRangeAt(text, from);
                if (link) { href = link.url; target = { anchor: link.from, focus: link.to }; }
            } else {
                const runs = sliceRichText(text, from, to).blocks.flatMap(block => block.runs).filter(run => run.text.length);
                const first = runs[0]?.marks.link;
                if (first && runs.every(run => run.marks.link === first)) href = first;
            }
            return { node: node.id, revision: doc.rev, selection, href, target };
        },
        applyTextLink(context: { readonly node: NodeId; readonly revision: number; readonly selection: EditSelection; readonly target?: EditSelection }, href: string | null) {
            const editor = manager.current?.editor, selection = editor?.getSelection();
            if (!editor || active !== context.node || doc.rev !== context.revision || !selection
                || selection.anchor !== context.selection.anchor || selection.focus !== context.selection.focus) return false;
            return editor.applyLink(href, context.target ?? context.selection);
        },
        /** Paste is one canonical whole-value set, prepared cooperatively from the captured value. */
        pasteText(fragment: RichFragment, options: FragmentSnapshotOptions): Promise<boolean> {
            const editor = manager.current?.editor;
            return editor ? editor.pasteCooperative(fragment, options) : Promise.resolve(false);
        },
        prepareTextCut(node: NodeId, revision: number, selection: EditSelection) {
            const editor = manager.current?.editor, current = editor?.getSelection();
            if (!editor || active !== node || doc.rev !== revision || !current || current.anchor !== selection.anchor || current.focus !== selection.focus)
                throw new Error('Text selection changed; cut again');
            return editor.prepareCut();
        },
        spellingAt(offset: number) { return spellingAtOffset(misspellings, offset); },
        spellingAtClient(x: number, y: number) {
            const editor = manager.current?.editor;
            if (!editor || !active) return null;
            const offset = editor.offsetAtClient(x, y), range = spellingAtOffset(misspellings, offset);
            return range ? { ...range, revision: doc.rev, node: active } : null;
        },
        async spellingSuggestions(word: string) { return spell ? spell.suggest(word) : []; },
        addSpellingWord(word: string) { options.spelling.add(word); },
        replaceSpelling(range: Misspelling & { readonly revision: number; readonly node: NodeId }, suggestion: string) {
            return replaceMisspelling(range, suggestion);
        },
        restoreText(value: TextSelectionSnapshot) { void prepareMetric(value.node, controller.signal).then(() => { if (current()) manager.start(value.node, { anchor: value.anchor, focus: value.head }); }, report); },
        finishComposition() { manager.close(true); },
        beforeHistoryReplay(step: HistoryStepInfo, _direction: 'undo' | 'redo') {
            if (!manager.current) return true;
            if (session.isGestureActive) return false;
            if (active && !step.touched.has(active)) manager.close();
            return true;
        },
        cancelPending() { editingEpoch++; return input.cancelPending(); },
        dispose() { if (disposed) return; editingEpoch++; controller.abort(); stopFonts(); stopSession(); stopDictionary(); input.flush(); manager.dispose(); stopScroll(); disposed = true; spell?.dispose(); svg?.remove(); toolbar?.remove(); live.remove(); },
    };
}
