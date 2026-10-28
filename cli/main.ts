/** Process entry for `bun run cw`. Loaded with `--preload ./cli/preload.ts`. */
import { runCli } from './crosswalker';

runCli(process.argv.slice(2)).then((code) => process.exit(code));
