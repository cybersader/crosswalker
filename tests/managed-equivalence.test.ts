/**
 * managedContentEquivalent (run again slice 2, R5 / acceptance case 10).
 * Synthetic notes only.
 */

import { managedContentEquivalent } from '../src/generation/managed-equivalence';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (source: string) => unknown };
const parseYaml = (text: string) => yaml.load(text);

function note(opts: {
	producedAt?: string;
	version?: string;
	title?: string;
	reviewer?: string;
	region?: string;
	userText?: string;
	specVersion?: string;
}): string {
	return [
		'---',
		`title: ${opts.title ?? 'Widget alpha'}`,
		...(opts.reviewer !== undefined ? [`reviewer: ${opts.reviewer}`] : []),
		'_crosswalker:',
		`  spec_version: ${opts.specVersion ?? 'https://crosswalker.dev/spec/tier1.schema.json'}`,
		`  produced_at: '${opts.producedAt ?? '2026-01-01T00:00:00.000Z'}'`,
		'  producer:',
		'    name: crosswalker',
		`    version: ${opts.version ?? '0.1.0'}`,
		'  curie: "zz:W-1"',
		'---',
		'',
		opts.userText ?? 'My own notes above.',
		'',
		'<!-- crosswalker:body:start -->',
		opts.region ?? 'Generated description.',
		'<!-- crosswalker:body:end -->',
		'',
	].join('\n');
}

describe('managedContentEquivalent', () => {
	it('treats a different produced_at and producer version as equal', () => {
		const result = managedContentEquivalent(
			note({}),
			note({ producedAt: '2026-05-05T12:00:00.000Z', version: '0.2.0' }),
			{ parseYaml },
		);
		expect(result).toEqual({ equal: true, differences: [] });
	});

	it('reports a changed managed property by name', () => {
		const result = managedContentEquivalent(note({}), note({ title: 'Widget beta' }), { parseYaml });
		expect(result.equal).toBe(false);
		expect(result.differences).toEqual(['frontmatter: title']);
	});

	it('still compares spec_version and nested managed keys', () => {
		const result = managedContentEquivalent(note({}), note({ specVersion: 'https://example.invalid/other' }), { parseYaml });
		expect(result.differences).toEqual(['frontmatter: _crosswalker.spec_version']);
	});

	it('ignores user_preserve keys the caller names', () => {
		const a = note({ reviewer: 'pat' });
		const b = note({ reviewer: 'sam' });
		expect(managedContentEquivalent(a, b, { parseYaml, userPreserve: ['reviewer'] }).equal).toBe(true);
		expect(managedContentEquivalent(a, b, { parseYaml }).differences).toEqual(['frontmatter: reviewer']);
	});

	it('ignores user body text outside managed regions', () => {
		expect(managedContentEquivalent(note({}), note({ userText: 'Rewritten by the user.' }), { parseYaml }).equal).toBe(true);
	});

	it('reports changed managed region text by region name', () => {
		const result = managedContentEquivalent(note({}), note({ region: 'A different description.' }), { parseYaml });
		expect(result).toEqual({ equal: false, differences: ['region: body'] });
	});

	it('fails closed when region markers cannot be read', () => {
		const broken = note({}).replace('<!-- crosswalker:body:end -->', '');
		const result = managedContentEquivalent(note({}), broken, { parseYaml });
		expect(result.equal).toBe(false);
		expect(result.differences).toContain('region: markers could not be read');
		expect(managedContentEquivalent(broken, broken, { parseYaml }).equal).toBe(true);
	});

	it('normalizes dates the YAML parser returns as Date objects', () => {
		const a = note({}).replace("title: Widget alpha", 'title: Widget alpha\nreviewed: 2026-02-03');
		const b = note({}).replace("title: Widget alpha", "title: Widget alpha\nreviewed: '2026-02-03T00:00:00.000Z'");
		expect(managedContentEquivalent(a, b, { parseYaml }).equal).toBe(true);
	});
});
