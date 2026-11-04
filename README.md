<p align="center">
  <img src="docs/public/logo.png" alt="Crosswalker" width="200" />
</p>

<h1 align="center">Crosswalker</h1>

<p align="center">
  <strong>Your frameworks, connected and usable in Obsidian.</strong>
</p>

<p align="center">
  <a href="https://github.com/cybersader/crosswalker/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cybersader/Crosswalker?style=flat-square" alt="License" /></a>
  <a href="https://cybersader.github.io/crosswalker/"><img src="https://img.shields.io/badge/docs-live-00d4aa?style=flat-square" alt="Docs" /></a>
  <a href="https://github.com/cybersader/crosswalker/releases"><img src="https://img.shields.io/github/v/release/cybersader/crosswalker?style=flat-square&include_prereleases&label=version" alt="Version" /></a>
  <a href="https://obsidian.md"><img src="https://img.shields.io/badge/Obsidian-plugin-7c3aed?style=flat-square" alt="Obsidian" /></a>
</p>

Import whole frameworks as plain Markdown notes. Open the Obsidian graph to explore their hierarchies as connected clusters, with crosswalk mappings linking controls across frameworks.

**The connections are not just for looks.** Browse which controls map to each other, link your evidence, and use Obsidian Bases views and coverage reports to see what is connected and where evidence is missing. Save the import setup, refresh it when the source changes, and use scripts or agents to manage repeatable work.

Built for compliance and GRC teams working with NIST, MITRE ATT&CK, CIS and other frameworks. Built-in recipes handle recognized publisher exports; guided import handles your own structured sources, including licensed ISO material you are entitled to use.

[Documentation](https://cybersader.github.io/crosswalker/) · [Quick start](#quick-start) · [Framework downloads](https://cybersader.github.io/crosswalker/reference/framework-data-sources/)

> **Prerelease.** This README describes the current `main` branch, including work newer than the downloadable release. See [Status](#status) before choosing a build. Try it in a test vault first.

## What you can do

| Goal | What Crosswalker provides |
|---|---|
| **Bring frameworks together** | Import CSV, Excel and JSON files individually, or use **Set up a framework stack** to bring in several frameworks and their available mappings in one guided run. |
| **Make the graph useful** | Linked recipes create parent/child navigation and shared hub notes. Color the graph by framework, then use **Explore framework connections** to inspect recorded mappings between selected frameworks. |
| **Choose your note layout** | Preview folders, notes, headings, tags, properties and links before writing. Use a built-in recipe or customize how your source becomes a vault. |
| **Find coverage and gaps** | Create saved Bases views and cross-framework pivot tables. Link evidence to controls and generate an evidence coverage report that includes controls without valid evidence. |
| **Keep large mapping sets manageable** | Store mappings as individual notes or one compact table. Review table rows individually or in bulk, and convert between the two storage choices. |
| **Refresh without starting over** | Explicitly choose the existing import to refresh. Update imported fields while keeping your own properties and text outside generated sections. |
| **Reuse and share the setup** | Save an import as a recipe, export it for a teammate, or choose **Run again** and supply the source file. Recipes do not include your source data. |
| **Take your work elsewhere** | Keep editable Markdown files, export framework data as CSV, and export crosswalk mappings as tables. CSV export uses the import recipe and reports columns it cannot reconstruct. |

**Graph or fewer files?** Choose mapping **Notes** for native graph connections, backlinks and Bases views. Choose **Table** for fewer files and a searchable review grid; its individual mappings do not appear in those native views. Crosswalker reads existing mappings, not proof that two controls are equivalent or that your organization is compliant.

## Quick start

### Install

Requires **Obsidian 1.10.0 or newer**. Enable the built-in **Bases** plugin for query views. Desktop is the current testing focus; mobile use is not yet verified.

1. Download `main.js`, `manifest.json` and `styles.css` from a [GitHub release](https://github.com/cybersader/crosswalker/releases).
2. Put them in your vault's `.obsidian/plugins/crosswalker/` folder.
3. Reload Obsidian and enable **Crosswalker** under **Settings > Community plugins**.

Crosswalker is not yet in the community plugin directory. See the [installation guide](https://cybersader.github.io/crosswalker/getting-started/installation/) for BRAT and manual installation, or [development setup](https://cybersader.github.io/crosswalker/development/setup/) to build current `main`.

### Start with a connected stack

1. Open the command palette and run **Crosswalker: Set up a framework stack**.
2. Pick the frameworks you need. Keep the **Standard** profile for every available framework level as notes and one note per mapping.
3. Follow the publisher download checklist, then add the files. The wizard shows which mappings connect your selections; you supply any required licensed files.
4. Review the destinations and file counts, then import. Frameworks are created before their mappings.
5. On current `main`, run **Crosswalker: Configure framework graph**, follow its preview and apply instructions, then open Graph view. Use **Crosswalker: Explore framework connections** to inspect the links, not just their appearance.

**Only importing one file?** Run **Crosswalker: Start here: import structured data**, pick your CSV, Excel or JSON file, and accept a recognized configuration or map the columns yourself. Preview the output before generating. Choose **Save as recipe** to reuse your setup.

[Full walkthrough](https://cybersader.github.io/crosswalker/getting-started/quick-start/) · [Publisher files and supported formats](https://cybersader.github.io/crosswalker/reference/framework-data-sources/)

## How it works

1. **Source files + a recipe.** Your framework export supplies the content; the recipe says how it becomes notes, properties and links.
2. **A connected vault.** Framework notes retain their source identity. Mapping notes connect controls across frameworks; evidence links connect your documents to controls.
3. **Views and repeatable updates.** Explore the graph, query with Bases, review coverage, or rerun an import against the same set of notes.

Your notes remain ordinary files you can read, edit, back up and version with Git. You decide when to refresh and which import to update; Crosswalker does not silently replace an existing framework with a newly selected source.

## CLI and agents

The `cw` command-line tool runs against a vault folder **without opening Obsidian**, using the plugin's import and export code. It supports imports, refreshes, replay with the kept recipe revision, validation, exports and inspection of framework connections.

From a clone of this repository, install dependencies with `bun install`. Example commands, with your own vault, source and exported recipe paths:

```sh
bun run cw -- recipes
bun run cw -- import --vault ./my-vault --source ./controls.csv --recipe ./recipe.json
bun run cw -- validate --vault ./my-vault
bun run cw -- help
```

Scripts and agents can work with explicit files and recipes; CI can check the generated notes using validation exit codes. No agent service is required. **Not every UI action has a CLI equivalent yet**: stack setup, saved-query creation and recipe-library management still use the plugin. See the [UI and CLI coverage table](https://cybersader.github.io/crosswalker/reference/ui-cli-parity/) for supported commands and tracked gaps.

## Status

**Status last verified: 2026-11-04**, against the code and [CHANGELOG](CHANGELOG.md). The latest published prerelease is **0.1.6**; current `main` also includes newer linked framework defaults, graph tools, recipe reuse and command-line workflows. A release download does not necessarily include everything described above.

Active development continues toward v0.1. Broader framework-version migration and a community sharing registry are **planned**, not current promises. See the [roadmap](https://cybersader.github.io/crosswalker/reference/roadmap/) for direction and [CHANGELOG](CHANGELOG.md) for delivered changes.

## Documentation and contributing

- [Documentation](https://cybersader.github.io/crosswalker/): walkthroughs, framework source guides and reference material.
- [Contributing](CONTRIBUTING.md) and [development guide](https://cybersader.github.io/crosswalker/development/contributing/): fixes, tests, documentation and recipes are welcome.
- [Built-in recipes](recipes/import/) and [community recipes repository](https://github.com/cybersader/crosswalker-recipes): inspect existing setups or propose another source.
- Related projects: [SEACOW](https://github.com/cybersader/seacowr-knowledge-platform-meta-framework) for vault organization and [folder-tag-sync](https://github.com/cybersader/obsidian-folder-tag-sync) for keeping folders and tags aligned.

## License

Crosswalker is [MIT licensed](LICENSE). Frameworks and mapping files retain their publishers' licenses; a supported import does not grant redistribution rights.
