import { frameworkImportError } from '../src/import/stack/stack-errors';

describe('stack framework error display', () => {
	it('shows affected row, cause and action without leaking arbitrary source text', () => {
		const output = frameworkImportError('Synthetic framework', [
			'Row 12: Level "name" rendered empty for this row: private publisher value.',
			'Row 13: Path collision: private publisher path.',
			'Row 14: private publisher text.',
		]);
		expect(output).toContain('Row 12: the name field is empty. Check the source name column');
		expect(output).toContain('Row 13: two source rows resolve to one note');
		expect(output).toContain('1 more errors remain');
		expect(output).not.toContain('private');
		expect(output).not.toContain('—');
	});
	it('gives a cause and action even if generation reports no detailed errors', () => {
		expect(frameworkImportError('Synthetic framework', [])).toContain('Check its required columns and destination');
	});
});
