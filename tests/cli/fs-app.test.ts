import * as fs from 'node:fs';
import * as path from 'node:path';
import { TFile, TFolder } from 'obsidian';
import { createFsApp, vaultRelative, UnsupportedFromCommandLineError } from '../../cli/fs-app';
import { tempDir } from './helpers';

describe('cli/fs-app', () => {
	it('round-trips create, read, modify, process, rename and delete through the real folder', async () => {
		const root = tempDir('fsapp');
		const app = createFsApp(root);
		const note = 'Frameworks/Demo/AC-1.md';

		const file = await app.vault.create(note, '---\ntitle: AC-1\nrelated: "[[AC-2]]"\n---\nBody\n');
		expect(file).toBeInstanceOf(TFile);
		expect(fs.readFileSync(path.join(root, note), 'utf8')).toContain('title: AC-1');
		expect(app.vault.getAbstractFileByPath('Frameworks/Demo')).toBeInstanceOf(TFolder);
		expect(app.vault.getMarkdownFiles().map((f: TFile) => f.path)).toEqual([note]);
		expect(app.metadataCache.getFileCache(file).frontmatter.title).toBe('AC-1');

		await app.vault.modify(file, '---\ntitle: AC-1 changed\n---\n');
		expect(await app.vault.read(file)).toBe('---\ntitle: AC-1 changed\n---\n');
		await app.vault.process(file, (text: string) => text.replace('changed', 'again'));
		expect(fs.readFileSync(path.join(root, note), 'utf8')).toContain('AC-1 again');

		await app.vault.rename(file, 'Frameworks/Other/AC-1.md');
		expect(fs.existsSync(path.join(root, note))).toBe(false);
		expect(app.vault.getAbstractFileByPath('Frameworks/Other/AC-1.md')).toBeInstanceOf(TFile);

		await app.vault.delete(app.vault.getAbstractFileByPath('Frameworks/Other/AC-1.md'));
		expect(fs.existsSync(path.join(root, 'Frameworks/Other/AC-1.md'))).toBe(false);
		expect(app.vault.getMarkdownFiles()).toHaveLength(0);
	});

	it('indexes a folder that already has notes in it', () => {
		const root = tempDir('fsapp-scan');
		fs.mkdirSync(path.join(root, 'A/B'), { recursive: true });
		fs.writeFileSync(path.join(root, 'A/B/note.md'), '---\nkind: x\n---\n');
		fs.mkdirSync(path.join(root, '.obsidian'));
		fs.writeFileSync(path.join(root, '.obsidian/app.json'), '{}');
		const app = createFsApp(root);
		expect(app.vault.getMarkdownFiles().map((f: TFile) => f.path)).toEqual(['A/B/note.md']);
		expect(app.vault.getAbstractFileByPath('.obsidian/app.json')).toBeNull();
	});

	it('rejects paths that leave the vault, and absolute paths typed by a person', async () => {
		expect(() => vaultRelative('../outside.md')).toThrow(/uses "\.\."/);
		expect(() => vaultRelative('a/../../outside.md')).toThrow(/uses "\.\."/);
		expect(() => vaultRelative('/etc/passwd')).toThrow(/absolute/);
		expect(vaultRelative('.')).toBe('');
		expect(vaultRelative('./Frameworks//Demo/')).toBe('Frameworks/Demo');

		const root = tempDir('fsapp-escape');
		const app = createFsApp(root);
		await expect(app.vault.create('../escape.md', 'x')).rejects.toThrow(/uses "\.\."/);
		expect(fs.existsSync(path.join(root, '..', 'escape.md'))).toBe(false);
		expect(app.vault.getAbstractFileByPath('../escape.md')).toBeNull();
	});

	it('accepts the leading slash the engine adds when it joins onto the vault root', async () => {
		const root = tempDir('fsapp-slash');
		const app = createFsApp(root);
		await app.vault.create('/Evidence/jn-a.md', 'x');
		expect(fs.existsSync(path.join(root, 'Evidence/jn-a.md'))).toBe(true);
		expect(app.vault.getAbstractFileByPath('/Evidence/jn-a.md')?.path).toBe('Evidence/jn-a.md');
	});

	it('names the method when the command line does not provide it', () => {
		const app = createFsApp(tempDir('fsapp-strict'));
		expect(() => (app.vault as { notAMethod: () => void }).notAMethod()).toThrow(UnsupportedFromCommandLineError);
	});
});
