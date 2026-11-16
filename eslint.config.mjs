import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Scope: the plugin source that ships (src/) plus the root package.json and
// manifest.json the Obsidian rules validate. Everything else is vault content,
// docs, tests or tooling. Typed linting over the whole tree type-checked src/
// once per folder tsconfig and ran out of memory on a shared machine.
export default defineConfig([
	globalIgnores([
		"**/node_modules/",
		".obsidian/",
		"main.js",
		"dist/",
		".workspace/",
		".obsidian-cache/",
		"docs/",
		"test-vault/",
		"Frameworks/",
		"recipes/",
		"templates/",
		"spec/",
		"tests/",
		"test/",
		"test-screenshots/",
		"coverage/",
		"cli/",
		"scripts/",
		"tools/",
		"*.mjs",
		"*.mts",
		"*.js",
	]),
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
