# App-written A/B reference fixtures

Copied byte-for-byte from the planning run's retained corpus; no snapshot is fabricated by a
library setter. The browser opens them through the real app's tree A/B/A. Their existing JSON bytes
are independently read as the persisted oracle. These files are legacy reference inputs, never
implementation material for the new engine.

| Local | Corpus source | SHA-256 |
| --- | --- | --- |
| pair-a.tldraw | formats/corpus/core/mouse-and-pen.tldraw — original mouse/pen actions from the harness smoke | 36a71390d0c4e2599a78dc9ff0f403d04a363f4fa9f92b87d4554b5f45dbaea0 |
| pair-b.tldraw | formats/corpus/team/FIG--whiteboard-settled--app-written-Figures.tldraw — actual figure/UI campaign | 99c43f6af08dac26b38a7ba8714ad6d8b3d34bd3ecfdb5379bfde5a1d85b4617 |

The authoritative corpus manifest and INDEX.md retain the source scripts and original build labels.
Controls qualify only fields whose actual scalar-value sets differ; different record counts alone
are not contrast. Noncontrasting fields stay UNCONTROLLED. Saved/live normalization shares reference
format helpers, so this does not independently prove decoding precision or the rendering algorithm.
