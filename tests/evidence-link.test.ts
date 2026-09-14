/**
 * evidence-link.test.ts — the command must make the correct contract the
 * default, not merely a possibility (2026-08-21).
 *
 * The reason this command exists is that hand-authored links kept coming out
 * wrong: the published example had the direction inverted, and a per-row
 * predicate column let imports emit links that never counted. So the tests that
 * matter are the ones asserting a user CANNOT produce those shapes here.
 */

import {
	buildEvidenceLink,
	evidenceLinkCurie,
	evidenceLinkPath,
	legacyEvidenceLinkCurie,
	legacyEvidenceLinkPath,
	type EvidenceLinkInput,
} from '../src/views/evidence-link';
import { CANONICAL_EVIDENCE_PREDICATE } from '../src/tier2/evidence-coverage';

function input(over: Partial<EvidenceLinkInput> = {}): EvidenceLinkInput {
	return {
		controlPath: 'Frameworks/NIST/AC-2.md',
		controlCurie: 'nist-800-53:AC-2',
		evidencePath: 'Evidence/MFA policy.md',
		coverage: 'full',
		status: 'approved',
		folder: 'Evidence/Junctions',
		...over,
	};
}

describe('the direction cannot come out backwards', () => {
	it('puts the control in subject and the evidence in object', () => {
		const { markdown } = buildEvidenceLink(input());
		expect(markdown).toMatch(/subject: "\[\[Frameworks\/NIST\/AC-2\.md\|AC-2\]\]"/);
		expect(markdown).toMatch(/object: "\[\[Evidence\/MFA policy\.md\|MFA policy\]\]"/);
	});

	it('always writes the canonical predicate', () => {
		// Never asked about in the UI, so it cannot be set to a near-miss value
		// that produces a link counting toward nothing.
		expect(buildEvidenceLink(input()).markdown)
			.toContain(`predicate: ${CANONICAL_EVIDENCE_PREDICATE}`);
	});

	it('carries the control identifier so a rename does not detach the link', () => {
		expect(buildEvidenceLink(input()).markdown).toContain('subject_curie: "nist-800-53:AC-2"');
	});

	it('omits the identifier rather than inventing one when the control has none', () => {
		// A fabricated identifier would be reported as unresolvable, which reads
		// as data corruption. Omitting it yields the clearer diagnosis that the
		// note was never imported by Crosswalker.
		const { markdown } = buildEvidenceLink(input({ controlCurie: null }));
		expect(markdown).not.toContain('subject_curie');
	});
});

describe('the note explains whether it counts', () => {
	it('says so when the link counts', () => {
		expect(buildEvidenceLink(input()).markdown).toContain('[!note] Counted');
	});

	it('warns that an unapproved link does not count yet', () => {
		// Proposed is the default in the modal, so this is the common case and
		// the one most likely to be misread as done.
		const { markdown } = buildEvidenceLink(input({ status: 'proposed' }));
		expect(markdown).toContain('[!warning] Not yet counted');
		expect(markdown).toContain('approved');
	});

	it('warns that a coverage of none does not count', () => {
		const { markdown } = buildEvidenceLink(input({ coverage: 'none' }));
		expect(markdown).toContain('does NOT cover');
	});
});

describe('identity and safety', () => {
	it('gives one control/evidence pair a stable path so relinking updates in place', () => {
		// Two notes for one pair would be double-counted by any tally of links.
		expect(evidenceLinkPath('E', 'nist:AC-2', 'F/AC-2.md', 'Ev/p.md'))
			.toBe(evidenceLinkPath('E', 'nist:AC-2', 'F/AC-2.md', 'Ev/p.md'));
	});

	it('gives different pairs different paths', () => {
		expect(evidenceLinkPath('E', 'nist:AC-2', 'F/AC-2.md', 'Ev/a.md'))
			.not.toBe(evidenceLinkPath('E', 'nist:AC-3', 'F/AC-3.md', 'Ev/a.md'));
	});

	it('strips characters that would be illegal in a filename', () => {
		const path = evidenceLinkPath('E', 'nist:AC-2', 'F/AC:2.md', 'Ev/a?b.md');
		expect(path.slice(path.lastIndexOf('/') + 1)).not.toMatch(/[:?*"<>|]/);
	});

	it('escapes a quote in a path so the frontmatter stays parseable', () => {
		const { markdown } = buildEvidenceLink(input({ evidencePath: 'Evidence/a"b.md' }));
		expect(markdown).toContain('\\"');
	});

	it('writes the optional scope only when given', () => {
		expect(buildEvidenceLink(input()).markdown).not.toContain('scope:');
		expect(buildEvidenceLink(input({ scope: 'Account provisioning only' })).markdown)
			.toContain('scope: "Account provisioning only"');
	});

	it('marks the note as a junction so projection picks it up', () => {
		expect(buildEvidenceLink(input()).markdown).toContain('kind: junction-note');
	});

	it('carries a _crosswalker block, without which the note is invisible to coverage', () => {
		// The blocker found 2026-08-28. spec/tier1.schema.json REQUIRES this block on a
		// junction note and src/tier2/projector.ts skips any note lacking it as "not
		// produced by Crosswalker" -- so a link without it sits in the vault counted by
		// nothing. Every link the modal created was in that state.
		//
		// It survived a round-trip test because that test injected `_crosswalker` by hand
		// before projecting, exercising a note shape the product never emits. This asserts
		// against the builder's ACTUAL output, which is the only thing that can catch it.
		const { markdown } = buildEvidenceLink(input());
		expect(markdown).toContain('_crosswalker:');
		expect(markdown).toMatch(/^\s+spec_version:/m);
		expect(markdown).toMatch(/^\s+produced_at:/m);
	});

	it('carries a curie, without which projection rejects the note outright', () => {
		// Found by the round-trip test: an omitted curie produced a note that
		// looked correct in the vault and reached no report at all, because
		// projection refuses junction notes that have no identity.
		expect(buildEvidenceLink(input()).markdown).toMatch(/^curie: cwk:\S+$/m);
	});

	it('keeps the curie legal when a name contains spaces', () => {
		// Evidence documents routinely have spaces; the CURIE grammar forbids
		// them, so a pass-through would emit an invalid identifier.
		const { markdown } = buildEvidenceLink(input({ evidencePath: 'Evidence/MFA policy v2.md' }));
		const curie = /^curie: (\S+)$/m.exec(markdown)?.[1] ?? '';
		expect(curie).toMatch(/^[a-z][a-z0-9_-]*:[A-Za-z0-9._\-()/]+$/);
	});
});

// ---------------------------------------------------------------------------
// AM-22 (2026-08-31): a junction's identity derives from its SUBJECT'S CURIE,
// never from filenames.
//
// THE DEFECT. `evidenceLinkCurie` and `evidenceLinkPath` were both functions of
// `basename()`. Identity derived from address, inside the door built to forbid
// exactly that. Two releases of one framework — the case release isolation
// exists to support — share control file names, so `Frameworks/NIST-r4/AC-2.md`
// and `Frameworks/NIST-r5/AC-2.md` produced ONE path and ONE curie. Linking
// evidence to r5 therefore passed AM-17's "is this the same link" door and
// replaced r4's link in full: its approval, reviewer, review date,
// `reviewed_against` baseline and the reviewer's own prose, while the notice
// said the link had been updated. Undetectable afterwards, because the
// identifier never changed, so nothing had a duplicate to report.
//
// SECOND HEAD, SAME ROOT. `fileSafe` and `curieSafe` collapse DIFFERENT
// character sets, so two pairs could take two addresses and one identity. Two
// notes holding one curie is a permanent `Ambiguous identity` collision that
// fails EVERY later import in the vault, raised from a window a user cannot
// connect to imports at all.
//
// WHY THE TESTS BELOW ARE SHAPED THIS WAY. The old suite's "gives different
// pairs different paths" varied `F/AC-2.md` against `F/AC-3.md` — the one part
// of the path that was actually read. Varying only the FOLDER was never
// asserted, which is precisely the release-isolation case. Every test here
// varies something the old scheme could not see.
// ---------------------------------------------------------------------------

const R4 = 'Frameworks/NIST-r4/AC-2.md';
const R5 = 'Frameworks/NIST-r5/AC-2.md';
const EVIDENCE = 'Evidence/MFA policy.md';

describe('AM-22: two controls that share a file name are two different links', () => {
	it('gives two releases of one control different identities', () => {
		// The E-A scenario in one line.
		expect(evidenceLinkCurie('nist:AC-2', R4, EVIDENCE))
			.not.toBe(evidenceLinkCurie('nist-iset-abc123:AC-2', R5, EVIDENCE));
	});

	it('gives two releases of one control different addresses', () => {
		// Not because an address is an identity — it is not — but because two
		// identities wanting one address turns the second link into a refusal the
		// user can do nothing about.
		expect(evidenceLinkPath('E', 'nist:AC-2', R4, EVIDENCE))
			.not.toBe(evidenceLinkPath('E', 'nist-iset-abc123:AC-2', R5, EVIDENCE));
	});

	it('and the OLD scheme collided on exactly that pair, which is why this matters', () => {
		// The frozen record of what shipped before proves the case above is a real
		// defect and not a hypothetical: same curie, same path, two controls.
		expect(legacyEvidenceLinkCurie(R4, EVIDENCE)).toBe(legacyEvidenceLinkCurie(R5, EVIDENCE));
		expect(legacyEvidenceLinkPath('E', R4, EVIDENCE)).toBe(legacyEvidenceLinkPath('E', R5, EVIDENCE));
	});

	it('is the SAME link when the control note is renamed under it', () => {
		// The positive half of "identity, never path": the control's curie is the
		// fact, so moving or renaming its note does not make a second link.
		expect(evidenceLinkCurie('nist:AC-2', R4, EVIDENCE))
			.toBe(evidenceLinkCurie('nist:AC-2', 'Frameworks/Renamed/Access control 2.md', EVIDENCE));
	});

	it('is a different link for a different evidence document', () => {
		// The control against every test above: an identity that never varied
		// would pass all of them and name nothing.
		expect(evidenceLinkCurie('nist:AC-2', R4, EVIDENCE))
			.not.toBe(evidenceLinkCurie('nist:AC-2', R4, 'Evidence/Other.md'));
	});
});

describe('AM-22: the sanitisers can no longer merge two pairs', () => {
	// `curieSafe` maps a space to `-` and then collapses runs of `-`, so these two
	// evidence documents produced ONE readable local part. `fileSafe` keeps the
	// space, so they took TWO addresses. Two files, one identity.
	const SPACED = 'Evidence/a b.md';
	const HYPHENED = 'Evidence/a-b.md';

	it('gives a curie-collapsing pair two identities', () => {
		expect(evidenceLinkCurie('nist:AC-2', R4, SPACED))
			.not.toBe(evidenceLinkCurie('nist:AC-2', R4, HYPHENED));
	});

	it('and the OLD scheme gave them one', () => {
		expect(legacyEvidenceLinkCurie(R4, SPACED)).toBe(legacyEvidenceLinkCurie(R4, HYPHENED));
	});

	it('distinguishes a control identified by curie from one identified by path', () => {
		// A control with no curie was never imported, so its path is the only
		// identity it has. The two halves are field-tagged for this reason: a path
		// that happens to read like a curie must not be taken for one.
		expect(evidenceLinkCurie(null, 'F/x.md', EVIDENCE))
			.not.toBe(evidenceLinkCurie('F/x.md', 'F/x.md', EVIDENCE));
	});

	it('treats a blank curie as no curie rather than as an identity', () => {
		expect(evidenceLinkCurie('   ', 'F/x.md', EVIDENCE)).toBe(evidenceLinkCurie(null, 'F/x.md', EVIDENCE));
	});
});

describe('AM-22: the legacy forms are a frozen record, not a scheme', () => {
	// These are what is already stamped in people's vaults. The update path looks
	// them up so a scheme change adopts the existing note instead of doubling it,
	// which means these two functions must keep emitting EXACTLY the pre-AM-22
	// output forever. Pinned literally, so a "cleanup" of the sanitisers cannot
	// silently orphan every link written before today.
	it('emits the pre-AM-22 curie verbatim', () => {
		expect(legacyEvidenceLinkCurie('Frameworks/NIST/AC-2.md', 'Evidence/MFA policy.md'))
			.toBe('cwk:AC-2-has_evidence-MFA-policy');
	});

	it('emits the pre-AM-22 address verbatim', () => {
		expect(legacyEvidenceLinkPath('Evidence/Junctions', 'Frameworks/NIST/AC-2.md', 'Evidence/MFA policy.md'))
			.toBe('Evidence/Junctions/AC-2--has_evidence--MFA policy.md');
	});

	it('and the current scheme is not the legacy one', () => {
		// If these ever agreed, the migration lookup would be a no-op and every
		// test above would be passing about nothing.
		expect(evidenceLinkCurie('nist:AC-2', 'Frameworks/NIST/AC-2.md', 'Evidence/MFA policy.md'))
			.not.toBe(legacyEvidenceLinkCurie('Frameworks/NIST/AC-2.md', 'Evidence/MFA policy.md'));
	});
});

describe('AM-22: the note the builder writes is addressed by the same rule', () => {
	// The builder is what the window actually calls. A path or curie computed one
	// way here and another way in the lookup is how a link gets written where
	// nothing will ever look for it again.
	it('stamps the curie the identity function names', () => {
		const built = buildEvidenceLink(input({ controlPath: R4, controlCurie: 'nist:AC-2', evidencePath: EVIDENCE }));
		expect(built.markdown).toContain(`curie: ${evidenceLinkCurie('nist:AC-2', R4, EVIDENCE)}`);
	});

	it('writes to the address the path function names', () => {
		const built = buildEvidenceLink(input({
			controlPath: R4, controlCurie: 'nist:AC-2', evidencePath: EVIDENCE, folder: 'Evidence/Junctions',
		}));
		expect(built.path).toBe(evidenceLinkPath('Evidence/Junctions', 'nist:AC-2', R4, EVIDENCE));
	});

	it('writes two releases of one control to two notes', () => {
		// The end-to-end statement of E-A at the builder level.
		const r4 = buildEvidenceLink(input({ controlPath: R4, controlCurie: 'nist:AC-2', evidencePath: EVIDENCE }));
		const r5 = buildEvidenceLink(input({ controlPath: R5, controlCurie: 'nist-iset-abc123:AC-2', evidencePath: EVIDENCE }));
		expect(r4.path).not.toBe(r5.path);
		expect(r4.markdown).not.toBe(r5.markdown);
	});
});
