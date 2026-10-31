import { createHash } from 'node:crypto';
import { render, renderTemplate, renderTemplateValue } from '../src/render';
import { validateTemplateSyntax } from '../src/render/template';
import { buildSyntheticRecipe, READABLE_SSSOM_FILE_TEMPLATE } from '../src/import/sssom-importer';
import { validateRecipe } from '../src/validation/validator';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('additive general filename filters', () => {
 it.each(['', 'abc', 'Ä / 漢字', 'a:b', '😀'])('hash uses the exact UTF-8 value (%p)', value => {
  expect(renderTemplate('{value|hash(8)}', { value })).toBe(digest(value).slice(0, 8));
  expect(renderTemplate('{value|hash(64)}', { value })).toBe(digest(value));
  expect(renderTemplate('{value|hash(4)}', { value })).toBe(digest(value).slice(0, 4));
 });
 it.each(['hash', 'hash(3)', 'hash(65)', 'hash(8.5)', 'hash(8x)', 'hash(-4)', 'default'])('refuses invalid filter arguments: %s', filter => {
  expect(() => renderTemplate(`{value|${filter}}`, { value: 'x' })).toThrow();
 });
 it.each(['', ' ', '\t\n'])('default replaces blank values (%p)', value => {
  expect(renderTemplate('{value|default(unnamed)}', { value })).toBe('unnamed');
 });
 it('default preserves nonempty values exactly and does not silently allow missing fields', () => {
  expect(renderTemplate('{value|default(unnamed)}', { value: ' X ' })).toBe(' X ');
  expect(() => renderTemplate('{missing|default(unnamed)}', {})).toThrow(/missing/i);
  expect(renderTemplate('{missing|optional|default(unnamed)}', {})).toBe('unnamed');
 });
 it('name-safe replaces forbidden runs, collapses spaces, strips outer dots and keeps readable punctuation', () => {
  expect(renderTemplate('{value|name-safe}', { value: '..  AC-2(1)\\/:*?"<>|#^[]\u0000\u007f\u0085 \t GV.SC-04 T1059.001 ... ' })).toBe('AC-2(1) GV.SC-04 T1059.001');
  expect(renderTemplate('{value|name-safe}', { value: 'A%20&B' })).toBe('A%20&B');
  expect(renderTemplate('{value|name-safe|default(unnamed)}', { value: '... /# ' })).toBe('unnamed');
 });
 it('name-safe removes invisible formatting characters and lone surrogates', () => {
  expect(renderTemplate('{value|name-safe}', { value: 'A​C‎-‮2⁦(1)﻿' })).toBe('AC-2(1)');
  expect(renderTemplate('{value|name-safe}', { value: 'A\ud83dB\ude00C' })).toBe('ABC');
  expect(renderTemplate('{value|name-safe}', { value: 'A😀B' })).toBe('A😀B');
 });
 it('truncate before name-safe never leaves half a character', () => {
  for (let n = 1; n <= 6; n++) {
   const out = renderTemplate(`{value|truncate(${n})|name-safe}`, { value: 'A😀😀B' });
   expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  }
  expect(renderTemplate('{value|truncate(2)|name-safe}', { value: 'A😀B' })).toBe('A');
 });
 it('default(text) maps over list items, so an empty list stays empty', () => {
  expect(renderTemplateValue('{value|default(unnamed)}', { value: [] })).toEqual([]);
 });
 it('new scalar filters lift over lists using the existing empty-item rules', () => {
  expect(renderTemplateValue('{value|name-safe}', { value: ['..A#B.', 'C/D'] })).toEqual(['A B', 'C D']);
  expect(renderTemplateValue('{value|default(unnamed)}', { value: [' ', 'A'] })).toEqual(['unnamed', 'A']);
  expect(renderTemplateValue('{value|hash(8)}', { value: ['A', 'B'] })).toEqual(['A', 'B'].map(value => digest(value).slice(0, 8)));
 });
 it('keeps existing fs-safe, truncate and slug behavior byte-identical, including surrogate slicing', () => {
  expect(renderTemplate('{value|fs-safe}', { value: '..A#^[B]|C/D. ' })).toBe('..A#^[B]_C_D');
  expect(renderTemplate('{value|slug}', { value: 'AC-2(1) · GV.SC-04' })).toBe('ac-2-1-gv-sc-04');
  expect(renderTemplate('{value|truncate(2)}', { value: 'A😀B' })).toBe('A\ud83d');
 });
});

describe('composable readable standalone mapping template', () => {
 const recipe = buildSyntheticRecipe('demo-a', 'demo-b');
 it('is schema-valid and uses ordinary supported template syntax', () => {
  expect(validateRecipe(recipe).valid).toBe(true);
  expect(() => validateTemplateSyntax(READABLE_SSSOM_FILE_TEMPLATE)).not.toThrow();
 });
 it.each([
  ['attack:T1059.001', 'T1059.001'],
  ['nist-sp-800-53-r5:AC-2(1)', 'AC-2(1)'],
  ['d3f:FileEncryption', 'FileEncryption'],
  ['nist-csf-2:GV.SC-04', 'GV.SC-04'],
  ['no-colon', 'no-colon'],
  ['', 'unnamed'],
  ['   ', 'unnamed'],
  ['p:keep:the:rest', 'keep the rest'],
  ['p:' + 'A'.repeat(200), 'A'.repeat(60)],
  ['p:' + 'A'.repeat(59) + '.more', 'A'.repeat(59)],
  ['p:' + 'A'.repeat(56) + ' . .tail', 'A'.repeat(56)],
 ])('renders probe %p as %p without slugging', (subject, stem) => {
  const scope = { subject_id: subject, object_id: 'target:M1036', _crosswalker_curie_local_part: 'edge-identity' };
  const name = `${stem} · M1036 (${digest('edge-identity').slice(0, 8)}).md`;
  expect(renderTemplate(READABLE_SSSOM_FILE_TEMPLATE, scope)).toBe(name);
  const address = render({ ...recipe, target: { layout: recipe.target.layout } }, { curie: 'sssom:edge-identity', scope });
  expect(address.primary.path).toBe(name);
  expect(name.length).toBeLessThanOrEqual(138);
 });
 it('is deterministic and distinguishes case-only identities and equal local ids from different prefixes', () => {
  const name = (identity: string) => renderTemplate(READABLE_SSSOM_FILE_TEMPLATE, { subject_id: 'p:A', object_id: 'q:B', _crosswalker_curie_local_part: identity });
  expect(name('edge-A')).toBe(name('edge-A'));
  expect(name('edge-A')).not.toBe(name('edge-a'));
  expect(name('p-A-q-B')).not.toBe(name('other-A-q-B'));
 });
});
