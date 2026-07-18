// Rendering pipeline shared by preview and review modes.
// hljs / renderMathInElement / mermaid are UMD globals loaded in app.html.
import { marked } from '../vendor/marked.esm.js';
import { t } from './i18n.mjs';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let markedConfigured = false;
function configureMarked() {
  if (markedConfigured) return;
  markedConfigured = true;
  marked.use({
    renderer: {
      // marked >= 13 object-style renderer signature
      code({ text, lang }) {
        const l = (lang || '').trim().toLowerCase();
        if (l === 'mermaid') return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
        // lang attr drives the CSS language badge (see #content pre > code[lang])
        const attrs = l ? ` class="language-${escapeHtml(l)}" lang="${escapeHtml(l)}"` : '';
        return `<pre><code${attrs}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });
}

let mermaidReady = false;

export function renderDocument(container, parsed) {
  configureMarked();
  container.textContent = '';
  for (const block of parsed.blocks) {
    const div = document.createElement('div');
    div.className = 'block';
    div.id = block.id;
    div.dataset.startLine = block.startLine;
    div.dataset.endLine = block.endLine;
    div.dataset.type = block.type;
    const tokens = [block.token];
    // Reference-style links are already resolved at lex time (blocks.mjs runs one
    // whole-document marked.lexer() before splitting), so this .links assignment is
    // belt-and-suspenders: Parser.parse() does not read it. Kept harmless, not load-bearing.
    tokens.links = parsed.links;
    try {
      div.innerHTML = marked.parser(tokens);
    } catch (e) {
      div.innerHTML =
        `<div class="block-error">${escapeHtml(t('render.failed', { err: String(e) }))}</div>` +
        `<pre>${escapeHtml(block.token.raw)}</pre>`;
    }
    container.appendChild(div);
  }
  postProcess(container);
}

function postProcess(container) {
  for (const img of container.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) {
      img.src = '/doc-assets/' + src.replace(/^\.\//, '');
    }
  }
  container.querySelectorAll('pre code').forEach((el) => {
    try { hljs.highlightElement(el); } catch { /* keep plain code */ }
  });
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch { /* formulas stay as source text */ }
  try {
    if (!mermaidReady) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      mermaidReady = true;
    }
    // mermaid renders an inline error diagram per failing block by itself
    mermaid.run({ nodes: container.querySelectorAll('.mermaid') }).catch(() => {});
  } catch { /* diagrams stay as source text */ }
}
