import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import * as yaml from 'js-yaml';
import { REPO, readTree, tempDir } from './helpers';

const run = (...args: string[]) => spawnSync('bun', ['scripts/demo-add-licensed.mjs', ...args], { cwd: REPO, encoding: 'utf8' });

describe('private demo add-on safety', () => {
	it('runs nothing without the private-room acknowledgement', () => {
		const vault = tempDir('private-guard');
		const result = run('--vault', vault);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--private-room-only');
		expect(fs.readdirSync(vault)).toEqual([]);
		fs.rmSync(vault, { recursive: true });
	});
	it('refuses a vault inside the checkout before running imports', () => {
		const result = run('--private-room-only', '--vault', path.join(REPO, 'private-test-vault'));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('inside the repository');
		expect(fs.existsSync(path.join(REPO, 'private-test-vault'))).toBe(false);
	});
	it('refuses a symlink into the checkout', () => {
		const root = tempDir('private-symlink');
		fs.symlinkSync(REPO, path.join(root, 'vault'));
		const result = run('--private-room-only', '--vault', path.join(root, 'vault'));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('inside the repository');
		fs.rmSync(root, { recursive: true });
	});
	it.each([[], ['--only', 'cri,cis'], ['--only', 'unknown']])('rejects an ambiguous or unknown source override (%j)', (...selection) => {
		const result = run('--private-room-only', '--vault', '/unused', '--source', '/unused.xlsx', ...selection);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/single --only|Unknown framework/);
	});
	it('skips unavailable sources with acquisition guidance without changing the demo', () => {
		const root = tempDir('private-missing');
		fs.mkdirSync(path.join(root, '.obsidian'));
		fs.writeFileSync(path.join(root, 'Start here.md'), '# Start here\n');
		fs.writeFileSync(path.join(root, '.obsidian/graph.json'), '{}');
		const result = run('--private-room-only', '--vault', root, '--sources-dir', root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Skip CRI Profile');
		expect(result.stdout).toContain('Skip CIS Controls');
		expect(result.stdout).toContain('https://');
		expect(fs.readFileSync(path.join(root, 'Start here.md'), 'utf8')).toBe('# Start here\n');
		fs.rmSync(root, { recursive: true });
	});
	it('enriches synthetic sources in manifest order with shared CIS identity and deterministic output', () => {
		const root = tempDir('private-synthetic');
		try {
			const sources = path.join(root, 'sources');
			fs.mkdirSync(path.join(sources, 'Frameworks/_licensed'), { recursive: true });
			const workbook = (file: string, tables: Record<string, unknown[][]>) => {
				const book = XLSX.utils.book_new();
				for (const [name, cells] of Object.entries(tables)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cells), name);
				XLSX.writeFile(book, path.join(sources, 'Frameworks', file));
			};
			workbook('CRI-Profile-ver.-2.2.2026-04-27.xlsx', {
				'CRI Profile v2.2 Structure': [
					['Synthetic banner'], [],
					['Profile Id', 'Level', 'Outline Id', 'CRI Profile Function / Category / Subcategory', 'Tier-1', 'Tier-2', 'Tier-3', 'Tier-4', 'CRI Profile v2.2 Diagnostic Statement', 'NIST CSF v2 Mapping'],
					['XX.YY-01', 'DS', '999', 'Invented / Example / Statement', '', '', '', '', 'Invented statement for synthetic testing.', ''],
				],
				'Diagnostic Statements by Tag': [['CRI Profile Subject Tags', 'Profile Id'], ['#Invented tag', 'XX.YY-01']],
				'Subject Tag LIst': [['CRI Profile Subject Tag'], ['#Invented tag']],
			});
			workbook('_licensed/CIS_Controls_Version_8.1_6_24_2024.xlsx', {
				'Controls V8': [
					['CIS Control', 'CIS Safeguard', 'Asset Type', 'Security Function', 'Title', 'Description', 'IG1', 'IG2', 'IG3'],
					['99', '', '', '', 'Invented control', 'Synthetic control description.', '', '', ''],
					['99', '99.10', 'Invented asset', 'Invented function', 'Invented safeguard', 'Synthetic safeguard description.', 'x', '', ''],
				],
			});
			workbook('wp-contentuploads202604CRI-Profile-ver.-2.2-Mappings-Catalog.2026-04-27.xlsx', {
				'CIS v8.1': [['CIS Id', 'Profile Id'], ['99.10', 'XX.YY-01']],
			});
			for (const name of ['a', 'b']) {
				const vault = path.join(root, name);
				fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
				fs.writeFileSync(path.join(vault, 'Start here.md'), '# Start here\n\nThis vault was built by Crosswalker from public data.\n\n## Graph colors\n\n## Try this\n');
				fs.writeFileSync(path.join(vault, '.obsidian/graph.json'), '{}');
				const result = run('--private-room-only', '--vault', vault, '--sources-dir', sources, '--only', 'cis,cri');
				expect(result.stderr).toBe('');
				expect(result.status).toBe(0);
				expect(result.stdout.indexOf('CRI Profile 2.2:')).toBeLessThan(result.stdout.indexOf('CIS Controls 8.1:'));
				const notes = [...readTree(vault)].filter(([file]) => file.endsWith('.md')).flatMap(([, bytes]) => {
					const match = /^---\n([\s\S]*?)\n---/.exec(bytes.toString());
					return match ? [yaml.load(match[1]) as Record<string, any>] : [];
				});
				const cri = notes.find((fm) => fm.curie === 'cri-profile:XX.YY-01');
				expect(cri?.tags).toContain('cri/subject/invented-tag');
				const cis = notes.filter((fm) => String(fm.curie).startsWith('cis-v8:'));
				expect(cis.map((fm) => fm.curie).sort()).toEqual(['cis-v8:99', 'cis-v8:99.10']);
				expect(cis[0]._crosswalker.import_set.id).toMatch(/^iset-/);
				expect(new Set(cis.map((fm) => fm._crosswalker.import_set.id)).size).toBe(1);
				expect(cis.find((fm) => fm.curie === 'cis-v8:99.10')?.asset_class).toBe('Invented asset');
				expect(notes.filter((fm) => fm.kind === 'crosswalk-edge')).toHaveLength(1);
				expect(fs.readFileSync(path.join(vault, 'Start here.md'), 'utf8')).toContain('Private room only');
				expect(fs.readFileSync(path.join(vault, '.obsidian/graph.json'), 'utf8')).toContain('cis-v8:');
			}
			expect(readTree(path.join(root, 'a'))).toEqual(readTree(path.join(root, 'b')));
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	}, 120_000);
});
