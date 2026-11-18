import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseSssomTsv } from '../../src/import/sssom-parser';
import { getRecipeTemplate, renderRecipeTemplate } from '../../src/views/recipe-templates';
import { demoGraphGroups, demoGraphJson } from './demo-graph';
import { mappingPairDiff } from './demo-public-sources';
import { checkPublicFolder, checkPublicSource, isRecipePath, loadStackFile, queryParams, StackFileError, type DerivedStep, type LicenseStep, type StackFile } from './stack-file';
import { derivedMappingTsv, mappingReaders } from './stack-mapping-readers';
import { manifest, sourceSummary, type FrameworkImport, type MappingImport } from './stack-report';

const REPO = path.resolve(__dirname, '../..');
const FIDELITY_GAP = 'Fidelity gap: the current notes-form SSSOM recipe does not project source_relation or comment. Publisher words are passed to the importer, not asserted as hierarchy.';

type Io = { out: (line: string) => void; err: (line: string) => void };
interface BuildOptions {
	file: string;
	vault: string;
	sourcesDir?: string;
	/** Keep the demo script's existing messages and --out flag name. */
	demo?: boolean;
}

/** Resolve symlink ancestors even when the final output folder does not exist. */
function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
	return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
}

function contains(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function prepareOut(out: string, marker: string | undefined, demo: boolean): void {
	const stat = fs.statSync(out, { throwIfNoEntry: false });
	if (!stat) {
		fs.mkdirSync(out, { recursive: true });
		return;
	}
	const option = demo ? '--out' : '--vault';
	if (!stat.isDirectory()) throw new StackFileError(`${out} is not a folder. Pick an empty or new folder for ${option}.`);
	if (fs.readdirSync(out).length === 0) return;
	// Only the demo script clears a previous build. A stack build never deletes:
	// --vault could name someone's real vault that happens to hold the marker note.
	if (!demo) throw new StackFileError(`${out} is not empty. A stack build never changes or clears an existing folder. Pick an empty or new folder for ${option}.`);
	if (!marker || !fs.lstatSync(path.join(out, marker), { throwIfNoEntry: false })?.isFile()) {
		throw new StackFileError(`${out} is not empty and is not a previous demo build. Pick an empty or new folder for ${option}.`);
	}
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
}

/** Resolve and check inputs before creating or clearing the output folder. */
function preflight(stack: StackFile, sourcesDir: string, out: string, demo: boolean) {
	const inputs = new Map<string, string>();
	const add = (source: string, optional = false) => {
		if (inputs.has(source)) return;
		const root = source.startsWith('Frameworks/') ? sourcesDir : REPO;
		const file = path.resolve(root, source);
		if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
			if (optional) return;
			const hint = source.startsWith('Frameworks/') || demo
				? `Use --sources-dir to select the checkout holding the ${stack.public ? 'public ' : ''}Frameworks/ files.`
				: 'Check the path from the repository root.';
			throw new StackFileError(`Missing fixture ${source}. ${hint}`);
		}
		const real = fs.realpathSync(file);
		if (contains(out, real)) throw new StackFileError(`The output contains the source ${source}. Choose a separate empty output folder.`);
		// Public smoke sources intentionally symlink committed fixtures from another checkout.
		// Check the real target's name too, without requiring it to live in sourcesDir.
		if (stack.public && real !== file) {
			const realRoot = [sourcesDir, REPO].find((candidate) => contains(candidate, real));
			const realName = realRoot ? path.relative(realRoot, real) : real;
			if (realRoot) checkPublicSource(realName);
			else if (realName !== source) {
				try { checkPublicSource(realName); } catch {
					throw new StackFileError(`The source ${source} links to a path that looks like licensed content. Choose a public source or use a private stack.`);
				}
			}
		}
		inputs.set(source, file);
	};
	for (const source of stack.requires) add(source);
	for (const step of stack.steps) {
		switch (step.kind) {
			case 'import':
				add(step.source);
				if (step.recipe && isRecipePath(step.recipe)) add(step.recipe);
				break;
			case 'derived-mappings':
				Object.values(step.inputs).forEach((file) => add(file));
				break;
			case 'license':
				add(step.file, step.style === 'terms' || Boolean(step.when));
				break;
			case 'query':
				if (getRecipeTemplate(step.template) === null) throw new StackFileError(`The shipped query template "${step.template}" is missing. Choose a shipped query template and update step "${step.id}".`);
				break;
		}
	}
	return inputs;
}

function cw(out: string, args: string[]) {
	const result = spawnSync('bun', ['--preload', './cli/preload.ts', 'cli/main.ts', ...args, '--vault', out], {
		cwd: REPO,
		encoding: 'utf8',
	});
	if (result.error) throw new StackFileError(`Could not run bun: ${result.error.message}. Check bun is installed and on PATH, then run the build again.`);
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function emit(text: string, log: (line: string) => void) {
	if (text) log(text.replace(/\n$/, ''));
}

const dump = (fields: Record<string, unknown>) => yaml.dump(fields, { quotingType: '"', lineWidth: -1 });

function licenseMarkdown(step: Extract<LicenseStep, { style: 'wrapped-md' }>, text: string) {
	return [
		`# ${step.name} license`,
		'',
		`The ${step.shortName} data in this folder is published by ${step.publisher} under the ${step.license}. The text below is the upstream LICENSE file, unchanged.`,
		'',
		'```text',
		text.replace(/\n$/, ''),
		'```',
		'',
	].join('\n');
}

/** Run an ordered build. Import steps still go through the public command line. */
export function buildStack(options: BuildOptions, io: Io): number {
	const { file, vault, sourcesDir = REPO, demo = false } = options;
	const noun = demo ? 'demo' : 'stack';
	const out = canonicalPath(vault);
	const sources = canonicalPath(sourcesDir);
	const roots = [canonicalPath(REPO), sources];
	if (roots.some((root) => contains(root, out))) {
		throw new StackFileError(`The ${noun} output must be outside the repository and the sources checkout. Choose a separate empty folder.`);
	}
	if (roots.some((root) => contains(out, root)) || contains(out, canonicalPath(file))) {
		throw new StackFileError(`The ${noun} output must not contain the inputs. Choose a separate empty folder.`);
	}
	const stack = loadStackFile(file);
	const inputs = preflight(stack, sources, out, demo);
	const sourcePath = (key: string) => {
		const file = inputs.get(key);
		if (!file) throw new StackFileError(`Missing fixture ${key}. Supply the file in the correct checkout, then run the build again.`);
		return file;
	};
	prepareOut(out, stack.guard?.emptyOrMarker, demo);
	io.out(`Building the ${noun} vault in ${out}`);

	const write = (relative: string, text: string) => {
		const target = path.join(out, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	};
	const sets = new Map<string, string | undefined>();
	const frameworks: FrameworkImport[] = [];
	const mappings: MappingImport[] = [];
	const graphKeys = () => frameworks.map((framework) => framework.graphKey);
	const importStep = (id: string, label: string, source: string, options: [string, string | number | undefined][]) => {
		const flags = options.flatMap(([flag, value]) => value === undefined ? [] : [`--${flag}=${value}`]);
		const result = cw(out, ['import', '--source', source, ...flags, '--deterministic']);
		if (result.code !== 0) {
			emit(result.stdout + result.stderr, io.err);
			const hint = demo ? 'The lines above say why.' : 'Fix the cause shown above, then run the build again.';
			throw new StackFileError(`${demo ? 'Demo' : 'Stack'} build stopped at "${label}" (exit ${result.code}). ${hint}`);
		}
		const setId = /Set id: (iset-[a-z0-9]+)\./.exec(result.stdout)?.[1];
		io.out(`  ${label}: ${result.stdout.trim().split('\n').pop()}`);
		sets.set(id, setId);
		return setId;
	};
	const writeLicense = (step: LicenseStep) => {
		if (step.when && !sets.has(step.when.slice('set:'.length))) return;
		const local = inputs.get(step.file);
		const md = `${step.folder}/LICENSE.md`;
		if (step.style === 'terms' && !local) {
			write(md, `${step.publisher}\n\n[Official terms](${step.url})\n`);
			io.out(`License link only: ${md}`);
			return;
		}
		const text = fs.readFileSync(local ?? sourcePath(step.file), 'utf8');
		write(`${step.folder}/LICENSE.txt`, text);
		write(md, step.style === 'wrapped-md' ? licenseMarkdown(step, text) :
			`# ${step.publisher}\n\n[Official terms](${step.url})\n\n\`\`\`text\n${text.replace(/\n$/, '')}\n\`\`\`\n`);
	};

	let temporary: string | undefined;
	let usedD3fendControls = false;
	let pendingFidelity = false;
	const flushFidelity = () => {
		if (pendingFidelity) io.out(FIDELITY_GAP);
		pendingFidelity = false;
	};
	const runDerived = (steps: DerivedStep[]) => {
		temporary ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cw-public-mappings-'));
		const staged: MappingImport[] = [];
		// Prepare each consecutive batch before importing it. This keeps the pair
		// diff and skip messages ahead of the batch, as in the original demo.
		for (const step of steps) {
			const rows = mappingReaders[step.reader](step, (input) => fs.readFileSync(sourcePath(step.inputs[input])));
			if (step.when) {
				const previousId = step.when.slice('adds-pairs-over:'.length);
				const previous = [...mappings, ...staged].find((mapping) => mapping.id === previousId);
				if (!previous) throw new StackFileError(`Step "${step.id}" cannot compare with "${previousId}" because it did not run. Use an earlier mapping that was imported.`);
				const existing = previous.derived?.rows ?? parseSssomTsv(fs.readFileSync(previous.source, 'utf8')).rows;
				const diff = mappingPairDiff(existing, rows.rows);
				io.out(`CSF concept crosswalk pair diff: ${JSON.stringify(diff)}`);
				if (!diff.added && !diff.strengthRows) {
					io.out('CSF concept crosswalk skipped: no additional endpoint pairs or strength values.');
					continue;
				}
			}
			const source = path.join(temporary, `${step.id}.sssom.tsv`);
			fs.writeFileSync(source, derivedMappingTsv(step, rows));
			staged.push({ id: step.id, label: step.label, source, destination: step.destination, derived: rows });
			usedD3fendControls ||= step.reader === 'd3fend-controls';
		}
		for (const mapping of staged) {
			mapping.setId = importStep(mapping.id, mapping.label, mapping.source, [['destination', mapping.destination]]);
			mappings.push(mapping);
		}
	};

	try {
		for (let i = 0; i < stack.steps.length; i++) {
			const step = stack.steps[i];
			// The original demo prints the report's final advisory just after licenses.
			if (step.kind !== 'license') flushFidelity();
			switch (step.kind) {
				case 'import': {
					const source = sourcePath(step.source);
					const recipe = step.recipe && isRecipePath(step.recipe) ? sourcePath(step.recipe) : step.recipe;
					const setId = importStep(step.id, step.role === 'mapping' ? `${step.label} links` : step.label, source,
						[['recipe', recipe], ['sheet', step.sheet], ['header-row', step.headerRow], ['destination', step.destination]]);
					const destination = step.destination && step.destination !== '.' ? step.destination : '';
					const record = { id: step.id, label: step.label, source, destination, setId };
					if (step.role === 'framework') frameworks.push({ ...record, graphKey: step.graphKey ?? step.id, describe: step.describe });
					if (step.role === 'mapping') mappings.push(record);
					break;
				}
				case 'derived-mappings': {
					const batch = [step];
					for (let next = stack.steps[i + 1]; next?.kind === 'derived-mappings'; next = stack.steps[i + 1]) {
						batch.push(next);
						i++;
					}
					runDerived(batch);
					break;
				}
				case 'note':
					write(step.path, `---\n${dump(step.frontmatter)}---\n\n${step.body}\n`);
					break;
				case 'set-fields':
					for (const file of step.files) {
						const target = `${step.folder}/${file}`;
						if (!fs.existsSync(path.join(out, target))) throw new StackFileError(`Could not set fields on "${target}": the note is missing. Check the path and that an earlier step creates the note.`);
						const text = fs.readFileSync(path.join(out, target), 'utf8');
						if (!/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.test(text)) {
							throw new StackFileError(`Could not set fields on "${target}": it has no frontmatter. Add frontmatter or correct the path, then run the build again.`);
						}
						write(target, text.replace(/^---\r?\n/, `---\n${dump(step.fields)}`));
					}
					break;
				case 'license':
					writeLicense(step);
					break;
				case 'query': {
					const params = queryParams(step.params, (id) => {
						const setId = sets.get(id);
						if (!setId) throw new StackFileError(`Query "${step.id}" needs a set id from "${id}", but that step did not produce one. Choose a step that imports a set.`);
						return setId;
					});
					write(step.path, `${renderRecipeTemplate(step.template, params)}\n`);
					break;
				}
				case 'start-here': {
					const summary = sourceSummary(out, frameworks, mappings);
					const bullets: Record<string, string[]> = {
						'{{frameworks}}': summary.frameworks.map(({ framework: f, counts }) => `- **${f.label}** in \`${f.destination || '(vault root)'}\`: ${f.describe ? `${f.describe}. ` : ''}${counts.notesCreated} notes; ${counts.parentResolved} resolved parent links.`),
						'{{mappings}}': summary.mappings.map(({ mapping: m, counts }) => `- **${m.label} links** in \`${m.destination || '(vault root)'}\`. ${counts.notesCreated} link notes; ${counts.subjectLinksResolved} resolved subject links and ${counts.objectLinksResolved} resolved object links.`),
						'{{graph-colors}}': demoGraphGroups(graphKeys()).map((group) => `- **${group.name}**: ${group.label}`),
					};
					write(step.path, step.lines.flatMap((line) => Object.prototype.hasOwnProperty.call(bullets, line) ? bullets[line] : [line]).join('\n'));
					break;
				}
				case 'graph':
					write(step.path, demoGraphJson(graphKeys()));
					break;
				case 'report': {
					const summary = sourceSummary(out, frameworks, mappings);
					for (const { framework, counts } of summary.frameworks) io.out(`Source report ${framework.id}: ${JSON.stringify(counts)}`);
					for (const { mapping, counts } of summary.mappings) io.out(`Source report ${mapping.id}: ${JSON.stringify(counts)}`);
					pendingFidelity = usedD3fendControls;
					break;
				}
			}
		}
		flushFidelity();
	} finally {
		if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
	}

	const { perFolder, bytes, notes } = manifest(out, stack.public ? checkPublicFolder : undefined);
	const check = cw(out, ['validate']);
	emit(check.stdout, io.out);
	if (check.code !== 0) {
		emit(check.stderr, io.err);
		io.err(demo ? 'The demo vault did not validate. The lines above name each failing note.' :
			'The stack vault did not validate. Fix the notes listed above and run the build again.');
		return 2;
	}
	io.out('\nManifest (notes per folder):');
	for (const [folder, count] of perFolder) io.out(`  ${String(count).padStart(5)}  ${folder}`);
	io.out(`  ${String(notes).padStart(5)}  notes in total, ${bytes} bytes on disk`);
	io.out(`Set ids: ${Array.from(sets, ([key, id]) => `${key}=${id ?? 'none'}`).join(', ')}`);
	return 0;
}
