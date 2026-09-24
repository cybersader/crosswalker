/**
 * recipe-registry.test.ts — the recognized-source registry (spec §7m).
 *
 * Verifies the registry loads the bundled import recipes, derives a sane match
 * signature from each recipe's templates, scores sources deterministically, gates
 * confident matches on the structural (identity) column, and reconstructs the
 * workbench mapping via fromRecipe (the round-trip fast path).
 */

import {
	RECIPE_REGISTRY,
	NIST_CATALOG_HEADER_ALIASES,
	applyHeaderAliases,
	canonicalHeaderColumns,
	CONFIDENT_MATCH_THRESHOLD,
	matchScore,
	findRecognizedRecipes,
	bestRecognizedRecipe,
	recipeMapping,
	summarizeRecipeShapes,
	normalizeColumn,
	type RecipeRegistryEntry,
} from '../src/import/recipe-registry';

function entry(id: string): RecipeRegistryEntry {
	const e = RECIPE_REGISTRY.find((r) => r.id === id);
	if (!e) throw new Error(`no registry entry for ${id}`);
	return e;
}

describe('recipe-registry — loading + signatures', () => {
	it('loads the bundled import recipes with ids, labels, and signatures', () => {
		// 9 concept recipes + the olir-crosswalk-edge recipe.
		expect(RECIPE_REGISTRY.length).toBeGreaterThanOrEqual(10);
		for (const e of RECIPE_REGISTRY) {
			expect(e.id).toBeTruthy();
			expect(e.label).toBeTruthy();
			expect(e.description).toBeTruthy();
			expect(e.signatureColumns.length).toBeGreaterThan(0);
		}
	});

	it('derives the NIST CSF CPRT signature from the recipe templates', () => {
		const e = entry('nist-csf-2-cprt');
		// The flat CPRT recipe references these columns in its templates.
		expect(e.signatureColumns).toEqual(
			expect.arrayContaining(['element_identifier', 'title', 'element_type', 'text']),
		);
		// The file-name (identity) column is required.
		expect(e.requiredColumns).toContain('element_identifier');
	});

	it('marks structural (folder/file) columns as required for the nested CPRT recipe', () => {
		const e = entry('nist-csf-2-cprt-hierarchical');
		expect(e.requiredColumns).toContain('element_identifier');
	});

	it('derives CIS control columns with a space in the name', () => {
		const e = entry('cis-controls-v8-controls');
		expect(e.signatureColumns).toEqual(expect.arrayContaining(['CIS Control', 'Title', 'Description']));
		expect(e.requiredColumns).toContain('CIS Control');
	});

	it('has a curated GRC-first label', () => {
		expect(entry('nist-csf-2-cprt').label).toBe('NIST CSF 2.0 (CPRT export)');
		expect(entry('cis-controls-v8-controls').label).toContain('CIS Controls v8');
	});
});

it('recognizes the catalog control-name heading and maps its row value to the recipe name key', () => {
	const catalog = entry('nist-800-53-r5-nested');
	const columns = ['Control Identifier', 'Control (or Control Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];
	expect(NIST_CATALOG_HEADER_ALIASES.name).toContain(columns[1]);
	expect(matchScore(catalog, canonicalHeaderColumns(columns, catalog))).toBe(100);
	const source = { columns, rows: [{
		'Control Identifier': 'ZZ-01', 'Control (or Control Enhancement) Name': 'Synthetic heading',
		'Control Text': 'Synthetic text', Discussion: '', 'Related Controls': '',
	}], rowCount: 1 } as Parameters<typeof applyHeaderAliases>[0];
	const parsed = applyHeaderAliases(source, catalog);
	expect(parsed.rows).toEqual([expect.objectContaining({ name: 'Synthetic heading' })]);
});

describe('recipe-registry — matchScore', () => {
	it('scores a perfect column match at 100', () => {
		const e = entry('cis-controls-v8-controls');
		expect(matchScore(e, ['CIS Control', 'Title', 'Description'])).toBe(100);
	});

	it('normalizes column names (case/punctuation insensitive)', () => {
		const e = entry('cis-controls-v8-controls');
		expect(matchScore(e, ['cis control', 'TITLE', 'description'])).toBe(100);
		expect(normalizeColumn('CIS Control')).toBe('cis_control');
		expect(normalizeColumn('SCF #')).toBe('scf__');
	});

	it('caps the score below the candidate floor when the required column is missing', () => {
		const e = entry('nist-csf-2-cprt');
		// Present: title, element_type, text — but NOT element_identifier (required).
		const score = matchScore(e, ['title', 'element_type', 'text', 'unrelated']);
		expect(score).toBeLessThan(CONFIDENT_MATCH_THRESHOLD);
	});

	it('returns a partial score when only some signature columns are present', () => {
		const e = entry('cis-controls-v8-controls');
		// CIS Control (required) + Title present, Description missing → 2/3.
		const score = matchScore(e, ['CIS Control', 'Title', 'extra_col']);
		expect(score).toBe(67);
	});

	it('is deterministic — independent of source column order', () => {
		const e = entry('cis-controls-v8-controls');
		const a = matchScore(e, ['Title', 'Description', 'CIS Control']);
		const b = matchScore(e, ['CIS Control', 'Title', 'Description']);
		expect(a).toBe(b);
	});
});

describe('recipe-registry — ranking + confident match', () => {
	it('finds a confident recognized recipe for a matching source', () => {
		const cols = ['CIS Control', 'Title', 'Description'];
		const best = bestRecognizedRecipe(cols);
		expect(best).not.toBeNull();
		expect(best!.entry.id).toBe('cis-controls-v8-controls');
		expect(best!.score).toBeGreaterThanOrEqual(CONFIDENT_MATCH_THRESHOLD);
	});

	it('ranks the nested CPRT recipe above the flat one on a tie (more specific first)', () => {
		// Both CPRT recipes reference the same columns; declaration order + specificity
		// put the nested (folder-producing) recipe first.
		const cols = ['element_identifier', 'title', 'element_type', 'text'];
		const ranked = findRecognizedRecipes(cols);
		expect(ranked[0].entry.id).toBe('nist-csf-2-cprt-hierarchical');
	});

	it('returns null for an unrelated source', () => {
		const best = bestRecognizedRecipe(['foo', 'bar', 'baz', 'qux']);
		expect(best).toBeNull();
	});

	it('does not confidently match ATT&CK-style CSV columns (they are not a bundled shape)', () => {
		// The visual-workbench ATT&CK CSV (technique_id,name,tactic,description) must
		// NOT trip the fast path — its columns differ from the mitre recipe signature.
		const best = bestRecognizedRecipe(['technique_id', 'name', 'tactic', 'description']);
		expect(best).toBeNull();
	});
});

describe('recipe-registry — recipe → mapping + shapes', () => {
	it('reconstructs a workbench mapping via fromRecipe (round-trip fast path)', () => {
		const mapping = recipeMapping(entry('nist-csf-2-cprt-hierarchical'));
		expect(mapping.mappings.length).toBeGreaterThan(0);
		// The nested recipe carries folder structure — at least one structural level.
		const anyFolder = mapping.mappings.some((m) =>
			m.levels.some((l) => l.destinations.some((d) => d.primitive === 'folder')),
		);
		expect(anyFolder).toBe(true);
	});

	it('summarizes the vault shapes a recipe produces', () => {
		expect(summarizeRecipeShapes(entry('nist-csf-2-cprt-hierarchical'))).toEqual(
			expect.arrayContaining(['folders', 'properties']),
		);
		// A flat recipe produces properties but no folders.
		expect(summarizeRecipeShapes(entry('cis-controls-v8-controls'))).not.toContain('folders');
	});
});

describe('recipe-registry — routing kind (crosswalk vs concept)', () => {
	it('registers the crosswalk-edge recipe', () => {
		const e = entry('olir-crosswalk-edge');
		expect(e.label).toContain('Crosswalk');
		expect(e.description).toBeTruthy();
	});

	it('routes ordinary concept recipes as "concept"', () => {
		expect(entry('nist-csf-2-cprt-hierarchical').routingKind).toBe('concept');
		expect(entry('cis-controls-v8-controls').routingKind).toBe('concept');
		expect(entry('mitre-attack-technique-flat').routingKind).toBe('concept');
	});

	it('routes the crosswalk recipe distinctly, read off the leaf layout entry\'s declared kind', () => {
		expect(entry('olir-crosswalk-edge').routingKind).toBe('crosswalk-edge');
	});

	it('confidently recognizes an OLIR-style crosswalk export (the crosswalk-from-olir.ts output shape)', () => {
		// tools/crosswalk-from-olir.ts emits exactly these columns per row.
		const cols = [
			'subject_id',
			'object_id',
			'subject_group',
			'object_group',
			'source_framework',
			'target_framework',
			'strm_predicate',
			'sssom_predicate',
			'mapping_justification',
			'mapping_provider',
			'match_confidence',
		];
		const best = bestRecognizedRecipe(cols);
		expect(best).not.toBeNull();
		expect(best!.entry.id).toBe('olir-crosswalk-edge');
		expect(best!.entry.routingKind).toBe('crosswalk-edge');
		expect(best!.score).toBe(100);
	});

	it('does NOT confidently match a raw SSSOM TSV export (a different, incompatible column shape)', () => {
		// Raw SSSOM (tools/fixtures/realistic/*.sssom.tsv, recipes/import/crosswalks/*.sssom.tsv)
		// uses predicate_id/confidence, not the crosswalk-edge recipe's strm_predicate/
		// match_confidence/subject_group/object_group/source_framework/target_framework —
		// it is pre-crosswalk-from-olir.ts input, not that tool's output. This is a known,
		// deliberate no-match: raw SSSOM has its own dedicated importer (sssom-importer.ts),
		// not the generic recognized-source fast path.
		const cols = ['subject_id', 'predicate_id', 'object_id', 'match_type', 'mapping_justification', 'mapping_provider'];
		const best = bestRecognizedRecipe(cols);
		expect(best).toBeNull();
	});
});

describe('recipe-registry — curated defaults (suggestedFolder + recommendedEnrichment)', () => {
	it('gives every entry a non-empty suggested destination folder', () => {
		for (const e of RECIPE_REGISTRY) {
			expect(e.suggestedFolder).toBeTruthy();
			expect(e.suggestedFolder.length).toBeGreaterThan(0);
		}
	});

	it('gives every entry a well-shaped enrichment hint with a rationale', () => {
		for (const e of RECIPE_REGISTRY) {
			expect(['none', 'tags-only', 'notes']).toContain(e.recommendedEnrichment.facetNotes);
			expect(typeof e.recommendedEnrichment.childrenLists).toBe('boolean');
			expect(e.recommendedEnrichment.rationale).toBeTruthy();
			if (e.recommendedEnrichment.facetNotes !== 'none') {
				expect(e.recommendedEnrichment.facetField).toBeTruthy();
			}
		}
	});

	it('recommends a tactic facet for MITRE ATT&CK (the clearest single facet in the corpus)', () => {
		const e = entry('mitre-attack-technique-flat');
		expect(e.recommendedEnrichment.facetNotes).toBe('notes');
		expect(e.recommendedEnrichment.facetField).toBe('tactic');
	});

	it('recommends no facet for single-column identity-only shapes', () => {
		expect(entry('nist-csf-2-flat').recommendedEnrichment.facetNotes).toBe('none');
		expect(entry('cis-controls-v8-controls').recommendedEnrichment.facetNotes).toBe('none');
	});

	it('does not recommend a facet hub for crosswalk edges (they route through the query layer)', () => {
		expect(entry('olir-crosswalk-edge').recommendedEnrichment.facetNotes).toBe('none');
	});

	it('curated copy avoids em dashes (UI-copy convention)', () => {
		for (const e of RECIPE_REGISTRY) {
			expect(e.label).not.toMatch(/—/);
			expect(e.description).not.toMatch(/—/);
			expect(e.recommendedEnrichment.rationale).not.toMatch(/—/);
		}
	});
});

describe('recipe-registry — real-world corpus confusion table (pinned regressions)', () => {
	// Column sets below are transcribed headers from real exports found in the
	// (gitignored, local-only) Frameworks/ corpus during the 2026-07-11 threshold
	// tuning pass — no framework content, just column names.

	it('confidently matches a full CIS Controls v8.1.2 export (true positive, 100)', () => {
		const cols = ['CIS Control', 'CIS Safeguard', 'Asset Class', 'Security Function', 'Title', 'Description', 'IG1', 'IG2', 'IG3'];
		const best = bestRecognizedRecipe(cols);
		expect(best?.entry.id).toBe('cis-controls-v8-flat');
		expect(best?.score).toBe(100);
	});

	it('does NOT confidently match a CIS "Change Log" sheet (real near-miss that used to false-positive at threshold 75)', () => {
		// Real shape: the Change Log workbook renames Asset Class/Security Function/
		// Description to "... v8.1", so 6 of `cis-controls-v8-flat`'s 9 signature
		// columns match — a genuine full-catalog column rename, not the safeguard
		// catalog itself.
		//
		// SCORE REPINNED 2026-08-26: 75 -> 67. `Description` moved from a managed
		// property to an `also_emit.body` section in the Wave 2 content rewrite, and
		// `deriveSignature` now counts body columns (they are source-shape facts, not
		// rendering choices), so this recipe's signature legitimately grew from 8
		// columns to 9 and 6/9 = 67. The invariant this test exists for is unchanged
		// and now holds with more margin. The `ranked[0]` assertion below is a real
		// REGRESSION FIX, not a repin: while body columns were missing,
		// `cis-controls-v8-controls` had shrunk to a 2-column signature and scored
		// 100 here — the exact confident false positive the 90 threshold was tuned to
		// prevent. All four Change Log sheets in the local corpus false-positived
		// that way; none do now.
		const cols = [
			'CIS Control',
			'CIS Safeguard',
			'Asset Class v8.1',
			'Security Function v8.1',
			'Title',
			'Description v8.1',
			'IG1',
			'IG2',
			'IG3',
		];
		const ranked = findRecognizedRecipes(cols);
		expect(ranked[0]?.entry.id).toBe('cis-controls-v8-flat');
		expect(ranked[0]?.score).toBe(67);
		expect(bestRecognizedRecipe(cols)).toBeNull();
	});

	it('confidently matches the real NIST_SP-800-53_rev5_catalog_load.csv column shape (true positive, 100)', () => {
		const cols = ['identifier', 'name', 'control_text', 'discussion', 'related'];
		const best = bestRecognizedRecipe(cols);
		expect(best?.entry.id).toBe('nist-800-53-r5-flat');
		expect(best?.score).toBe(100);
	});

	it('does not surface the real sp800-53ar5-assessment-procedures.csv shape at all', () => {
		// A genuinely different NIST export (assessment procedures, not the control
		// catalog). Verbatim header of Frameworks/sp800-53ar5-assessment-procedures.csv.
		//
		// REPINNED 2026-08-26 (was: ranked[0] = nist-800-53-r5-flat at 50). This test
		// and "returns a partial score" are mutually incompatible under ANY uniform
		// signature rule, so one had to move; this is the one whose exact number was
		// incidental. The 800-53 recipe consumes four columns (identifier, name,
		// control_text, discussion — the last two as body sections since Wave 2), and
		// this sheet supplies one of them, so 1/4 = 25, below CANDIDATE_FLOOR.
		//
		// REPINNED AGAIN 2026-08-26, same reason, one column later (was 25). The
		// recipe now also consumes `related` — as a `related_curies` CURIE array and
		// as the "## Related controls" body links, both unblocked by the per-item
		// transformation capability. That makes the signature five columns, and this
		// sheet still supplies exactly one, so 1/5 = 20. The number moved; the two
		// invariants this test exists for did not, and now hold with MORE margin
		// (20 is further below the 40 floor than 25 was).
		//
		// Dropping out of the candidate list is the better answer, not a loss: none of
		// `name`, `control_text` or `discussion` carries an `optional` filter, so
		// pointing this recipe at this sheet fails EVERY row with a render error.
		// Offering it as an informational "maybe" was offering a recipe that cannot
		// run. The two invariants that matter are unchanged: the assessment export is
		// not confidently matched, and it is not mistaken for the control catalog.
		const cols = ['family', 'identifier', 'sort-as', 'control-name', 'assessment-objective', 'EXAMINE', 'INTERVIEW', 'TEST'];
		expect(bestRecognizedRecipe(cols)).toBeNull();
		expect(matchScore(entry('nist-800-53-r5-flat'), cols)).toBe(20);
		expect(findRecognizedRecipes(cols)).toEqual([]);
	});

	it('confidently matches a full SCF 2026 export (true positive, 100)', () => {
		// FIXTURE REPINNED 2026-08-26. The previous 5-column list was a hand-typed
		// EXCERPT, so when the recipe's signature grew (Wave 2 added four managed
		// properties and twelve body sections; deriveSignature now counts body
		// columns) the excerpt silently matched 2 of 19 and this recipe vanished from
		// the results — a fixture defect, not a matcher regression. Replaced with the
		// verbatim leading header block of the "SCF 2026.1" sheet in
		// Frameworks/Secure.Controls.Framework.SCF.-.2026.1.1.xlsx: 26 of that sheet's
		// 369 columns, chosen because they contain every column the recipe reads. The
		// remaining ~343 are authoritative-source mapping columns the recipe ignores
		// and that cannot move the score (matchScore only counts signature columns).
		//
		// Header text is verbatim including the embedded newlines Excel stores in
		// these cells; normalizeColumn maps "\n" and " " to the same "_", which is why
		// "PPTDF\nApplicability" matches the recipe's `{PPTDF Applicability}`. Column
		// NAMES only, no framework content: the SCF workbook is CC BY-ND, local-only.
		const cols = [
			'SCF Domain',
			'SCF Control',
			'SCF #',
			'Secure Controls Framework (SCF)\nControl Description',
			'Conformity Validation\nCadence',
			'Evidence Request List (ERL) #',
			'Possible Solutions & Considerations\nMicro-Small Business (<10 staff)\nBLS Firm Size Classes 1-2',
			'Possible Solutions & Considerations\nSmall Business (10-49 staff)\nBLS Firm Size Classes 3-4',
			'Possible Solutions & Considerations\nMedium Business (50-249 staff)\nBLS Firm Size Classes 5-6',
			'Possible Solutions & Considerations\nLarge Business (250-999 staff)\nBLS Firm Size Classes 7-8',
			'Possible Solutions & Considerations\nEnterprise (> 1,000 staff)\nBLS Firm Size Class 9',
			'SCF Control Question',
			'Relative Control Weighting',
			'PPTDF\nApplicability',
			'NIST CSF\nFunction Grouping',
			'SCRM Focus\n\nTIER 1\nSTRATEGIC',
			'SCRM Focus\n\nTIER 2\nOPERATIONAL',
			'SCRM Focus\n\nTIER 3\nTACTICAL',
			'SCR-CMM Level 0\nNot Performed',
			'SCR-CMM Level 1\nPerformed Informally',
			'SCR-CMM Level 2\nPlanned & Tracked',
			'SCR-CMM Level 3\nWell Defined',
			'SCR-CMM Level 4\nQuantitatively Controlled',
			'SCR-CMM Level 5\nContinuously Improving',
			'SCF\nCommunity Derived',
			'SCF\nSCRMS',
		];
		const best = bestRecognizedRecipe(cols);
		expect(best?.entry.id).toBe('scf-2026-flat');
		expect(best?.score).toBe(100);
	});

	it('does NOT surface a narrower SCF subset sheet missing the Domain column (real near-miss)', () => {
		// FIXTURE REPINNED 2026-08-26, same excerpt defect as the test above: the
		// previous 4-column list was hand-typed. This is the verbatim header row of
		// the "Data Privacy Mgmt Principles" sheet of the same workbook (all 38
		// columns, so nothing that could raise the score is hidden).
		//
		// SCORE MOVED 75 -> 16, and the recipe now falls below CANDIDATE_FLOOR rather
		// than ranking first. Both follow from the same fact: the sheet supplies 3 of
		// the 19 columns the recipe consumes (SCF Control, SCF #, and the control
		// description), and none of the other 16 carries an `optional` filter, so this
		// recipe would fail every row of this sheet with a render error. "Not offered
		// at all" is the correct answer for a source the recipe cannot run against;
		// the old 75 was an artifact of comparing against a 4-column signature.
		//
		// The pinned invariant is unchanged and now holds with far more margin: a
		// narrower SCF subset must never be auto-selected as a full SCF import.
		const cols = [
			'#',
			'Principle Name',
			'SCF Data Privacy Management Principle (SCF-DPMP) Description',
			'SCF Control',
			'SCF #',
			'Secure Controls Framework (SCF)\nControl Description',
			'AICPA\nTSC 2017:2022 (used for SOC 2)',
			'APEC\nPrivacy Framework\n2015',
			'GAPP',
			'ISO\n27701 \n2025',
			'ISO\n29100\n2024',
			'NIST Privacy Framework\n1.0',
			'NIST\n800-53\nR5',
			'NIST\n800-53B R5\n(privacy)',
			'NIST\nCSF\n2.0',
			'OECD\nPrivacy Principles',
			'US\nData Privacy Framework (DPF)',
			'US\nFIPPS',
			'US\nHIPAA Administrative Simplification\n2013',
			'US - AK\nPIPA',
			'US - CA\nCCPA\n2025',
			'US - CO\nColorado Privacy Act',
			'US - IL\nBIPA',
			'US - IL\nIPA',
			'US - IL\nPIPA',
			'US - NV\nSB220',
			'US - OR\nCPA',
			'US - TN\nTennessee Information Protection Act',
			'US - TX\nBC521',
			'US - VA\nCDPA\n2025',
			'US - VT\nAct 171 of 2018',
			'EMEA\nEU\nGDPR',
			'EMEA\nSaudi Arabia\nPersonal Data Protection Law (PDPL)',
			'APAC\nAustralia\nPrivacy Act',
			'APAC\nAustralian Privacy Principles',
			'APAC\nIndia\nDPDPA 2023',
			'APAC\nNew Zealand Privacy Act of 2020',
			'Americas\nCanada\nPIPEDA',
		];
		expect(matchScore(entry('scf-2026-flat'), cols)).toBe(16);
		expect(findRecognizedRecipes(cols)).toEqual([]);
		expect(bestRecognizedRecipe(cols)).toBeNull();
	});

	it('counts also_emit.body columns in the signature (the Wave 2 regression this table caught)', () => {
		// Pins the rule directly rather than only through its consequences: where a
		// recipe puts a column's prose (a YAML property vs a `## Description` body
		// section) is a rendering choice, but whether the source CARRIES that column
		// is a source-shape fact, and only the second is the matcher's business.
		// Wave 2 moved prose out of `managed` into `also_emit.body` in five recipes;
		// before this rule they silently left the match signature and
		// cis-controls-v8-controls fell to two columns.
		expect(entry('cis-controls-v8-controls').signatureColumns).toContain('Description');
		expect(entry('nist-800-53-r5-flat').signatureColumns).toEqual(
			expect.arrayContaining(['control_text', 'discussion']),
		);
		expect(entry('nist-csf-2-flat').signatureColumns).toContain('Implementation Examples');
		expect(entry('mitre-attack-technique-flat').signatureColumns).toEqual(
			expect.arrayContaining(['description', 'detection', 'system requirements']),
		);

		// And the counterpart rule: an `optional` column still counts. Discounting
		// optional columns was measured against the local corpus and REJECTED (it
		// collapses the MITRE signature to 3 and auto-matches six unrelated ATT&CK
		// sheets); see the module doc comment in recipe-registry.ts.
		expect(entry('mitre-attack-technique-flat').signatureColumns).toContain('platforms');
	});
});
