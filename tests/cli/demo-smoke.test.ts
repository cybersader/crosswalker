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
	const temporary = tempDir('demo');
	const out = path.join(temporary, 'vault');
	const sources = path.join(temporary, 'sources');
	let result: ReturnType<typeof spawnSync>;

	beforeAll(() => {
		// The CTID release is held locally, not in git. Tests use synthetic rows,
		// with the other existing public fixtures read from the checkout.
		fs.mkdirSync(path.join(sources, 'Frameworks'), { recursive: true });
		for (const name of ['csf2.xlsx', 'NIST_SP-800-53_rev5_catalog_load.csv', 'enterprise-attack-v16.1.xlsx',
			'f3-excel-v1.2.xlsx', 'LICENSES', 'd3fend.csv', 'd3fend_to_nist80053.csv', 'att&ck_to_d3fend.csv',
			'Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx']) {
			fs.symlinkSync(path.join(REPO, 'Frameworks', name), path.join(sources, 'Frameworks', name));
		}
		fs.writeFileSync(path.join(sources, 'Frameworks/nist_800_53-rev5_attack-16.1-enterprise_json.json'), JSON.stringify({
			metadata: { attack_version: '16.1' }, mapping_objects: [
				{ capability_id: 'AC-2', attack_object_id: 'T1078', mapping_type: 'mitigates' },
				{ capability_id: 'AC-2', attack_object_id: 'T1078', mapping_type: 'mitigates' },
			],
		}));
		result = spawnSync('bun', ['scripts/demo-build.mjs', '--out', out, '--sources-dir', sources], { cwd: REPO, encoding: 'utf8' });
	}, 240000);

	afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

	it('finishes and prints a manifest', () => {
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
		expect(result.stdout).toContain('all valid');
		expect(result.stdout).toMatch(/notes in total, \d+ bytes on disk/);
	});

	it('has the frameworks, both link sets, evidence, queries and the start note', () => {
		for (const folder of [
			'Frameworks/NIST-CSF-2.0', 'Frameworks/NIST-SP-800-53-r5', 'Frameworks/MITRE-ATT&CK',
			'_crosswalker/mappings/csf-to-800-53', '_crosswalker/mappings/csf-to-mitre',
			'Frameworks/MITRE-D3FEND', 'Frameworks/MITRE-ATT&CK-Mitigations',
			'_crosswalker/mappings/800-53-to-attack', '_crosswalker/mappings/800-53-to-d3fend',
			'_crosswalker/mappings/attack-mitigations-to-d3fend',
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

	it('refuses output inside either checkout, including a symlink alias', () => {
		const alias = path.join(temporary, 'sources-alias');
		fs.symlinkSync(sources, alias);
		const rejected = spawnSync('bun', ['scripts/demo-build.mjs', '--out', path.join(alias, 'unsafe'), '--sources-dir', sources], { cwd: REPO, encoding: 'utf8' });
		expect(rejected.status).toBe(1);
		expect(rejected.stderr).toContain('outside the repository and the sources checkout');
		expect(fs.existsSync(path.join(sources, 'unsafe'))).toBe(false);
	});

	it('writes the graph settings as the only file under .obsidian', () => {
		expect(fs.readdirSync(path.join(out, '.obsidian'))).toEqual(['graph.json']);
		const graph = JSON.parse(fs.readFileSync(path.join(out, '.obsidian/graph.json'), 'utf8'));
		expect(graph).toMatchObject({ showTags: false, showArrow: false, lineSizeMultiplier: 1.3, hideUnresolved: true, showOrphans: false, showAttachments: false });
		expect(graph.colorGroups.length).toBeGreaterThanOrEqual(7);
		expect(graph.colorGroups).toContainEqual(expect.objectContaining({ query: 'tag:#mitre-d3fend OR [curie:"mitre-d3fend:"]' }));
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
		const notes = fs.readdirSync(folder).filter((f) => f.endsWith('.md') && f !== 'LICENSE.md').map((file) => {
			const text = fs.readFileSync(path.join(folder, file), 'utf8');
			return yaml.load(text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)![1]) as Record<string, any>;
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

	it('imports full ATT&CK with resolved parents, separate mitigations and sparse D3FEND levels', () => {
		const read = (folder: string) => fs.readdirSync(path.join(out, folder)).filter((name) => name.endsWith('.md') && name !== 'LICENSE.md')
			.map((name) => yaml.load(fs.readFileSync(path.join(out, folder, name), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)![1]) as Record<string, any>);
		const techniques = read('Frameworks/MITRE-ATT&CK');
		expect(techniques).toHaveLength(656);
		expect(techniques.filter((note) => note.parent)).toHaveLength(453);
		for (const note of techniques.filter((note) => note.parent)) {
			expect(fs.existsSync(path.join(out, 'Frameworks/MITRE-ATT&CK', `${note.technique_id.split('.')[0]}.md`))).toBe(true);
		}
		const mitigations = read('Frameworks/MITRE-ATT&CK-Mitigations');
		expect(mitigations).toHaveLength(44);
		expect(mitigations.every((note) => note.mitigation_id && !note.technique_id)).toBe(true);
		expect(mitigations.every((note) => note.curie === `mitre-attack:${note.mitigation_id}`)).toBe(true);
		expect(mitigations.every((note) => note.tags?.includes('mitre-attack'))).toBe(true);
		const graph = JSON.parse(fs.readFileSync(path.join(out, '.obsidian/graph.json'), 'utf8'));
		expect(graph.colorGroups).toContainEqual(expect.objectContaining({ query: 'tag:#mitre-attack OR [curie:"mitre-attack:"]', color: { rgb: 0xe5484d, a: 1 } }));
		const hierarchy = fs.readFileSync(path.join(out, 'Queries/ATT&CK hierarchy.base'), 'utf8');
		expect(hierarchy).toContain(techniques[0]._crosswalker.import_set.id);
		expect(hierarchy).not.toContain(mitigations[0]._crosswalker.import_set.id);
		const defensive = read('Frameworks/MITRE-D3FEND');
		expect(defensive).toHaveLength(183);
		expect(defensive.every((note) => note.title && note.technique_id && !note.parent)).toBe(true);
		const edges = read('_crosswalker/mappings/800-53-to-d3fend').filter((note) => note.kind === 'crosswalk-edge');
		expect(edges).toHaveLength(180);
		for (const edge of edges) expect(edge.sssom_predicate).toBe('skos:relatedMatch');
		// Tracked fidelity gap: neither extension nor comment projects to notes yet.
		expect(edges[0]).not.toHaveProperty('source_relation');
		expect(edges[0]).not.toHaveProperty('comment');
		// Disjoint catalogs share the publisher namespace without changing M ids.
		const mitigationEdges = read('_crosswalker/mappings/attack-mitigations-to-d3fend').filter((note) => note.kind === 'crosswalk-edge');
		expect(mitigationEdges).toHaveLength(89);
		for (const edge of mitigationEdges) {
			expect(edge.subject_id).toMatch(/^mitre-attack:M\d{4}$/);
			expect(mitigations.some((note) => note.mitigation_id === edge.subject_id.split(':')[1])).toBe(true);
			expect(defensive.some((note) => note.curie === edge.object_id)).toBe(true);
			expect(edge.subject_note).toBeTruthy();
			expect(edge.object_note).toBeTruthy();
		}
		expect(fs.readFileSync(path.join(out, 'Start here.md'), 'utf8')).toContain('89 resolved subject links and 89 resolved object links.');
	});

	it('carries no restricted content or restricted framework names', () => {
		for (const [p, bytes] of readTree(out)) {
			const folders = p.split('/').slice(0, -1).join('/');
			expect({ p, restricted: RESTRICTED.test(folders) }).toEqual({ p, restricted: false });
			expect({ p, licensed: bytes.toString('utf8').includes('_licensed') }).toEqual({ p, licensed: false });
		}
	});
});
