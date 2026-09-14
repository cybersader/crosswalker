import type { App, TFolder } from 'obsidian';
import { TFile } from 'obsidian';
import { ExportFolderPickerModal } from '../../src/export/folder-picker-modal';
import { exportSiblingPath, writeExportFile } from '../../src/export/write-export-file';

function folder(
	path: string,
	name: string,
	parentPath: string | null,
	root: boolean,
): TFolder {
	return {
		path,
		name,
		parent: parentPath === null ? null : { path: parentPath },
		children: [],
		isRoot: () => root,
	} as unknown as TFolder;
}

function makeWriterApp(initial: Record<string, string> = {}): {
	app: App;
	files: Map<string, string>;
	folders: Set<string>;
	create: jest.Mock;
	modify: jest.Mock;
} {
	const files = new Map(Object.entries(initial));
	const folders = new Set<string>();
	const create = jest.fn(async (path: string, content: string) => {
		if (files.has(path) || folders.has(path)) throw new Error('target already exists');
		files.set(path, content);
		return new TFile(path);
	});
	const modify = jest.fn(async (file: TFile, content: string) => {
		files.set(file.path, content);
	});
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return { path, children: [] };
				return null;
			},
			create,
			modify,
			createFolder: jest.fn(async (path: string) => {
				folders.add(path);
			}),
		},
	} as unknown as App;
	return { app, files, folders, create, modify };
}

describe('export folder root naming', () => {
	it.each([
		['', 'csv', 'vault.export.csv'],
		['/', 'csv', 'vault.export.csv'],
		['', 'tsv', 'vault.export.tsv'],
		['/', 'tsv', 'vault.export.tsv'],
	])('uses isRoot() for root path %p with extension %s', (path, extension, expected) => {
		expect(exportSiblingPath(folder(path, '', null, true), extension)).toBe(expected);
	});

	it.each([
		['csv', 'Frameworks/NIST.export.csv'],
		['tsv', 'Frameworks/NIST.export.tsv'],
	])('keeps non-root sibling naming unchanged for %s', (extension, expected) => {
		expect(exportSiblingPath(folder('Frameworks/NIST', 'NIST', 'Frameworks', false), extension))
			.toBe(expected);
	});

	it.each(['', '/'])('labels root path %p with the public root predicate', (path) => {
		const modal = new ExportFolderPickerModal({} as App, jest.fn());
		expect(modal.getItemText(folder(path, '', null, true))).toBe('/ (vault root)');
	});

	it('keeps non-root picker labels unchanged', () => {
		const modal = new ExportFolderPickerModal({} as App, jest.fn());
		expect(modal.getItemText(folder('Frameworks/NIST', 'NIST', 'Frameworks', false)))
			.toBe('Frameworks/NIST');
	});
});

describe('writeExportFile overwrite policy', () => {
	it('retains the legacy default of replacing an existing file', async () => {
		const { app, files, create, modify } = makeWriterApp({ 'Exports/table.tsv': 'old bytes' });

		await writeExportFile(app, 'Exports/table.tsv', 'new bytes');

		expect(files.get('Exports/table.tsv')).toBe('new bytes');
		expect(modify).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
	});

	it('retains the legacy default of creating a missing file', async () => {
		const { app, files, create, modify } = makeWriterApp();

		await writeExportFile(app, 'table.tsv', 'new bytes');

		expect(files.get('table.tsv')).toBe('new bytes');
		expect(create).toHaveBeenCalledTimes(1);
		expect(modify).not.toHaveBeenCalled();
	});

	it('refuses an existing file when overwrite is disabled', async () => {
		const { app, files, create, modify } = makeWriterApp({ 'table.tsv': 'old bytes' });

		await expect(writeExportFile(app, 'table.tsv', 'new bytes', { overwriteExisting: false }))
			.rejects.toThrow(/already exists/i);

		expect(files.get('table.tsv')).toBe('old bytes');
		expect(create).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
	});

	it('never converts a create-only race into an overwrite', async () => {
		const { app, files, create, modify } = makeWriterApp();
		create.mockImplementationOnce(async (path: string) => {
			files.set(path, 'racing writer bytes');
			throw new Error('target appeared during create');
		});

		await expect(writeExportFile(app, 'table.tsv', 'new bytes', { overwriteExisting: false }))
			.rejects.toThrow(/appeared during create/i);

		expect(files.get('table.tsv')).toBe('racing writer bytes');
		expect(modify).not.toHaveBeenCalled();
	});

	it('refuses a non-file destination without removing or replacing it', async () => {
		const { app, folders, create, modify } = makeWriterApp();
		folders.add('table.tsv');

		await expect(writeExportFile(app, 'table.tsv', 'new bytes', { overwriteExisting: true }))
			.rejects.toThrow(/not a file/i);

		expect(folders.has('table.tsv')).toBe(true);
		expect(create).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
	});
});
