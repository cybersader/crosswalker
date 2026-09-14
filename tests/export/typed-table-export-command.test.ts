import type { App, TFolder } from 'obsidian';
import { TFile } from 'obsidian';
import { buildNoteContent } from '../../src/generation/generation-engine';
import {
	runFolderTypedTableExport,
	type FolderTypedTableExportOutcome,
} from '../../src/export/run-folder-typed-table-export';
import { makeMockApp } from './helpers';

function folder(path: string, name: string, parentPath = '', root = false): TFolder {
	return {
		path,
		name,
		parent: root ? null : { path: parentPath },
		children: [],
		isRoot: () => root,
	} as unknown as TFolder;
}

function mappingNote(overrides: Record<string, unknown> = {}): string {
	return buildNoteContent({
		curie: 'xwalk:ac-2--a-9-2-1',
		kind: 'crosswalk-edge',
		subject_id: 'nist:AC-2',
		predicate_id: 'is_narrower_than',
		object_id: 'iso27001:A.9.2.1',
		match_confidence: 0.8,
		mapping_justification: 'Account lifecycle requirements overlap.',
		...overrides,
	}, '# Mapping\n');
}

function fixedExport(tsv = 'header\nrow\n', rowCount = 1, skipped = 0) {
	return jest.fn(async () => ({
		tsv,
		rowCount,
		skipped: Array.from({ length: skipped }, (_, index) => ({
			path: `bad-${index + 1}.md`,
			reason: 'not exportable',
		})),
	}));
}

function makeExistingTargetApp(path: string, content: string): {
	app: App;
	files: Map<string, string>;
	create: jest.Mock;
	modify: jest.Mock;
} {
	const files = new Map([[path, content]]);
	const create = jest.fn(async (createdPath: string, bytes: string) => {
		if (files.has(createdPath)) throw new Error('already exists');
		files.set(createdPath, bytes);
		return new TFile(createdPath);
	});
	const modify = jest.fn(async (file: TFile, bytes: string) => {
		files.set(file.path, bytes);
	});
	const app = {
		vault: {
			getAbstractFileByPath: (candidate: string) => files.has(candidate) ? new TFile(candidate) : null,
			create,
			modify,
			createFolder: jest.fn(),
		},
	} as unknown as App;
	return { app, files, create, modify };
}

function expectFailedWithoutRawError(outcome: FolderTypedTableExportOutcome, raw: string): void {
	expect(outcome.status).toBe('failed');
	expect(outcome.message).toMatch(/check|choose|rename|try again/i);
	expect(outcome.message).not.toContain(raw);
	expect(outcome.message).not.toMatch(/exported \d/i);
}

describe('runFolderTypedTableExport', () => {
	it('writes the existing exporter TSV to the nested folder sibling path', async () => {
		const { app, written } = makeMockApp();
		const sourcePath = 'Mappings/NIST-ISO/AC-2--A-9-2-1.md';
		const crosswalkPath = 'Mappings/NIST-ISO.export.tsv';
		const sourceBytes = mappingNote();
		const crosswalkBytes = 'existing crosswalk export bytes\n';
		written.set(sourcePath, sourceBytes);
		written.set(crosswalkPath, crosswalkBytes);

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings/NIST-ISO', 'NIST-ISO', 'Mappings'),
		});

		expect(outcome).toMatchObject({
			status: 'written',
			destinationPath: 'Mappings/NIST-ISO.export.typed-mappings.tsv',
			rowCount: 1,
			skippedCount: 0,
		});
		expect(written.get('Mappings/NIST-ISO.export.typed-mappings.tsv')).toBe(
			'Focal Document\tFocal Document Element\tReference Document\tReference Document Element\tRelationship\tStrength of Relationship (Optional)\tRationale\n' +
			'nist\tAC-2\tiso27001\tA.9.2.1\tsubset of\t8\tAccount lifecycle requirements overlap.\n',
		);
		expect(written.get(sourcePath)).toBe(sourceBytes);
		expect(written.get(crosswalkPath)).toBe(crosswalkBytes);
		expect(outcome.message).toBe('Exported 1 typed mapping to Mappings/NIST-ISO.export.typed-mappings.tsv.');
	});

	it.each(['', '/'])('uses isRoot() for a %p vault-root path representation', async (rootPath) => {
		const { app, written } = makeMockApp();
		written.set('edge.md', mappingNote({ predicate_id: 'is_equivalent_to' }));
		const exportFolder = jest.fn(async (exportApp: App, selector: string) => {
			const { exportFolderAsStrmTsv } = await import('../../src/export/strm-tsv-exporter');
			return exportFolderAsStrmTsv(exportApp, selector);
		});

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder(rootPath, rootPath, '', true),
			exportFolder,
		});

		expect(outcome.status).toBe('written');
		expect(outcome.destinationPath).toBe('vault.export.typed-mappings.tsv');
		expect(outcome.message).toContain('vault.export.typed-mappings.tsv');
		expect(exportFolder).toHaveBeenCalledWith(app, '');
		expect(written.get('vault.export.typed-mappings.tsv')).toContain('\tequal\t');
	});

	it('reports skipped-note singular and plural only after a successful write', async () => {
		const one = makeMockApp();
		one.written.set('Mappings/edge.md', mappingNote());
		one.written.set('Mappings/plain.md', '# no frontmatter\n');
		const singular = await runFolderTypedTableExport({
			app: one.app,
			folder: folder('Mappings', 'Mappings'),
		});
		expect(singular.status).toBe('written');
		expect(singular.skippedCount).toBe(1);
		expect(singular.message).toContain('1 note skipped');

		const two = makeMockApp();
		two.written.set('Mappings/edge.md', mappingNote());
		two.written.set('Mappings/plain-a.md', '# no frontmatter\n');
		two.written.set('Mappings/plain-b.md', '---\ntitle: no curie\n---\n');
		const plural = await runFolderTypedTableExport({
			app: two.app,
			folder: folder('Mappings', 'Mappings'),
		});
		expect(plural.status).toBe('written');
		expect(plural.skippedCount).toBe(2);
		expect(plural.message).toContain('2 notes skipped');
	});

	it('preserves prior output when zero rows are exportable, including skipped notes', async () => {
		const { app, written } = makeMockApp();
		const destination = 'Mappings.export.typed-mappings.tsv';
		written.set('Mappings/plain.md', '# no frontmatter\n');
		written.set(destination, 'prior output bytes\n');
		const writeFile = jest.fn();
		const confirmReplace = jest.fn();

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			writeFile,
			confirmReplace,
		});

		expect(outcome).toMatchObject({ status: 'empty', rowCount: 0, skippedCount: 1 });
		expect(outcome.message).toContain('No typed mappings found under "Mappings". No export was written.');
		expect(outcome.message).toContain('1 note skipped');
		expect(written.get(destination)).toBe('prior output bytes\n');
		expect(writeFile).not.toHaveBeenCalled();
		expect(confirmReplace).not.toHaveBeenCalled();
	});

	it('replaces an existing file only after explicit confirmation', async () => {
		const destination = 'Mappings.export.typed-mappings.tsv';
		const { app, files, create, modify } = makeExistingTargetApp(destination, 'old bytes\n');
		const confirmReplace = jest.fn(async () => true);

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			confirmReplace,
			exportFolder: fixedExport('new bytes\n'),
		});

		expect(outcome.status).toBe('written');
		expect(confirmReplace).toHaveBeenCalledWith(destination);
		expect(files.get(destination)).toBe('new bytes\n');
		expect(modify).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
	});

	it('treats confirmation cancellation or dismissal as cancelled and preserves bytes', async () => {
		const destination = 'Mappings.export.typed-mappings.tsv';
		const { app, files, create, modify } = makeExistingTargetApp(destination, 'old bytes\n');
		const confirmReplace = jest.fn(async () => false);

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			confirmReplace,
			exportFolder: fixedExport('new bytes\n'),
		});

		expect(outcome.status).toBe('cancelled');
		expect(outcome.message).toBe(`Export cancelled. ${destination} was not replaced.`);
		expect(files.get(destination)).toBe('old bytes\n');
		expect(create).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
	});

	it('refuses a non-file destination with an actionable message', async () => {
		const destination = 'Mappings.export.typed-mappings.tsv';
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => path === destination ? { path, children: [] } : null,
			},
		} as unknown as App;
		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			exportFolder: fixedExport(),
		});

		expect(outcome.status).toBe('failed');
		expect(outcome.message).toContain('is not a file');
		expect(outcome.message).toMatch(/rename.*try again/i);
	});

	it('reports exporter/read failures without exposing raw errors or success', async () => {
		const raw = 'secret adapter failure';
		const outcome = await runFolderTypedTableExport({
			app: { vault: {} } as unknown as App,
			folder: folder('Mappings', 'Mappings'),
			exportFolder: jest.fn(async () => { throw new Error(raw); }),
		});

		expectFailedWithoutRawError(outcome, raw);
		expect(outcome.message).toContain('read typed mappings');
	});

	it('refuses a destination that appears after the runner check but before the real writer lookup', async () => {
		const destination = 'Mappings.export.typed-mappings.tsv';
		const sentinel = 'racing writer sentinel bytes\n';
		const files = new Map<string, string>();
		let destinationLookups = 0;
		const confirmReplace = jest.fn(async () => true);
		const modify = jest.fn(async (file: TFile, bytes: string) => {
			files.set(file.path, bytes);
		});
		const create = jest.fn(async (path: string, bytes: string) => {
			files.set(path, bytes);
			return new TFile(path);
		});
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => {
					if (path !== destination) return null;
					destinationLookups += 1;
					if (destinationLookups === 1) return null;
					if (!files.has(path)) files.set(path, sentinel);
					return new TFile(path);
				},
				create,
				modify,
				createFolder: jest.fn(),
			},
		} as unknown as App;

		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			exportFolder: fixedExport('new export bytes\n'),
			confirmReplace,
		});

		expect(outcome.status).toBe('failed');
		expect(outcome.message).toContain('Could not create');
		expect(destinationLookups).toBe(2);
		expect(confirmReplace).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(files.get(destination)).toBe(sentinel);
	});

	it('reports create failures without exposing raw errors or success', async () => {
		const raw = 'disk exploded while creating';
		const outcome = await runFolderTypedTableExport({
			app: { vault: { getAbstractFileByPath: () => null } } as unknown as App,
			folder: folder('Mappings', 'Mappings'),
			exportFolder: fixedExport(),
			writeFile: jest.fn(async () => { throw new Error(raw); }),
		});

		expectFailedWithoutRawError(outcome, raw);
		expect(outcome.message).toContain('Could not create');
	});

	it('reports confirmed replacement rejection without claiming the prior file is unchanged', async () => {
		const raw = 'modify partially wrote then rejected';
		const destination = 'Mappings.export.typed-mappings.tsv';
		const { app } = makeExistingTargetApp(destination, 'old bytes\n');
		const outcome = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			exportFolder: fixedExport(),
			confirmReplace: jest.fn(async () => true),
			writeFile: jest.fn(async () => { throw new Error(raw); }),
		});

		expectFailedWithoutRawError(outcome, raw);
		expect(outcome.message).toContain('Could not replace');
		expect(outcome.message).not.toMatch(/unchanged|nothing changed/i);
	});

	it('confirmed repeat export is deterministic at the same destination', async () => {
		const destination = 'Mappings.export.typed-mappings.tsv';
		const { app, files } = makeExistingTargetApp(destination, 'old bytes\n');
		const exportFolder = fixedExport('stable bytes\n');
		const confirmReplace = jest.fn(async () => true);

		const first = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			exportFolder,
			confirmReplace,
		});
		const second = await runFolderTypedTableExport({
			app,
			folder: folder('Mappings', 'Mappings'),
			exportFolder,
			confirmReplace,
		});

		expect(first.status).toBe('written');
		expect(second.status).toBe('written');
		expect(first.destinationPath).toBe(destination);
		expect(second.destinationPath).toBe(destination);
		expect(files.get(destination)).toBe('stable bytes\n');
		expect(exportFolder).toHaveBeenCalledTimes(2);
		expect(confirmReplace).toHaveBeenCalledTimes(2);
	});
});
