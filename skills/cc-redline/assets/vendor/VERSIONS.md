# Vendored front-end libraries

Downloaded via `npm pack` and committed for fully offline use.
To upgrade: re-download each library at the target version via `npm pack` (unpack
and copy only the files listed under "Files kept"), then update the version column.
Note: mermaid.min.js is a pre-built bundle that also embeds DOMPurify, d3, dagre,
cytoscape, lodash, js-yaml and others — see THIRD-PARTY-NOTICES.md.

| Library | Version | npm package | Files kept |
|---------|---------|-------------|------------|
| marked | 18.0.6 | marked | marked.esm.js |
| mermaid | 11.16.0 | mermaid | mermaid.min.js |
| KaTeX | 0.17.0 | katex | katex/katex.min.js, katex/katex.min.css, katex/auto-render.min.js, katex/fonts/*.woff2 |
| highlight.js | 11.11.1 | @highlightjs/cdn-assets | highlight/highlight.min.js, highlight/atom-one-light.css (active theme), highlight/github.min.css (retained, unused) |

Licenses: see `licenses/` (MIT, except highlight.js which is BSD-3-Clause).
