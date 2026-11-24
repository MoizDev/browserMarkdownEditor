import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Interim identity shape matching V-01a. Files are emitted build artefacts, never vault files. */
export async function buildIdentity({ worktree, distDir, patch } = {}) {
    const files = [];
    const walk = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else {
                const bytes = await readFile(path);
                files.push({ path: relative(distDir, path).replaceAll('\\', '/'), sha256: sha256(bytes), bytes: bytes.length });
            }
        }
    };
    if (distDir) await walk(distDir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
    const diff = (await exec('git', ['diff', '--binary', 'HEAD'], { cwd: worktree })).stdout;
    return {
        commit, treeClean: !(await exec('git', ['status', '--porcelain'], { cwd: worktree })).stdout.trim(),
        sourceDiffSha256: sha256(diff), patchSha256: patch ? sha256(await readFile(patch)) : null,
        files, manifestSha256: sha256(JSON.stringify(files)),
    };
}

/** Rules bind a served URL AND an exact anchor count. A missed/drifted anchor is a harness fault,
 * never a silent no-op. Reports retain both byte hashes. Install helper/fault endpoint routes after
 * this binder so their protocol responses are not mistaken for build artefacts. */
export async function bindServedBodies(context, { identity, origin, mode = 'production', rules = [], record = () => {} }) {
    const emitted = new Map((identity?.files ?? []).map(file => [file.path, file]));
    const bodies = [];
    const substitutions = [];
    const failures = [];
    let stopping = false;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await context.route(new RegExp(`^${escape(origin)}/`), async route => {
        try {
            const request = route.request();
            const url = new URL(request.url());
            const response = await route.fetch();
            const bytes = await response.body();
            const originalSha256 = sha256(bytes);
            const path = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
            const emittedFile = emitted.get(path);
            if (mode !== 'dev' && response.status() === 200) {
                if (!emittedFile || emittedFile.sha256 !== originalSha256) throw new Error(`HarnessFault: unbound served body ${url}`);
            }
            let body = bytes;
            let status = response.status();
            const appliedRules = [];
            for (const rule of rules) {
                if (!rule.match({ url, request, body: body.toString('utf8') })) continue;
                const source = body.toString('utf8');
                const anchors = source.split(rule.anchor).length - 1;
                if (anchors !== (rule.anchorCount ?? 1)) throw new Error(`HarnessFault: ${rule.id} anchor count ${anchors}, expected ${rule.anchorCount ?? 1}: ${url}`);
                const changed = await rule.transform(source, url);
                if (typeof changed === 'string') body = Buffer.from(changed);
                else { body = Buffer.from(changed.body); status = changed.status ?? status; }
                const applied = { id: rule.id, url: String(url), at: Date.now(), anchors, originalSha256, substitutedSha256: sha256(body), originalBytes: bytes.length, substitutedBytes: body.length, status };
                appliedRules.push(applied);
            }
            const headers = response.headers();
            delete headers['content-encoding'];
            delete headers['content-length'];
            await route.fulfill({ status, headers, body });
            bodies.push({ url: String(url), path, at: Date.now(), status, originalSha256, servedSha256: sha256(body), bytes: body.length });
            for (const applied of appliedRules) {
                substitutions.push(applied);
                record({ type: 'substitution-applied', ...applied });
            }
        } catch (error) {
            if (stopping || route.request().failure()?.errorText === 'net::ERR_ABORTED') {
                record({ type: 'binding-request-aborted', url: route.request().url(), duringTeardown: stopping });
                return;
            }
            failures.push(String(error));
            record({ type: 'binding-fault', error: String(error) });
            await route.abort().catch(() => {});
        }
    });
    return {
        bodies, substitutions, failures,
        stop() { stopping = true; },
        check() { if (failures.length) throw new Error(failures.join('\n')); },
        requireApplied(id) {
            this.check();
            const applied = substitutions.filter(event => event.id === id);
            if (!applied.length) throw new Error(`HarnessFault: ${id} was not served/applied`);
            return applied;
        },
    };
}
