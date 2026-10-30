/**
 * Demo smoke: `bun run demo:build` produces a vault that validates, has the
 * expected folders, and carries no restricted content.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const RESTRICTED = /(_licensed|\bcri\b|cri-profile|iso[-_ ]?27|\biso\b|soc[-_ ]?2|\bpci\b|\bcis\b|cis-controls|\bscf\b)/i;

describe('demo:build', () => {
	const out = path.join(tempDir('demo'), 'vault');
	let result: ReturnType<typeof spawnSync>;

	beforeAll(() => {
		result = spawnSync('bun', ['scripts/demo-build.mjs', '--out', out], { cwd: REPO, encoding: 'utf8' });
	}, 240000);

	it('finishes and prints a manifest', () => {
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
		expect(result.stdout).toContain('all valid');
		expect(result.stdout).toMatch(/notes in total, \d+ bytes on disk/);
	});

	it('has the frameworks, both link sets, evidence, queries and the start note', () => {
		for (const folder of [
			'Frameworks/NIST-CSF-2.0', 'Frameworks/NIST-SP-800-53-r5', 'Frameworks/MITRE-ATT&CK',
			'_crosswalker/mappings/csf-to-800-53', '_crosswalker/mappings/csf-to-mitre',
			'Evidence/Documents', 'Evidence/Junctions', 'Queries',
		]) {
			expect({ folder, exists: fs.existsSync(path.join(out, folder)) }).toEqual({ folder, exists: true });
		}
		expect(fs.existsSync(path.join(out, 'Start here.md'))).toBe(true);
		const evidence = fs.readdirSync(path.join(out, 'Evidence/Junctions'));
		expect(evidence.length).toBeGreaterThanOrEqual(3);
		expect(evidence.length).toBeLessThanOrEqual(5);
		const bases = fs.readdirSync(path.join(out, 'Queries')).filter((f) => f.endsWith('.base'));
		expect(bases.length).toBeGreaterThanOrEqual(4);
	});

	it('writes the graph settings as the only file under .obsidian', () => {
		expect(fs.readdirSync(path.join(out, '.obsidian'))).toEqual(['graph.json']);
		const graph = JSON.parse(fs.readFileSync(path.join(out, '.obsidian/graph.json'), 'utf8'));
		expect(graph).toMatchObject({ showTags: true, showArrow: true, hideUnresolved: true, showOrphans: false, showAttachments: false });
		expect(graph.colorGroups.length).toBeGreaterThanOrEqual(5);
	});

	it('builds every framework level as a note that links to its parent', () => {
		for (const note of [
			'Frameworks/NIST-CSF-2.0/PR/PR.AA/PR.AA-01.md',
			'Frameworks/NIST-SP-800-53-r5/AC/AC-2/AC-2.md',
		]) {
			expect({ note, exists: fs.existsSync(path.join(out, note)) }).toEqual({ note, exists: true });
		}
		const start = fs.readFileSync(path.join(out, 'Start here.md'), 'utf8');
		for (const [, file] of start.matchAll(/`((?:Frameworks|Queries)\/[^`]+\.(?:md|base))`/g)) {
			expect({ file, exists: fs.existsSync(path.join(out, file)) }).toEqual({ file, exists: true });
		}
		const control = fs.readFileSync(path.join(out, 'Frameworks/NIST-SP-800-53-r5/AC/AC-2/AC-2.md'), 'utf8');
		expect(control).toMatch(/^parent: .*\[\[/m);
	});

	it('validates with cw validate', async () => {
		const { io, err } = captureIo();
		expect(await runCli(['validate', '--vault', out], io)).toBe(0);
		expect(err).toEqual([]);
	}, 60000);

	it('targets the queries at the demo set ids', () => {
		const ids = [...result.stdout.matchAll(/Set id: (iset-[a-z0-9]+)\./g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThanOrEqual(6);
		const coverage = fs.readFileSync(path.join(out, 'Queries/CSF to 800-53 coverage.base'), 'utf8');
		expect(coverage).toMatch(/csf-to-800-53|iset-/);
	});

	// The demo exists to show mappings joining real framework notes. A link set
	// whose ends point at notes the vault does not have reads as empty in Obsidian.
	// The few CSF to 800-53 rows that stay unresolved name a family, a category,
	// or a control newer than the catalog, so they are source gaps, not bugs.
	it('resolves mapping links to framework notes at both ends', () => {
		const resolved = (folder: string) => {
			let total = 0;
			let both = 0;
			for (const name of fs.readdirSync(path.join(out, folder)).filter((f) => f.endsWith('.md'))) {
				const text = fs.readFileSync(path.join(out, folder, name), 'utf8');
				const ends = ['subject_note', 'object_note'].map(
					(key) => new RegExp(`^${key}: "\\[\\[([^|\\]]+)`, 'm').exec(text)?.[1],
				);
				if (ends.every((e) => e === undefined)) continue;
				total++;
				if (ends.every((e) => e !== undefined && fs.existsSync(path.join(out, `${e}.md`)))) both++;
			}
			return { total, both };
		};
		const nist = resolved('_crosswalker/mappings/csf-to-800-53');
		expect(nist.total).toBeGreaterThan(700);
		expect(nist.both / nist.total).toBeGreaterThan(0.98);
		const mitre = resolved('_crosswalker/mappings/csf-to-mitre');
		expect(mitre).toEqual({ total: mitre.total, both: mitre.total });
		expect(mitre.total).toBeGreaterThan(0);
	});

	it('imports all real F3 techniques and tactics last, with resolved hierarchy links', () => {
		const folder = path.join(out, 'Frameworks/MITRE-F3');
		const notes = fs.readdirSync(folder).filter((f) => f.endsWith('.md')).map((file) => {
			const text = fs.readFileSync(path.join(folder, file), 'utf8');
			return yaml.load(text.split('---')[1]) as Record<string, any>;
		});
		const techniques = notes.filter((n) => n.technique_id);
		const tactics = notes.filter((n) => n.tactic_id);
		expect(techniques).toHaveLength(138);
		expect(tactics).toHaveLength(8);
		expect(techniques.filter((n) => n.tactic_ids.length > 1)).toHaveLength(41);
		const byId = new Map(techniques.map((n) => [n.technique_id, n]));
		let parents = 0;
		let tacticLinks = 0;
		for (const note of techniques) {
			expect(note.curie).toBe(`mitre-f3:${note.technique_id}`);
			expect(note._crosswalker.import_set.ontology).toBe('mitre-f3');
			if (note.technique_id.includes('.')) {
				parents++;
				const parent = note.technique_id.split('.')[0];
				expect(note.parent).toBe(`[[${parent}]]`);
				expect(note.parent_curie).toBe(`mitre-f3:${parent}`);
				expect(byId.get(parent)?.children).toContain(`[[${note.technique_id}]]`);
				expect(fs.existsSync(path.join(folder, `${parent}.md`))).toBe(true);
			} else {
				expect(note.parent).toBeUndefined();
				expect(note.parent_curie).toBeUndefined();
			}
			expect(note.tactic_notes).toEqual(note.tactic_ids.map((id: string) => `[[${id}]]`));
			for (const id of note.tactic_ids) {
				tacticLinks++;
				expect(tactics.some((n) => n.tactic_id === id)).toBe(true);
				expect(fs.existsSync(path.join(folder, `${id}.md`))).toBe(true);
			}
		}
		expect(parents).toBe(55);
		expect(tacticLinks).toBe(191);
		for (const note of tactics) expect(note._crosswalker.import_set.ontology).toBe('mitre-f3');
		const license = fs.readFileSync(path.join(REPO, 'Frameworks/LICENSES/mitre-f3-LICENSE.txt'), 'utf8');
		expect(fs.readFileSync(path.join(folder, 'LICENSE.txt'), 'utf8')).toBe(license);
		// Markdown copy for hosts that refuse .txt: upstream text unchanged inside one fence.
		const licenseMd = fs.readFileSync(path.join(folder, 'LICENSE.md'), 'utf8');
		expect(licenseMd.startsWith('# MITRE Fight Fraud Framework (F3) license\n')).toBe(true);
		expect(licenseMd).toContain(`\n\`\`\`text\n${license.replace(/\n$/, '')}\n\`\`\`\n`);
		expect(licenseMd).not.toMatch(/^---/);
		expect(result.stdout).toContain('csf=iset-a0f1e2, sp80053=iset-0f6ht0, attack=iset-xskeb8, csfTo80053=iset-7z4lxm, csfToAttack=iset-if5214, evidence=iset-g3sec8, f3=iset-xfkz1i, f3Tactics=iset-juu0p7');
		const start = fs.readFileSync(path.join(out, 'Start here.md'), 'utf8');
		expect(start).toContain('Frameworks/MITRE-F3/F1002.001.md');
		expect(start).not.toContain('Fight Fraud Framework (sample');
	});

	it('carries no restricted content or restricted framework names', () => {
		for (const [p, bytes] of readTree(out)) {
			const folders = p.split('/').slice(0, -1).join('/');
			expect({ p, restricted: RESTRICTED.test(folders) }).toEqual({ p, restricted: false });
			expect({ p, licensed: bytes.toString('utf8').includes('_licensed') }).toEqual({ p, licensed: false });
		}
	});
});
