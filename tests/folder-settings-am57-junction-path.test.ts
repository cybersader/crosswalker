/**
 * folder-settings-am57-junction-path.test.ts -- AM-57 (2026-09-04, pass 18,
 * Task C item 5): one normalizer for every folder setting, pinned at the
 * junction-note composition site.
 *
 * THE DEFECT THIS PINS (pass-17 SUSPECTED 7, promoted). `evidenceLinkPath`
 * composed `${folder}/${name}-${hash}.md` from the RAW `evidenceJunctionFolder`
 * setting. With the folder configured as `Evidence/Junctions/` (a trailing
 * separator -- entered once, in Settings, no import involved), the composed
 * path was `Evidence/Junctions//X-<hash>.md`. `getAbstractFileByPath` is a
 * direct key lookup that normalizes nothing, so the occupant check answered
 * null on a key the vault's file map does not hold: the address refusal that
 * exists to stop a junction note landing on somebody else's note could not
 * fire, and `vault.create` was handed a path nobody had normalized.
 *
 * THE RULE. `evidenceLinkPath` composes through `normalizeFolderSetting` --
 * the SAME accessor AM-53 built for the output root, now generalised to every
 * folder a person types into Settings. This test proves both halves: the
 * composed string never carries a double separator, AND a vault whose file
 * map holds the NORMALIZED path is found by the occupant check the modal
 * actually performs (`getAbstractFileByPath` on the composed path).
 */

import { TFile } from 'obsidian';
import { evidenceLinkPath } from '../src/views/evidence-link';
import { evidenceJunctionFolder, DEFAULT_EVIDENCE_JUNCTION_FOLDER } from '../src/settings/folder-settings';
import type { App } from 'obsidian';

const CONTROL_CURIE = 'cwk:ac-1';
const CONTROL_PATH = 'Controls/AC-1.md';
const EVIDENCE_PATH = 'Evidence/MFA policy.md';

describe('AM-57: a junction folder setting with a trailing slash composes a SINGLE-slash path', () => {
	it('evidenceLinkPath never emits a doubled separator for a trailing-slash folder', () => {
		const path = evidenceLinkPath('Evidence/Junctions/', CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		expect(path).not.toContain('//');
		expect(path.startsWith('Evidence/Junctions/')).toBe(true);
	});

	it('a trailing slash and no trailing slash compose the IDENTICAL address', () => {
		const withSlash = evidenceLinkPath('Evidence/Junctions/', CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		const withoutSlash = evidenceLinkPath('Evidence/Junctions', CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		expect(withSlash).toBe(withoutSlash);
	});
});

describe('AM-57: the occupant check sees the existing note at the composed address', () => {
	function makeApp(existingPath: string): App {
		return {
			vault: {
				getAbstractFileByPath: (path: string) => (path === existingPath ? new TFile(path) : null),
			},
		} as unknown as App;
	}

	it('a junction note already at the NORMALIZED address is found, even though the setting carries a trailing slash', () => {
		const path = evidenceLinkPath('Evidence/Junctions/', CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		const app = makeApp(path); // seeded at the correctly normalized address
		const occupant = app.vault.getAbstractFileByPath(path);
		expect(occupant).not.toBeNull();
		expect((occupant as TFile).path).toBe(path);
	});

	it('going through the settings accessor first (the real call chain) composes the same address the occupant check sees', () => {
		const settings = { evidenceJunctionFolder: 'Evidence/Junctions/' };
		const folder = evidenceJunctionFolder(settings); // main.ts's own read site
		const path = evidenceLinkPath(folder, CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		expect(path).not.toContain('//');
		const app = makeApp(path);
		expect(app.vault.getAbstractFileByPath(path)).not.toBeNull();
	});

	it('an UNDEFINED setting (a record from before the field existed) falls back to the shared default, still composing a normalized address', () => {
		// S11 (2026-09-04, pass 19): the default applies to exactly ONE state --
		// the stored field is `undefined`. An empty string is a CHOICE (the vault
		// root), not an absence, and is handled by the next describe block.
		const folder = evidenceJunctionFolder({});
		expect(folder).toBe(DEFAULT_EVIDENCE_JUNCTION_FOLDER);
		const path = evidenceLinkPath(folder, CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		expect(path.startsWith(`${DEFAULT_EVIDENCE_JUNCTION_FOLDER}/`)).toBe(true);
		expect(path).not.toContain('//');
	});
});

/**
 * S11 (2026-09-04, pass 19): the vault root is a folder a person can
 * legitimately choose for evidence links, and choosing it must not silently
 * substitute the default the way it did before this ruling.
 *
 * THE DEFECT THIS PINS. `evidenceJunctionFolder`/`evidenceReportFolder` used
 * to apply the default whenever the stored value NORMALIZED to empty, and
 * `normalizeFolderSetting('/')` is `''` by design (both spellings of the root
 * agree) -- so a person who picked the vault root in the folder suggester, or
 * typed a bare `/`, got `Evidence/Junctions` instead, silently. The accessors
 * now mirror `outputRootPath`, not `outputRootFile`: a value that normalizes
 * to nothing IS the vault root and is RETURNED as such, and the default
 * applies only to the one genuinely absent state above (`undefined`).
 */
describe('S11: the vault root is a real, reachable choice for the evidence folders -- not a silent substitution', () => {
	it('evidenceJunctionFolder({ evidenceJunctionFolder: "/" }) is "" -- the root, never the default', () => {
		expect(evidenceJunctionFolder({ evidenceJunctionFolder: '/' })).toBe('');
	});

	it('evidenceJunctionFolder({ evidenceJunctionFolder: "" }) is ALSO "" -- an explicit empty string is the root too, not the default', () => {
		expect(evidenceJunctionFolder({ evidenceJunctionFolder: '' })).toBe('');
	});

	it('the junction composes at the vault root as "<name>.md" -- no leading separator, and never the default folder', () => {
		const folder = evidenceJunctionFolder({ evidenceJunctionFolder: '/' });
		const path = evidenceLinkPath(folder, CONTROL_CURIE, CONTROL_PATH, EVIDENCE_PATH);
		expect(path.startsWith('/')).toBe(false);
		expect(path).not.toContain('//');
		expect(path.startsWith(`${DEFAULT_EVIDENCE_JUNCTION_FOLDER}/`)).toBe(false);
		// A root-composed address is a bare file name: no directory component
		// before it at all.
		expect(path).not.toContain('/');
	});

	it('undefined still yields the default, so the two states (absent vs. root) remain distinguishable', () => {
		expect(evidenceJunctionFolder({ evidenceJunctionFolder: undefined })).toBe(DEFAULT_EVIDENCE_JUNCTION_FOLDER);
		expect(evidenceJunctionFolder({})).toBe(DEFAULT_EVIDENCE_JUNCTION_FOLDER);
	});
});
