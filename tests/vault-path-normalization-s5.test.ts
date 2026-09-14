/**
 * vault-path-normalization-s5.test.ts -- S5 (2026-09-04, pass 16, Task C item
 * 5): normalizePath('') is '/' on the host, and both copies must agree, and
 * an empty evidence field is still refused.
 *
 * THE DEFECT THIS PINS. The host's `normalizePath` returns `'/'` (the vault
 * root) for an input that collapses to nothing, but the pure copy
 * (`src/render/vault-path.ts`) and the test mock (`tests/__mocks__/obsidian.ts`)
 * both returned `''`. A copy that answers a DIFFERENT string than the host is
 * exactly the failure `vault-path.ts` exists to prevent -- and this
 * divergence went the truthiness direction: `'/'` is truthy, `''` is not. The
 * live consequence was in `evidence-link-modal.ts`: `pairChanged` and
 * `create` both used to test `normalizePath(this.evidencePath.trim())` for
 * truthiness, so a BLANK evidence field normalized to `'/'`, which read as "a
 * path was given," `getAbstractFileByPath('/')` resolved to the vault root
 * (so the "no note found" warning never fired either), and an empty field
 * minted a junction whose object was a link to nothing.
 *
 * THE RULE. `normalizeVaultPath` and the mock now both return `'/'` for an
 * input that collapses to nothing, matching the host; the modal's guards test
 * the RAW input (before normalization) instead of relying on the normalized
 * form's truthiness.
 */

import { TFile, TFolder } from 'obsidian';
import { normalizeVaultPath, normalizedPathPieces } from '../src/render/vault-path';
import { normalizePath as mockNormalizePath } from '../tests/__mocks__/obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as { Notice: new (message: string, timeout?: number) => unknown };
const RealNotice = obsidianModule.Notice;
const notices: string[] = [];
beforeAll(() => {
	obsidianModule.Notice = class {
		constructor(message: string) { notices.push(message); }
	} as unknown as typeof RealNotice;
});
afterAll(() => { obsidianModule.Notice = RealNotice; });
beforeEach(() => { notices.length = 0; });
const said = (): string => notices.join('\n');

// ---------------------------------------------------------------------------
// Both copies answer '/' -- the host's own answer -- for an input that
// collapses to nothing, never ''.
// ---------------------------------------------------------------------------

describe('S5: normalizePath(\'\') is \'/\' on the host, and both copies agree', () => {
	it('the pure copy returns \'/\' for the empty string', () => {
		expect(normalizeVaultPath('')).toBe('/');
	});

	it('the mock returns \'/\' for the empty string, matching the host', () => {
		expect(mockNormalizePath('')).toBe('/');
	});

	it('both copies return \'/\' for a string that collapses to nothing (slashes only)', () => {
		expect(normalizeVaultPath('///')).toBe('/');
		expect(mockNormalizePath('///')).toBe('/');
	});

	it('both copies return \'/\' for a string that is whitespace-shaped separators', () => {
		expect(normalizeVaultPath('\\\\')).toBe('/');
		expect(mockNormalizePath('\\\\')).toBe('/');
	});

	it('normalizedPathPieces still yields no pieces for an empty segment -- one path serves both spellings', () => {
		expect(normalizedPathPieces('')).toEqual([]);
		expect(normalizedPathPieces('///')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The modal: a blank evidence field is refused, tested against the RAW input,
// never minting a junction that names nothing.
// ---------------------------------------------------------------------------

function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
		},
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
	};
	return { app: app as unknown as App, files };
}

const R4: ControlCandidate = { path: 'Frameworks/NIST-r4/AC-2.md', title: 'AC-2', curie: 'nist:AC-2', reviewCid: null };

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	resolveToken: number;
	inFlightPair: { controlPath: string; evidencePath: string } | null;
	pairChanged(): void;
	create(): Promise<void>;
}

describe('S5: create() refuses a blank evidence field rather than minting a junction to the vault root', () => {
	it('whitespace-only evidence text is refused, and nothing is written', async () => {
		const { app, files } = makeVault();
		const modal = new EvidenceLinkModal({ app, folder: 'Evidence/Junctions' }) as unknown as ModalInternals;
		modal.control = R4;
		// Trims to '' -- `normalizePath('')` is '/' on the host, which is truthy,
		// so a guard that tested the NORMALIZED value would have let this through.
		modal.evidencePath = '   ';
		const before = new Map(files);

		await modal.create();

		expect(said()).toContain('Enter the path to the evidence document.');
		expect(said()).not.toContain('No note found');
		expect([...files.keys()].sort()).toEqual([...before.keys()].sort());
	});

	it('truly empty evidence text is refused the same way', async () => {
		const { app, files } = makeVault();
		const modal = new EvidenceLinkModal({ app, folder: 'Evidence/Junctions' }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = '';
		const before = new Map(files);

		await modal.create();

		expect(said()).toContain('Enter the path to the evidence document.');
		expect([...files.keys()].sort()).toEqual([...before.keys()].sort());
	});
});

describe('S5: pairChanged() never starts a lookup for a blank evidence field', () => {
	it('a blank field leaves no lookup in flight and increments no token', () => {
		const { app } = makeVault();
		const modal = new EvidenceLinkModal({ app, folder: 'Evidence/Junctions' }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = '   ';

		modal.pairChanged();

		expect(modal.inFlightPair).toBeNull();
		expect(modal.resolveToken).toBe(0);
	});
});
