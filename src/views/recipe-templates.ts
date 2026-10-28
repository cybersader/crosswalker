/**
 * recipe-templates.ts — Phase 4b reference templates per shipped recipe.
 *
 * Each shipped recipe in `recipes/v0-1/*.json` is paired with a `` ```base ``
 * codeblock template here. The Phase 4b picker uses these to translate
 * recipe + user params → the block text that gets inserted at cursor.
 *
 * Templates use `{{param_name}}` Mustache-style placeholders. The picker's
 * parameter editor's output (`Record<string, unknown>`) flows through
 * `renderRecipeTemplate(id, params)` to produce the final block text.
 *
 * NOTE: These templates are intentionally MINIMAL — they include the
 * essential `views:` block for the shape but skip the heavy comments from
 * `templates/coverage-matrix.base`. Comments live in the .base file shipped
 * by Phase 3's first-run write; the picker's inserted block is meant to be
 * concise inline content in a user's note.
 *
 * WITHDRAWN (2026-08-21, Challenge 45): `orphan-controls-no-evidence`.
 *
 * It filtered control notes on `length(evidence) == 0`. No recipe has ever
 * emitted an `evidence` property, so the filter matched every control and the
 * view reported total non-coverage regardless of the truth — a confident,
 * well-formatted, wrong answer on exactly the question a compliance reader
 * trusts most.
 *
 * The deeper reason it is not simply fixed: a Bases filter selects from the set
 * of notes that exist. "Controls with no evidence" is a claim about a
 * relationship that does NOT exist, so there is no row for the filter to keep.
 * No property name would have rescued it. That query lives in Tier 2, where a
 * LEFT JOIN can report absence — see `conceptsWithoutValidEvidence` in
 * `src/tier2/evidence-coverage.ts`.
 */

const TEMPLATES: Record<string, string> = {
	'nist-csf-coverage-matrix': `filters:
  and:
{{#mapping_set}}    - 'note._crosswalker.import_set.id == "{{mapping_set}}"'
    - 'kind == "crosswalk-edge"'
{{/mapping_set}}{{^mapping_set}}    - file.inFolder("_crosswalker/mappings/csf-to-800-53")
{{/mapping_set}}    - 'confidence >= {{confidence_threshold}}'
    - or:
        - predicate_modifier.isEmpty()
        - 'predicate_modifier != "NOT"'
views:
  - type: crosswalker-pivot
    name: "{{#mapping_set}}Mapping coverage matrix{{/mapping_set}}{{^mapping_set}}NIST CSF → 800-53 coverage matrix{{/mapping_set}}"
    config:
      rowsBy: "subject_id"
      colsBy: "object_id"
      cellOp: "count"
      empty: "gap"
      heatmap: true`,

	'nist-csf-to-mitre-coverage': `filters:
  and:
{{#mapping_set}}    - 'note._crosswalker.import_set.id == "{{mapping_set}}"'
    - 'kind == "crosswalk-edge"'
{{/mapping_set}}{{^mapping_set}}    - file.inFolder("_crosswalker/mappings/csf-to-mitre")
{{/mapping_set}}    - 'confidence >= {{confidence_threshold}}'
    - or:
        - predicate_modifier.isEmpty()
        - 'predicate_modifier != "NOT"'
{{#tactic_filter}}    - 'tactic == "{{tactic_filter}}"'
{{/tactic_filter}}views:
  - type: crosswalker-pivot
    name: "{{#mapping_set}}Mapping coverage matrix by tactic{{/mapping_set}}{{^mapping_set}}NIST CSF → MITRE ATT&CK coverage{{/mapping_set}}"
    config:
      rowsBy: "subject_id"
      colsBy: "object_id"
      cellOp: "count"
      empty: "gap"
      heatmap: true`,

	// Spans every mapping set, so it selects mapping notes by identity (every
	// crosswalk edge carries kind: crosswalk-edge, whichever writer made it),
	// not by the demo folder it used to name. It has no set param, so a saved
	// query regenerates with this filter. That is the one deliberate exception
	// to byte-identical regeneration: the old folder filter found nothing outside
	// the demo vault, and the release record note (kind: mapping-set) that sits
	// beside the edges is no longer counted as a mapping.
	'crosswalk-density-by-framework': `filters:
  and:
    - 'kind == "crosswalk-edge"'
    - or:
        - predicate_modifier.isEmpty()
        - 'predicate_modifier != "NOT"'
formulas:
  pair: 'source_framework + " → " + target_framework'
views:
  - type: table
    name: "Crosswalk density by framework pair"
    order:
      - formula.pair
      - file.name
    summaries:
      file.name: Count`,

	// 'orphan-controls-no-evidence' is DELIBERATELY ABSENT. See the withdrawal
	// note in this module's doc comment. Use conceptsWithoutValidEvidence() in
	// src/tier2/evidence-coverage.ts instead; a Bases filter cannot express it.

	// Positive evidence report. This is what Bases CAN answer honestly: it lists
	// junction notes that exist and qualify. It deliberately does not attempt a
	// count of controls, because the controls with no junction have no note here
	// to count. Validity mirrors src/tier2/evidence-coverage.ts; the two must be
	// changed together or a reader gets different answers from the same vault.
	'evidence-junctions-by-control': `filters:
  and:
    - 'kind == "junction-note"'
    - 'predicate == "has_evidence"'
    - 'status == "approved"'
    - or:
        - 'coverage == "full"'
        - 'coverage == "partial"'
views:
  - type: table
    name: "Approved evidence links by control"
    order:
      - subject
      - object
      - coverage
      - review_date
    summaries:
      subject: Count`,

	// TODO: a default wizard import turns a family column into a folder level and writes no family property, so family_filter matches nothing there.
	'controls-by-family-list': `filters:
  and:
{{#framework_set}}    - 'note._crosswalker.import_set.id == "{{framework_set}}"'
{{/framework_set}}{{^framework_set}}    - file.inFolder("Frameworks/CIS-Controls-v8")
{{/framework_set}}{{#family_filter}}    - 'family == "{{family_filter}}"'
{{/family_filter}}views:
  - type: list
    name: "{{#framework_set}}Controls by family{{/framework_set}}{{^framework_set}}CIS Controls by family{{/framework_set}}"
    order:
      - family
      - id`,

	'skos-hierarchy-narrower': `filters:
  and:
{{#framework_set}}    - 'note._crosswalker.import_set.id == "{{framework_set}}"'
{{/framework_set}}{{^framework_set}}    - file.inFolder("Frameworks/MITRE-ATT&CK")
{{/framework_set}}views:
  # Hierarchy renderer ships in v0.1.7-v0.1.8 — Bases falls back to
  # table view until then. The data + structure are correct; only the
  # custom visualization is "renderer coming soon".
{{#framework_set}}  - type: table
    name: "Framework hierarchy"
    order:
      - file.folder
      - parent
      - file.name
{{/framework_set}}{{^framework_set}}  - type: table
    name: "MITRE ATT&CK tactic → technique hierarchy"
    order:
      - tactic
      - parent
      - id
      - title{{/framework_set}}`,
};

/**
 * Get the raw template for a recipe ID, or null if no template is registered.
 */
export function getRecipeTemplate(recipeId: string): string | null {
	return TEMPLATES[recipeId] ?? null;
}

/**
 * Render a recipe template with user-supplied param values. Supports:
 *   - Simple substitution: `{{name}}` → params[name]
 *   - Section conditional: `{{#name}}...{{/name}}` → block content only if
 *     params[name] is truthy (non-empty string, non-zero number, true)
 *   - Inverted section: `{{^name}}...{{/name}}` → block content only if
 *     params[name] is NOT truthy. Templates pair the two so a saved query
 *     whose params predate a new param (e.g. the chosen set) regenerates
 *     byte-identically to the template it was created from.
 *
 * Unknown params in the template (no value in `params`) substitute as empty
 * string — the picker's UI should ensure all params have at least their
 * default, so unknown-param case is defensive.
 */
export function renderRecipeTemplate(
	recipeId: string,
	params: Record<string, unknown>,
): string | null {
	const template = getRecipeTemplate(recipeId);
	if (template === null) return null;
	return interpolate(template, params);
}

export function interpolate(template: string, params: Record<string, unknown>): string {
	// 1. Sections: {{#name}}...{{/name}} renders when params[name] is truthy,
	//    {{^name}}...{{/name}} when it is not. Blocks may nest other names.
	// 2. Plain substitutions: {{name}}
	return interpolatePlain(renderSections(template, params), params);
}

function renderSections(s: string, params: Record<string, unknown>): string {
	return s.replace(/\{\{([#^])([\w_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_match, sigil: string, name: string, block: string) => {
		const show = sigil === '#' ? isTruthy(params[name]) : !isTruthy(params[name]);
		return show ? renderSections(block, params) : '';
	});
}

function isTruthy(v: unknown): boolean {
	return (
		(typeof v === 'string' && v.length > 0) ||
		(typeof v === 'number' && v !== 0) ||
		(typeof v === 'boolean' && v) ||
		(Array.isArray(v) && v.length > 0)
	);
}

function interpolatePlain(s: string, params: Record<string, unknown>): string {
	return s.replace(/\{\{([\w_]+)\}\}/g, (_match, name) => {
		const v = params[name];
		if (v === undefined || v === null) return '';
		return String(v);
	});
}
