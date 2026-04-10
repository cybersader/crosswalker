# Crosswalker / Obsidian Frameworker - Complete Project Documentation

> **⚠️ Historical working document — not the canonical current-state reference.**
>
> This brief was written in the pre-docs-site era when Crosswalker was framed as a Python-first tool with an Obsidian plugin as "next evolution." The plugin is now the primary surface, and the Python CLI ([`frameworks_to_obsidian.py`](frameworks_to_obsidian.py)) is a secondary tool that ships alongside it. Sections below still reference Dataview as the query layer and treat the plugin as future work — that's all outdated.
>
> **For current project state, always check these first:**
>
> | What | Where |
> |---|---|
> | **Live docs site** (authoritative) | [cybersader.github.io/crosswalker](https://cybersader.github.io/crosswalker/) |
> | Roadmap | [`docs/src/content/docs/reference/roadmap/index.mdx`](docs/src/content/docs/reference/roadmap/index.mdx) |
> | Foundation research decisions | [`docs/src/content/docs/agent-context/zz-log/`](docs/src/content/docs/agent-context/zz-log/) — especially the 04-10 foundation research synthesis |
> | Open research challenges | [`docs/src/content/docs/agent-context/zz-challenges/`](docs/src/content/docs/agent-context/zz-challenges/) |
> | Terminology (crosswalk vs evidence link, STRM/SSSOM aliases) | [`docs/src/content/docs/concepts/terminology.mdx`](docs/src/content/docs/concepts/terminology.mdx) |
> | External orgs / specs / methodologies | [`docs/src/content/docs/reference/registry/`](docs/src/content/docs/reference/registry/) |
> | Architecture concepts | [`docs/src/content/docs/concepts/`](docs/src/content/docs/concepts/) |
> | Contributing guide (current) | [`CONTRIBUTING.md`](CONTRIBUTING.md) + [`docs/development/contributing/`](https://cybersader.github.io/crosswalker/development/contributing/) |
>
> **This file is preserved** because it contains useful historical framing (original problem statement, initial ecosystem survey, early vision principles) that's still load-bearing for understanding *why* the project exists. When content here conflicts with the docs site, **the docs site wins**.
>
> Notable outdated sections in this file:
> - **"Next Evolution"** (line ~23) — the plugin IS the current form, not the future form
> - **"DataviewJS"** references — the project has since committed to Obsidian Bases as the query layer (Dataview is deprecated; see the [Obsidian Bases direction research item](https://cybersader.github.io/crosswalker/reference/roadmap/))
> - **"Link Metadata System"** section — partially stale; see the updated [link-metadata-system design doc](https://cybersader.github.io/crosswalker/agent-context/link-metadata-system/) and [Challenge 07](https://cybersader.github.io/crosswalker/agent-context/zz-challenges/07-link-metadata-edge-model/) for the current thinking on evidence-link edge models
> - **"Development Roadmap"** — entirely superseded by the live roadmap page

## Table of Contents
1. [Project Overview](#project-overview)
2. [Current State](#current-state)
3. [Vision & Goals](#vision--goals)
4. [Core Concepts](#core-concepts)
5. [Technical Architecture](#technical-architecture)
6. [Supported Frameworks](#supported-frameworks)
7. [Link Metadata System](#link-metadata-system)
8. [Implementation Approaches](#implementation-approaches)
9. [Development Roadmap](#development-roadmap)
10. [Resources & References](#resources--references)

---

## Project Overview

**Project Name**: Crosswalker / Obsidian Frameworker

**Current Tool**: [Crosswalker](https://github.com/cybersader/Crosswalker) - A Python toolkit to translate tabular cybersecurity framework data into Obsidian-ready taxonomic folder structures and interconnected markdown notes.

**Next Evolution**: Transform into a comprehensive Obsidian plugin that enables:
1. Importing framework data into Obsidian vaults
2. Creating bidirectional links with metadata between evidence notes and framework nodes
3. Querying and aggregating framework mappings
4. Managing GRC (Governance, Risk, and Compliance) workflows

**Problem Statement**: Organizations need to map unstructured evidence and workspace data to structured compliance frameworks (NIST, ISO, CIS, etc.). Current solutions either lock data into proprietary databases or require manual, error-prone processes.

**Solution**: A flexible, plaintext-based system that treats cybersecurity frameworks as taxonomic hierarchies mapped to filesystem folders and YAML metadata, enabling graph-based exploration with Obsidian.

---

## Current State

### Crosswalker Python Tool

**Repository**: https://github.com/cybersader/Crosswalker

**Current Capabilities**:
- Transforms tabular framework data (CSV/XLSX) into Obsidian markdown structures
- Creates hierarchical folder structures matching framework taxonomies
- Generates markdown files with YAML frontmatter
- Supports framework crosswalking (mapping between frameworks)
- Produces consolidated export workbooks for validation

**Workflow**:
1. Load spreadsheets (frameworks data)
2. Normalize and clean data
3. Build framework tables
4. Deduplicate entries
5. Generate hierarchical markdown files with YAML frontmatter

**Technical Stack**:
- Python 100%
- Pandas for data processing
- Config-driven via `FrameworkConfig` and `LinkConfig` classes
- MIT Licensed

---

## Vision & Goals

### The Ultimate Goal

Build a comprehensive Obsidian plugin ecosystem that allows organizations to:

1. **Import Frameworks**: Automatically import standard frameworks (NIST, CIS, ISO, etc.) into structured vault hierarchies
2. **Map Evidence**: Link evidence notes to framework controls with rich metadata
3. **Query Relationships**: Use DataviewJS to aggregate and visualize framework mappings
4. **Manage Compliance**: Track compliance status, reviewers, evidence sufficiency, etc.
5. **Export Reports**: Generate compliance reports and crosswalk documents
6. **Collaborate**: Enable teams to work on compliance in plaintext, version-controlled format

### The Philosophy

**From the creator's vision**:

> "We're building bridges between different system components used to structure knowledge platforms and information. In Obsidian, we have tags, folders, and links. These are all interrelated but we need to align these systems to the realities of knowledge work and knowledge communication."

**Key Principles**:
- **Single Source of Truth**: All relationships recorded in the workspace, always up-to-date
- **Flexible Storage**: Metadata inline or in frontmatter, JSON or simple strings
- **Extensible**: Minimal refactoring for new frameworks
- **Unified Queries**: Combine structured + unstructured data
- **Plain Text**: No lock-in, version-controllable, future-proof

---

## Core Concepts

### 1. Framework as Taxonomy

**Definition**: A framework is a structured hierarchy of folders/files representing standards, policies, or systematic knowledge arrangements.

**Components**:
- **Folder-level nodes**: High-level groupings (e.g., "Security Controls", "Policy Documents")
- **Leaf nodes**: Specific items (e.g., "AC-2: Account Management", "Control 3.1.2")

**Representation**:
```
vault/
└── Frameworks/
    └── NIST-SP-800-53/
        ├── Access Control (AC)/
        │   ├── AC-1 Policy and Procedures.md
        │   ├── AC-2 Account Management.md
        │   └── ...
        └── ...
```

### 2. Edge (Link) Metadata

**Problem**: Traditional markdown links only store the destination. We need to attach metadata to relationships.

**Solution**: Use inline Dataview tags with dot notation and JSON to encode relationship metadata.

**Edge metadata** includes:
- **dotKey**: Specific relationship type (e.g., `framework_here.reviewer`)
- **Values**: Booleans, strings, numbers, JSON objects
- **Link types**: WikiLinks, Markdown links, plain text

**Example**:
```markdown
framework_here.applies_to:: [[NIST AC-2]] {"sufficient": true, "reviewer": "Alice", "control": true}
```

### 3. Priority Structure (Metadata Hierarchy)

When edge metadata appears in multiple places, a priority structure determines which data "wins":

1. **Inline tag (dot notation) + link + explicit value/JSON**
2. **Inline tag (dot notation) + link + implied boolean**
3. **Inline tag (child/leaf dot notation) + link + JSON**
4. **Inline tag (parent/root dot notation) + link + JSON**
5. **Inline tag without link + value**
6. **YAML frontmatter**
7. **Folder-level or inherited metadata**

### 4. Levels of Querying

Query relationships at different hierarchical levels:

1. **Leaf-Level**: Direct references to a specific framework node
2. **Folder-Level**: Aggregate all links for an entire folder/subtree
3. **Global**: Vault-wide search for framework references

### 5. Link Syntax System

**Dot Notation Use Cases**:

1. **Default for JSON-based links**
   ```markdown
   framework_here.reviewer:: "Person_1"
   ```

2. **Boolean flag**
   ```markdown
   framework_here.applies_to:: [[ID 12]]
   ```

3. **JSON object for specific key**
   ```markdown
   framework_here.applies_to:: [[ID 13]] {"sufficient": true, "control": true}
   ```

**Wrapping Styles**:
- **No wrapping**: `framework_here.applies_to:: [[ID 12]]`
- **Square brackets**: `[framework_here.applies_to:: [[ID 12]]]`
- **Parentheses**: `(framework_here.applies_to:: [[ID 12]])`

**Link Types**:
- **WikiLink**: `[[Page Name]]`
- **Markdown link**: `[Link Text](path/to/file.md)`
- **Plain text**: `"String value"` or `123`

---

## Technical Architecture

### System Design

```
┌─────────────────────────────────────────────────────────┐
│  Evidence Notes (Workspace)                             │
│  - Meeting notes                                        │
│  - Policy documents                                     │
│  - Audit findings                                       │
│  - Technical documentation                              │
└──────────────┬──────────────────────────────────────────┘
               │ Link with metadata
               │ framework_here.applies_to:: [[Control]]
               ▼
┌─────────────────────────────────────────────────────────┐
│  Framework Structure (Taxonomy)                         │
│  - NIST 800-53                                          │
│  - CIS Controls                                         │
│  - NIST CSF                                             │
│  - Custom frameworks                                    │
└──────────────┬──────────────────────────────────────────┘
               │ DataviewJS Queries
               ▼
┌─────────────────────────────────────────────────────────┐
│  Aggregated Views                                       │
│  - Compliance dashboards                                │
│  - Evidence tables                                      │
│  - Crosswalk matrices                                   │
│  - Gap analysis                                         │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

**1. Authoring Phase**:
- Write evidence notes with inline links to framework nodes
- Embed metadata using dot notation + JSON syntax
- Define relationships in frontmatter (optional)

**2. Parsing Phase**:
- Custom regex processes each note
- Captures dotKey, link destination, metadata (JSON/values)
- Handles different wrapping styles

**3. Priority Merging Phase**:
- Multiple definitions of same relationship → apply priority rules
- Merge metadata from inline tags, frontmatter, defaults

**4. Querying Phase**:
- DataviewJS scripts gather inbound references
- Filter by framework folder or specific leaf node
- Build aggregated relationship objects

**5. Aggregation & Display**:
- Combine inbound edges from multiple notes
- Apply priority structure to resolve conflicts
- Display as tables, nested JSON, or custom views

---

## Supported Frameworks

### Currently Implemented (Python tool)

1. **MITRE ATT&CK**
   - Techniques, tactics, procedures
   - Mappings to defenses

2. **MITRE D3FEND**
   - Defensive techniques
   - Mappings to NIST 800-53

3. **MITRE ENGAGE**
   - Cyber denial and deception
   - Mappings to ATT&CK

4. **NIST Cybersecurity Framework v2.0**
   - Functions, categories, subcategories
   - Informative references

5. **NIST SP 800-53 Rev. 5**
   - Security and privacy controls
   - Assessment procedures

6. **CIS Controls v8**
   - Implementation groups
   - Safeguards

7. **CRI (Cyber Risk Institute) Profile**
   - Financial sector community profile
   - Crosswalks to multiple frameworks

### Framework Crosswalks

**Supported crosswalk mappings**:
- CRI → NIST CSF v2
- CRI → FFIEC CAT (Cybersecurity Assessment Tool)
- CRI → FFIEC AIO (Architecture, Infrastructure, Operations)
- CRI → FFIEC BCM (Business Continuity Management)
- CRI → CISA CPG (Cross-Sector Cybersecurity Performance Goals)
- NIST 800-53 → MITRE ATT&CK
- D3FEND → NIST 800-53
- And more...

### Data Sources

Frameworks data must be obtained from official sources:
- **NIST**: https://csrc.nist.gov/
- **MITRE**: https://attack.mitre.org/, https://d3fend.mitre.org/, https://engage.mitre.org/
- **CIS**: https://www.cisecurity.org/controls
- **CRI**: https://cyberriskinstitute.org/

---

## Link Metadata System

### Regex for Parsing

Custom regex captures inline link syntax + metadata:

```regex
^(?:\[|\()?(?<dotKey>framework_here(?:\.\w+)*)::\s*(?:\[\[(?<wikilink>[^|\]]+)\]\]|\[(?<mdText>[^\]]+?)\]\((?<mdLink>[^)]+?)\)|(?<plainLink>[^"\[\]\(\)\s{}]+))?\s*(?:(?<json>\{[^}]*\})|"(?<quotedValue>[^"]+)")?(?=\]|\)|$)
```

**Captured Groups**:
- `dotKey`: `framework_here.applies_to`
- `wikilink`: `[[Page Name]]`
- `mdText` + `mdLink`: `[Text](path.md)`
- `plainLink`: Plain text value
- `json`: JSON object
- `quotedValue`: Quoted string

### Metadata Priority Examples

**Example 1: Most Specific Wins**

```markdown
# Evidence Note

framework_here.reviewer:: "Bob"
framework_here.applies_to:: [[AC-2]] {"reviewer": "Alice", "sufficient": true}
```

For the link to AC-2:
- `reviewer` = "Alice" (inline + link + JSON beats default)
- `sufficient` = true (from inline JSON)

**Example 2: Default Values**

```markdown
framework_here.status:: "under_review"
framework_here.applies_to:: [[AC-2]]
framework_here.applies_to:: [[AC-3]] {"status": "approved"}
```

For [[AC-2]]:
- `status` = "under_review" (inherited from default)

For [[AC-3]]:
- `status` = "approved" (explicit override)

### Link Syntax Examples Table

| Syntax | Meaning | Link Type | Wrapper | Metadata |
|--------|---------|-----------|---------|----------|
| `framework_here.reviewer:: "Person_1"` | Set default reviewer | Plain (no link) | None | Quoted string |
| `[framework_here.applies_to:: [[ID 12]]]` | Applies to ID 12 | WikiLink | Square brackets | Boolean (implied true) |
| `(framework_here.applies_to:: [[ID 13]] {"sufficient": true})` | Applies to ID 13 with metadata | WikiLink + JSON | Parentheses | JSON object |
| `framework_here.reviewed:: [[ID 12]]` | Reviewed relationship | WikiLink | None | Boolean (implied true) |
| `[framework_here.score:: 9]` | Default score | Default for all links | Square brackets | Number |

---

## Implementation Approaches

### Approach 1: Enhance Python Tool + Dataview Queries

**Scope**: Keep Crosswalker as Python CLI, add Dataview templates

**Components**:
1. **Python Tool** (existing):
   - Import frameworks into vault
   - Generate folder structure + markdown files
   - Add Dataview query templates to each framework node

2. **Manual Workflow**:
   - Users add inline links in evidence notes
   - DataviewJS queries in framework notes display aggregated links

**Pros**:
- Minimal development (mostly already done)
- No plugin maintenance
- Works with existing Dataview plugin

**Cons**:
- Manual setup required
- No GUI for adding metadata
- Users must learn custom syntax

### Approach 2: Full Obsidian Plugin

**Scope**: Build comprehensive Obsidian plugin

**Core Features**:

1. **Framework Import**
   - UI to select/download frameworks
   - Automatic vault structure generation
   - Configurable folder locations

2. **Link Metadata Editor**
   - GUI modal for adding framework links
   - Autocomplete for framework nodes
   - Form fields for metadata (reviewer, status, etc.)
   - Inserts properly formatted inline syntax

3. **Relationship Browser**
   - Side panel showing framework hierarchy
   - Click to insert links
   - Visual indication of existing mappings

4. **Query Builder**
   - No-code interface for common queries
   - Pre-built templates (compliance dashboard, gap analysis, etc.)
   - Export to tables/CSV

5. **Validation & Linting**
   - Check link syntax
   - Validate metadata schemas
   - Highlight broken framework references

6. **Report Generator**
   - Compliance status reports
   - Evidence matrices
   - Crosswalk documents

**Pros**:
- User-friendly GUI
- Integrated workflow
- Validation and error checking
- Professional solution

**Cons**:
- Significant development effort
- Maintenance burden
- Learning curve for developers

### Approach 3: Hybrid (Recommended for MVP)

**Scope**: Python tool + lightweight plugin + Dataview templates

**Phase 1** (Python + Templates):
1. Enhance Python tool with better templates
2. Add pre-built DataviewJS queries to framework notes
3. Create vault-starter template with example workflows
4. Document custom link syntax thoroughly

**Phase 2** (Light Plugin):
1. **Link Inserter Command**
   - Command palette: "Insert Framework Link"
   - Search framework nodes
   - Modal with metadata fields
   - Insert formatted syntax at cursor

2. **Syntax Helper**
   - Autocomplete for `framework_here.*` keys
   - Preview how link will render
   - Validate JSON syntax

**Phase 3** (Enhanced Plugin):
1. Settings UI for framework locations
2. Framework browser sidebar
3. Query templates
4. Basic reporting

**Pros**:
- Incremental development
- Validate assumptions early
- Users can start with Phase 1 immediately

**Cons**:
- Requires both Python and TypeScript skills
- Multiple codebases to maintain

---

## Development Roadmap

### Phase 1: Foundation (Python Tool Enhancement)

**Goal**: Production-ready Python tool with excellent docs

**Tasks**:
1. ✅ Core framework import (already done)
2. ⬜ Add comprehensive README with architecture diagrams
3. ⬜ Create example vault demonstrating workflows
4. ⬜ Template DataviewJS queries for each framework type
5. ⬜ Document link syntax with examples
6. ⬜ Add CLI flags (--framework, --output, --dry-run)
7. ⬜ Package for PyPI distribution

**Deliverables**:
- `crosswalker` PyPI package
- Example vault ZIP download
- Comprehensive documentation site
- Video tutorials

### Phase 2: Obsidian Plugin MVP

**Goal**: Basic framework link insertion plugin

**Tasks**:
1. ⬜ Initialize Obsidian plugin project
2. ⬜ Implement framework detection (scan vault for framework folders)
3. ⬜ Build "Insert Framework Link" command
   - Search modal for framework nodes
   - Metadata input fields
   - Syntax generation
4. ⬜ Add autocomplete for `framework_here.*` keys
5. ⬜ Syntax validation and highlighting
6. ⬜ Settings page for framework configuration

**Deliverables**:
- Published Obsidian community plugin
- Plugin documentation
- Integration with Python tool

### Phase 3: Advanced Features

**Goal**: Comprehensive framework management system

**Tasks**:
1. ⬜ Framework browser sidebar
2. ⬜ Relationship visualization (graph view enhancement)
3. ⬜ Query builder UI
4. ⬜ Report generator
5. ⬜ Framework update/sync mechanism
6. ⬜ Multi-framework support in single vault
7. ⬜ Collaboration features (comments, assignments)

**Deliverables**:
- Professional-grade GRC tool in Obsidian
- Enterprise documentation
- Training materials

### Phase 4: Ecosystem

**Goal**: Build community and integrations

**Tasks**:
1. ⬜ Integration with other compliance tools
2. ⬜ OSCAL (Open Security Controls Assessment Language) support
3. ⬜ Two-way sync with external systems
4. ⬜ Template marketplace for different industries
5. ⬜ API for external tools

---

## Supported Frameworks Detail

### CRI (Cyber Risk Institute) Profile

**Data Source**: `Final-CRI-Profile-v2.0-Public-CRI.xlsx`

**Structure**:
- **Functions**: GOVERN, IDENTIFY, PROTECT, DETECT, RESPOND, RECOVER
- **Categories**: Organizational Context, Risk Management Strategy, etc.
- **Subcategories**: Specific diagnostic statements
- **Tiers**: 1-4 maturity levels

**Key Sheets**:
1. CRI Profile v2.0 Structure
2. Diagnostic Statements by Tag
3. NIST CSF v2 Mapping
4. FFIEC CAT Mapping
5. FFIEC AIO Mapping
6. FFIEC BCM Mapping
7. CISA CPG Mapping
8. NIST Ransomware Profile Mapping

**Example Hierarchy**:
```
GV (GOVERN)
└── GV.OC (Organizational Context)
    ├── GV.OC-01 (Organizational Mission)
    │   └── GV.OC-01.01 (Diagnostic Statement)
    └── GV.OC-02 (Stakeholder Expectations)
```

### NIST SP 800-53 Rev. 5

**Data Source**: `sp800-53r5-control-catalog.xlsx`

**Structure**:
- **Families**: AC (Access Control), AU (Audit), etc.
- **Controls**: Base controls (AC-1, AC-2, etc.)
- **Enhancements**: Control enhancements (AC-2(1), AC-2(2), etc.)

**Fields**:
- Control Identifier
- Control Name
- Control Text (requirements)
- Discussion
- Related Controls

**Assessment Procedures** (separate sheet):
- EXAMINE: What to review
- INTERVIEW: Who to interview
- TEST: What to test

### MITRE ATT&CK

**Data Source**: ATT&CK Navigator / STIX data

**Structure**:
- **Tactics**: Initial Access, Execution, Persistence, etc.
- **Techniques**: Specific attack methods
- **Sub-techniques**: Detailed variations
- **Procedures**: Real-world examples

**Relationships**:
- Technique → Tactic (many-to-many)
- Technique → Mitigation
- Technique → Data Source
- Software → Technique

### MITRE D3FEND

**Data Source**: `nist.5.csv`

**Structure**:
- **Defensive Techniques**: Organized taxonomically
- **Digital Artifacts**: Things that can be defended
- **Relationships**: Technique → Artifact

**Mappings**:
- D3FEND → NIST 800-53
- ATT&CK Mitigations → D3FEND Techniques

### CIS Controls v8

**Data Source**: CIS Controls download

**Structure**:
- **Implementation Groups**: IG1, IG2, IG3
- **Controls**: 18 top-level controls
- **Safeguards**: Specific actions (numbered x.y)

**Mappings**:
- CIS → NIST CSF
- CIS → NIST 800-53

---

## Use Cases & Workflows

### Use Case 1: Compliance Mapping

**Scenario**: Map security policies to NIST 800-53 controls

**Workflow**:
1. Import NIST 800-53 framework using Python tool
2. Create policy documents in vault
3. Add links to relevant controls:
   ```markdown
   # Access Control Policy

   framework_here.implements:: [[AC-1]] {"coverage": "full", "reviewer": "CISO"}
   framework_here.implements:: [[AC-2]] {"coverage": "partial", "notes": "Missing automated account management"}
   ```
4. Review framework control pages to see all implementing policies
5. Generate gap analysis report

### Use Case 2: Audit Evidence Collection

**Scenario**: Collect evidence for an audit against CIS Controls

**Workflow**:
1. Import CIS Controls framework
2. During audit prep, create evidence notes
3. Link evidence to controls:
   ```markdown
   # Firewall Configuration Review 2025-01

   framework_here.evidence_for:: [[CIS 4.4]] {"sufficient": true, "date": "2025-01-15", "auditor": "Jane"}
   framework_here.evidence_for:: [[CIS 4.5]] {"sufficient": false, "gap": "Missing egress filtering"}
   ```
4. Query controls to see evidence status
5. Identify gaps before audit
6. Generate evidence matrix for auditors

### Use Case 3: Framework Crosswalk Analysis

**Scenario**: Understand overlap between NIST CSF and CIS Controls

**Workflow**:
1. Import both frameworks with crosswalk data
2. Use pre-built queries to show mappings
3. Identify controls that satisfy multiple frameworks
4. Optimize compliance efforts by addressing overlapping requirements

### Use Case 4: GRC Team Collaboration

**Scenario**: Distributed team working on compliance program

**Workflow**:
1. Store vault in Git repository
2. Team members work on different areas
3. Use metadata to assign reviewers and track status:
   ```markdown
   framework_here.owner:: "Security Team"
   framework_here.status:: "in_review"
   framework_here.due_date:: "2025-03-01"
   ```
4. Pull requests for review
5. Automated checks via CI/CD
6. Generate reports from main branch

---

## Technical Challenges & Solutions

### Challenge 1: Performance with Large Vaults

**Problem**: DataviewJS queries slow with 10k+ framework notes

**Solutions**:
- Index framework references (plugin can build cache)
- Lazy loading (only query visible folders)
- Pre-compute aggregations during idle time
- Store query results in cached files

### Challenge 2: Schema Validation

**Problem**: Users make typos in metadata keys

**Solutions**:
- Plugin provides autocomplete
- Linting to check against schema
- Visual indicators for invalid links
- Schema definition files per framework

### Challenge 3: Framework Updates

**Problem**: Frameworks change (new controls, deprecated items)

**Solutions**:
- Version framework imports (NIST-800-53-r5 folder)
- Migration scripts for links
- Deprecation warnings in queries
- Maintain multiple versions simultaneously

### Challenge 4: Link Syntax Complexity

**Problem**: Custom syntax is hard to learn

**Solutions**:
- GUI for most common operations (no syntax needed)
- Syntax snippets and templates
- Live preview of parsed metadata
- Comprehensive documentation with examples
- Community templates library

---

## Success Metrics

### Adoption Metrics
- ✅ Python tool: 50+ GitHub stars
- ⬜ Plugin: 100+ installations in first month
- ⬜ Community: Active forum/Discord
- ⬜ Templates: 10+ community-contributed framework templates

### Quality Metrics
- ✅ Framework imports work for all supported frameworks
- ⬜ Zero data loss in parsing/import
- ⬜ Query performance <1s for 1000 notes
- ⬜ 95%+ user satisfaction

### Business Metrics
- ⬜ Adoption by 5+ organizations
- ⬜ Published case studies
- ⬜ Integration with enterprise GRC tools
- ⬜ Contribution to compliance time reduction

---

## Resources & References

### Existing Codebases

**Python Tool**:
- https://github.com/cybersader/Crosswalker

**Related Work**:
- https://github.com/rabobank-cdc/DeTTECT (MITRE ATT&CK framework)

### Data Sources

**Framework Data**:
- NIST CSRC: https://csrc.nist.gov/
- MITRE ATT&CK: https://attack.mitre.org/
- MITRE D3FEND: https://d3fend.mitre.org/
- MITRE ENGAGE: https://engage.mitre.org/
- CIS Controls: https://www.cisecurity.org/controls
- CRI Profile: https://cyberriskinstitute.org/

### Obsidian Development

**Plugin Development**:
- Obsidian API: https://docs.obsidian.md/
- Plugin Dev Guide: https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin
- Sample Plugins: https://github.com/obsidianmd/obsidian-sample-plugin

**Community Resources**:
- Obsidian Forum: https://forum.obsidian.md/
- Plugin Ideas: https://forum.obsidian.md/c/plugin-ideas/
- Dataview Docs: https://blacksmithgu.github.io/obsidian-dataview/

### Compliance Standards

**OSCAL**:
- NIST OSCAL: https://pages.nist.gov/OSCAL/
- Use for schema definitions

**GRC Concepts**:
- Framework mapping
- Control inheritance
- Evidence collection
- Continuous monitoring

### Graph Database Concepts

**Typed/Labeled Links**:
- Neo4j Cypher: https://neo4j.com/docs/cypher-manual/
- RDF: https://www.w3.org/RDF/
- Inspiration for link metadata design

---

## Next Steps

### For Python Tool

1. ⬜ Review and refactor `framework_to_obsidian.py`
2. ⬜ Add comprehensive README with architecture
3. ⬜ Create example vault
4. ⬜ Add CLI documentation
5. ⬜ Publish to PyPI

### For Obsidian Plugin

1. ⬜ Set up plugin development environment
2. ⬜ Design plugin architecture
3. ⬜ Implement basic framework detection
4. ⬜ Build link insertion modal
5. ⬜ Test with example vault

### For Documentation

1. ⬜ Create comprehensive user guide
2. ⬜ Record video tutorials
3. ⬜ Build example workflows
4. ⬜ Publish blog posts / case studies

### For Community

1. ⬜ Create Discord/forum for users
2. ⬜ Establish contribution guidelines
3. ⬜ Build template library
4. ⬜ Partner with GRC professionals

---

## Questions to Resolve

1. **Plugin vs. Tool**: Should we focus on enhancing Python tool or building full plugin first?
2. **Metadata Schema**: How to define and validate metadata schemas per framework?
3. **Multi-Framework**: How to handle multiple frameworks in single vault without conflicts?
4. **Updates**: How to handle framework updates without breaking existing links?
5. **Export**: What format for compliance reports (PDF, HTML, OSCAL JSON)?
6. **Collaboration**: How to enable team workflows (assignments, reviews, approvals)?
7. **Integration**: Which external GRC tools to integrate with first?

---

## Appendix: Regex Pattern Explanation

The core regex for parsing framework links:

```regex
^(?:\[|\()?(?<dotKey>framework_here(?:\.\w+)*)::\s*(?:\[\[(?<wikilink>[^|\]]+)\]\]|\[(?<mdText>[^\]]+?)\]\((?<mdLink>[^)]+?)\)|(?<plainLink>[^"\[\]\(\)\s{}]+))?\s*(?:(?<json>\{[^}]*\})|"(?<quotedValue>[^"]+)")?(?=\]|\)|$)
```

**Breakdown**:
- `^`: Start of line
- `(?:\[|\()?`: Optional opening bracket or paren
- `(?<dotKey>framework_here(?:\.\w+)*)`: Capture dot notation key
- `::\s*`: Dataview inline field separator
- Link options (one of):
  - `\[\[(?<wikilink>[^|\]]+)\]\]`: WikiLink
  - `\[(?<mdText>[^\]]+?)\]\((?<mdLink>[^)]+?)\)`: Markdown link
  - `(?<plainLink>[^"\[\]\(\)\s{}]+)`: Plain text
- Metadata options (one of):
  - `(?<json>\{[^}]*\})`: JSON object
  - `"(?<quotedValue>[^"]+)"`: Quoted string
- `(?=\]|\)|$)`: Lookahead for closing bracket/paren/end

---

**Last Updated**: 2025-11-30
**Status**: Planning & Design Phase
**Primary Contact**: cybersader
**License**: MIT
