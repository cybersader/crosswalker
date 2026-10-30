import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runCli } from '../../cli/crosswalker';
import { referencedFramework, referencedFrameworkRecipe } from '../../src/import/stack/referenced-frameworks';
import { mappingRowsToTsv } from '../../src/import/stack/mapping-readers';
import { captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

it('replaces an id-only note with the full framework in its explicitly selected set, preserving identity, links and user work', async () => {
	const root = tempDir('referenced-takeover');
	try {
		const vault = path.join(root, 'vault');
		fs.mkdirSync(vault);
		const binding = { column: 'Invented references', label: 'Invented target', ontology: 'invented-target' };
		const converted = referencedFramework([{ 'Invented id': 'XX-999', 'Invented references': 'ZZ 999\nZZ/999' }], binding, { idColumn: 'Invented id', ontology: 'invented-source' });
		const recipe = referencedFrameworkRecipe(binding.ontology, 'Invented source');
		const recipeFile = path.join(root, 'recipe.json');
		const sourceFile = path.join(root, 'references.csv');
		fs.writeFileSync(recipeFile, JSON.stringify(recipe));
		fs.writeFileSync(sourceFile, 'id,framework,file_id\n' + converted.notes.map((note) => `${note.id},${note.framework},${note.file_id}`).join('\n') + '\n');
		const destination = 'Frameworks/Invented references';
		const run = async (args: string[]) => {
			const { io, out, err } = captureIo();
			const code = await runCli([...args, '--vault', vault, '--deterministic'], io);
			expect({ code, errors: err.filter((line) => !line.startsWith('warning: ')) }).toEqual({ code: 0, errors: [] });
			return out.join('\n');
		};
		const initial = await run(['import', '--source', sourceFile, '--recipe', recipeFile, '--destination', destination]);
		const setId = /Set id: (iset-[a-z0-9]+)\./.exec(initial)![1];
		const original = [...readTree(vault)].filter(([file]) => file.startsWith(`${destination}/`));
		expect(original).toHaveLength(2);
		for (const [file, bytes] of original) {
			expect(bytes.toString()).toContain("Only the identifier is known here.");
			fs.writeFileSync(path.join(vault, file), bytes.toString().replace(/^---\n/, '---\nreviewer: Invented reviewer\n') + '\nUser annotation outside managed content.\n');
		}
		const mappingsFile = path.join(root, 'mappings.sssom.tsv');
		fs.writeFileSync(mappingsFile, mappingRowsToTsv(converted.mappings, 'Invented publisher', 'invented-source', 'invented-target', '2099'));
		await run(['import', '--source', mappingsFile, '--destination', 'Mappings', '--set', 'new-set-qualified']);
		const edgeFiles = [...readTree(vault)].filter(([file, bytes]) => file.startsWith('Mappings/') && bytes.toString().includes('kind: crosswalk-edge'));
		expect(edgeFiles).toHaveLength(2);
		const originalLinks = edgeFiles.map(([, bytes]) => (yaml.load(/^---\n([\s\S]*?)\n---/.exec(bytes.toString())![1]) as Record<string, unknown>).object_note);
		expect(originalLinks.every((link) => typeof link === 'string' && link.includes(destination))).toBe(true);

		const full = JSON.parse(JSON.stringify(recipe));
		full.recipe = 'invented-full-framework';
		full.target.also_emit.frontmatter.managed.title = '{Invented title}';
		full.target.also_emit.body = [{ position: 'append', template: '{Invented prose}' }];
		fs.writeFileSync(recipeFile, JSON.stringify(full));
		fs.writeFileSync(sourceFile, 'id,framework,file_id,Invented title,Invented prose\n' + converted.notes.map((note) => `${note.id},${note.framework},${note.file_id},Invented complete title,Invented complete description.`).join('\n') + '\n');
		const refreshed = await run(['import', '--source', sourceFile, '--recipe', recipeFile, '--destination', destination, '--set', setId]);
		expect(refreshed).toContain('2 updated');
		const tree = readTree(vault);
		const after = [...tree].filter(([file]) => file.startsWith(`${destination}/`));
		expect(after.map(([file]) => file).sort()).toEqual(original.map(([file]) => file).sort());
		for (const [file, bytes] of after) {
			const text = bytes.toString();
			const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as Record<string, any>;
			const old = yaml.load(/^---\n([\s\S]*?)\n---/.exec(original.find(([name]) => name === file)![1].toString())![1]) as Record<string, any>;
			expect(fm.curie).toBe(old.curie);
			expect(fm._crosswalker.import_set.id).toBe(setId);
			expect(fm.reviewer).toBe('Invented reviewer');
			expect(text).toContain('User annotation outside managed content.');
			expect(text).toContain('Invented complete description.');
			expect(text).not.toContain('Only the identifier is known here.');
			expect(text).not.toContain('cw-referenced-framework');
		}
		for (const [file, bytes] of edgeFiles) expect(tree.get(file)).toEqual(bytes);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
