/**
 * template-engine.test.ts — the two capabilities added by the 2026-08-26
 * template-engine contract, acceptance case by acceptance case.
 *
 *   Capability 1 (§1) — LITERAL KEY ACCESS. `['segment']` quoting at any path
 *     position, the exact-key-first resolution step, and `optional` widened to
 *     fire at every segment. Dotted traversal for nested sources is untouched.
 *
 *   Capability 2 (§2) — PER-ITEM TRANSFORMATION. A value may be a list, and
 *     EVERY filter (existing or future) lifts over it automatically. The
 *     `split(delim)` / `join(sep)` / `reject(pattern)` / `wikilink` /
 *     `trim(chars)` algebra, plus the depth-aware filter-argument lexer (R2.4)
 *     that finally makes `regex()` and `|` writable.
 *
 * Regression pins for the pre-change behaviour live alongside the new cases on
 * purpose: the bar for both capabilities is that every existing recipe renders
 * byte-identically where it does not use the new syntax.
 */

import {
	render,
	renderTemplate,
	renderTemplateValue,
	renderBodyProjection,
	RenderError,
	type BodyProjection,
	type Recipe,
	type RenderReport,
} from '../src/render';
import { parseInterpolation, parseTemplateSegments, interpolationColumn } from '../src/render/template';
import { fromRecipe, toRecipeRegions, type RecipeRegions } from '../src/import/mapping/serialize';

const report = (): RenderReport => ({ notes: [] });
const codes = (r: RenderReport): string[] => r.notes.map((n) => n.code);

// ---------------------------------------------------------------------------
// Capability 1 — literal key access (contract §1.8)
// ---------------------------------------------------------------------------

describe('capability 1 — literal key access', () => {
	it('1.1 resolves a quoted literal key', () => {
		expect(renderTemplate("{['A.B']}", { 'A.B': 'x' })).toBe('x');
	});

	it('1.2 resolves a bare dotted header via the exact-key step, with no note', () => {
		const r = report();
		expect(renderTemplate('{A.B}', { 'A.B': 'x' }, r)).toBe('x');
		expect(r.notes).toEqual([]);
	});

	it('1.3 prefers the literal column but reports the competing nested reading', () => {
		const r = report();
		expect(renderTemplate('{A.B}', { 'A.B': 'x', A: { B: 'y' } }, r)).toBe('x');
		expect(codes(r)).toEqual(['literal-key-shadowed']);
		expect(r.notes[0].detail).toContain("['A.B']");
	});

	it('1.4 leaves ordinary dotted traversal alone (regression pin)', () => {
		const r = report();
		expect(renderTemplate('{a.b}', { a: { b: 'y' } }, r)).toBe('y');
		expect(r.notes).toEqual([]);
	});

	it('1.5 leaves a real STIX-shaped nested path alone (regression pin)', () => {
		const row = {
			type: 'attack-pattern',
			external_references: [
				{ source_name: 'mitre-attack', external_id: 'T1055' },
				{ source_name: 'capec', external_id: 'CAPEC-640' },
			],
		};
		expect(renderTemplate('{external_references.0.external_id}', row)).toBe('T1055');
		expect(renderTemplate('{external_references.1.source_name}', row)).toBe('capec');
	});

	it('1.6 composes quoting with traversal at arbitrary depth', () => {
		expect(renderTemplate("{['a'].b.['c.d']}", { a: { b: { 'c.d': 'z' } } })).toBe('z');
		expect(
			renderTemplate("{['weird.parent'].child.0.['odd.leaf']}", {
				'weird.parent': { child: [{ 'odd.leaf': 'deep' }] },
			}),
		).toBe('deep');
	});

	it("1.7 does not terminate the interpolation on a `}` inside quotes", () => {
		expect(renderTemplate("{['x}y']}", { 'x}y': 'braced' })).toBe('braced');
		// ...and the surrounding literal text is still preserved.
		expect(renderTemplate("pre {['x}y']} post", { 'x}y': 'braced' })).toBe('pre braced post');
	});

	it('1.8 `optional` rescues a missing INTERMEDIATE segment, not just the last', () => {
		expect(renderTemplate('{a.b.c|optional}', {})).toBe('');
		expect(renderTemplate('{a.b.c|optional}', { a: null })).toBe('');
		expect(renderTemplate('{a.b.c|optional}', { a: { b: {} } })).toBe('');
	});

	it('1.9 `optional` rescues a non-object intermediate', () => {
		expect(renderTemplate('{a.b.c|optional}', { a: 'a string' })).toBe('');
	});

	it('1.10 without `optional` a non-object intermediate still throws (regression pin)', () => {
		expect(() => renderTemplate('{a.b}', { a: 'a string' })).toThrow(RenderError);
		expect(() => renderTemplate('{a.b}', { a: 'a string' })).toThrow('hit non-object value');
	});

	it('1.11 a quoted literal key round-trips through the workbench byte-identically', () => {
		const recipe = {
			target: {
				layout: [{ level: 'row', mechanism: 'file' as const, template: "{['A.B']}.md" }],
				also_emit: { frontmatter: { managed: { statement: "{['CRI Profile v2.2 Diagnostic Statement']}" } } },
			},
		};
		const regions = toRecipeRegions(fromRecipe(recipe as unknown as { target: RecipeRegions }));
		expect(regions.layout).toEqual(recipe.target.layout);
		expect(regions.also_emit!.frontmatter!.managed).toEqual(recipe.target.also_emit.frontmatter.managed);
		// The model records WHY it is quoted, so it cannot silently become a path.
		const mapping = fromRecipe(recipe as unknown as { target: RecipeRegions });
		expect(mapping.mappings[0].levels[0].source).toEqual({ column: 'A.B', literal: true });
	});

	it('1.12 a dotted PATH round-trips dotted — it must NOT become quoted', () => {
		const recipe = {
			target: {
				layout: [
					{ level: 'row', mechanism: 'file' as const, template: '{external_references.0.external_id}.md' },
				],
			},
		};
		const regions = toRecipeRegions(fromRecipe(recipe as unknown as { target: RecipeRegions }));
		expect(regions.layout).toEqual(recipe.target.layout);
		const mapping = fromRecipe(recipe as unknown as { target: RecipeRegions });
		expect(mapping.mappings[0].levels[0].source).toEqual({ column: 'external_references.0.external_id' });
	});

	it('1.13 a quoted key counts as ONE column for signatures, not two segments', () => {
		const segments = parseTemplateSegments("{['A.B']}");
		expect(segments).toHaveLength(1);
		expect(segments[0].kind).toBe('interp');
		const interp = (segments[0] as { kind: 'interp'; interp: ReturnType<typeof parseInterpolation> }).interp;
		expect(interpolationColumn(interp)).toEqual({ column: 'A.B', literal: true });
		expect(interp.path).toEqual([{ name: 'A.B', literal: true }]);
	});

	it('R0 — the shared tokenizer keeps the raw path for exact re-serialization', () => {
		const interp = parseInterpolation("['Errata 2026.1']|optional|trim");
		expect(interp.rawPath).toBe("['Errata 2026.1']");
		expect(interp.filters.map((f) => f.name)).toEqual(['optional', 'trim']);
		expect(interp.filters.map((f) => f.raw)).toEqual(['optional', 'trim']);
	});

	it('resolves the real CRI dotted header with no recipe edit at all', () => {
		const row = {
			'CRI Profile v2.2 Diagnostic Statement': 'The organization maintains an asset inventory.',
			'CRI Profile Function / Category / Subcategory': 'GV: Govern',
		};
		expect(renderTemplate('{CRI Profile v2.2 Diagnostic Statement}', row)).toBe(
			'The organization maintains an asset inventory.',
		);
		expect(renderTemplate("{['CRI Profile v2.2 Diagnostic Statement']}", row)).toBe(
			'The organization maintains an asset inventory.',
		);
	});

	it('keeps a column name carrying parentheses working (real SCF header)', () => {
		const col = 'Possible Solutions & Considerations Micro-Small Business (<10 staff) BLS Firm Size Classes 1-2';
		expect(renderTemplate(`{${col}|trim}`, { [col]: '  do the thing  ' })).toBe('do the thing');
	});
});

// ---------------------------------------------------------------------------
// Capability 2 — per-item transformation (contract §2.8)
// ---------------------------------------------------------------------------

describe('capability 2 — lists and per-item filters', () => {
	it('2.1 split(<delim>) produces a trimmed, empty-free list', () => {
		expect(renderTemplateValue('{v|split(,)}', { v: 'a, b, c' })).toEqual(['a', 'b', 'c']);
		expect(renderTemplateValue('{v|split(,)}', { v: 'a,,b,' })).toEqual(['a', 'b']);
	});

	it('2.2 split(<delim>,<index>) is unchanged and takes parse precedence (regression pin)', () => {
		expect(renderTemplate('{v|split(.,0)}', { v: 'A.B' })).toBe('A');
		expect(renderTemplate('{v|split(:,0)}', { v: 'DE.AE-01: Adverse events' })).toBe('DE.AE-01');
		expect(renderTemplate('{v|split(:,1)}', { v: 'DE.AE-01: Adverse events' })).toBe('Adverse events');
	});

	it('2.3 every filter lifts over a list — including ones never modified', () => {
		expect(renderTemplateValue('{v|split(,)|upper}', { v: 'a,b' })).toEqual(['A', 'B']);
		expect(renderTemplateValue('{v|split(,)|slug}', { v: 'Access Control, Audit Log' })).toEqual([
			'access-control',
			'audit-log',
		]);
		// curie-prefix was written as a scalar filter and needed no change: L1 paying for itself.
		expect(renderTemplateValue('{v|split(,)|curie-prefix(nist-800-53)}', { v: 'AC-3, AC-5' })).toEqual([
			'nist-800-53:AC-3',
			'nist-800-53:AC-5',
		]);
	});

	it('2.4 trim(<chars>) cleans each item', () => {
		expect(renderTemplateValue('{v|split(,)|trim(.)}', { v: 'AC-3, SC-37.' })).toEqual(['AC-3', 'SC-37']);
		// trim with no argument is byte-identical to today (regression pin).
		expect(renderTemplate('{v|trim}', { v: '  padded  ' })).toBe('padded');
	});

	it('2.5 reject(<pattern>) drops an item, leaving an empty list', () => {
		expect(renderTemplateValue('{v|split(,)|reject(^\\[None\\]$)}', { v: '[None]' })).toEqual([]);
		expect(renderTemplateValue('{v|split(,)|reject(^\\[None\\]$)}', { v: 'AC-3, [None], AC-5' })).toEqual([
			'AC-3',
			'AC-5',
		]);
	});

	it('2.8 join(<sep>) consumes a list back into a scalar', () => {
		expect(renderTemplateValue('{v|split(,)|join(; )}', { v: 'a,b' })).toBe('a; b');
		expect(renderTemplate('prefix {v|split(,)|join(/)} suffix', { v: 'a, b' })).toBe('prefix a/b suffix');
	});

	it('2.9 join on a scalar is the identity, so it composes harmlessly', () => {
		expect(renderTemplateValue('{v|join(,)}', { v: 'plain' })).toBe('plain');
	});

	it('2.10 a list reaching a text template is an error naming join (L3)', () => {
		expect(() => renderTemplate('x {v|split(,)} y', { v: 'a,b' })).toThrow(RenderError);
		expect(() => renderTemplate('x {v|split(,)} y', { v: 'a,b' })).toThrow('join(<sep>)');
		// Two interpolations is also a text context.
		expect(() => renderTemplate('{v|split(,)}{v}', { v: 'a,b' })).toThrow('join(<sep>)');
	});

	it('2.11 wikilink decorates each item', () => {
		expect(renderTemplateValue('{v|split(,)|wikilink}', { v: 'a,b' })).toEqual(['[[a]]', '[[b]]']);
	});

	it('2.12 wikilink on an absent optional value never produces [[]]', () => {
		expect(renderTemplateValue('{v|optional|wikilink}', {})).toBe('');
		expect(renderTemplate('{v|optional|wikilink}', {})).toBe('');
	});

	it('2.15 regex() with a capture group is finally writable (R2.4 balanced parens)', () => {
		expect(renderTemplate('{v|regex(:\\s*(.+)$)}', { v: 'GV.OC-01: The organizational mission' })).toBe(
			'The organizational mission',
		);
	});

	it('2.16 a `|` inside a filter argument is argument text, not a chain separator (R2.4)', () => {
		expect(renderTemplate('{v|regex(A\\|B)}', { v: 'B' })).toBe('B');
		// Unescaped too: depth > 0 means the pipe is argument text.
		expect(renderTemplate('{v|regex(A|B)}', { v: 'B' })).toBe('B');
	});

	it('2.17 a backslash class reaches RegExp intact (R2.4 backslash rule)', () => {
		expect(renderTemplate('{v|regex([A-Z.]+-\\d+)}', { v: 'see AC-2 now' })).toBe('AC-2');
		expect(renderTemplate('{v|regex(\\s(\\w+)$)}', { v: 'two words' })).toBe('words');
		// The five escaped punctuation characters collapse to ONE literal char, so
		// `\(` reaches RegExp as a grouping paren, not an escaped one. A literal
		// parenthesis is matched via a character class, which the lexer also honours.
		expect(renderTemplate('{v|regex(\\(x\\))}', { v: 'a (x) b' })).toBe('x');
		expect(renderTemplate('{v|regex([(]x[)])}', { v: 'a (x) b' })).toBe('(x)');
	});

	it('R2.4 a regex character class holds literal parens and pipes', () => {
		// `^[^(]+` — an UNBALANCED paren inside a class. Depth counting alone would
		// swallow the rest of the chain; the lexer suspends it inside `[...]`.
		expect(renderTemplate('{v|regex(^[^(]+)|trim}', { v: 'APRA CPG 234 (2)' })).toBe('APRA CPG 234');
		expect(renderTemplate('{v|regex([a|b]+)}', { v: 'zzabz' })).toBe('ab');
	});

	it('2.21 elided items are recorded once, with a count', () => {
		const r = report();
		renderTemplateValue('{v|split(,)|reject(^\\[None\\]$)}', { v: 'AC-3, [None], [None]' }, r);
		const dropped = r.notes.filter((n) => n.code === 'list-items-dropped');
		expect(dropped).toHaveLength(1);
		expect(dropped[0].detail).toContain('2 items');
		expect(dropped[0].detail).toContain('reject');
	});

	it('2.22 list rendering is deterministic', () => {
		const chain = '{v|split(,)|trim(.)|reject(^\\[None\\]$)|curie-prefix(nist-800-53)}';
		const scope = { v: 'AC-3, [None], SC-37.' };
		const first = renderTemplateValue(chain, scope);
		for (let i = 0; i < 25; i++) expect(renderTemplateValue(chain, scope)).toEqual(first);
	});
});

// ---------------------------------------------------------------------------
// The real dirty values from §2.6 — the whole reason this design exists
// ---------------------------------------------------------------------------

describe('capability 2 — the real dirty values', () => {
	it('NIST 800-53 `related`: terminal period stripped, [None] sentinel dropped', () => {
		const chain = '{related|optional|split(,)|trim(.)|reject(^\\[None\\]$)}';
		expect(renderTemplateValue(chain, { related: 'AC-3, AC-5, AC-6, SC-37.' })).toEqual([
			'AC-3',
			'AC-5',
			'AC-6',
			'SC-37',
		]);
		expect(renderTemplateValue(chain, { related: '[None]' })).toEqual([]);
		// An absent cell becomes '' at `optional`, then the produce step turns that
		// into an empty list — which the managed sink omits, same as an empty scalar.
		expect(renderTemplateValue(chain, {})).toEqual([]);
		// Same chain, different sink: CURIEs for Tier 2 closure.
		expect(
			renderTemplateValue(
				'{related|optional|split(,)|trim(.)|reject(^\\[None\\]$)|curie-prefix(nist-800-53)}',
				{ related: 'AC-3, SC-37.' },
			),
		).toEqual(['nist-800-53:AC-3', 'nist-800-53:SC-37']);
	});

	it('MITRE ATT&CK `tactics`: a clean list property, not 800 minted links', () => {
		expect(
			renderTemplateValue('{tactics|optional|split(,)|trim}', {
				tactics: 'defense-evasion, privilege-escalation',
			}),
		).toEqual(['defense-evasion', 'privilege-escalation']);
	});

	it('NIST CSF `Informative References`: all three pieces of the design at once', () => {
		const cell = [
			'CCM v4.0: BCR-01',
			'SP 800-53 Rev 5.1.1: CP-2',
			'SP 800-53 Rev 5.1.1: CP-4',
			'CIS CSC v8: 11.1',
		].join('\n');
		const chain =
			"{['Informative References']|optional|split(\\n)|trim|reject(^(?!SP 800-53))|regex(:\\s*(.+)$)|curie-prefix(nist-800-53)}";
		expect(renderTemplateValue(chain, { 'Informative References': cell })).toEqual([
			'nist-800-53:CP-2',
			'nist-800-53:CP-4',
		]);
	});

	it('CRI `Financial Services Mapping References`: the per-item count parenthetical', () => {
		expect(
			renderTemplateValue(
				"{['Financial Services Mapping References']|optional|split(,)|trim|regex(^[^(]+)|trim}",
				{ 'Financial Services Mapping References': 'APRA CPG 234 (2),ASIC (1)' },
			),
		).toEqual(['APRA CPG 234', 'ASIC']);
	});
});

// ---------------------------------------------------------------------------
// Sinks — where a list is allowed to land (contract §2.5)
// ---------------------------------------------------------------------------

const listRecipe = (managed: Record<string, string>, managedLinks?: Record<string, { template: string }>): Recipe => ({
	recipe: 'list-sinks',
	target: {
		layout: [{ level: 'row', mechanism: 'file', template: '{id}.md' }],
		also_emit: { frontmatter: { managed, ...(managedLinks ? { managed_links: managedLinks } : {}) } },
	},
});

describe('capability 2 — sinks', () => {
	it('2.6 a managed key whose chain yields an empty list is omitted entirely', () => {
		const recipe = listRecipe({ related: '{related|optional|split(,)|reject(^\\[None\\]$)}' });
		const a = render(recipe, { curie: 'nist:AC-2', scope: { id: 'AC-2', related: '[None]' } });
		expect('related' in a.frontmatter).toBe(false);
	});

	it('2.7 a managed key whose chain yields a list emits a YAML array', () => {
		const recipe = listRecipe({ tactics: '{tactics|optional|split(,)|trim}' });
		const a = render(recipe, {
			curie: 'mitre-attack:T1055',
			scope: { id: 'T1055', tactics: 'defense-evasion, privilege-escalation' },
		});
		expect(a.frontmatter.tactics).toEqual(['defense-evasion', 'privilege-escalation']);
	});

	it('managed_links takes a list directly, wrapping each item once', () => {
		const recipe = listRecipe({}, { related: { template: '{related|split(,)|trim(.)|reject(^\\[None\\]$)}' } });
		const a = render(recipe, {
			curie: 'nist-800-53:AC-2',
			scope: { id: 'AC-2', related: 'AC-3, [None], SC-37.' },
		});
		expect(a.frontmatter.related).toEqual(['[[AC-3]]', '[[SC-37]]']);
	});

	it('managed_links already-decorated items are not double-wrapped', () => {
		const recipe = listRecipe({}, { related: { template: '{related|split(,)|wikilink}' } });
		const a = render(recipe, { curie: 'x:1', scope: { id: '1', related: 'AC-3, AC-5' } });
		expect(a.frontmatter.related).toEqual(['[[AC-3]]', '[[AC-5]]']);
	});

	it('2.14 managed_links on a scalar (and a numeric cell) is byte-identical to before', () => {
		const recipe = listRecipe({}, { related: { template: '{related}' } });
		const numeric = render(recipe, { curie: 'x:1', scope: { id: '1', related: 5 } });
		expect(numeric.frontmatter.related).toEqual(['[[5]]']);
		const scalar = render(recipe, { curie: 'x:1', scope: { id: '1', related: 'AC-3, AC-5; PM-9' } });
		expect(scalar.frontmatter.related).toEqual(['[[AC-3]]', '[[AC-5]]', '[[PM-9]]']);
	});

	it('2.18 a body projection with format list takes one item per element', () => {
		const projection: BodyProjection = {
			template: '{examples|split(;)|trim}',
			position: 'section',
			heading: 'Implementation examples',
			format: 'list',
		};
		const region = renderBodyProjection(projection, { examples: 'Ex1; Ex2; Ex3' });
		expect(region!.content).toBe('- Ex1\n- Ex2\n- Ex3');
	});

	it('2.19 a body projection with format list fed a newline scalar is unchanged (regression pin)', () => {
		const projection: BodyProjection = { template: '{examples}', format: 'list' };
		const region = renderBodyProjection(projection, { examples: 'Ex1\nEx2\n\nEx3' });
		expect(region!.content).toBe('- Ex1\n- Ex2\n- Ex3');
	});

	it('a body projection with a non-list format rejects a list (L3)', () => {
		const projection: BodyProjection = { template: '{examples|split(;)}', format: 'quote' };
		expect(() => renderBodyProjection(projection, { examples: 'a; b' })).toThrow(RenderError);
	});

	it('an empty list body projection is omitted like an empty scalar (regression pin)', () => {
		const projection: BodyProjection = { template: '{v|split(,)|reject(.)}', format: 'list' };
		expect(renderBodyProjection(projection, { v: 'a,b' })).toBeNull();
	});

	it('2.20 a list may not drive a layout template — variadic remains the only mechanism', () => {
		const recipe: Recipe = {
			recipe: 'list-into-folder',
			target: {
				layout: [
					{ level: 'family', mechanism: 'folder', template: '{parts|split(.)}' },
					{ level: 'row', mechanism: 'file', template: '{id}.md' },
				],
			},
		};
		expect(() => render(recipe, { curie: 'x:1', scope: { id: '1', parts: 'A.B.C' } })).toThrow(RenderError);
		expect(() => render(recipe, { curie: 'x:1', scope: { id: '1', parts: 'A.B.C' } })).toThrow('join(<sep>)');
	});
});

// ---------------------------------------------------------------------------
// Capability 3 — delimiter-set part/prefix filters (spec §2.1, 2026-09-14)
// ---------------------------------------------------------------------------

describe('capability 3 — delimiter-set part/prefix filters', () => {
	it('3.1 part(<delims>,<index>) indexes pieces split on ANY set character (A5)', () => {
		expect(renderTemplate('{v|part(.-,1)}', { v: 'A.B.C-D' })).toBe('B');
		expect(renderTemplate('{v|part(.-,2)}', { v: 'A.B.C-D' })).toBe('C');
	});

	it('3.2 prefix(<delims>,<index>) truncates the original, delimiters preserved (A5)', () => {
		expect(renderTemplate('{v|prefix(.-,2)}', { v: 'A.B.C-D' })).toBe('A.B.C');
		expect(renderTemplate('{v|prefix(.-,3)}', { v: 'A.B.C-D' })).toBe('A.B.C-D');
	});

	it('3.3 packed CRI id: every level of GV.OC-01.01 is reachable', () => {
		const v = 'GV.OC-01.01';
		expect(renderTemplate('{v|prefix(.-,0)}', { v })).toBe('GV');
		expect(renderTemplate('{v|prefix(.-,1)}', { v })).toBe('GV.OC');
		expect(renderTemplate('{v|prefix(.-,2)}', { v })).toBe('GV.OC-01');
		expect(renderTemplate('{v|part(.-,3)}', { v })).toBe('01');
	});

	it('3.4 a single-character set equals split (D length 1 is legal, spec §2.1)', () => {
		expect(renderTemplate('{v|part(.,1)}', { v: 'AA.01' })).toBe(renderTemplate('{v|split(.,1)}', { v: 'AA.01' }));
		expect(renderTemplate('{v|part(.,1)}', { v: 'AA.01' })).toBe('01');
	});

	it('3.5 out-of-range index yields empty with the named note (A8)', () => {
		const r = report();
		expect(renderTemplate('{v|part(.-,9)}', { v: 'A.B.C-D' }, r)).toBe('');
		expect(codes(r)).toContain('part-index-missing');
		const p = report();
		expect(renderTemplate('{v|prefix(.-,9)}', { v: 'A.B.C-D' }, p)).toBe('');
		expect(codes(p)).toContain('prefix-index-missing');
	});

	it('3.6 no set character present: index 0 is the whole value, higher indexes note part-no-delimiter (A8)', () => {
		expect(renderTemplate('{v|part(.-,0)}', { v: 'PLAIN' })).toBe('PLAIN');
		const r = report();
		expect(renderTemplate('{v|part(.-,1)}', { v: 'PLAIN' }, r)).toBe('');
		expect(codes(r)).toContain('part-no-delimiter');
	});

	it('3.7 escapes: a comma or paren in the set is written \\\\, and \\\\)', () => {
		expect(renderTemplate('{v|part(\\,\\),1)}', { v: 'a,b)c' })).toBe('b');
		expect(renderTemplate('{v|prefix(\\,\\),1)}', { v: 'a,b)c' })).toBe('a,b');
	});

	it('3.8 part(<delims>) produces the trimmed non-empty piece list (A8)', () => {
		expect(renderTemplateValue('{v|part(.-)}', { v: 'GV.OC-01' })).toEqual(['GV', 'OC', '01']);
	});

	it('3.9 per-item lifting: part/prefix map over a list like every filter (A8)', () => {
		expect(renderTemplateValue('{v|split(;)|part(.-,0)}', { v: 'GV.OC-01;GV.OC-02' })).toEqual(['GV', 'GV']);
		expect(renderTemplateValue('{v|split(;)|prefix(.-,1)}', { v: 'GV.OC-01;GV.OC-02' })).toEqual([
			'GV.OC',
			'GV.OC',
		]);
	});

	it('3.10 empty pieces are dropped before indexing, and prefix keeps the original text (A5)', () => {
		expect(renderTemplate('{v|part(.,1)}', { v: 'A..B' })).toBe('B');
		// Truncation rule for repeated delimiters: prefix ends at the END of the
		// indexed non-empty piece (the last character of `B` here), so every
		// delimiter BEFORE the piece survives and a delimiter AFTER it does not.
		// For `A..B` the second dot sits after the piece boundary and is dropped.
		expect(renderTemplate('{v|prefix(.,1)}', { v: 'A..B' })).toBe('A..B');
	});

	it('3.11 values are trimmed before splitting', () => {
		expect(renderTemplate('{v|part(.-,0)}', { v: '  GV  ' })).toBe('GV');
		expect(renderTemplate('{v|prefix(.-,1)}', { v: ' GV.OC-01 ' })).toBe('GV.OC');
	});

	it('3.12 empty delimiter set is a RenderError, like split', () => {
		expect(() => renderTemplateValue('{v|part()}', { v: 'A.B' })).toThrow(RenderError);
		expect(() => renderTemplateValue('{v|part(,0)}', { v: 'A.B' })).toThrow(RenderError);
		expect(() => renderTemplate('{v|prefix(,0)}', { v: 'A.B' })).toThrow(RenderError);
	});

	it('3.13 prefix without an index is an error; there is no list form', () => {
		expect(() => renderTemplateValue('{v|prefix(.-)}', { v: 'A.B.C' })).toThrow(RenderError);
	});
});
