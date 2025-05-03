Collaborate and join the [Obsidian & Cyber Working Group](https://github.com/cybersader/awesome-obsidian-and-cyber) (more of a knowledge work and cyber working group)

📫 Contact me via my Cal.com link at [my website](https://cybersader.com/README#%F0%9F%94%97+Links)

# Crosswalker

> A Python toolkit to translate tabular cybersecurity framework data into Obsidian-ready taxonomic folder structures and interconnected markdown notes.

Essentially, a **Framework crosswalk engine** — crosswalks/maps and translates NIST, CIS, ISO, etc., into linked Markdown pages so you can evidence-map, explore, and automate straight from plaintext notes.  I'm already 1500 lines of Python code in on this one.  Way harder than expected.  So far, I've got MITRE ATT&CK + D3FEND + ENGAGE, NIST800-53, CSFv2, CISv8, and the CRI Profile started.

This tool can be extended to work with other knowledge platforms.

Below example of implementation and intent in [Obsidian](https://obsidian.md/).

![image](https://github.com/user-attachments/assets/55baa236-4f4c-4930-8338-24994b7ad8bf)

GRC involves a lot of knowledge work; keeping structured frameworks side-by-side with the knowledge we input, utilize, and share could change how we do that type of work.

## 🚀 Features
- Supports CRI, NIST CSF, NIST SP-800-53, MITRE ATT&CK, MITRE EngAGE, MITRE D3FEND, CIS Controls v8, and custom crosswalks.
- Configurable `FrameworkConfig` and `LinkConfig` for modular addition of new frameworks and link mappings.
- Generates hierarchical folders and `.md` files with YAML front-matter and optional body content.

## 💡 Philosophy & Approach
- First Principles: treat frameworks as taxonomic hierarchies, mapping them to file-system folders and YAML metadata.
- Config-Driven: minimal code changes are required to onboard new frameworks via `FrameworkConfig` and `LinkConfig`.
- Interoperable: leverages pandas and simple CSV/XLSX mapping tables, keeping data sources separate and extensible.
- Obsidian-Friendly: produces Markdown with YAML front-matter and relative wikilinks for graph-based exploration.

## 🏗️ Architecture & Workflow
1. Load framework spreadsheets (CSV/XLSX) from the `Frameworks/` directory into pandas DataFrames.
2. Clean & normalize columns (strip whitespace, unify casing, forward-fill hierarchies).
3. Build core framework tables and crosswalk/mapping tables with custom rename and cleaning logic.
4. Deduplicate each DataFrame so that each framework ID appears only once.
5. Export all raw and merged tables into a consolidated `frameworks_export.xlsx` workbook for inspection.
6. Define `FrameworkConfig` instances for each framework, specifying ID columns, hierarchy columns, folder and file naming conventions, and front-matter mappings.
7. (Optional) Define `LinkConfig` instances to inject inter-framework wikilinks based on mapping tables or matching rules.
8. Run the taxonomy builder to generate an Obsidian-compatible folder structure of `.md` files.
9. Drop the generated folders into your Obsidian vault and visualize the framework graph.

## 📦 Installation & Environment

1. Clone the repository:
   ```bash
   git clone https://github.com/cybersader/crosswalker
   cd frameworks_to_obsidian
   ```
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate   # macOS/Linux
   .\\venv\\Scripts\\activate  # Windows
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## 📁 Directory Structure
```text
.
├── cri_mapper.py              # Example: CRI-specific mapper
├── frameworks_to_obsidian.py  # Generic, multi-framework mapper
├── Frameworks/                # Place CSV/XLSX framework files here
├── requirements.txt           # Python dependencies
├── LICENSE                    # Project license (MIT)
├── README.md                  # Project overview and docs
└── CONTRIBUTING.md            # Contribution guidelines
```

## ⚖️ Data Licensing
> The raw CSV/XLSX framework data under `Frameworks/` is not included in this repo and remains under its original licenses.
> Before running the scripts, download each framework from the official sources:
- **NIST Cybersecurity Framework (CSF v2.0)**: https://www.nist.gov/cyberframework
- **NIST SP-800-53 Rev.5**: https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final
- **MITRE ATT&CK & EngAGE**: https://attack.mitre.org/, https://engage.mitre.org/
- **MITRE D3FEND**: https://d3fend.mitre.org/
- **CIS Controls v8**: https://www.cisecurity.org/controls/

## 📖 Usage

### Generic Frameworks
```bash
python frameworks_to_obsidian.py
```

### CRI Example

This was where it all started with trying to do all this "crosswalking" between frameworks.  CRI is a "community profile" of the CSFv2 framework.

```bash
python cri_mapper.py
```

## 🤝 Contributing
Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📝 License
This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
