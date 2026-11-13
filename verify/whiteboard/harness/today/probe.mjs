import { until, frames } from '../runtime.mjs';
import { decodeNodes, normalizeSaved } from '../saved.mjs';
import { assertProbeVersion } from './version.mjs';

// Reference only. This reads the already-mounted editor; no mutation/setter is used.
export function installProbe() {
  if (window !== window.top || !window.__harness) return;
  const state = window.__harness;
  const epoch = crypto.randomUUID();
  const identities = new WeakMap();
  let sequence = 0;
  const fail = (name, detail) => { throw Error(`PROBE_OBJECT_ASSERT ${name}: ${detail}`); };
  const object = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name, 'expected an object');
    return value;
  };
  const text = (value, name) => { if (typeof value !== 'string') fail(name, 'expected a string'); return value; };
  const number = (value, name) => { if (!Number.isFinite(value)) fail(name, 'expected a finite number'); return value; };
  const boolean = (value, name) => { if (typeof value !== 'boolean') fail(name, 'expected a boolean'); return value; };
  const array = (value, name) => { if (!Array.isArray(value)) fail(name, 'expected an array'); return value; };
  const methods = (value, names, prefix) => {
    object(value, prefix);
    for (const name of names) if (typeof value[name] !== 'function') fail(`${prefix}.${name}`, 'expected a function');
  };
  const json = (value, name, depth = 0) => {
    if (depth > 64) fail(name, 'JSON nesting exceeds the observation bound');
    // Optional record properties can be absent in this known schema. Required
    // editor/method/record members are checked separately, never defaulted.
    if (value === null || ['undefined', 'string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number') { number(value, name); return; }
    if (typeof value !== 'object') fail(name, 'expected JSON data, not a missing/member/function value');
    for (const [key, child] of Object.entries(value)) json(child, `${name}.${key}`, depth + 1);
  };
  const box = (value, name) => {
    object(value, name);
    for (const key of ['x', 'y', 'w', 'h']) number(value[key], `${name}.${key}`);
    return value;
  };
  const matrix = (value, name) => {
    object(value, name);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) number(value[key], `${name}.${key}`);
    methods(value, ['applyToPoint'], name);
    return value;
  };
  const record = (value, name) => {
    object(value, name);
    text(value.id, `${name}.id`);
    text(value.typeName, `${name}.typeName`);
    if (value.typeName === 'shape') {
      for (const key of ['type', 'parentId', 'index']) text(value[key], `${name}.${key}`);
      for (const key of ['x', 'y', 'rotation', 'opacity']) number(value[key], `${name}.${key}`);
      boolean(value.isLocked, `${name}.isLocked`);
      object(value.props, `${name}.props`); json(value.props, `${name}.props`);
      object(value.meta, `${name}.meta`); json(value.meta, `${name}.meta`);
    } else if (value.typeName === 'asset' || value.typeName === 'binding') {
      text(value.type, `${name}.type`);
      object(value.props, `${name}.props`); json(value.props, `${name}.props`);
      object(value.meta, `${name}.meta`); json(value.meta, `${name}.meta`);
      if (value.typeName === 'binding') {
        text(value.fromId, `${name}.fromId`); text(value.toId, `${name}.toId`);
      }
    }
    return value;
  };
  const evidence = markers => {
    const required = ['utils', 'state', 'state-react', 'store', 'validate', 'tlschema', 'editor'];
    if (!Array.isArray(markers)) throw Error('PROBE_VERSION_ASSERT: missing fetched-marker evidence');
    for (const name of required) if (!markers.some(marker => marker.package === `@tldraw/${name}` && marker.version === '5.2.4' && typeof marker.url === 'string')) {
      throw Error(`PROBE_VERSION_ASSERT @tldraw/${name}: no checked network marker`);
    }
  };
  const editorMethods = ['getCurrentPageShapes', 'getContainer', 'getCamera', 'getViewportScreenBounds', 'getViewportPageBounds', 'getAsset', 'getShapePageBounds', 'getShapePageTransform', 'getAncestorPageId', 'getSelectedShapeIds', 'getEditingShapeId', 'getCurrentToolId', 'getInstanceState', 'getCurrentPageId', 'getPages', 'getCanUndo', 'getCanRedo', 'getColorMode', 'getCurrentTheme'];
  const owner = fiber => {
    for (let i = 0; fiber && i < 120; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const path = props?.filePath ?? props?.file?.path ?? props?.tab?.file?.path;
      if (typeof path === 'string') return path;
    }
    return undefined;
  };
  const candidate = value => value && typeof value === 'object' && value.store && (value.inputs || value.user);
  state.findEditor = (path, markers) => {
    evidence(markers);
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) throw Error('PROBE_PATH_ASSERT: a vault-relative canvas path is required');
    for (const root of document.querySelectorAll('.tl-container')) {
      const key = Object.keys(root).find(key => key.startsWith('__reactFiber$'));
      if (!key) {
        if (root.querySelector('.tl-canvas')) fail('editor.reactFiber', 'mounted canvas has no expected React binding');
        continue;
      }
      if (owner(root[key]) !== path) continue;
      // A loading container is not an object-shape fault. Once the actual
      // canvas exists, a missing provider/member must not become an empty read.
      if (!root.querySelector('.tl-canvas')) throw Error(`PROBE_NOT_MOUNTED ${path}: canvas is still loading`);
      let editor;
      for (let fiber = root[key], i = 0; fiber && i < 120 && !editor; fiber = fiber.return, i++) {
        if (candidate(fiber.memoizedProps?.value)) editor = fiber.memoizedProps.value;
        for (let dep = fiber.dependencies?.firstContext; dep && !editor; dep = dep.next) if (candidate(dep.memoizedValue)) editor = dep.memoizedValue;
        for (let hook = fiber.memoizedState, j = 0; hook && j < 100 && !editor; hook = hook.next, j++) {
          const value = hook.memoizedState;
          for (const entry of [value, value?.current, ...(Array.isArray(value) ? value : [])]) if (candidate(entry)) { editor = entry; break; }
        }
      }
      if (!editor) fail(`editor(${path})`, 'mounted path-bound canvas has no editor provider');
      methods(editor, editorMethods, 'editor');
      methods(editor.store, ['allRecords', 'getStoreSnapshot'], 'editor.store');
      if (editor.getContainer() !== root) fail(`editor(${path}).getContainer`, 'provider belongs to a different canvas root');
      if (!identities.has(editor)) identities.set(editor, `${epoch}:${++sequence}`);
      return editor;
    }
    throw Error(`PROBE_NOT_MOUNTED ${path}: no canvas bound to that exact document`);
  };
  state.readEditor = (path, operation = 'nodes', markers) => {
    const e = state.findEditor(path, markers);
    if (!['nodes', 'session', 'document', 'identity'].includes(operation) && operation?.kind !== 'handles') fail('operation', 'unknown reference read');
    if (operation === 'identity') return identities.get(e);
    const cam = object(e.getCamera(), 'camera');
    for (const key of ['x', 'y', 'z']) number(cam[key], `camera.${key}`);
    if (cam.z <= 0) fail('camera.z', 'expected a positive zoom');
    const screen = box(e.getViewportScreenBounds(), 'viewport.screen');
    const world = box(e.getViewportPageBounds(), 'viewport.world');
    for (const key of ['maxX', 'maxY']) number(screen[key], `viewport.screen.${key}`);
    const all = array(e.store.allRecords(), 'store.allRecords');
    all.forEach((item, i) => record(item, `store[${i}]`));
    const byId = new Map(all.map(item => [item.id, item]));
    if (byId.size !== all.length) fail('store.allRecords', 'duplicate record ids');
    const bounds = value => value ? { x: value.x, y: value.y, width: value.w, height: value.h } : null;
    const assetAt = id => {
      const asset = record(e.getAsset(text(id, 'assetId')), `asset(${id})`);
      if (asset.typeName !== 'asset' || asset.id !== id) fail(`asset(${id})`, 'wrong referenced asset');
      return asset;
    };
    const pages = all.filter(item => item.typeName === 'shape' && item.type === 'image' && (item.meta.notebookPage !== undefined || item.meta.pdfPage !== undefined)).map(item => {
      const asset = assetAt(item.props.assetId);
      const index = item.meta.notebookPage ?? item.meta.pdfPage;
      number(index, `${item.id}.physicalPage`);
      for (const key of ['w', 'h']) { number(item.props[key], `${item.id}.${key}`); number(asset.props[key], `${asset.id}.${key}`); }
      text(asset.props.mimeType, `${asset.id}.mimeType`); text(asset.props.src, `${asset.id}.src`);
      const image = e.getContainer().querySelector(`[data-shape-id=${JSON.stringify(item.id)}] img`);
      return { index, id: item.id, x: item.x, y: item.y, width: item.props.w, height: item.props.h, locked: item.isLocked, asset: { id: asset.id, width: asset.props.w, height: asset.props.h, mime: asset.props.mimeType, source: asset.props.src, metadata: asset.meta }, raster: image ? { width: image.naturalWidth, height: image.naturalHeight, complete: image.complete, scaleX: image.naturalWidth / item.props.w, scaleY: image.naturalHeight / item.props.h, sourceKind: image.currentSrc.split(':')[0] } : null };
    }).sort((a, b) => a.y - b.y);
    if (operation === 'document') {
      const snapshot = object(e.store.getStoreSnapshot(), 'store.getStoreSnapshot');
      return object(snapshot.store, 'store.getStoreSnapshot.store');
    }
    const selected = array(e.getSelectedShapeIds(), 'selection');
    for (const id of selected) { text(id, 'selection.id'); if (byId.get(id)?.typeName !== 'shape') fail('selection.id', `unknown shape ${id}`); }
    const editing = e.getEditingShapeId();
    if (editing !== null) text(editing, 'editing.id');
    const tool = text(e.getCurrentToolId(), 'currentTool');
    if (operation?.kind === 'handles') {
      if (operation.id !== undefined) text(operation.id, 'handles.requestedId');
      if (operation.id && !selected.includes(operation.id) || editing || tool !== 'select') return [];
      methods(e, ['pageToScreen', 'getShape', 'getShapeHandles'], 'editor');
      methods(e.overlays, ['getCurrentOverlays', 'getOverlayGeometry'], 'editor.overlays');
      const out = [];
      const emit = (role, point, extra = {}) => {
        object(point, 'handle.world'); number(point.x, 'handle.world.x'); number(point.y, 'handle.world.y');
        const css = object(e.pageToScreen(point), 'handle.css'); number(css.x, 'handle.css.x'); number(css.y, 'handle.css.y');
        if (css.x < screen.x || css.y < screen.y || css.x > screen.maxX || css.y > screen.maxY) return;
        out.push({ role, positionWorld: { x: point.x, y: point.y }, positionCSS: { x: css.x, y: css.y }, ...extra });
      };
      if (selected.length === 1) {
        const shape = record(e.getShape(selected[0]), 'handle.shape');
        const transform = matrix(e.getShapePageTransform(shape), 'handle.transform');
        const handles = e.getShapeHandles(shape);
        if (handles !== null && handles !== undefined) for (const handle of array(handles, 'shape.handles')) {
          object(handle, 'shape.handle'); text(handle.type, 'shape.handle.type'); text(handle.id, 'shape.handle.id');
          const kind = shape.type === 'note' ? 'adjacent-note' : ['virtual', 'create'].includes(handle.type) ? 'midpoint' : 'vertex';
          emit(kind, transform.applyToPoint(handle), { id: handle.id, index: handle.index });
        }
      }
      for (const overlay of array(e.overlays.getCurrentOverlays(), 'overlays')) {
        object(overlay, 'overlay'); text(overlay.type, 'overlay.type');
        if (overlay.type !== 'selection_foreground') continue;
        const geometry = e.overlays.getOverlayGeometry(overlay);
        if (geometry === null || geometry === undefined) continue;
        const rectangle = box(object(geometry, 'overlay.geometry').bounds, 'overlay.bounds');
        const props = object(overlay.props, 'overlay.props');
        const type = text(props.overlayType, 'overlay.props.overlayType');
        const name = text(props.handle, 'overlay.props.handle').replace(/_rotate$/, '').replaceAll('_', '-');
        const role = type === 'resize_handle' ? (name.includes('-') ? 'resize-corner/' : 'resize-side/') + name : type === 'rotate_handle' ? 'rotate-corner/' + name : 'rotate-mobile';
        emit(role, { x: rectangle.x + rectangle.w / 2, y: rectangle.y + rectangle.h / 2 }, { id: text(overlay.id, 'overlay.id'), actualOverlay: true });
      }
      return out;
    }
    const mode = text(e.getColorMode(), 'colourMode');
    const theme = object(e.getCurrentTheme(), 'theme');
    const palette = object(object(theme.colors, 'theme.colors')[mode], `theme.colors.${mode}`);
    json(palette, 'palette');
    if (operation === 'session') {
      const instance = object(e.getInstanceState(), 'instance');
      for (const key of ['isPenMode', 'exportBackground', 'isGridMode', 'isFocusMode', 'isDebugMode', 'isToolLocked']) boolean(instance[key], `instance.${key}`);
      object(instance.stylesForNextShape, 'instance.stylesForNextShape'); json(instance.stylesForNextShape, 'instance.stylesForNextShape');
      const input = object(e.inputs, 'editor.inputs');
      for (const key of ['isPointing', 'isPanning', 'isPinching']) boolean(input[key], `inputs.${key}`);
      methods(input, ['getShiftKey', 'getAltKey', 'getCtrlKey', 'getMetaKey'], 'inputs');
      const modifiers = { shift: input.getShiftKey(), alt: input.getAltKey(), ctrl: input.getCtrlKey(), meta: input.getMetaKey() };
      for (const [key, value] of Object.entries(modifiers)) boolean(value, `modifiers.${key}`);
      methods(e.user, ['getUserPreferences'], 'editor.user');
      const preferences = object(e.user.getUserPreferences(), 'preferences'); json(preferences, 'preferences');
      const sheets = array(e.getPages(), 'sheets').map(page => {
        object(page, 'sheet');
        return { id: text(page.id, 'sheet.id'), name: text(page.name, 'sheet.name'), order: text(page.index, 'sheet.index') };
      });
      const currentSheet = text(e.getCurrentPageId(), 'currentSheet');
      if (!sheets.some(sheet => sheet.id === currentSheet)) fail('currentSheet', 'not present in the observed sheet list');
      return {
        camera: { x: -cam.x, y: -cam.y, zoom: cam.z }, viewport: { css: bounds(screen), world: bounds(world) },
        currentTool: ({ draw: 'pen', geo: 'figure', arrow: 'connector', line: 'polyline', note: 'sticky', highlight: 'highlighter' }[tool] || tool),
        penOnly: instance.isPenMode, exportBackground: instance.exportBackground,
        input: { pointing: input.isPointing, panning: input.isPanning, pinching: input.isPinching, modifiers },
        preferences, viewPreferences: { grid: instance.isGridMode, focus: instance.isFocusMode, debug: instance.isDebugMode },
        colourMode: mode, palette, toolLocked: instance.isToolLocked, selection: selected, currentSheet, sheets,
        nextStyles: instance.stylesForNextShape, editing,
        canUndo: boolean(e.getCanUndo(), 'canUndo'), canRedo: boolean(e.getCanRedo(), 'canRedo'), pages, backdrops: pages,
      };
    }
    return all.filter(item => item.typeName === 'shape' && !pages.some(page => page.id === item.id)).map(item => {
      const p = item.props;
      const kind = { draw: 'stroke', highlight: 'stroke', geo: 'figure', note: 'sticky', arrow: 'connector', line: 'polyline', image: 'picture', video: 'clip', bookmark: 'linkcard' }[item.type] || item.type;
      const rectangle = box(e.getShapePageBounds(item), `${item.id}.bounds`);
      const transform = matrix(e.getShapePageTransform(item), `${item.id}.transform`);
      const position = { x: transform.e, y: transform.f };
      const page = pages.find(page => rectangle.y + rectangle.h / 2 >= page.y && rectangle.y + rectangle.h / 2 <= page.y + page.height);
      const asset = p.assetId ? assetAt(p.assetId) : null;
      const bindings = all.filter(binding => binding.typeName === 'binding' && binding.fromId === item.id);
      const attached = terminal => {
        const binding = bindings.find(binding => binding.props.terminal === terminal);
        return binding ? { target: binding.toId, anchor: binding.props.normalizedAnchor, exact: binding.props.isExact, precise: binding.props.isPrecise, snap: binding.props.snap ?? null } : null;
      };
      const plain = node => node.type === 'text' ? node.text : node.type === 'hardBreak' ? '\n' : (node.content || []).map(plain).join(node.type === 'doc' ? '\n' : '');
      const marks = [];
      const walk = (node, trail = []) => {
        object(node, 'richText.node'); text(node.type, 'richText.node.type');
        if (node.type === 'text') { text(node.text, 'richText.text'); marks.push({ text: node.text, marks: node.marks || [], path: trail }); }
        if (node.content) array(node.content, 'richText.content').forEach((child, i) => walk(child, [...trail, i]));
      };
      if (p.richText) walk(p.richText);
      const element = e.getContainer().querySelector(`[data-shape-id=${JSON.stringify(item.id)}]`);
      let paintedText = null;
      if (element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) if (node.textContent.trim()) {
          const parent = node.parentElement, style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
          if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') continue;
          const range = document.createRange(); range.selectNodeContents(parent);
          const rectangles = [...range.getClientRects()].filter(rect => rect.width && rect.height);
          paintedText = { text: parent.textContent, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, direction: style.direction, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, lineCount: new Set(rectangles.map(rect => Math.round(rect.y * 10) / 10)).size, fontLoaded: document.fonts.check(style.fontSize + ' ' + style.fontFamily) };
          break;
        }
      }
      const video = element?.querySelector('video');
      const htmlVideo = video ? { paused: video.paused, currentTime: video.currentTime, muted: video.muted, loop: video.loop, controls: video.controls, autoplay: video.autoplay, duration: Number.isFinite(video.duration) ? video.duration : null, ended: video.ended, readyState: video.readyState } : null;
      return {
        id: item.id, kind, subkind: item.type === 'highlight' ? 'highlighter' : item.type === 'draw' ? 'pen' : null, figure: p.geo ?? null,
        title: p.name ?? null, parent: item.parentId, order: item.index, position, localPosition: { x: item.x, y: item.y },
        size: { width: p.w ?? rectangle.w, height: p.h ?? rectangle.h }, bounds: bounds(rectangle), rotation: item.rotation,
        page: page?.index ?? null, pageLocalPosition: page ? { x: position.x - page.x, y: position.y - page.y } : null,
        sheet: text(e.getAncestorPageId(item), `${item.id}.sheet`), swatch: p.color ?? null, resolvedSwatch: palette[p.color] ?? null,
        width: p.scale ?? null, fill: p.fill ?? null, dash: p.dash ?? null, opacity: item.opacity, font: p.font ?? null,
        textSize: p.size ?? null, alignment: p.textAlign ?? p.align ?? null, verticalAlignment: p.verticalAlign ?? null,
        plainText: p.richText ? plain(p.richText) : p.text ?? null, richMarks: marks, richText: p.richText ?? null, locked: item.isLocked,
        styles: { swatch: p.color, labelSwatch: p.labelColor, fill: p.fill, dash: p.dash, size: p.size, font: p.font, alignment: p.textAlign ?? p.align, verticalAlignment: p.verticalAlign, scale: p.scale, opacity: item.opacity },
        connector: kind === 'connector' ? { start: p.start, end: p.end, startAttachment: attached('start'), endAttachment: attached('end'), startHead: p.arrowheadStart, endHead: p.arrowheadEnd, bend: p.bend, kind: p.kind, labelPosition: p.labelPosition, elbowMidPoint: p.elbowMidPoint ?? null } : null,
        polyline: kind === 'polyline' ? { points: p.points, spline: p.spline } : null,
        ink: kind === 'stroke' ? { segments: p.segments, isPen: p.isPen, isClosed: p.isClosed, isComplete: p.isComplete, scale: p.scale, scaleX: p.scaleX, scaleY: p.scaleY } : null,
        media: asset ? { id: asset.id, mime: asset.props.mimeType, width: asset.props.w, height: asset.props.h, source: asset.props.src, name: asset.props.name, animated: asset.props.isAnimated, size: asset.props.fileSize } : null,
        crop: p.crop ?? null, flipX: p.flipX ?? null, flipY: p.flipY ?? null, altText: p.altText ?? null,
        playback: 'playing' in p ? { isPlaying: p.playing, time: p.time ?? null, autoplay: p.autoplay ?? null } : null,
        htmlVideo, inverted: !!item.meta.inverted, url: p.url ?? null, autoWidth: p.autoSize ?? null, paintedText, metadata: item.meta,
      };
    });
  };
}

export function probeHelpers(h) {
  const { page } = h;
  const settled = new Set();
  const read = async (path, operation) => {
    // Readiness is checked through public DOM before touching the provider.
    if (!await page.locator('.tl-container .tl-canvas').count()) throw Error(`PROBE_NOT_MOUNTED ${path}: no mounted canvas`);
    const evidence = await assertProbeVersion(h);
    return page.evaluate(({ path, operation, evidence }) => window.__harness.readEditor(path, operation, evidence), { path, operation, evidence });
  };
  const fileSnapshot = async path => {
    if (path.endsWith('.pdf')) {
      const pdf = await h.pdf.inspect(await h.vault.read(path, { bytes: true }));
      const attachment = pdf.attachments.find(attachment => attachment.name === 'tldraw-snapshot.json');
      if (!attachment) throw Error(`PROBE_OBJECT_ASSERT saved(${path}): PDF has no editable legacy attachment`);
      return JSON.parse(attachment.bytes.toString('utf8'));
    }
    const value = await h.vault.read(path);
    return value.trim() ? JSON.parse(value) : null;
  };
  const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
  const userRecords = store => Object.values(store).filter(record => !(record.typeName === 'shape' && (record.meta?.pdfPage !== undefined || record.meta?.notebookPage !== undefined)) && !(record.typeName === 'asset' && (record.meta?.pdfPage !== undefined || record.meta?.notebookPaper))).sort((a, b) => a.id.localeCompare(b.id));
  return {
    binding: path => read(path, 'identity'),
    ready: async path => {
      const identity = await until(() => read(path, 'identity'), { timeout: 30000, description: `mounted reference editor ${path}` });
      if (!settled.has(identity)) { await frames(page, 3); settled.add(identity); }
      return read(path, 'session');
    },
    today: async path => { await h.probe.ready(path); return decodeNodes(await read(path, 'nodes')); },
    saved: async path => { const snapshot = await fileSnapshot(path); return snapshot ? normalizeSaved(snapshot) : []; },
    session: async path => { await h.probe.ready(path); return read(path, 'session'); },
    handles: async (path, id) => { await h.probe.ready(path); return read(path, { kind: 'handles', id }); },
    synchronized: async path => {
      const live = await read(path, 'document');
      const saved = await fileSnapshot(path);
      const store = saved?.document?.store ?? saved?.store;
      if (!store || typeof store !== 'object') throw Error(`PROBE_OBJECT_ASSERT saved(${path}).store: missing document store`);
      return canonical(userRecords(live)) === canonical(userRecords(store));
    },
    pending: async () => { throw Error('PROBE_UNAVAILABLE pending: no outside-app debounce observation'); },
    export: async () => { throw Error('PROBE_UNAVAILABLE export: use an actual UI download/capture; private export options are not a parity read-out'); },
    paper: async path => {
      const value = await h.vault.read(path);
      return { paper: value.trim() ? JSON.parse(value).paper : { size: 'letter', orientation: 'portrait', ruling: 'lined', spacing: 24, margin: true, pageCount: 1 }, pages: (await h.probe.session(path)).pages };
    },
    worldToCSS: async (path, point) => { const { camera, viewport } = await h.probe.session(path); return { x: viewport.css.x + (point.x - camera.x) * camera.zoom, y: viewport.css.y + (point.y - camera.y) * camera.zoom }; },
    cssToWorld: async (path, point) => { const { camera, viewport } = await h.probe.session(path); return { x: camera.x + (point.x - viewport.css.x) / camera.zoom, y: camera.y + (point.y - viewport.css.y) / camera.zoom }; },
  };
}
