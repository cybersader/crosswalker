import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runCli } from '../../cli/crosswalker';
import { captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

describe('explicit CLI mapping release isolation', () => {
	it('imports overlapping publisher releases without taking over the first set', async () => {
		const root = tempDir('mapping-releases');
		const vault = path.join(root, 'vault');
		fs.mkdirSync(vault);
		for (const [i, release] of ['first', 'second'].entries()) {
			const source = path.join(root, `${release}.sssom.tsv`);
			fs.writeFileSync(source, `# mapping_set_id: "urn:synthetic:${release}"\nsubject_id\tpredicate_id\tobject_id\nmade-up:XX.YY-01\tskos:relatedMatch\tother:ZZ.AA-02\n`);
			const { io, err } = captureIo();
			expect(await runCli(['import', '--source', source, '--vault', vault, '--destination', release, '--set', 'new-set-qualified', '--deterministic'], io)).toBe(0);
			expect(err).toEqual([]);
			const notes = [...readTree(vault)].filter(([file, bytes]) => file.endsWith('.md') && bytes.toString().includes('kind: crosswalk-edge'));
			expect(notes).toHaveLength(i + 1);
		}
		const facts = [...readTree(vault)].filter(([, bytes]) => bytes.toString().includes('kind: crosswalk-edge')).map(([, bytes]) => yaml.load(/^---\n([\s\S]*?)\n---/.exec(bytes.toString())![1]) as Record<string, unknown>);
		expect(new Set(facts.map((fm) => fm.curie)).size).toBe(2);
		expect(facts[0].subject_id).toBe(facts[1].subject_id);
		fs.rmSync(root, { recursive: true });
	});
	it('rejects mapping-only isolation on a framework import', async () => {
		const root = tempDir('mapping-option');
		const source = path.join(root, 'source.csv');
		fs.writeFileSync(source, 'id,title\nXX.YY-01,Invented\n');
		const { io, err } = captureIo();
		expect(await runCli(['import', '--source', source, '--vault', root, '--set', 'new-set-qualified'], io)).toBe(1);
		expect(err.join('\n')).toContain('for mapping files');
		fs.rmSync(root, { recursive: true });
	});
});
