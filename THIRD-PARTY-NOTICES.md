# Third-Party Notices

This project bundles the following third-party libraries under `assets/vendor/`.
Each retains its own license; full texts are in `assets/vendor/licenses/`.

## Directly vendored

| Library | Version | License | Path |
|---|---|---|---|
| marked | 18.0.6 | MIT | `assets/vendor/marked.esm.js` |
| KaTeX | 0.17.0 | MIT | `assets/vendor/katex/` |
| highlight.js | 11.11.1 | BSD-3-Clause | `assets/vendor/highlight/` |
| mermaid | 11.16.0 | MIT | `assets/vendor/mermaid.min.js` |

## Bundled inside `mermaid.min.js`

`mermaid.min.js` is a pre-built bundle that additionally embeds, among others:

- **DOMPurify 3.4.0** — Apache-2.0 OR MPL-2.0 — © Cure53 and contributors
  (full Apache-2.0 text: `assets/vendor/licenses/dompurify-LICENSE`)
- d3 — ISC / BSD-3-Clause
- dagre, dagre-d3 — MIT
- cytoscape — MIT
- lodash — MIT
- js-yaml — MIT

These are redistributed as part of the mermaid bundle under their respective
licenses. See the mermaid project for the authoritative dependency list.
