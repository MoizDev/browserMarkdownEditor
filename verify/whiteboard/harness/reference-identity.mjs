// Build binding for the reference exception; package versions are checked separately.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function referenceIdentity(h, options) {
  if (!options.referenceBuild) return async () => { throw Error('REFERENCE_BUILD_ASSERT: private reference reads require a local build receipt and independently expected commits'); };
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const expected = JSON.parse(await readFile(options.referenceBuild, 'utf8'));
  assert.match(options.expectedReferenceCommit ?? '', /^[0-9a-f]{40}$/, 'REFERENCE_BUILD_ASSERT: expectedReferenceCommit required');
  assert.match(options.expectedHarnessCommit ?? '', /^[0-9a-f]{40}$/, 'REFERENCE_BUILD_ASSERT: expectedHarnessCommit required');
  assert.equal(expected.referenceCommit, options.expectedReferenceCommit, 'REFERENCE_BUILD_ASSERT: wrong archived reference commit');
  assert.equal(git(['rev-parse', 'HEAD']), options.expectedHarnessCommit, 'REFERENCE_BUILD_ASSERT: harness checkout differs from reviewed commit');
  assert.equal(expected.harnessCommit, options.expectedHarnessCommit, 'REFERENCE_BUILD_ASSERT: build was not prepared by this reviewed harness');
  assert.equal(git(['status', '--porcelain', '--', 'verify/whiteboard/harness', 'verify/whiteboard/w-b']), '', 'REFERENCE_BUILD_ASSERT: uncommitted reference harness');
  assert.equal(expected.mode, 'production');
  assert.equal(expected.variant, options.referenceVariant ?? 'reference', 'REFERENCE_BUILD_ASSERT: unexpected source mutant');
  execFileSync('git', ['merge-base', '--is-ancestor', expected.referenceCommit, 'impl/reference'], { cwd: root });
  if (expected.variant === 'pinned-tool') {
    const patchFile = 'verify/whiteboard/harness/mutants/pinned-tool.patch';
    const patch = execFileSync('git', ['show', `${options.expectedHarnessCommit}:${patchFile}`], { cwd: root });
    assert.equal(expected.patchFile, patchFile);
    assert.equal(expected.patchSha256, sha(patch), 'REFERENCE_BUILD_ASSERT: source patch hash differs');
  } else {
    assert.equal(expected.patchFile, null);
    assert.equal(expected.patchSha256, null);
  }
  h.expectedReferenceBuild = expected;
  const checked = new WeakSet();
  let document;
  return async () => {
    const main = h.responses.findLast(row => row.mainDocument && row.status === 200);
    if (!main) throw Error('REFERENCE_BUILD_ASSERT: no actual main-document response');
    const current = h.responseObjects.get(main.url);
    if (document !== current) {
      const receipt = await h.context.request.get(new URL('b39-build.json', h.baseURL).href);
      assert.equal(receipt.status(), 200, 'REFERENCE_BUILD_ASSERT: server has no reference receipt');
      assert.deepEqual(await receipt.json(), expected, 'REFERENCE_BUILD_ASSERT: stale or different reference server');
      document = current;
    }
    for (const [url, response] of h.responseObjects) {
      if (checked.has(response) || response.request().resourceType() !== 'script' || response.status() !== 200) continue;
      const pathname = new URL(url).pathname.replace(/^\//, '');
      const original = expected.chunks[pathname];
      if (!original) throw Error(`REFERENCE_BUILD_ASSERT: unidentified script ${url}`);
      const mutations = h.mutations.flatMap(mutation => mutation.targets ?? [mutation]);
      const mutation = mutations.find(mutation => mutation.url === url);
      if (mutation && mutation.beforeSha256 !== original) throw Error(`REFERENCE_BUILD_ASSERT: mutation was not anchored to the expected ${pathname}`);
      const expectedSha = mutation?.afterSha256 ?? original;
      assert.equal(sha(await response.body()), expectedSha, `REFERENCE_BUILD_ASSERT: wrong network bytes for ${pathname}`);
      checked.add(response);
    }
    h.referenceBuildAssertions = (h.referenceBuildAssertions ?? 0) + 1;
    return { referenceCommit: expected.referenceCommit, harnessCommit: expected.harnessCommit, variant: expected.variant, entry: expected.entry, entrySha256: expected.chunks[expected.entry] };
  };
}
