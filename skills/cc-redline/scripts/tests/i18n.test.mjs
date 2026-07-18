import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translations, translate } from '../../assets/js/i18n.mjs';

test('en and zh have identical key sets', () => {
  assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations.zh).sort());
});

test('every translation value is a non-empty string', () => {
  for (const lang of ['en', 'zh'])
    for (const [k, v] of Object.entries(translations[lang])) {
      assert.equal(typeof v, 'string', `${lang}.${k}`);
      assert.ok(v.length > 0, `${lang}.${k}`);
    }
});

test('placeholder keys keep their {param} tokens in both languages', () => {
  for (const key of ['btn.submit', 'popover.target', 'popover.targetSel', 'alert.submitFailed', 'render.failed'])
    for (const lang of ['en', 'zh'])
      assert.match(translations[lang][key], /\{\w+\}/, `${lang}.${key} lost its placeholder`);
});

test('translate returns the value and interpolates {n}', () => {
  assert.equal(translate('en', 'btn.done'), translations.en['btn.done']);
  assert.match(translate('zh', 'btn.submit', { n: 3 }), /3/);
});

test('translate falls back to en, then to the key itself', () => {
  assert.equal(translate('zh', '__missing__'), '__missing__');
  const enOnly = Object.keys(translations.en)[0];
  assert.equal(translate('xx', enOnly), translations.en[enOnly]); // unknown lang → en
});
