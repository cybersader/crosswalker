/**
 * evidence-coverage.ts — the authoritative answer to "which controls have
 * evidence, and which do not" (2026-08-21, Challenge 45 §4.3).
 *
 * WHY THIS EXISTS
 *
 * The question a compliance reader actually asks is a NEGATIVE one: which
 * controls have *no* valid evidence. That question cannot be answered from
 * Markdown alone. Obsidian Bases filters a set of notes; it cannot report on
 * the notes that are missing a relationship, because the row it would need to
 * emit does not exist. Two earlier attempts got this wrong in ways that both
 * produced confident, well-formatted, wrong answers:
 *
 *   - A Base filtering `length(evidence) == 0` over control notes. No recipe
 *     ever emitted an `evidence` property, so the filter matched every control
 *     and the report read "nothing has evidence" regardless of the truth.
 *   - Counting backlinks. Hierarchy links, index links, and crosswalk links are
 *     all backlinks, so nearly every control looked covered.
 *
 * The anti-join belongs here, in SQL, where "no matching row" is expressible.
 *
 * WHAT COUNTS AS EVIDENCE
 *
 * Deliberately strict, because the failure mode of a coverage report is someone
 * concluding a control is satisfied when it is not. A junction counts only when
 * all of the following hold:
 *
 *   1. Its predicate is exactly `has_evidence`. Other predicates are real data
 *      and may be perfectly valid relationships, but they are not a claim that
 *      evidence satisfies a control, so they never count toward coverage.
 *   2. It resolves to a concept BY IDENTITY (`subject_curie` matching a
 *      concept's `curie`), never by wikilink text. Text matching is how a
 *      renamed note silently detaches its evidence.
 *   3. `status` is `approved`. Proposed and in-review evidence is not evidence.
 *   4. `coverage` is `full` or `partial`. `none` and `n/a` are explicit
 *      statements that this artifact does NOT cover the control.
 *   5. It is not expired or stale under the review policy.
 *   6. Its subject has not CHANGED since it was approved. An attestation
 *      records the control's content fingerprint at approval
 *      (`reviewed_against`); when the control is re-imported with different
 *      content, the link still RESOLVES but stops being a valid claim, because
 *      the reviewer approved evidence against text that no longer exists.
 *      Freshness therefore has three drivers, not two: expiry, time, and
 *      content.
 *
 * A link that never recorded a baseline is `unrecorded`. It COUNTS, and it is
 * REPORTED, by name and by count. Treating a never-recorded fingerprint as
 * evidence of change would zero out every existing vault on the day the plugin
 * updates, for nothing the user did; treating it as evidence of no change would
 * exempt it forever, invisibly. See `unbaselined_valid_junctions`.
 *
 * LINEAGE
 *
 * A framework release that renames, splits, or merges its controls is a
 * MAPPING between two release ontologies, not a special case: the transition is
 * recorded as ordinary crosswalk assertions using the `superseded_by` predicate
 * (or its inverse `supersedes`). When an attestation points at a control that
 * is no longer in the index AND lineage edges name a replacement, the honest
 * diagnosis is `subject-superseded` with the candidates listed, not the bare
 * `subject-not-a-known-concept`. Same population, better answer, which is why
 * it sits directly above that reason in the ladder rather than beside it.
 *
 * Crosswalker never re-points an attestation itself, and never infers a
 * successor from name similarity or from anything else. Listing the candidates
 * a human asserted is the entire feature; choosing among them is a human act.
 *
 * Anything failing these is EXCLUDED and DIAGNOSABLE (see
 * `diagnoseExcludedJunctions`), never silently reinterpreted. A junction
 * pointing the wrong way, or carrying a near-miss predicate, is a data problem
 * for a human to fix — guessing at intent is how a coverage number stops
 * meaning anything.
 *
 * DIRECTION
 *
 * `subject` is the CONTROL; `object` is the evidence artifact. The junction
 * reads "control has_evidence document". This matters: the inverse reading
 * ("document implements control") was published in the GRC guide and produces
 * zero coverage rows against this query, because `subject_curie` then holds an
 * evidence document that matches no concept.
 */

import { closureFromConcept } from './queries';
import { asTier2Db, type Tier2Db, type Tier2DbLike } from './db';

/** The one predicate that constitutes a claim of evidence coverage. */
export const CANONICAL_EVIDENCE_PREDICATE = 'has_evidence';

/** Coverage states a concept can be in. `partial` is deliberately NOT `covered`. */
export type CoverageState = 'covered' | 'partial' | 'uncovered';

/** One concept plus its valid-evidence tallies. */
export interface EvidenceCoverageRow {
	curie: string;
	title: string;
	vault_path: string;
	/** Junctions meeting every validity rule above. */
	valid_count: number;
	/** Of those, the ones asserting `coverage: full`. */
	full_count: number;
	/** Of those, the ones asserting `coverage: partial`. */
	partial_count: number;
	coverage_state: CoverageState;
}

/** Aggregate posture for one ontology. Every field is a count of concepts. */
export interface EvidenceCoverageSummary {
	ontology_id: string;
	total_concepts: number;
	covered: number;
	partial: number;
	uncovered: number;
	/** Junctions excluded for any reason — the number a reader should ask about. */
	excluded_junctions: number;
	/**
	 * Valid links that carry no usable review baseline: no `reviewed_against`
	 * recorded, or a subject with no fingerprint to compare against.
	 *
	 * These COUNT toward the percentages above. This number says how much of
	 * those percentages rests on links whose subject may have changed since
	 * approval without Crosswalker being able to tell. Counted, never silently
	 * exempted.
	 */
	unbaselined_valid_junctions: number;
}

/** Why one junction did not count toward coverage. */
export type ExclusionReason =
	| 'predicate-not-canonical'
	| 'no-subject-identity'
	| 'subject-superseded'
	| 'subject-not-a-known-concept'
	| 'not-approved'
	| 'coverage-not-asserted'
	| 'expired'
	| 'subject-changed'
	| 'stale';

/**
 * Why one COUNTED link has no comparable review baseline.
 *
 * All three are the absence of a record, never evidence of anything:
 * `unrecorded` (the link never wrote one), `subject-absent` (the reviewed
 * subject is not in the index), `subject-unhashed` (the subject carries no
 * fingerprint because its producer did not compute one).
 */
export type BaselineGap = 'unrecorded' | 'subject-absent' | 'subject-unhashed';

/** Current comparison state for an attestation subject. */
export type SubjectBaseline = BaselineGap | 'changed' | 'match';

/** Highest-priority recipe-driven explanation for a changed subject. */
export type ReviewChangeKind = 'wording' | 'scope' | 'housekeeping';

/** One valid link whose subject state at approval cannot be compared to now. */
export interface UnbaselinedJunction {
	vault_path: string;
	subject: string;
	subject_curie: string | null;
	baseline: BaselineGap;
}

/** One junction that exists but does not count, and the reason. */
export interface ExcludedJunction {
	vault_path: string;
	subject: string;
	subject_curie: string | null;
	predicate: string;
	reason: ExclusionReason;
	/** Independent of the primary exclusion reason (for example expired + changed). */
	subject_baseline: SubjectBaseline;
	/** Null unless subject_baseline is changed. */
	change_kind: ReviewChangeKind | null;
}

/**
 * One concept a superseded subject was replaced by, as asserted by lineage
 * edges in the vault.
 *
 * `vault_path` is null when the successor is named by a lineage edge but is not
 * itself imported here. That row is still listed. Dropping it would report "no
 * successor known" when a successor IS asserted, which is the one wrong answer
 * this whole section exists to avoid.
 */
export interface SuccessorCandidate {
	curie: string;
	title: string | null;
	/** Null when the successor concept is not imported in this vault. */
	vault_path: string | null;
	/** Hops along the lineage chain. 1 is a direct replacement. */
	depth: number;
}

/**
 * One control that attestations still point at, which is no longer in the
 * index, and which lineage edges say was replaced.
 *
 * This is the structural-transition regime: the newer release was imported
 * under a new ontology id, so the old concepts orphaned and their attestations
 * dangle. The successor mapping set is what reconnects them, and this row is
 * how a human sees the candidates.
 */
export interface SupersededSubject {
	subject_curie: string;
	/** Attestations still pointing at the superseded control. */
	attestation_count: number;
	/** Their vault paths, ordered, so the reader can open them. */
	attestation_paths: string[];
	/** Candidates, nearest first. Never empty for a row that appears here. */
	successors: SuccessorCandidate[];
}

/**
 * The validity predicate, as a SQL fragment applied to the aliased
 * `junction_notes_with_freshness` row `j`. Kept in one place so the coverage
 * query, the summary, and the exclusion diagnostics can never drift apart —
 * a report and its own explanation disagreeing is worse than either alone.
 *
 * `not-set` freshness (no review_date and no expires_at) is admitted. Refusing
 * it would zero out coverage for every team that has not yet adopted review
 * dates, which reports a data-entry gap as a compliance gap.
 *
 * `subject-changed` is NOT admitted: the control the reviewer read is not the
 * control in the vault, so the claim is no longer substantiated. That is a
 * different statement from "the link is broken" — it still resolves, and
 * re-approving it restores the count.
 *
 * A link whose `subject_baseline` is `unrecorded` sits inside `fresh` or
 * `not-set` and therefore still counts. That is the absence ruling, expressed
 * as the one line of SQL that is NOT here.
 */
const VALID_JUNCTION_CONDITIONS = `
	j.predicate = $predicate
	AND j.status = 'approved'
	AND j.coverage IN ('full', 'partial')
	AND j.freshness NOT IN ('expired', 'stale', 'subject-changed')
`;

/**
 * How deep a successor walk follows a lineage chain. Deliberately tighter than
 * the closure default of 10: a replacement chain more than five releases long
 * inside one vault is far more likely to be a data error than a real chain, and
 * a shorter cap keeps the candidate list honest.
 */
export const SUCCESSOR_WALK_MAX_DEPTH = 5;

/**
 * Does the subject of this junction have an outbound successor edge? Written as
 * a correlated EXISTS over the aliased row `j`.
 *
 * Two spellings, because lineage can legitimately be recorded from either end:
 * a stored `A superseded_by B` row, or a stored `B supersedes A` row. Those are
 * the same assertion, and the effective-edge traversal in `queries.ts` already
 * materialises the inverse of every stored row, so
 * `closureFromConcept(A, 'superseded_by')` reaches B in both cases. This
 * predicate has to match that, or the diagnosis and the successor list would
 * disagree: a vault that records lineage only from the newer end would be told
 * "no successor known" while the walk was quietly able to find one.
 *
 * `predicate_modifier = ''` is load-bearing. A `NOT superseded_by` row asserts
 * the OPPOSITE, that the object does not replace the subject, and walking it
 * would manufacture a successor out of an explicit denial. The effective-edge
 * traversal applies the same filter for the same reason.
 */
const SUCCESSOR_EDGE_EXISTS = `
	SELECT 1 FROM mappings m
	WHERE m.predicate_modifier = ''
	  AND (
	    (m.predicate_id = 'superseded_by' AND m.subject_id = j.subject_curie)
	    OR (m.predicate_id = 'supersedes' AND m.object_id = j.subject_curie)
	  )
`;

/** Row shape returned by the grouped coverage query, before state derivation. */
type RawCoverageRow = [string, string, string, number, number, number];

/** Derive the reported state. `full` evidence outranks `partial`; absence is absence. */
function deriveState(fullCount: number, validCount: number): CoverageState {
	if (fullCount > 0) return 'covered';
	if (validCount > 0) return 'partial';
	return 'uncovered';
}

/**
 * Every concept in `ontologyId` with its valid-evidence tallies, including the
 * concepts with none. The LEFT JOIN is the whole point: an INNER JOIN can only
 * ever describe controls that already have evidence, which is the opposite of
 * the question being asked.
 */
export async function evidenceCoverageByConcept(dbLike: Tier2DbLike, ontologyId: string): Promise<EvidenceCoverageRow[]> {
	const db = asTier2Db(dbLike);
	const rows = await db.exec({
		sql: `
			SELECT
				c.curie,
				c.title,
				c.vault_path,
				COUNT(j.vault_path) AS valid_count,
				COALESCE(SUM(CASE WHEN j.coverage = 'full' THEN 1 ELSE 0 END), 0) AS full_count,
				COALESCE(SUM(CASE WHEN j.coverage = 'partial' THEN 1 ELSE 0 END), 0) AS partial_count
			FROM concepts c
			LEFT JOIN junction_notes_with_freshness j
				ON j.subject_curie = c.curie
				AND ${VALID_JUNCTION_CONDITIONS}
			WHERE c.ontology_id = $ontology_id
			GROUP BY c.curie, c.title, c.vault_path
			ORDER BY c.curie
		`,
		bind: { $ontology_id: ontologyId, $predicate: CANONICAL_EVIDENCE_PREDICATE },
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as RawCoverageRow[];

	return rows.map((r) => ({
		curie: String(r[0]),
		title: String(r[1]),
		vault_path: String(r[2]),
		valid_count: Number(r[3]),
		full_count: Number(r[4]),
		partial_count: Number(r[5]),
		coverage_state: deriveState(Number(r[4]), Number(r[3])),
	}));
}

/**
 * Concepts with zero valid evidence — the trustworthy replacement for the
 * withdrawn `length(evidence) == 0` Base and for backlink counting.
 */
export async function conceptsWithoutValidEvidence(dbLike: Tier2DbLike, ontologyId: string): Promise<EvidenceCoverageRow[]> {
	return (await evidenceCoverageByConcept(dbLike, ontologyId)).filter((row) => row.valid_count === 0);
}

/**
 * Aggregate posture for one ontology. Counts concepts, not junctions, except
 * `excluded_junctions`, which counts junctions deliberately: it is the number
 * that tells a reader how much data was set aside before the percentages above
 * it were computed.
 */
export async function evidenceCoverageSummary(dbLike: Tier2DbLike, ontologyId: string): Promise<EvidenceCoverageSummary> {
	const db = asTier2Db(dbLike);
	const rows = await evidenceCoverageByConcept(db, ontologyId);
	let covered = 0;
	let partial = 0;
	let uncovered = 0;
	for (const row of rows) {
		if (row.coverage_state === 'covered') covered += 1;
		else if (row.coverage_state === 'partial') partial += 1;
		else uncovered += 1;
	}
	return {
		ontology_id: ontologyId,
		total_concepts: rows.length,
		covered,
		partial,
		uncovered,
		excluded_junctions: (await diagnoseExcludedJunctions(db)).length,
		unbaselined_valid_junctions: (await listUnbaselinedValidJunctions(db)).length,
	};
}

/**
 * Valid links whose subject state at approval cannot be compared to the
 * subject state now.
 *
 * Three ways that happens, all of them ABSENCE OF A RECORD rather than evidence
 * of anything: the link never recorded a baseline (`unrecorded`), its subject
 * is not in the index (`subject-absent`), or its subject carries no fingerprint
 * because the producer did not compute one (`subject-unhashed`). All three
 * count toward coverage and all three are surfaced here, so a reader can see
 * how much of the number is unverifiable rather than being told it is fine.
 *
 * Built on the same `VALID_JUNCTION_CONDITIONS` token as every other query in
 * this file, so the count can never describe a different population than the
 * percentages it sits beside.
 */
export async function listUnbaselinedValidJunctions(dbLike: Tier2DbLike): Promise<UnbaselinedJunction[]> {
	const db = asTier2Db(dbLike);
	const rows = await db.exec({
		sql: `
			SELECT j.vault_path, j.subject, j.subject_curie, j.subject_baseline
			FROM junction_notes_with_freshness j
			WHERE ${VALID_JUNCTION_CONDITIONS}
				AND j.subject_curie IS NOT NULL
				AND j.subject_curie <> ''
				AND EXISTS (SELECT 1 FROM concepts c WHERE c.curie = j.subject_curie)
				AND j.subject_baseline IN ('unrecorded', 'subject-absent', 'subject-unhashed')
			ORDER BY j.vault_path
		`,
		bind: { $predicate: CANONICAL_EVIDENCE_PREDICATE },
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	return rows.map((r) => ({
		vault_path: String(r[0]),
		subject: String(r[1]),
		subject_curie: r[2] === null || r[2] === undefined || r[2] === '' ? null : String(r[2]),
		baseline: String(r[3]) as UnbaselinedJunction['baseline'],
	}));
}

/**
 * Every junction that exists but does not count, with the reason.
 *
 * This is the counterpart that makes a strict rule usable. Without it, a team
 * whose junctions all point the wrong way sees "0 controls covered" and has no
 * way to discover that their data is one direction-flip away from correct.
 *
 * Reasons are evaluated in a fixed priority order so each junction gets exactly
 * one, and so the most actionable problem wins: a junction with a wrong
 * predicate AND no identity is reported as the predicate problem, because
 * fixing the predicate is what the author actually intended to write.
 *
 * `subject-changed` sits ABOVE the `stale` catch-all deliberately. Below it, a
 * content-invalidated link would be reported as "not reviewed recently enough"
 * — a confidently stated wrong reason, which is worse than no reason at all.
 * A link that is both expired and content-changed reports `expired`, because
 * that is the branch the freshness view already picked; the second fact is not
 * lost, it is carried separately on `subject_baseline`.
 */
export async function diagnoseExcludedJunctions(dbLike: Tier2DbLike): Promise<ExcludedJunction[]> {
	const db = asTier2Db(dbLike);
	const rows = await db.exec({
		sql: `
			SELECT
				j.vault_path,
				j.subject,
				j.subject_curie,
				j.predicate,
				j.subject_baseline,
				j.change_kind,
				CASE
					WHEN j.predicate <> $predicate THEN 'predicate-not-canonical'
					WHEN j.subject_curie IS NULL OR j.subject_curie = '' THEN 'no-subject-identity'
					WHEN NOT EXISTS (SELECT 1 FROM concepts c WHERE c.curie = j.subject_curie)
						AND EXISTS (${SUCCESSOR_EDGE_EXISTS})
						THEN 'subject-superseded'
					WHEN NOT EXISTS (SELECT 1 FROM concepts c WHERE c.curie = j.subject_curie)
						THEN 'subject-not-a-known-concept'
					WHEN j.status IS NULL OR j.status <> 'approved' THEN 'not-approved'
					WHEN j.coverage IS NULL OR j.coverage NOT IN ('full', 'partial')
						THEN 'coverage-not-asserted'
					WHEN j.freshness = 'expired' THEN 'expired'
					WHEN j.freshness = 'subject-changed' THEN 'subject-changed'
					ELSE 'stale'
				END AS reason
			FROM junction_notes_with_freshness j
			WHERE NOT (
				${VALID_JUNCTION_CONDITIONS}
				AND j.subject_curie IS NOT NULL
				AND j.subject_curie <> ''
				AND EXISTS (SELECT 1 FROM concepts c WHERE c.curie = j.subject_curie)
			)
			ORDER BY j.vault_path
		`,
		bind: { $predicate: CANONICAL_EVIDENCE_PREDICATE },
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	return rows.map((r) => ({
		vault_path: String(r[0]),
		subject: String(r[1]),
		subject_curie: r[2] === null || r[2] === undefined || r[2] === '' ? null : String(r[2]),
		predicate: String(r[3]),
		subject_baseline: String(r[4]) as SubjectBaseline,
		change_kind: r[5] === null || r[5] === undefined ? null : String(r[5]) as ReviewChangeKind,
		reason: String(r[6]) as ExclusionReason,
	}));
}

/**
 * Superseded controls that attestations still point at, each with the successor
 * candidates the vault asserts.
 *
 * Derived FROM the exclusion diagnosis rather than from a parallel query, so
 * the count in this table and the rows in "links that did not count" can never
 * describe different populations. That is the same discipline as
 * `VALID_JUNCTION_CONDITIONS`: one definition, many readers.
 *
 * The walk is memoised per distinct subject CURIE. Ten attestations against one
 * withdrawn control are one closure call, not ten.
 *
 * @param excluded already-diagnosed rows, when the caller has them. Omitted, the
 *   diagnosis is run here.
 */
export async function listSupersededSubjects(
	dbLike: Tier2DbLike,
	excluded?: ExcludedJunction[],
): Promise<SupersededSubject[]> {
	const db = asTier2Db(dbLike);
	const rows = (excluded ?? await diagnoseExcludedJunctions(db)).filter(
		(row) => row.reason === 'subject-superseded' && row.subject_curie !== null,
	);
	if (rows.length === 0) return [];

	const grouped = new Map<string, string[]>();
	for (const row of rows) {
		const curie = row.subject_curie as string;
		const paths = grouped.get(curie);
		if (paths) paths.push(row.vault_path);
		else grouped.set(curie, [row.vault_path]);
	}

	const out: SupersededSubject[] = [];
	for (const [subjectCurie, paths] of [...grouped.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		// Forward-only by construction: the effective-edge traversal stores the
		// inverse of each row under the inverse predicate, so filtering on
		// `superseded_by` walks old -> new and never new -> old.
		const reached = await closureFromConcept(
			db,
			subjectCurie,
			'superseded_by',
			SUCCESSOR_WALK_MAX_DEPTH,
		);
		const looked: SupersededSubject['successors'] = [];
		for (const entry of reached) {
			looked.push({
				curie: entry.target_curie,
				depth: entry.shortest_depth,
				...(await lookupConcept(db, entry.target_curie)),
			});
		}
		const successors = looked
			.sort((a, b) => a.depth - b.depth || a.curie.localeCompare(b.curie));

		out.push({
			subject_curie: subjectCurie,
			attestation_count: paths.length,
			attestation_paths: [...paths].sort((a, b) => a.localeCompare(b)),
			successors,
		});
	}
	return out;
}

/**
 * Title and path for one CURIE, or nulls when it is not imported here.
 *
 * Nulls mean "not in this vault", never "does not exist": the lineage edge that
 * named it is an assertion in its own right and is reported either way.
 */
async function lookupConcept(db: Tier2Db, curie: string): Promise<{ title: string | null; vault_path: string | null }> {
	const rows = await db.exec({
		sql: `
			SELECT title, vault_path
			FROM concepts
			WHERE curie = $curie
			ORDER BY ontology_id
			LIMIT 1
		`,
		bind: { $curie: curie },
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	if (rows.length === 0) return { title: null, vault_path: null };
	const title = rows[0][0];
	const path = rows[0][1];
	return {
		title: title === null || title === undefined ? null : String(title),
		vault_path: path === null || path === undefined ? null : String(path),
	};
}
