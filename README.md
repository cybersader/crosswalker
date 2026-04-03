# Crosswalker

[![GitHub](https://img.shields.io/github/license/cybersader/Crosswalker)](https://github.com/cybersader/Crosswalker)
[![Docs](https://img.shields.io/badge/docs-live-blue)](https://cybersader.github.io/Crosswalker/)

Import structured ontologies (frameworks, taxonomies, any hierarchical data) into Obsidian with hierarchical folder structures, typed links, and metadata.

**Repository**: https://github.com/cybersader/Crosswalker
**Documentation**: https://cybersader.github.io/Crosswalker/

## Features

- **Import wizard** with 4-step workflow (select file, configure columns, preview, generate)
- **CSV parsing** with PapaParse streaming for large files (>5MB)
- **Column type detection** (hierarchy, ID, text, numeric, date, tags, URL)
- **Hierarchical folder structures** generated from your data columns
- **YAML frontmatter** with configurable property mapping
- **Config system** — save, load, and auto-match import configurations
- **WikiLinks** for crosswalks between framework nodes
- **Debug logging** to vault file for troubleshooting

## Installation

### From community plugins (coming soon)

1. Open Settings > Community plugins
2. Search for "Crosswalker"
3. Install and enable

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/cybersader/Crosswalker/releases)
2. Create folder: `your-vault/.obsidian/plugins/crosswalker/`
3. Copy the files into that folder
4. Enable the plugin in Settings > Community plugins

## Usage

### Basic import

1. Open command palette (`Ctrl/Cmd + P`) > "Crosswalker: Import structured data"
2. Select your CSV file
3. Map columns to hierarchy levels, frontmatter properties, links, or body content
4. Preview the folder tree and sample notes
5. Generate

### Example

Starting with a NIST 800-53 spreadsheet:

| Control Family | Control ID | Control Name | Related Controls |
|---------------|------------|--------------|------------------|
| Access Control | AC-1 | Policy and Procedures | AC-2, AC-3 |
| Access Control | AC-2 | Account Management | AC-1, AC-3, AC-5 |

Generates:

```
Ontologies/
└── NIST-800-53/
    └── Access Control/
        ├── AC-1.md
        └── AC-2.md
```

Where `AC-1.md` contains:

```yaml
---
control_id: AC-1
control_name: Policy and Procedures
control_family: Access Control
related_controls:
  - "[[AC-2]]"
  - "[[AC-3]]"
_crosswalker:
  source_file: nist-800-53.csv
  import_date: 2026-04-02
  config_id: abc123
---
```

## Configuration

See Settings > Crosswalker for:

- Default output path
- Key naming style (snake_case, camelCase, kebab-case, etc.)
- Array handling (keep as array, stringify, first value, etc.)
- Empty value handling (skip, null, placeholder)
- Frontmatter style (flat, nested)
- Link syntax presets (WikiLink, Markdown, custom)
- Config matching sensitivity
- Debug logging toggle

## Python tool

The repository also includes the original Python CLI tool (`frameworks_to_obsidian.py`) for importing cybersecurity frameworks. It supports NIST 800-53, CSF v2, CIS v8, MITRE ATT&CK/D3FEND/ENGAGE, and CRI Profile with crosswalk linking between frameworks.

```bash
pip install -r requirements.txt
python frameworks_to_obsidian.py
```

## Roadmap

See the full [roadmap](https://cybersader.github.io/Crosswalker/reference/roadmap/) on the docs site.

- [x] Import wizard MVP (CSV parsing, column config, preview, generation)
- [x] Config save/load/match system
- [x] Documentation site
- [ ] XLSX parser
- [ ] JSON parser
- [ ] Cross-framework linking
- [ ] Config export/import for sharing
- [ ] OSCAL export

## Development

```bash
# Install dependencies
bun install

# Development mode (watch, outputs to test-vault)
bun run dev

# Production build
bun run build

# Run tests
bun run test

# Run linter
bun run lint

# Run docs E2E tests
cd docs && bun run test:local
```

## Contributing

See the [contributing guide](https://cybersader.github.io/Crosswalker/development/contributing/) on the docs site.

## License

MIT — see [LICENSE](LICENSE) for details.
