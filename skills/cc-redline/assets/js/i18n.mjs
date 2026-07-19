// Bilingual (en / zh) i18n for the browser UI and runtime prompts.
// Display-layer only: values written into the submission JSON are stable English
// (see blocks.mjs DOC_START, and the English `scope` keys), decoupled from this.
export const LANG_KEY = 'cc-redline-lang';

export const translations = {
  en: {
    'app.title': 'CC Redline',
    'topbar.conn': 'Connection status',
    'nav.group': 'Annotation navigation (N next / P prev)',
    'nav.prev': 'Previous annotation (P)',
    'nav.next': 'Next annotation (N)',
    'btn.global': 'Overall',
    'btn.global.title': 'Overall comment (not tied to a specific location)',
    'btn.hide': 'Hide annotations',
    'btn.show': 'Show annotations',
    'btn.hide.title': 'Hide / show all annotations',
    'btn.submit': 'Submit ({n})',
    'btn.done': 'End review',
    'ruler.title': 'Overview: gold = block/section, red = selection, blue = line; gray = heading. Click/drag to jump.',
    'popover.placeholder': 'Write your comment… (Enter to save, Shift+Enter for newline, Esc to cancel)',
    'popover.save': 'Save',
    'popover.cancel': 'Cancel',
    'popover.target': '[{scope}] {path} (L{start}-L{end})',
    'popover.targetSel': ' — "{sel}"',
    'selection.btn': 'Annotate selection',
    'lang.switch': 'Language',
    'scope.block': 'block',
    'scope.section': 'section',
    'scope.selection': 'selection',
    'scope.line': 'line',
    'doc.start': '(document start)',
    'handle.block': 'Annotate block',
    'handle.section': 'Annotate section',
    'global.target': 'Overall comment (not tied to a specific location)',
    'rail.submitted': 'Submitted',
    'rail.edit': 'Edit',
    'rail.delete': 'Delete',
    'banner.submitted': 'Submitted. Waiting for the agent to apply your edits…',
    'banner.done': 'Review finished. You can close this page.',
    'banner.docChanged': 'The document changed.',
    'banner.refreshNow': 'Refresh now (discard unsubmitted annotations)',
    'banner.later': 'Not now',
    'banner.docChangedSoft': 'The document changed; refreshing is recommended before submitting.',
    'banner.refresh': 'Refresh',
    'confirm.done': 'End this review? The server will exit.',
    'alert.submitFailed': 'Submit failed: {err}',
    'render.failed': 'Render failed: {err}',
  },
  zh: {
    'app.title': 'CC Redline',
    'topbar.conn': '连接状态',
    'nav.group': '批注导航（N 下一个 / P 上一个）',
    'nav.prev': '上一个批注 (P)',
    'nav.next': '下一个批注 (N)',
    'btn.global': '整体意见',
    'btn.global.title': '整体意见（不针对具体位置）',
    'btn.hide': '隐藏批注',
    'btn.show': '显示批注',
    'btn.hide.title': '隐藏/显示所有批注',
    'btn.submit': '提交批注 ({n})',
    'btn.done': '结束 Review',
    'ruler.title': '文档概览：黄=块/章节批注，红=选中，蓝=行；灰=标题。点击/拖动跳转',
    'popover.placeholder': '写下你的修改意见…（Enter 保存，Shift+Enter 换行，Esc 取消）',
    'popover.save': '保存',
    'popover.cancel': '取消',
    'popover.target': '[{scope}] {path}（L{start}-L{end}）',
    'popover.targetSel': '：「{sel}」',
    'selection.btn': '批注选中内容',
    'lang.switch': '语言',
    'scope.block': '块',
    'scope.section': '章节',
    'scope.selection': '选中',
    'scope.line': '行',
    'doc.start': '（文档开头）',
    'handle.block': '批注本块',
    'handle.section': '批注整节',
    'global.target': '整体意见（不针对具体位置）',
    'rail.submitted': '已提交',
    'rail.edit': '编辑',
    'rail.delete': '删除',
    'banner.submitted': '已提交，等待 AI 修改中…',
    'banner.done': '本次 Review 已结束，可关闭此页面。',
    'banner.docChanged': '文档已更新。',
    'banner.refreshNow': '立即刷新（丢弃未提交批注）',
    'banner.later': '暂不刷新',
    'banner.docChangedSoft': '文档已更新，提交前建议刷新。',
    'banner.refresh': '刷新',
    'confirm.done': '确定结束本次 review 吗？服务将退出。',
    'alert.submitFailed': '提交失败：{err}',
    'render.failed': '渲染失败：{err}',
  },
};

function interpolate(str, params) {
  return params ? str.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : str;
}

// Pure, node-testable: pick a value by (lang, key), fall back en → key.
export function translate(lang, key, params) {
  const table = translations[lang] || translations.en;
  const value = key in table ? table[key] : (key in translations.en ? translations.en[key] : key);
  return interpolate(value, params);
}

let current = 'en';
export function getLang() { return current; }

function syncHtmlLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
}

export function initLang() {
  let lang = null;
  try { lang = localStorage.getItem(LANG_KEY); } catch { /* no storage */ }
  if (lang !== 'en' && lang !== 'zh') {
    const nav = (typeof navigator !== 'undefined' && navigator.language || '').toLowerCase();
    lang = nav.startsWith('zh') ? 'zh' : 'en';
  }
  current = lang;
  syncHtmlLang();
  return current;
}

export function setLang(lang) {
  if (lang !== 'en' && lang !== 'zh') return;
  current = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* no storage */ }
  syncHtmlLang();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cc-redline:langchange', { detail: { lang } }));
  }
}

export function t(key, params) { return translate(current, key, params); }

// Fill every [data-i18n*] element under `root` for the current language.
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-label]')) el.dataset.label = t(el.dataset.i18nLabel);
}
