// Reference-only marker faults. The version guard reads network tuples independently.
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
export const markerSpecs = [
  { name: 'object', kind: 'marker', find: 'getCurrentPageShapes', replacement: 'getCurrentPageShapes_B39_RENAMED' },
  { name: 'version', kind: 'marker', pattern: String.raw`[\w$]+\((["'])((?:@tldraw\/[\w-]+|tldraw))\1\s*,\s*(["'])([^"']+)\3\s*,\s*(["'])(esm|cjs)\5\)`, replacementVersion: '0.0.0' },
];

export async function prepareConsistentMarker(h, { mode, expectedBuild }) {
  const spec = markerSpecs.find(spec => spec.name === mode);
  if (!spec || spec.kind !== 'marker') throw Error('MUTATION_ASSERT: unknown marker kind');
  const entries = Object.entries(expectedBuild.scripts ?? {});
  if (!entries.length || entries.length > 1024) throw Error('MUTATION_ASSERT: module inventory outside the explicit bound');
  const expected = expectedBuild.markerCounts?.[mode];
  if (!expected || !Object.keys(expected).length) throw Error(`MUTATION_ASSERT: no independently built ${mode} replacement inventory`);
  const loaded = await h.page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  if (entries.some(([file]) => loaded.includes(new URL(`/${file}`, h.baseURL).href))) throw Error('MUTATION_ASSERT: marker faults must be prepared before app scripts are loaded');
  const targets = [], observed = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < entries.length) {
      const [file, hash] = entries[cursor++];
      const url = new URL(`/${file}`, h.baseURL).href;
      const response = await h.context.request.get(url);
      if (!response.ok()) throw Error(`MUTATION_ASSERT: ${url} returned ${response.status()}`);
      const body = await response.body();
      if (sha(body) !== hash) throw Error(`MUTATION_ASSERT: ${file} is not the expected source artifact`);
      const text = body.toString('utf8');
      const expression = spec.pattern ? new RegExp(spec.pattern, 'g') : null;
      const count = expression ? [...text.matchAll(expression)].length : text.split(spec.find).length - 1;
      if (count !== (expected[file] ?? 0)) throw Error(`MUTATION_ASSERT: ${file} has ${count} replacements, expected exactly ${expected[file] ?? 0}`);
      if (!count) continue;
      observed[file] = count;
      const modified = expression ? text.replace(expression, match => {
        if (!/(["'])5\.2\.4\1/.test(match)) throw Error('MUTATION_ASSERT: version source is not the pinned 5.2.4 marker');
        return match.replace(/(["'])5\.2\.4\1/, (_, quote) => `${quote}${spec.replacementVersion}${quote}`);
      }) : text.split(spec.find).join(spec.replacement);
      if (modified === text) throw Error('MUTATION_ASSERT: replacement changed no bytes');
      const target = { file, url, expectedMatches: expected[file], matches: count, beforeSha256: hash, afterSha256: sha(modified), served: 0 };
      await h.context.route(url, async route => { target.served++; await route.fulfill({ status: 200, contentType: 'application/javascript', body: modified }); });
      targets.push(target);
    }
  }));
  for (const file of Object.keys(expected)) if (observed[file] !== expected[file]) throw Error(`MUTATION_ASSERT: did not cover expected chunk ${file}`);
  const record = { kind: 'marker', mode, expectedCounts: expected, observedCounts: observed, matches: targets.reduce((sum, target) => sum + target.matches, 0), targets };
  record.assertApplied = () => {
    if (!targets.some(target => target.served > 0)) throw Error('MUTATION_ASSERT: no substituted chunk reached the running app');
    return { ...record, assertApplied: undefined };
  };
  return record;
}
