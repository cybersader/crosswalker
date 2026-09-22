import { TFile } from 'obsidian';
import {
	discoverImportSets,
	ImportSetProvenanceError,
	knownSourcesOf,
} from '../src/generation/import-set';

interface NoteStamp {
	importSet: unknown;
	file?: string;
	sourceHash?: string;
	producedAt?: string;
}

function mockApp(notes: Record<string, NoteStamp>) {
	const files = Object.keys(notes).map((path) => new TFile(path));
	return {
		vault: {
			getMarkdownFiles: () => files,
			cachedRead: jest.fn(async () => ''),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const note = notes[file.path];
				return {
					frontmatter: {
						_crosswalker: {
							import_set: note.importSet,
							...(note.file !== undefined || note.sourceHash !== undefined
								? {
									source_ref: {
										...(note.file !== undefined ? { file: note.file } : {}),
										...(note.sourceHash !== undefined ? { source_hash: note.sourceHash } : {}),
									},
								}
								: {}),
							...(note.producedAt !== undefined ? { produced_at: note.producedAt } : {}),
						},
					},
				};
			},
		},
	} as any;
}

const endpoint = (id: string) => ({ id, scheme: 'endpoint-v1' });

describe('import-set source provenance', () => {
	it('collects distinct source pairs and retains the latest produced_at for each pair', async () => {
		const app = mockApp({
			'Frameworks/One/A.md': {
				importSet: endpoint('iset-aaa111'),
				file: 'one.csv',
				sourceHash: 'sha256-one',
				producedAt: '2026-09-20T10:00:00.000Z',
			},
			'Frameworks/One/B.md': {
				importSet: endpoint('iset-aaa111'),
				file: 'one.csv',
				sourceHash: 'sha256-one',
				producedAt: '2026-09-21T10:00:00.000Z',
			},
			'Frameworks/One/C.md': {
				importSet: endpoint('iset-aaa111'),
				file: 'one.csv',
				sourceHash: 'sha256-one',
				producedAt: '2026-09-19T10:00:00.000Z',
			},
			'Frameworks/Two/A.md': {
				importSet: endpoint('iset-bbb222'),
				file: 'alpha.csv',
				sourceHash: 'sha256-alpha',
				producedAt: '2026-09-18T08:00:00.000Z',
			},
			'Frameworks/Two/B.md': {
				importSet: endpoint('iset-bbb222'),
				file: 'beta.xlsx',
				sourceHash: 'sha256-beta',
				producedAt: '2026-09-19T08:00:00.000Z',
			},
			'Frameworks/Three/A.md': {
				importSet: endpoint('iset-ccc333'),
			},
		});

		const sets = await discoverImportSets(app);
		expect(sets.map((set) => ({ id: set.id, sources: set.sources }))).toEqual([
			{
				id: 'iset-aaa111',
				sources: [{
					file: 'one.csv',
					sourceHash: 'sha256-one',
					producedAt: '2026-09-21T10:00:00.000Z',
				}],
			},
			{
				id: 'iset-bbb222',
				sources: [
					{
						file: 'alpha.csv',
						sourceHash: 'sha256-alpha',
						producedAt: '2026-09-18T08:00:00.000Z',
					},
					{
						file: 'beta.xlsx',
						sourceHash: 'sha256-beta',
						producedAt: '2026-09-19T08:00:00.000Z',
					},
				],
			},
			{ id: 'iset-ccc333', sources: [] },
		]);

		expect(knownSourcesOf(sets)).toEqual([
			{
				setId: 'iset-aaa111',
				file: 'one.csv',
				sourceHash: 'sha256-one',
				producedAt: '2026-09-21T10:00:00.000Z',
			},
			{
				setId: 'iset-bbb222',
				file: 'alpha.csv',
				sourceHash: 'sha256-alpha',
				producedAt: '2026-09-18T08:00:00.000Z',
			},
			{
				setId: 'iset-bbb222',
				file: 'beta.xlsx',
				sourceHash: 'sha256-beta',
				producedAt: '2026-09-19T08:00:00.000Z',
			},
		]);
	});

	it('still rejects a corrupt import_set block', async () => {
		const app = mockApp({
			'Frameworks/Bad.md': { importSet: 'iset-bad999' },
		});

		await expect(discoverImportSets(app)).rejects.toBeInstanceOf(ImportSetProvenanceError);
	});
});
