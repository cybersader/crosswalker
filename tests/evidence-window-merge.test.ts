/**
 * evidence-window-merge.test.ts — AM-39's third clause and AM-40 (2026-09-01).
 *
 * AM-39, THE DEFECT. The evidence window's update was
 * `vault.modify(file, note.markdown)`: the whole junction note replaced by a
 * rebuild from three form controls. `buildEvidenceLink` emits `reviewer` and
 * `review_date` only from inputs the window never passes, and never emits
 * `confidence`, `expires_at` or `notes` at all. Those five, plus `scope`, are
 * exactly the keys `recipes/starter/evidence-junction-notes.json` declares
 * `user_preserve` "so the review workflow is not clobbered on re-import" — the
 * re-import honoured it and this window silently deleted them, an approval and
 * its date and its expiry, while reporting that the link had been "updated".
 * The reviewer's own prose under the note went with it. And because the three
 * controls were not prefilled from the note, a second click reset an approved,
 * partially-scoped link to the form's defaults: proposed, full, no scope.
 *
 * A window that can destroy an attestation is not a lighter-weight door than an
 * import; it is the same door with no lock. AM-39 routes the update through the
 * merge machinery generation uses: this window's own keys are rewritten,
 * everything else on the note is carried across byte-for-byte, a managed body
 * region is rebuilt inside its markers, and an unmarked body is refreshed only
 * when it is byte-identical to what the window itself last wrote.
 *
 * AM-40, THE RULING. `EvidenceLinkModal.create()` began with
 * `requireVaultIndexed`, which refuses to answer while Obsidian is still
 * indexing. Both readers below it already raw-read any file the metadata cache
 * missed, so the gate refused what the code beneath it could already see, while
 * genuinely blocking the ordinary startup case. A fail-closed precondition
 * belongs where the read is BLIND, not where it can see. The gate is gone; the
 * cold-cache answers below are what it was protecting, asserted directly.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkCurie, evidenceLinkPath } from '../src/views/evidence-link';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Notices, swapped on the LIVE module object so src/ calls the double.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as { Notice: new (message: string, timeout?: number) => unknown };
const RealNotice = obsidianModule.Notice;
const notices: string[] = [];

beforeAll(() => {
	obsidianModule.Notice = class {
		constructor(message: string) { notices.push(message); }
	} as unknown as typeof RealNotice;
});
afterAll(() => { obsidianModule.Notice = RealNotice; });
beforeEach(() => { notices.length = 0; });

const said = (): string => notices.join('\n');

/**
 * A vault double. `coldCache: true` models the state AM-40 is about: Obsidian
 * has not indexed anything yet, so every `getFileCache` answers null while the
 * files on disk are perfectly readable.
 */
function makeVault(opts: { coldCache?: boolean } = {}) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const opened: string[] = [];
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			// S5 (2026-09-04) fix follow-up: buildLinkFallbackIndex reads getFiles(),
			// not getMarkdownFiles() -- a stub missing it throws the moment a scan
			// falls back to the vault file list. No non-markdown fixture here, so this
			// answers the same set; see tests/vault-path-normalization-s5.test.ts for
			// the PDF/non-markdown case.
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				if (opts.coldCache) return null;
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
			getFirstLinkpathDest: (linkpath: string) => {
				if (files.has(linkpath)) return new TFile(linkpath);
				const withExtension = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
				if (files.has(withExtension)) return new TFile(withExtension);
				const name = (linkpath.split('/').pop() ?? linkpath).replace(/\.md$/, '');
				const found = [...files.keys()].filter((path) => path.split('/').pop() === `${name}.md`);
				return found.length === 1 ? new TFile(found[0]) : null;
			},
		},
		workspace: {
			getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
		},
	};
	return { app: app as unknown as App, files, folders, opened };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';

const CONTROL: ControlCandidate = {
	path: 'Frameworks/NIST/AC-2.md',
	title: 'AC-2',
	curie: 'nist:AC-2',
	reviewCid: null,
};

const LINK_PATH = evidenceLinkPath(FOLDER, CONTROL.curie, CONTROL.path, EVIDENCE);
const LINK_CURIE = evidenceLinkCurie(CONTROL.curie, CONTROL.path, EVIDENCE);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	coverage: string;
	status: string;
	evidenceScope: string;
	/** AM-41. Set only by the status dropdown's onChange; nothing else may set it. */
	statusSetInThisWindow: boolean;
	pairRefusal: string | null;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

/**
 * Press "Create link". `set` names the controls the person actually ANSWERED —
 * anything omitted is a control they never touched, which is the case the whole
 * prefill clause is about.
 *
 * AM-43 (2026-09-02): the pair lookup is a separate, awaited step now — prefill
 * is display-time, not write-time. `resolvePair` is driven directly (the DOM's
 * blur/change events are not present in this harness), and `set` names the
 * controls answered AFTER the prefill lands, exactly mirroring a person reading
 * the form and then changing what they mean to change.
 */
async function pressCreateLink(
	app: App,
	set: { coverage?: string; status?: string; scope?: string } = {},
	control: ControlCandidate = CONTROL,
): Promise<void> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = control;
	modal.evidencePath = EVIDENCE;
	await modal.resolvePair(control, EVIDENCE);
	if (set.coverage !== undefined) modal.coverage = set.coverage;
	if (set.status !== undefined) { modal.status = set.status; modal.statusSetInThisWindow = true; }
	if (set.scope !== undefined) modal.evidenceScope = set.scope;
	await modal.create();
}

/**
 * The junction a reviewer has worked on: approved, partially scoped, with the
 * five review keys the bulk recipe declares `user_preserve`, a key no part of
 * this product knows about, and the reviewer's own prose under it.
 *
 * The values are written in shapes a round trip through a YAML parser would
 * quietly change — a quoted date, a number that looks like a float, a value
 * with a trailing comment — because "byte-for-byte" is the claim.
 */
const PRESERVED_LINES = [
	'reviewer: "A. Reviewer"',
	'review_date: "2026-08-01"',
	'confidence: 0.90',
	'expires_at: 2027-01-01  # renewal window',
	'notes: |',
	'  Sampled 20 accounts.',
	'  Two exceptions, both waived.',
	'audit_ticket: SEC-4417',
];
const PROSE = 'The reviewer wrote this paragraph and it must survive.';

function reviewedJunction(): string {
	return [
		'---',
		`curie: ${LINK_CURIE}`,
		'kind: junction-note',
		`title: "AC-2 has evidence: MFA policy"`,
		`subject: "[[${CONTROL.path}|AC-2]]"`,
		`subject_curie: "${CONTROL.curie}"`,
		'predicate: has_evidence',
		`object: "[[${EVIDENCE}|MFA policy]]"`,
		'coverage: partial',
		'status: approved',
		'scope: "Account provisioning only"',
		...PRESERVED_LINES,
		'tags: [evidence/junction]',
		'_crosswalker:',
		'  spec_version: "https://crosswalker.dev/spec/tier1.schema.json"',
		'  import_set:',
		'    id: iset-aaaaaa',
		'---',
		'',
		`# AC-2 has evidence: MFA policy`,
		'',
		PROSE,
		'',
	].join('\n');
}

function seedReviewed(files: Map<string, string>): void {
	files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
	files.set(EVIDENCE, '# MFA policy\n');
	files.set(LINK_PATH, reviewedJunction());
}

const fmTextOf = (text: string): string =>
	/^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';

const fmOf = (text: string): Record<string, unknown> =>
	(yaml.load(fmTextOf(text)) ?? {}) as Record<string, unknown>;

// ===========================================================================
// AM-39 — the window merges, it does not replace.
// ===========================================================================

describe('AM-39: an update from the evidence window preserves what the window does not own', () => {
	it('carries the six user_preserve keys across BYTE-FOR-BYTE', async () => {
		// THE defect, stated at the level it matters: an approval, who gave it,
		// when, how confident, when it lapses, and what they sampled. The window
		// has no control for any of them and no opinion about them.
		const { app, files } = makeVault();
		seedReviewed(files);

		await pressCreateLink(app);

		const after = files.get(LINK_PATH)!;
		for (const line of PRESERVED_LINES) {
			expect([line, after.includes(line)]).toEqual([line, true]);
		}
		// `scope` is the sixth. It IS a window control, so it is preserved by the
		// prefill rather than by the carry - asserted here because the recipe
		// declares all six together and a reader should see all six.
		expect(fmOf(after).scope).toBe('Account provisioning only');
		expect(said()).toContain('Updated the existing link');
	});

	it('keeps the reviewer prose under the note', async () => {
		// The other half of a full replace. A paragraph someone wrote is not
		// recoverable; a stale generated sentence is.
		const { app, files } = makeVault();
		seedReviewed(files);
		await pressCreateLink(app);
		expect(files.get(LINK_PATH)).toContain(PROSE);
	});

	it('keeps a key no part of this product knows about', async () => {
		// The rule is "the keys this window writes, and only those". A merge that
		// enumerated known keys instead would drop another plugin's, or a
		// recipe's extra column, and pass every declaration above.
		const { app, files } = makeVault();
		seedReviewed(files);
		await pressCreateLink(app);
		expect(files.get(LINK_PATH)).toContain('audit_ticket: SEC-4417');
	});

	it('an UNTOUCHED control does not overwrite what the link already records', async () => {
		// The prefill clause. A second click used to silently reset an approved,
		// partially-scoped link to the form defaults (proposed / full / no scope)
		// and report it as an update. An untouched control is a question nobody
		// answered, not an answer of "default".
		const { app, files } = makeVault();
		seedReviewed(files);
		await pressCreateLink(app);

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.status).toBe('approved');
		expect(fm.coverage).toBe('partial');
		expect(fm.scope).toBe('Account provisioning only');
	});

	it('a control the person DID answer wins, and only that one', async () => {
		// The other side of the same rule. Prefill that ignored the form would be
		// a window that cannot change anything.
		const { app, files } = makeVault();
		seedReviewed(files);

		await pressCreateLink(app, { status: 'in_review' });

		const after = files.get(LINK_PATH)!;
		expect(fmOf(after).status).toBe('in_review');
		// Everything the person did not answer is unchanged.
		expect(fmOf(after).coverage).toBe('partial');
		expect(fmOf(after).scope).toBe('Account provisioning only');
		expect(after).toContain('reviewer: "A. Reviewer"');
		expect(after).toContain('confidence: 0.90');
	});

	it('an answered scope replaces the recorded one rather than appending to it', async () => {
		// A text control the person typed into. The recorded value must not
		// survive alongside the new one, which a naive line-merge would do.
		const { app, files } = makeVault();
		seedReviewed(files);

		await pressCreateLink(app, { scope: 'Whole control' });

		const after = files.get(LINK_PATH)!;
		expect(fmOf(after).scope).toBe('Whole control');
		expect(after).not.toContain('Account provisioning only');
		expect(fmTextOf(after).split('\n').filter((l) => l.startsWith('scope:'))).toHaveLength(1);
	});

	it('still rewrites the keys the window DOES own', async () => {
		// The control. A merge that preserved everything would preserve the defect
		// in the other direction: a link whose recorded facts never update.
		const { app, files } = makeVault();
		seedReviewed(files);
		// A title from an older era, and a subject label that no longer matches.
		files.set(LINK_PATH, files.get(LINK_PATH)!
			.replace('title: "AC-2 has evidence: MFA policy"', 'title: "an old title nobody rewrote"'));

		await pressCreateLink(app);

		const after = files.get(LINK_PATH)!;
		expect(after).not.toContain('an old title nobody rewrote');
		expect(fmOf(after).title).toBe('AC-2 has evidence: MFA policy');
		expect(fmOf(after).curie).toBe(LINK_CURIE);
		expect(fmOf(after).kind).toBe('junction-note');
	});

	it('refreshes its OWN unedited body when a control changes', async () => {
		// The body says, in words, whether the link counts. Leaving that behind
		// after a status change would put a sentence on the note contradicting the
		// property beside it. The window may rewrite a body it can show it wrote:
		// one byte-identical to what it would have written for the facts the note
		// itself records.
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		await pressCreateLink(app);
		expect(files.get(LINK_PATH)).toContain('This link is `proposed`');

		await pressCreateLink(app, { status: 'in_review' });

		const after = files.get(LINK_PATH)!;
		expect(after).toContain('This link is `in_review`');
		expect(after).not.toContain('This link is `proposed`');
	});

	it('leaves an EDITED body alone even when the same control changes', async () => {
		// The asymmetry that makes the refresh above safe. Once a person has
		// written in the note, the window is not the author of that text, and a
		// stale generated sentence is the cheaper loss.
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		await pressCreateLink(app);
		files.set(LINK_PATH, `${files.get(LINK_PATH)!}\n${PROSE}\n`);

		await pressCreateLink(app, { status: 'in_review' });

		const after = files.get(LINK_PATH)!;
		expect(after).toContain(PROSE);
		// The property still updated; only the prose is off limits.
		expect(fmOf(after).status).toBe('in_review');
	});

	it('a fresh link is still created, unchanged by any of this', async () => {
		// The control that keeps the merge from being a refusal in disguise.
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');

		await pressCreateLink(app);

		expect(files.has(LINK_PATH)).toBe(true);
		expect(fmOf(files.get(LINK_PATH)!).curie).toBe(LINK_CURIE);
		expect(said()).toContain('Evidence link created.');
	});
});

// ===========================================================================
// AM-40 — the gate is gone, and the readers beneath it still answer.
// ===========================================================================

describe('AM-40: the window answers correctly with a cold metadata cache', () => {
	it('creates the link during startup indexing instead of telling the user to come back', async () => {
		// The ordinary case the gate blocked: nothing is wrong, the vault is
		// simply still being read, and the window refused to do anything at all.
		const { app, files } = makeVault({ coldCache: true });
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');

		await pressCreateLink(app);

		expect(files.has(LINK_PATH)).toBe(true);
		expect(said()).not.toContain('still reading');
		expect(said()).not.toContain('indexing');
	});

	it('finds the junction that already exists rather than minting a second one', async () => {
		// What the gate was protecting: a half-read vault answering "no junction
		// names this pair" about junctions it never saw. The readers below it
		// raw-read a cache-missed file, so the answer is right without it — which
		// is the whole argument for deleting it.
		const { app, files } = makeVault({ coldCache: true });
		seedReviewed(files);

		await pressCreateLink(app);

		expect([...files.keys()].filter((p) => p.startsWith(FOLDER))).toEqual([LINK_PATH]);
		expect(said()).toContain('Updated the existing link');
	});

	it('preserves the reviewer fields on that cold-cache update too', async () => {
		// The two amendments meet here: the update the gate used to prevent is now
		// reached, so it had better be the merging update and not the replacing
		// one.
		const { app, files } = makeVault({ coldCache: true });
		seedReviewed(files);

		await pressCreateLink(app);

		const after = files.get(LINK_PATH)!;
		expect(after).toContain('reviewer: "A. Reviewer"');
		expect(after).toContain('expires_at: 2027-01-01  # renewal window');
		expect(after).toContain(PROSE);
		expect(fmOf(after).status).toBe('approved');
	});

	it('a junction whose properties cannot be read still refuses, cold cache or not', async () => {
		// AM-35 is not what AM-40 removed. The fail-closed refusal that lives
		// where the read happens is untouched, and a cold cache does not turn it
		// into a mint.
		//
		// AM-43 moved this refusal from a Notice at submit time into the pair
		// lookup's own state: the lookup runs once, before the controls are even
		// answerable, and the submit button stays disabled while `pairRefusal` is
		// set — so a real UI never lets `create()` run at all here. `create()`
		// itself now only re-triggers the lookup and reports "Checking...".
		const { app, files } = makeVault({ coldCache: true });
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set('Notes/Damaged.md', '---\n: : :\n  - broken\n---\n\nText.\n');

		// `create()` is deliberately NOT called here: with no resolution, it only
		// re-triggers the lookup (`pairChanged()` clears `pairRefusal` and fires a
		// new async `resolvePair`) and shows a generic "Checking..." notice — a
		// real UI never reaches it anyway, because the submit button stays
		// disabled while `pairRefusal` is set.
		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		await modal.resolvePair(CONTROL, EVIDENCE);

		expect(files.has(LINK_PATH)).toBe(false);
		expect(modal.pairRefusal).toContain('Notes/Damaged.md');
		expect(modal.pairRefusal).toContain('could not be read');
	});
});
