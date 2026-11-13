// Preparation only. Invoke under bme-lock build, never under a browser run slot.
// All source patches live in a detached scratch worktree, not the lane's src/.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ROOT, argumentsOf, git, sha256, command, exists, replaceExactly, toolbox, workSite } from './common.mjs';

const options = argumentsOf(process.argv.slice(2), ['base', 'source', 'scratch', 'variant', 'toolbox'], ['base', 'source', 'scratch', 'variant', 'toolbox']);
if (!['clean', 'holds'].includes(options.variant)) throw new Error('Known preparation variants: clean, holds');
const sourceRoot = resolve(options.source), scratch = resolve(options.scratch);
const scratchRoot = '/Users/adham/Developer/bme-impl/scratch/';
if (!sourceRoot.startsWith(scratchRoot) || !scratch.startsWith(scratchRoot) || scratch.startsWith(sourceRoot + '/')) throw new Error('Source and emitted output must be separate scratch paths');
const base = git(ROOT, 'rev-parse', options.base), tools = await toolbox(options.toolbox);
await mkdir(scratch, { recursive: true });
if (!await exists(join(sourceRoot, '.git'))) {
    await command('git', ['worktree', 'add', '--detach', sourceRoot, base], ROOT);
}
if (git(sourceRoot, 'rev-parse', 'HEAD') !== base) throw new Error('Existing scratch source has a different commit');
const file = 'src/components/PdfViewer.tsx', path = join(sourceRoot, file);
const original = git(sourceRoot, 'show', `HEAD:${file}`) + '\n';
const current = await readFile(path, 'utf8');
if (current !== original) throw new Error('Refusing to overwrite a dirty scratch source');
let patched = original;
if (options.variant === 'holds') {
    patched = replaceExactly(patched,
        'const renderLoop = useCallback(async (i: number, st: PageState) => {\n        st.busy = true;',
        'const renderLoop = useCallback(async (i: number, st: PageState) => {\n        const __d1Hold = (window as unknown as { __d1Hold(phase: string, page: number): Promise<void> }).__d1Hold;\n        st.busy = true;');
    patched = replaceExactly(patched,
        'const target = st.want;\n                const page = await getPage(i);',
        'const target = st.want;\n                const page = await getPage(i);\n                await __d1Hold("page", i);');
    patched = replaceExactly(patched,
        'const emphasis = await bindPdfNativeEmphasis(page, ctx, target.emphasis);',
        'const emphasis = await bindPdfNativeEmphasis(page, ctx, target.emphasis);\n                await __d1Hold("bind", i);');
    patched = replaceExactly(patched,
        'st.rendering = target;\n                try {',
        'st.rendering = target;\n                task.onContinue = resume => { void __d1Hold("render", i).then(resume); };\n                try {');
    patched = replaceExactly(patched,
        'probe => { st.renderTask = probe; }, current, !!rect);',
        'probe => { st.renderTask = probe; probe.onContinue = resume => { void __d1Hold("verify", i).then(resume); }; }, current, !!rect);');
    await writeFile(path, patched);
}
const sourceDiff = git(sourceRoot, 'diff', '--', file);
if ((options.variant === 'holds') !== Boolean(sourceDiff)) throw new Error('Prepared hold patch did not change exactly the intended source');
const sourcePatch = sourceDiff ? sourceDiff + '\n' : '';
await writeFile(join(scratch, 'source.patch'), sourcePatch);

// Each scratch worktree gets its own install, never a symlink/shared cache.
if (!await exists(join(sourceRoot, 'node_modules/.package-lock.json'))) await command('npm', ['ci', '--no-audit', '--no-fund'], sourceRoot);
if (await realpath(join(sourceRoot, 'node_modules')) !== join(sourceRoot, 'node_modules')) throw new Error('Scratch dependencies must be an owned install');
const config = join(scratch, 'vite.config.mjs'), dist = join(scratch, 'dist');
// Hidden source maps are external attribution data, not app instrumentation.
await writeFile(config, `import original from ${JSON.stringify(join(sourceRoot, 'vite.config.ts'))};\nexport default {...original,root:${JSON.stringify(sourceRoot)},cacheDir:${JSON.stringify(join(scratch, 'vite-cache'))},optimizeDeps:{...original.optimizeDeps,exclude:[...(original.optimizeDeps?.exclude||[]),'@tldraw/assets/imports.vite']},build:{...original.build,outDir:${JSON.stringify(dist)},emptyOutDir:true,sourcemap:'hidden'}};\n`);
await command(process.execPath, [join(sourceRoot, 'node_modules/vite/bin/vite.js'), 'build', '--config', config, '--mode', 'production'], sourceRoot);
const identity = await tools.buildIdentity({ worktree: sourceRoot, distDir: dist, patch: sourcePatch || undefined });
const prepared = { root: sourceRoot, scratch, mode: 'production', config, distDir: dist,
    identity: { ...identity, configSha256: sha256(await readFile(config)), sourceDiffSha256: sha256(sourcePatch), mode: 'production' },
    base, variant: options.variant, source: { path: file, beforeSha256: sha256(original), afterSha256: sha256(patched) },
    workSite: workSite(patched), toolbox: tools.metadata };
await writeFile(join(scratch, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n');
console.log(JSON.stringify({ prepared: join(scratch, 'prepared.json'), commit: identity.commit, patchSha256: identity.patchSha256, manifestSha256: identity.manifestSha256 }));
