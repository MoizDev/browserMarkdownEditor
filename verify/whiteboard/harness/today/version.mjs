// Reference-only: these are the library's own registration tuples in ACTUALLY fetched JS.
// A filename/hash identifies a build, never this package-version assertion.
const REQUIRED = ['@tldraw/utils', '@tldraw/state', '@tldraw/state-react', '@tldraw/store', '@tldraw/validate', '@tldraw/tlschema', '@tldraw/editor'];
const EXPECTED = '5.2.4';
const parsed = new WeakMap();

export async function assertProbeVersion(h) {
  await h.assertReferenceBuild();
  const evidence = [];
  for (const [url, response] of h.responseObjects) {
    if (response.request().resourceType() !== 'script' || response.status() !== 200) continue;
    let markers = parsed.get(response);
    if (!markers) {
      const text = await response.text();
      markers = [...text.matchAll(/[\w$]+\((["'])(@tldraw\/[\w-]+)\1\s*,\s*(["'])([^"']+)\3\s*,\s*(["'])(esm|cjs)\5\)/g)]
        .map(match => ({ package: match[2], version: match[4], moduleKind: match[6], url }));
      parsed.set(response, markers);
    }
    evidence.push(...markers);
  }
  for (const name of REQUIRED) {
    const matches = evidence.filter(marker => marker.package === name);
    if (!matches.length) throw Error(`PROBE_VERSION_ASSERT ${name}: no library registration marker in the fetched chunks`);
    for (const marker of matches) if (marker.version !== EXPECTED) throw Error(`PROBE_VERSION_ASSERT ${name}: fetched ${marker.version}, expected ${EXPECTED} (${marker.url})`);
  }
  h.probeVersionAssertions ??= { count: 0, evidence: [] };
  h.probeVersionAssertions.count++;
  h.probeVersionAssertions.evidence = evidence;
  return evidence;
}
