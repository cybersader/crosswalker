/** CLI adapter for the plugin's graph configuration policy and plugin data boundary. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFsApp, vaultRelative } from './fs-app';
import { discoverInstalledFrameworks } from '../src/discovery/installed-frameworks';
import { graphColorGroups, type GraphConfigurationMode } from '../src/graph/graph-colors';
import { applyGraphConfiguration, planGraphConfiguration } from '../src/graph/graph-configuration';

/** Check the nearest existing ancestor too, so a missing file cannot escape via a symlink. */
export function graphConfigDirectory(rootDir: string, input = '.obsidian'): string {
	const relative = vaultRelative(input);
	if (!relative) throw new Error('The config directory must be a directory inside the vault. Pass --config-dir .obsidian or your vault-relative config folder.');
	const root = fs.realpathSync(rootDir);
	const directory = path.join(root, relative);
	if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) throw new Error('The config path is not a directory. Choose a vault-relative config folder.');
	for (const suffix of ['', '/graph.json', '/plugins/crosswalker/data.json']) {
		let current = path.join(root, relative + suffix);
		while (!fs.existsSync(current)) {
			// A dangling symlink must not masquerade as a genuinely missing setting.
			if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The config path contains a broken symbolic link. Repair it before configuring the graph.');
			const parent = path.dirname(current);
			if (parent === current) throw new Error('The config path could not be resolved. Choose a directory inside the vault.');
			current = parent;
		}
		const resolved = fs.realpathSync(current);
		const fromRoot = path.relative(root, resolved);
		if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
			throw new Error('The config path leaves the vault through a symbolic link. Choose a config directory inside the vault.');
		}
	}
	return relative;
}

export async function configureGraphFromCli(vault: string, configInput: string | undefined, mode: GraphConfigurationMode, apply: boolean) {
	if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new Error('The vault folder does not exist. Pass an existing vault with --vault; no folder was created.');
	const configDir = graphConfigDirectory(vault, configInput);
	const app = createFsApp(vault);
	const discovery = discoverInstalledFrameworks(app as never);
	if (discovery.state !== 'ready') throw new Error('The vault is still indexing. Try again after its notes are indexed.');
	if (discovery.frameworks.length === 0) throw new Error('No frameworks found. Import a framework first, then configure its graph.');
	const groups = graphColorGroups(discovery.frameworks.map((f) => ({ name: f.name, prefix: f.id })));
	const plan = await planGraphConfiguration(app.vault.adapter, configDir, groups, mode);
	if (!apply) return { ...plan.preview, status: 'preview', applied: false, next: 'Close Obsidian before using --apply so open graph views cannot overwrite saved defaults.' };
	graphConfigDirectory(vault, configDir);
	let status;
	try { status = await applyGraphConfiguration(app.vault.adapter, plan); }
	catch { throw new Error('The graph settings could not be saved. Check that the vault config folder is writable, then try again.'); }
	return {
		...plan.preview, status, applied: status === 'applied',
		next: status === 'partial'
			? 'Saved graph defaults changed, but color history was not saved. Check that Crosswalker settings are writable before trying again; existing colors will be kept conservatively.'
			: status === 'stale' ? 'Settings changed during configuration. Preview again before applying.'
				: 'Saved global graph defaults updated. Open Obsidian and reopen the global graph to see them. Local graphs were not changed.',
	};
}
