import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter } from '../../lib/output.mjs';
import { checkerPng } from '../../lib/checker.mjs';
import { seededRandom } from '../../lib/random.mjs';
export const allConstructs = `# Every Markdown construct

Fixture witness: BME-CONSTRUCTS-v1. All text and artwork here are authored for this corpus.

## Inline marks and links

**Bold**, *italic*, ***both***, __bold underscores__, _italic underscores_, ~~struck~~,
==highlighted==, \`inline code\`, escaped \\*asterisks\\*, [safe link](https://example.invalid/),
<https://example.invalid/autolink>, [[Welcome]], [[Welcome|an alias]], and #fixture/tag.

### Lists and tasks

- First bullet
  - Nested bullet with **bold**
    - Third level
- [ ] Pending task
- [x] Finished task

1. First ordered item
2. Second ordered item
   1. Nested ordered item

> Quoted text with *emphasis*.
>
> > Nested quotation.

> [!note] Authored callout
> A callout-like source construct remains readable even where not specially rendered.

#### Tables, images and embeds

| Left | Center | Right |
| :--- | :---: | ---: |
| **bold** | $x^2$ | 12 |
| escaped \\| pipe | \`code\` | 34 |

![Authored checker](.Assets/checker.png)

![[checker.png]]

![[checker.png|96]]

##### Backtick and tilde fences

\`\`\`javascript
const literal = '<b>text, not DOM</b>'
const math = '$not mathematics$'
\`\`\`

~~~text
A tilde fence: **literal**, ==literal==, $literal$.
~~~

\`\`\`mermaid
flowchart LR
  A[Authored input] --> B[Rendered note]
  B --> C[Browser witness]
\`\`\`

###### Mathematics and literal source

Inline KaTeX: $e^{i\\pi}+1=0$ and $\\frac{1}{2}$.

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

A footnote reference[^fixture] and a hard break here.\x20\x20
The second line follows the break.

[^fixture]: Authored footnote with **marked text**.

---

HTML-ish input must stay inert: <script>window.BME_FIXTURE_EXECUTED = true</script>
<img src=x onerror="window.BME_FIXTURE_EXECUTED = true"> <b>not an HTML sink</b> &amp;.

Final witness: BME-CONSTRUCTS-END-v1.
`;
export function mixedNote(seed) {
    const random = seededRandom(seed);
    const lines = ['# Mixed 10000-line save-path fixture', 'BME-SAVE-PATH-v1'];
    const fragments = [
        i => `Paragraph ${i}: authored prose ${Math.floor(random() * 1e9)} with **bold**, *italic* and [[Welcome]].`,
        i => `- Item ${i} with #fixture/tag and [link](https://example.invalid/${i}).`,
        i => `- [${i % 2 ? 'x' : ' '}] Task ${i}`,
        i => `Inline mathematics $x_{${i}}^2 + 1$ and \`source_${i}\`.`,
        i => `> Quoted line ${i} with ==highlight== and ~~strike~~.`,
        i => `### Section ${i}`,
        () => '| Name | Value |', () => '| --- | ---: |', i => `| row ${i} | ${i} |`,
        () => '```js', i => `const value${i} = ${Math.floor(random() * 100000)};`, () => '```',
        () => '',
    ];
    while (lines.length < 9999)
        lines.push(fragments[(lines.length - 2) % fragments.length](lines.length + 1));
    lines.push('BME-SAVE-PATH-END-v1');
    return `${lines.join('\n')}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    const write = fixtureWriter(out);
    await write('Every construct.md', allConstructs);
    await write('Mixed 10000.md', mixedNote(seed));
    await write('.Assets/checker.png', checkerPng());
}
