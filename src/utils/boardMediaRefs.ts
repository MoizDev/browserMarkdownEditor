export type BoardMediaRefsResult = { ok: true; names: string[] } | { ok: false; reason: 'unreadable' | 'unknown-format' };

type Frame = {
  kind: 'object' | 'array';
  state: 'first' | 'key' | 'colon' | 'value' | 'after';
  key: string;
  role: 'root' | 'document' | 'store' | 'records' | 'record' | 'other';
  type?: string;
  id?: string;
  file?: string;
  fileSeen?: boolean;
  count?: number;
};

/** A bounded lexical walk, not a board-model import. Unknown fields are scanned too: a newer
 * record may be the only thing keeping an asset alive. A malformed or ambiguous document fails
 * closed so the retirement caller keeps everything. Memory depends on nesting and the supplied
 * asset-name list, not on the size of a stroke, data URL, or the file. */
export async function boardMediaRefs(source: Uint8Array | ReadableStream<Uint8Array>, assetNames: ReadonlySet<string>): Promise<BoardMediaRefsResult> {
  const names = new Set<string>();
  const byHash = new Map<string, string[]>();
  let maxName = 0;
  for (const name of assetNames) {
    maxName = Math.max(maxName, name.length);
    const match = /^([0-9a-f]{64})\./u.exec(name);
    if (match) {
      const list = byHash.get(match[1]) ?? [];
      list.push(name);
      byHash.set(match[1], list);
    }
  }
  // A file-system component is normally far shorter. Refuse exceptionally long candidates
  // rather than silently failing to protect a name that the caller could actually retire.
  if (maxName > 65536) return { ok: false, reason: 'unreadable' };
  const captureLimit = Math.max(1024, maxName + 32);
  const stack: Frame[] = [];
  let rootDone = false, rootFormat: string | undefined, formatSeen = false;
  let documentSeen = false, storeSeen = false, recordsSeen = false, endSeen = false, recordCount = 0;
  let mode: 'normal' | 'string' | 'escape' | 'unicode' | 'atom' = 'normal';
  let token = '', overflow = false, unicode = '', isKey = false;
  let tail: string[] = [], tailCursor = 0;
  let hexRun = '', hexFirst = '', hexLength = 0;
  let atom = '';
  function fail(): never { throw new Error('Invalid or ambiguous board JSON'); }
  const frame = (): Frame => stack[stack.length - 1];
  const scanHash = (hash: string) => { for (const name of byHash.get(hash) ?? []) names.add(name); };
  const finishHex = () => {
    const parent = stack[stack.length - 1];
    // A media record's own hash does not resolve to the hash filename when `file` names
    // a displaced copy. Resolve that one at object close, after seeing both fields.
    if (!(!isKey && parent?.role === 'record' && parent.key === 'id') && hexLength >= 64) {
      scanHash(hexFirst); scanHash(hexRun);
    }
    hexRun = ''; hexFirst = ''; hexLength = 0;
  };
  const char = (ch: string) => {
    if (token.length < captureLimit) token += ch;
    else overflow = true;
    if (tail.length < captureLimit) tail.push(ch);
    else { tail[tailCursor] = ch; tailCursor = (tailCursor + 1) % captureLimit; }
    const code = ch.charCodeAt(0);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) {
      hexLength = Math.min(65, hexLength + 1);
      if (hexLength <= 64) hexFirst += ch;
      hexRun = (hexRun + ch).slice(-64);
    } else finishHex();
  };
  const scanValue = (value: string, truncated: boolean) => {
    finishHex();
    if (!truncated && assetNames.has(value)) names.add(value);
    const candidate = truncated ? tail.slice(tailCursor).join('') + tail.slice(0, tailCursor).join('') : value;
    const basename = candidate.slice(Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\')) + 1);
    const withoutQuery = basename.split(/[?#]/u, 1)[0];
    if (assetNames.has(basename)) names.add(basename);
    if (assetNames.has(withoutQuery)) names.add(withoutQuery);
    try {
      const decoded = decodeURIComponent(withoutQuery);
      if (assetNames.has(decoded)) names.add(decoded);
    } catch { /* A literal percent is a valid filename too. */ }
  };
  const endValue = () => {
    if (!stack.length) { if (rootDone) fail(); rootDone = true; return; }
    const parent = frame();
    if (parent.state !== 'value') fail();
    parent.state = 'after';
  };
  const startContainer = (kind: 'object' | 'array') => {
    if (stack.length >= 128) fail();
    let role: Frame['role'] = 'other';
    if (!stack.length) {
      if (rootDone || kind !== 'object') fail();
      role = 'root';
    } else {
      const parent = frame();
      if (parent.state !== 'value') fail();
      if (parent.role === 'root' && parent.key === 'format') { if (formatSeen) fail(); formatSeen = true; }
      if (parent.role === 'root' && parent.key === 'document' && kind === 'object') { if (documentSeen) fail(); documentSeen = true; role = 'document'; }
      else if (parent.role === 'document' && parent.key === 'store' && kind === 'object') { storeSeen = true; role = 'store'; }
      else if (parent.role === 'root' && parent.key === 'records' && kind === 'array') { if (recordsSeen) fail(); recordsSeen = true; role = 'records'; }
      else if (parent.role === 'records') { if (kind !== 'object' || endSeen) fail(); role = 'record'; }
    }
    stack.push({ kind, state: 'first', key: '', role });
  };
  const endContainer = (kind: 'object' | 'array') => {
    const item = stack.pop();
    if (!item || item.kind !== kind || (item.state !== 'first' && item.state !== 'after')) fail();
    if (item.role === 'record') {
      if (!item.type) fail();
      if (item.type === 'end') { if (item.count !== recordCount) fail(); endSeen = true; }
      else recordCount++;
    }
    if (item.role === 'record' && item.type !== 'media' && item.id) {
      const runs = item.id.match(/[0-9a-f]{64,}/gu) ?? [];
      for (const run of runs) { scanHash(run.slice(0, 64)); scanHash(run.slice(-64)); }
    }
    if (item.role === 'record' && item.type === 'media') {
      if (!item.id || !/^sha256:[0-9a-f]{64}$/u.test(item.id)) fail();
      if (item.fileSeen && item.file !== undefined) {
        if (!item.file || item.file === '.' || item.file === '..' || /[/\\]/u.test(item.file)) fail();
        names.add(item.file);
      } else if (item.id?.startsWith('sha256:')) scanHash(item.id.slice(7));
    }
    endValue();
  };
  const stringValue = () => {
    const value = token;
    if (isKey) {
      if (overflow || !stack.length || frame().kind !== 'object' || !['first', 'key'].includes(frame().state)) fail();
      scanValue(value, false);
      frame().key = value; frame().state = 'colon';
    } else {
      if (!stack.length || frame().state !== 'value') fail();
      const parent = frame();
      scanValue(value, overflow);
      if (parent.role === 'root' && parent.key === 'format') {
        if (formatSeen || overflow) fail();
        formatSeen = true; rootFormat = value;
      }
      if (parent.role === 'record') {
        if (parent.key === 'type') { if (parent.type !== undefined || overflow) fail(); parent.type = value; }
        if (parent.key === 'id') { if (parent.id !== undefined || overflow) fail(); parent.id = value; }
        if (parent.key === 'file') { if (parent.fileSeen || overflow) fail(); parent.fileSeen = true; parent.file = value; }
      }
      endValue();
    }
    token = ''; tail = []; tailCursor = 0; overflow = false; hexRun = ''; hexFirst = ''; hexLength = 0;
  };
  const finishAtom = () => {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(atom)) fail();
    if (!stack.length || frame().state !== 'value') fail();
    const parent = frame();
    if (parent.role === 'root' && parent.key === 'format') { if (formatSeen) fail(); formatSeen = true; }
    if (parent.role === 'record' && parent.key === 'count') {
      if (parent.count !== undefined || !/^(?:0|[1-9]\d*)$/u.test(atom) || !Number.isSafeInteger(Number(atom))) fail();
      parent.count = Number(atom);
    }
    if (parent.role === 'record' && parent.key === 'file') {
      if (parent.fileSeen || atom !== 'null') fail();
      parent.fileSeen = true;
    }
    atom = ''; mode = 'normal'; endValue();
  };
  const consume = (input: string) => {
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (mode === 'string') {
        if (ch === '"') { mode = 'normal'; stringValue(); }
        else if (ch === '\\') mode = 'escape';
        else { if (ch.charCodeAt(0) < 32) fail(); char(ch); }
        continue;
      }
      if (mode === 'escape') {
        if (ch === 'u') { unicode = ''; mode = 'unicode'; }
        else {
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!Object.hasOwn(escapes, ch)) fail();
          char(escapes[ch]); mode = 'string';
        }
        continue;
      }
      if (mode === 'unicode') {
        if (!/^[0-9a-fA-F]$/u.test(ch)) fail();
        unicode += ch;
        if (unicode.length === 4) { char(String.fromCharCode(parseInt(unicode, 16))); mode = 'string'; }
        continue;
      }
      if (mode === 'atom') {
        if (/^[a-zA-Z0-9+.-]$/u.test(ch)) { if (atom.length >= 128) fail(); atom += ch; continue; }
        finishAtom(); i--; continue;
      }
      if (/^[ \t\r\n]$/u.test(ch)) continue;
      if (rootDone) fail();
      if (!stack.length) { if (ch !== '{') fail(); startContainer('object'); continue; }
      const parent = frame();
      if (parent.kind === 'object') {
        if (parent.state === 'colon') { if (ch !== ':') fail(); parent.state = 'value'; continue; }
        if (parent.state === 'first' || parent.state === 'key') {
          if (ch === '}' && parent.state === 'first') { endContainer('object'); continue; }
          if (ch !== '"') fail();
          isKey = true; token = ''; tail = []; tailCursor = 0; overflow = false; mode = 'string'; continue;
        }
        if (parent.state === 'after') {
          if (ch === '}') { endContainer('object'); continue; }
          if (ch !== ',') fail(); parent.state = 'key'; continue;
        }
      } else {
        if (parent.state === 'after') {
          if (ch === ']') { endContainer('array'); continue; }
          if (ch !== ',') fail(); parent.state = 'value'; continue;
        }
        if (parent.state === 'first') {
          if (ch === ']') { endContainer('array'); continue; }
          parent.state = 'value';
        }
      }
      if (parent.state !== 'value') fail();
      if (parent.role === 'records' && ch !== '{') fail();
      if (ch === '{' || ch === '[') { startContainer(ch === '{' ? 'object' : 'array'); continue; }
      if (ch === '"') { isKey = false; token = ''; tail = []; tailCursor = 0; overflow = false; mode = 'string'; continue; }
      if (/^[tfn\-0-9]$/u.test(ch)) { atom = ch; mode = 'atom'; continue; }
      fail();
    }
  };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (source instanceof Uint8Array) {
      for (let at = 0; at < source.length; at += 65536) consume(decoder.decode(source.subarray(at, at + 65536), { stream: true }));
    } else {
      const reader = source.getReader();
      let finished = false;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) { finished = true; break; }
          if (!(part.value instanceof Uint8Array)) fail();
          for (let at = 0; at < part.value.length; at += 65536) consume(decoder.decode(part.value.subarray(at, at + 65536), { stream: true }));
        }
      } finally {
        if (!finished) { try { await reader.cancel(); } catch { /* The source already failed. */ } }
        reader.releaseLock();
      }
    }
    consume(decoder.decode());
    if ((mode as string) === 'atom') finishAtom();
    if (mode !== 'normal' || !rootDone || stack.length) fail();
    // The native marker wins even when the compatibility document appeared first.
    if (formatSeen) return rootFormat === 'board' && recordsSeen && endSeen ? { ok: true, names: [...names] } : { ok: false, reason: 'unknown-format' };
    return documentSeen && storeSeen ? { ok: true, names: [...names] } : { ok: false, reason: 'unknown-format' };
  } catch { return { ok: false, reason: 'unreadable' }; }
}
