/**
 * provenance.ts — _crosswalker provenance block writer
 *
 * Emits the `_crosswalker` frontmatter block per `spec/tier1.schema.json`
 * (#/$defs/provenance_block). Captures what produced the note, when, from
 * which source, against which recipe.
 *
 * Pure function. Same inputs (excluding `produced_at` which is always
 * `new Date().toISOString()` at call time) → same output.
 *
 * `recipeHash` / `conceptCid` are pass-through only — this module never
 * computes them. Computation lives in ./hash.ts (`computeRecipeHash`,
 * `computeConceptCid`); call sites in generation-engine.ts and
 * tests/helpers/golden-vault.ts compute them and pass the results in here.
 * See hash.ts's doc comments for the exact, load-bearing field-set
 * definitions (Ch 43 deliverable §2, `.workspace/2026-07-11-challenge-43-
 * version-migration-deliverable.md`).
 */

import type { ImportSetReference } from './import-set';
import type { ReviewGroupCids } from './hash';

const SPEC_VERSION = 'https://crosswalker.dev/spec/tier1.schema.json';

export interface ProvenanceInput {
	/** Optional: the recipe id (e.g., 'nist-allfolders') */
	recipeId?: string;
	/** Optional: hash of the recipe content (sha256-... format) */
	recipeHash?: string;
	/** Optional: the source file the row came from */
	sourceFile?: string;
	/** Optional: source URL if fetched remotely */
	sourceUrl?: string;
	/** Optional: source ontology CURIE prefix (`nist:_`, `iso27001:_`) */
	sourceCurie?: string;
	/** Optional: source version string ('rev 5', '2022', 'v8.1') */
	sourceVersion?: string;
	/** Optional: hash of the source file at import time */
	sourceHash?: string;
	/** Optional only for legacy/direct callers; generation always stamps ownership. */
	importSet?: ImportSetReference;
	/** Optional: the canonical concept identity content hash */
	conceptCid?: string;
	/**
	 * Optional: the review-normalized content fingerprint (Ch 43). Same identity
	 * record as `conceptCid`, with cosmetic string differences folded away, so an
	 * attestation can tell a rewritten control from a re-typeset one. Optional on
	 * purpose: a producer that does not compute one emits nothing, and an absent
	 * fingerprint is never read as evidence of change.
	 */
	reviewCid?: string;
	/** Optional recipe-driven explanation hashes for a changed reviewCid. */
	reviewGroups?: ReviewGroupCids;
}

const PRODUCER_NAME = 'crosswalker-plugin';
const PRODUCER_KIND = 'plugin-engine';

/**
 * Build the `_crosswalker` provenance block matching `spec/tier1.schema.json`.
 *
 * Always populates: spec_version, source_ref (best effort), produced_at,
 * producer. Optionally populates: recipe (if recipeId is provided),
 * concept_cid (if conceptCid is provided).
 */
export function buildProvenance(input: ProvenanceInput, pluginVersion: string): Record<string, unknown> {
	const block: Record<string, unknown> = {
		spec_version: SPEC_VERSION,
		source_ref: buildSourceRef(input),
		produced_at: new Date().toISOString(),
		producer: {
			kind: PRODUCER_KIND,
			name: PRODUCER_NAME,
			version: pluginVersion,
		},
	};

	if (input.recipeId) {
		block.recipe = {
			id: input.recipeId,
			...(input.recipeHash ? { hash: input.recipeHash } : {}),
		};
	}

	if (input.importSet) {
		block.import_set = {
			id: input.importSet.id,
			scheme: input.importSet.scheme,
			// Where the set lives, recorded so a refresh never has to infer it from
			// vault paths. An import that guesses its own destination wrong writes a
			// second copy of itself beside the first.
			...(input.importSet.destination ? { destination: input.importSet.destination } : {}),
			// AM-6. The ontology the set is pinned to, stamped beside the scheme it is
			// pinned to. Without it a refresh recomputes the ontology from its own
			// recipe, and a recomputation that lands on a different answer writes a
			// second copy of the framework and orphans the first.
			...(input.importSet.ontology ? { ontology: input.importSet.ontology } : {}),
			// AM-27. The identity-derivation rule the set is pinned to. Omitted when
			// absent, and absence is the legacy filename-stem rule: a set written
			// before this pin existed must keep deriving the identities its notes
			// already carry, or the next refresh recognises none of them and writes
			// the whole framework a second time.
			...(input.importSet.derivation ? { derivation: input.importSet.derivation } : {}),
		};
	}

	if (input.conceptCid) {
		block.concept_cid = input.conceptCid;
	}

	if (input.reviewCid) {
		block.review_cid = input.reviewCid;
	}

	if (input.reviewGroups) {
		block.review_groups = { ...input.reviewGroups };
	}

	return block;
}

function buildSourceRef(input: ProvenanceInput): Record<string, unknown> {
	const ref: Record<string, unknown> = {};
	if (input.sourceFile) ref.file = input.sourceFile;
	if (input.sourceUrl) ref.url = input.sourceUrl;
	if (input.sourceCurie) ref.curie = input.sourceCurie;
	if (input.sourceVersion) ref.version = input.sourceVersion;
	if (input.sourceHash) ref.source_hash = input.sourceHash;

	// Schema requires at least one of file/url/curie. If none, flag generic.
	if (Object.keys(ref).length === 0) {
		ref.curie = 'unknown:_';
	}

	return ref;
}
