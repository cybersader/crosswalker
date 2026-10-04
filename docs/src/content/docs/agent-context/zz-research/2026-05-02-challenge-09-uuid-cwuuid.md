---
title: "Ch 09 deliverable: UUID / CWUUID cross-cutting identifier strategy"
description: "Fresh-agent research deliverable for Challenge 09. Recommends UUIDv7 default + sha256 multibase CIDs for content-addressed entities + CURIEs (ORCID for SSSOM authors); CWUUID is a display convention, not a new identifier algebra. Includes full OSCAL round-trip mapping table and per-entity decision table."
tags: [research, deliverable, identifiers, uuid, oscal, sssom]
date: 2026-05-02
sidebar:
  label: "Ch 09: UUID/CWUUID strategy"
  order: -20260502.2
---

:::tip[Origin and lifecycle]
This is a fresh-agent research deliverable produced 2026-05-02 in response to [Challenge 09: UUID/CWUUID cross-cutting strategy](/crosswalker/agent-context/zz-challenges/archive/09-uuid-cwuuid-cross-cutting-strategy/). It was summarized in [05-02 §2.2](/crosswalker/agent-context/zz-log/2026-05-02-direction-research-wave-and-roadmap-reshape/#22-challenge-09--uuid--cwuuid-cross-cutting-identifier-strategy) and **adopted** as the identifier strategy per [05-02 direction posture](/crosswalker/agent-context/zz-log/2026-05-02-direction-research-wave-and-roadmap-reshape/#direction-posture) — the only research wave deliverable adopted today (others deferred pending Challenges 11/12/13). Preserved verbatim; not edited after publication.
:::

# Challenge 09 — UUID / CWUUID Cross-Cutting Identifier Strategy

**Status:** Decision-ready proposal for the Crosswalker Foundation phase
**Author scope:** Identifier strategy across every Crosswalker entity type, with OSCAL round-trip alignment
**Date:** 2026-05-01

---

## Executive Summary — The Recommended Scheme

Crosswalker should adopt a **layered, mostly-UUIDv7 identifier strategy with content-addressed exceptions**, surfaced under a uniform display prefix `cw:` (read aloud as "CWUUID"). The full scheme:

1. **Default identifier class for almost everything Crosswalker generates: UUIDv7** (RFC 9562, May 2024). UUIDv7 is a fully RFC-9562-compliant 128-bit UUID with a 48-bit Unix-millisecond timestamp prefix and 74 bits of randomness/counter. It is OSCAL-shape-compatible (same canonical 8-4-4-4-12 hex form, same `uuid` datatype), but unlike UUIDv4 it is **lexicographically and chronologically sortable**, which dramatically improves filesystem listings, git diffs, dataview index locality, and debugging.
2. **Content-addressed identifiers (sha256 → multibase b32 prefix `cid:`) only where the entity *is* its content.** This applies to spine snapshots (already decided), schema definition releases in the marketplace, and import provenance hashes — not to mutable artifacts like edges or evidence.
3. **Composite natural keys (CURIEs) for everything that is *external* to Crosswalker** — controls, techniques, framework versions, ORCIDs, prefixed source identifiers — using the SSSOM/CURIE convention (`NIST_800_53_R5:AC-2`, `MITRE_ATTACK:T1078`, `ORCID:0000-...`). These are *not* UUIDs; they are stable references whose resolution is governed by a vault-level `curie_map`.
4. **No custom CW-prefixed bespoke ID format.** "CWUUID" is a *display convention*, not a new identifier algebra. Every CW-generated UUIDv7 is rendered in two equivalent forms:
   - **Canonical (machine)**: `0190f3c8-8c41-7a3b-9f27-9e0aa1b3c4d5` — exactly what OSCAL expects.
   - **Short display (human)**: `cw:0190f3c8…3c4d5` (first-8…last-5 hex) for grep, log lines, and filename suffixes. This is purely a UI affordance; the canonical UUID always lives in YAML frontmatter.
5. **Filename strategy: human-readable filename + canonical UUID in frontmatter, with a short-hash suffix on collision-prone classes only.**
   - Ontology nodes: `AC-2.md` (filename = framework natural ID; UUID in frontmatter)
   - Crosswalk junction notes: `nist-800-53-r5__AC-2--mitre-attack__T1078--cw7a3b9f.md` (composite + short-hash suffix, because the same pair can be re-mapped under different predicates/justifications)
   - Evidence-link junction notes: `evidence-name--AC-2--cw7a3b9f.md` (same rationale)
   - Spine snapshots: `spine-NIST-800-53-r5--<sha256:0..12>.md` (content-addressed; the hash *is* the version).
6. **OSCAL round-trip rule: preserve incoming UUIDs on import; mint UUIDv7 only for entities Crosswalker creates de novo.** Treat the OSCAL `uuid` flag/field on every imported assembly as authoritative and store it byte-for-byte; export the same value back. Crosswalker's own internal UUIDs (junction notes, evidence links, lifecycle records) are emitted into OSCAL `uuid` slots with no special treatment — UUIDv7 is a valid value of the OSCAL `uuid` datatype.
7. **Mapping author/reviewer IDs use SSSOM convention verbatim: ORCID CURIEs preferred, GitHub-handle CURIEs as fallback.** Crosswalker does not invent an internal user ID for this slot.
8. **Vault identity gets a single UUIDv7 stamped into `.crosswalker/vault.yaml`.** Cross-vault federation is deferred to Phase 2; the vault UUID combined with globally-unique UUIDv7 entity IDs is the foundation that makes deduplication possible later without retro-fitting.

The minimum viable Foundation set (v0.1) is **six identifier classes**: vault UUID, ontology-web UUID, ontology-node UUID, junction-note UUID (covers crosswalk and evidence-link), spine snapshot CID, and SSSOM author CURIE. All other entity IDs can be retro-fitted in v0.2 because the migration is deterministic (timestamp-based UUIDv7 from file mtime).

The remainder of this document is the supporting analysis.

---

## 1. Identifier Options Compared

The candidate identifier classes were evaluated against the criteria specified in the challenge brief (determinism, sortability, distribution-safety, filename-friendliness, OSCAL alignment, byte size, human-readability).

| Option | Bits | Canonical length | Determ. | Time-sortable | Filename-safe | OSCAL-shape | Human-readable | Notes |
|---|---|---|---|---|---|---|---|---|
| **UUIDv4** (random) | 128 | 36 chars (hex+dashes) | No | **No** | Yes | **Yes (canonical OSCAL)** | Poor | NIST OSCAL traditionally recommends v4; collision-safe; unsorted insertion fragments indexes. |
| **UUIDv7** (Unix-ms time + rand) | 128 | 36 chars | No | **Yes** | Yes | **Yes (RFC 9562 compliant; same datatype)** | Poor (timestamp not visible in hex) | RFC 9562 §5.7 (May 2024). RFC explicitly recommends UUIDv7 over UUIDv1/v6. Backward-compatible UUID format. |
| **UUIDv5** (SHA-1 namespaced) | 128 | 36 chars | **Yes** (deterministic from name) | No | Yes | **Yes** | Poor | Useful for "ingest the same OSCAL file twice → same UUID." Crosswalker uses this only for derived identities where a deterministic seed is already authoritative. |
| **ULID** | 128 | 26 chars (Crockford b32) | No | **Yes** | Yes | No (not a UUID datatype) | Medium | Binary-compatible with UUIDv7 — same 128 bits, different encoding. Rejected as primary because OSCAL slots reject the b32 form. |
| **NanoID** | ~126 | 21 chars (A-Za-z0-9_-) | No | No | Yes | No | Medium | Compact, but not OSCAL-shape and not sortable. |
| **Content-address (sha256 multibase)** | 256 | 52+ chars b32 | **Yes (by definition)** | No | Yes | No (use as-is in `link/href`, not in `uuid` slot) | Poor | Correct only when the entity *is* its content (spine snapshot, schema release). |
| **Composite key** (`framework:version:control_id`) | n/a | variable | **Yes** | Lexically | Marginal (colons OK on POSIX, but punctuation-sensitive on Windows) | No (these are OSCAL human-oriented `id`/`control-id` values, not `uuid`) | Excellent | This *is* SSSOM's native CURIE form; we keep it as the natural-key complement, not the primary key. |
| **CW-prefixed bespoke ID** (`CW-7a3b9f...`) | varies | varies | varies | varies | Yes | **No** (cannot be emitted into OSCAL `uuid` slot) | Excellent | Inventing a new opaque identifier algebra adds work without yielding capability that UUIDv7 + display prefix doesn't already give. Rejected. |
| **URN** (`urn:crosswalker:evidence-link:7a3b9f`) | varies | verbose | varies | No | Yes | No (URNs go into OSCAL `link/href`, not `uuid`) | Good | Useful as a *resolvable reference form* in `props`/`link` — not as the primary internal key. |
| **DID** (Decentralized Identifier) | varies | very verbose | varies | No | Yes | No | Poor | Out of scope per the challenge. Overkill for a single-vault GRC tool; resolution infrastructure cost is enormous. |

**Key takeaway**: UUIDv7 dominates UUIDv4 on every axis except (a) blunt collision unpredictability for adversarial settings (irrelevant in a single-tenant GRC vault) and (b) the literal text "RFC 4122 v4" still appearing on the OSCAL UUID concept page. UUIDv7 is, however, formally a valid UUID under RFC 9562 (the supersession of RFC 4122) and uses the same canonical 128-bit hex representation that the OSCAL `uuid` datatype validates against. There is no syntactic rejection path: an OSCAL document containing UUIDv7 values validates against `oscal_*_metaschema.xml` schemas because those constrain only the UUID *grammar*, not the version bits.

### What UUIDv7 actually buys Crosswalker

- **Filesystem locality**: junction-note files (`evidence-*--cw7a3b9f.md`) sort by creation time when listed.
- **Git diffs are stable**: git's rename-detection works better when consecutive related notes have similar prefixes.
- **Debugging**: the first 10 hex chars of a UUIDv7 are "the millisecond it was created" — a maintainer can immediately tell when a junction note was generated, even from logs.
- **Dataview/index performance**: lexical sort = chronological sort = no extra `created` index needed for time queries.
- **ULID interop**: a UUIDv7's 128 bits are identical to a ULID's 128 bits; a maintenance script can convert between forms losslessly (per the ramsey/uuid documentation and the ULID specification).

---

## 2. OSCAL UUID Semantics — Findings and Crosswalker Implications

The authoritative source is NIST's OSCAL "Identifier Use and UUIDs" page (last updated June 10, 2025). Salient points:

- **Two identifier kinds**: *machine-oriented* (UUID, datatype `uuid`, globally unique) and *human-oriented* (token, datatype `token`, locally unique, semantically meaningful — e.g., `control-id="ac-2"`).
- **UUID format**: NIST documents this as "RFC 4122" UUIDs. RFC 9562 (May 2024) supersedes RFC 4122 but is fully backward-compatible — every RFC 4122 UUID is a valid RFC 9562 UUID, and the canonical hex grammar is unchanged. UUIDv4, v5, and v7 all conform to the same `uuid` datatype.
- **Why UUIDs were chosen** (per NIST): no central authority required, broad library support, low collision risk in 128 bits.
- **Per-subject consistency**: identifiers should be stable across revisions of the same document; they should change only when the *subject itself* has changed in a way that no longer represents the same identified subject. This is the central rule for Crosswalker's lifecycle handling.
- **OSCAL.io content-identifier convention** (community, not NIST core): SHA-aware re-use via UUIDv5 is permitted — `@scheme=http://oscal.io/oscal/identifier/contentuuid` in `document-id`, with v4-or-v5 acceptable. This shows there is precedent for using deterministic UUIDs in OSCAL contexts.
- **NIST OSCAL CLI / XSLT-Tooling**: the only NIST-blessed UUID generator (currently in `XSLT-Tooling`) emits UUIDv4. There is, as of issue #191 against `oscal-cli`, an active community request for a first-class UUID tool. There is no published NIST statement *prohibiting* UUIDv7; the NIST docs simply predate broad UUIDv7 adoption.

### Is UUIDv7 OSCAL-compliant?

**Yes, syntactically.** The OSCAL `uuid` datatype is regex-defined as the standard 8-4-4-4-12 hex pattern with no version-bit constraint enforced by the published schemas (xmllint validation against `oscal_*_metaschema.xsd` accepts any version 1–8). NIST's *recommendation* still names "v4" because that is what the original RFC 4122 narrative emphasized; this is recommendation, not a schema rule. The risk of switching is therefore: (a) a future NIST schema tightening to enforce v4 specifically (low probability — would break vast amounts of in-the-wild OSCAL content) and (b) a strict third-party validator that rejects non-v4 UUIDs (rare; most validators only check the regex). Crosswalker should monitor the OSCAL repo for any constraint addition that targets the version nibble; until then, UUIDv7 is fully compatible.

### Import strategy: preserve, don't re-mint

When Crosswalker ingests OSCAL content (a NIST 800-53 catalog OSCAL XML, a third-party SSP, a FedRAMP profile):

1. **Every `@uuid` flag and `<uuid>` field on every imported assembly is preserved verbatim.** That UUID becomes the Crosswalker UUID for that node. Round-tripping requires this; it is the OSCAL "per-subject consistency" rule.
2. **For entities *implied* by the import but not given a UUID** (e.g., a control inside a catalog whose `control` element only has `control-id` but no UUID — controls are human-oriented in OSCAL), Crosswalker mints a UUIDv7 and stores it *alongside* the natural ID (`control-id`). On export, the natural ID is what flows back into OSCAL; the UUID is recorded as a `prop[name="cw-internal-uuid"]` if needed for round-trip detection.
3. **Crosswalker-originated entities** (junction notes, evidence-links, lifecycle records) get UUIDv7 from the start. When emitted in OSCAL contexts (e.g., as `link[rel]` references or as observation/finding UUIDs in an Assessment Results document), they fit the `uuid` datatype without modification.

### Crosswalker → OSCAL UUID slot mapping

| Crosswalker entity | OSCAL counterpart | OSCAL slot | Identifier class |
|---|---|---|---|
| Ontology web (imported framework version, e.g., NIST 800-53 r5 catalog) | `catalog` root | `catalog/@uuid` | UUID (preserve incoming; mint UUIDv7 if absent) |
| Ontology web — profile import | `profile` root | `profile/@uuid` | UUID (preserve) |
| Ontology web — component definition import | `component-definition` root | `component-definition/@uuid` | UUID (preserve) |
| Ontology node (control) | `control` element | `control/@id` (human-oriented token) | CURIE natural key; Crosswalker UUIDv7 stored in note frontmatter only |
| Ontology node (control statement / assessment objective) | `part`, `objective` | `part/@id`, etc. | Token (human-oriented); internal UUIDv7 in frontmatter |
| Ontology node (technique/sub-technique, MITRE ATT&CK) | n/a in NIST OSCAL core; commonly modeled as catalog group/control in extended profiles | Token | CURIE (`MITRE_ATTACK:T1078`) + internal UUIDv7 |
| Crosswalk edge (pairwise, with STRM/SSSOM payload) | Closest: `mapping` (Control Mapping Model, OSCAL pre-release) or a `link[rel='related']` with prop bag | mapping `@uuid` if using control-mapping; otherwise `link/@href` URN to internal UUID | UUIDv7 (Crosswalker-minted) + SSSOM `record_id` set to the same value as a CURIE |
| Evidence-link junction note | Closest: SSP `implemented-requirement/by-component`, AR `observation`, AR `evidence` | `observation/@uuid`, `evidence/@uuid` | UUIDv7 |
| Evidence note (user-authored markdown) | AR `evidence` resource | `evidence/@uuid` and/or `back-matter/resource/@uuid` | UUIDv7 |
| Spine snapshot | `catalog` resolved snapshot (could be a back-matter resource) | `back-matter/resource/@uuid`; `rlink/@href` carries `sha256:` content URI | sha256 CID (primary) + UUIDv7 (resource wrapper, if needed for OSCAL emit) |
| Mapping author / reviewer | `metadata/party/@uuid` and `metadata/responsible-party` | `party/@uuid` (UUID) and `party/external-id[@scheme='ORCID']` (ORCID CURIE) | UUID for OSCAL `party`; CURIE (ORCID) for SSSOM `author_id` |
| Framework version / spine version | `catalog/metadata/version` + `metadata/published` + content-address | `metadata/version` (semantic string) + `document-id` | Composite: semver string + sha256 CID (in `document-id[@scheme='…contenthash']`) + catalog `@uuid` |
| Vault identity | n/a in OSCAL (this is Crosswalker-private) | exported as `metadata/prop[name='cw-vault-id']` if needed for federation | UUIDv7 |
| Lifecycle change record | AR `risk-log/entry/@uuid`, AR `assessment-log/entry/@uuid` | `entry/@uuid` | UUIDv7 |
| Schema definition (marketplace) | `back-matter/resource/@uuid`; checksum in `rlink/hash` | `resource/@uuid` + `hash[@algorithm='SHA-256']` | sha256 CID (primary, content-defined) + UUIDv7 wrapper for OSCAL emission |

OSCAL UUIDs are documented as globally unique (machine-oriented, 128 bits) versus locally unique within a document (human-oriented tokens). The Crosswalker scheme respects this: every UUID we mint is globally unique; every CURIE/natural key relies on the framework's native namespace plus a per-vault `curie_map` for resolution.

---

## 3. Per-Entity Identifier Scheme — Decision Table

| Entity type | Primary identifier | Format | Filename rule | Frontmatter key | Rationale |
|---|---|---|---|---|---|
| **Vault** | UUIDv7 | canonical hex | `.crosswalker/vault.yaml` | `vault_id` | Required substrate for any future federation; minted once at vault init. |
| **Ontology web** (framework version, e.g., NIST 800-53 r5) | UUIDv7 (Crosswalker-minted unless OSCAL catalog import provides one — then preserve) | canonical hex | `webs/nist-800-53-r5.md` (human filename) | `web_id`, `web_oscal_uuid` (if imported) | Controls the parent grouping; OSCAL round-trip must preserve catalog `@uuid`. |
| **Ontology node** (control, technique, sub-technique) | Composite natural key (CURIE) — primary; UUIDv7 — secondary internal ID | CURIE: `NIST_800_53_R5:AC-2`; UUID: hex | `webs/nist-800-53-r5/AC-2.md` (filename = framework natural ID) | `id` (CURIE), `cw_uuid` (UUIDv7), `oscal_id` (token, if differs) | Human-readable filenames are non-negotiable for GRC reviewers; CURIEs satisfy SSSOM; UUID handles renamed/split/merged controls (see §6). |
| **Crosswalk edge** (pairwise junction note) | UUIDv7 | canonical hex | `crosswalks/<src>--<tgt>/<src-id>--<tgt-id>--cw<short>.md` | `cw_uuid`, `record_id` (CURIE form of UUID), `subject_id`, `object_id`, `predicate_id` | Same pair can be mapped under multiple predicates/justifications; UUID uniquely names each *assertion*. SSSOM `record_id` slot (added in PR #452) accepts a UUID. |
| **Evidence-link junction note** (one file per evidence→ontology edge) | UUIDv7 | canonical hex | `evidence-links/<evidence-slug>--<onto-id>--cw<short>.md` | `cw_uuid` | One file per edge per the prior decision; short suffix avoids collisions when the same evidence is linked to many controls. |
| **Evidence note** (user-authored markdown) | UUIDv7 | canonical hex | user-chosen | `cw_uuid` | Auto-injected by plugin on first save; immutable thereafter. Mirrors Obsidian Advanced URI's `uid` convention. |
| **Spine snapshot** | sha256 multibase CID | `cid:b32...` | `spines/<framework>/<semver>--<short-sha>.md` | `cid`, `algo: sha256`, `framework`, `version`, `as_of` (date) | Already decided as content-addressed; no UUID needed for the *snapshot identity*. A wrapping note may also carry a UUIDv7 for OSCAL emission. |
| **Mapping author/reviewer** | ORCID CURIE preferred; GitHub CURIE fallback; OSCAL `party/@uuid` for OSCAL emission | `ORCID:0000-0002-1825-0097` | n/a (lives in `parties.yaml`) | `author_id`, `reviewer_id` | SSSOM specification mandates CURIEs in TSV serialisation; ORCID is the convention used in the SSSOM examples. |
| **Framework version / spine version** | Composite: `<framework>:<semver>` + sha256 CID + `as_of` date | `NIST_800_53_R5:5.1.1@cid:b32...@2024-03-15` | embedded in spine note | `version`, `cid`, `as_of` | Three-part identity captures: editorial version (semver), content (CID), and ingestion time. |
| **Lifecycle change record** | UUIDv7 | canonical hex | `lifecycle/<YYYY-MM>/cw<short>.md` (UUIDv7's time prefix already encodes the date — folder is for browsing convenience) | `cw_uuid`, `op`, `subject_uuid` | Atomic operation log; UUIDv7's monotonic property gives free total ordering. |
| **Schema definition** (marketplace community concept) | sha256 CID — primary; UUIDv7 wrapper for cataloging | `cid:b32...` | `schemas/<name>/<semver>--<short-sha>.yaml` | `cid`, `version`, `name`, `cw_uuid` | Schemas are released artifacts; their identity *is* their content. UUID exists only to be addressable as an OSCAL `resource`. |

---

## 4. Filename Strategy — Decision and Justification

**Decision: UUID lives in frontmatter; filenames are human-readable; collision-prone classes get a short UUID suffix.**

### Prior art surveyed

- **Obsidian Advanced URI** (Vinzent03) — the de facto standard for stable note linking — uses a `uid` field in YAML frontmatter and resolves `obsidian://advanced-uri?uid=...` independently of the filename. This means "rename the file, keep the link." Crosswalker should align with this convention so existing Obsidian users get URI compatibility for free.
- **`obsidian-ulid-plugin`** (NickAnderegg) — defaults to `uid` field, inserts ULIDs (binary-equivalent to UUIDv7) into frontmatter, never modifies filenames or any other field. Cleanest pattern; it should not auto-overwrite an existing `uid`.
- **`obsidian-unique-identifiers`** (tvanreenen) — supports UUID, NanoID, ULID, KSUID, CUID. Validates that the multi-format approach is mainstream in the Obsidian ecosystem.
- **`obsidian-note-uid`** (mrjackphil) — adds an `obsidian://open-by-uid?uid=...` URI handler tied to a frontmatter `id` field. Same pattern.
- **Logseq** — uses `:block/uuid` (UUID) per block, exposed as `id::` property in markdown export. Filenames stay human-readable. There is community pressure (forum thread "Drop UUID for blocks in favor of short codes") to display shorter forms, validating Crosswalker's "display short, store full" approach.
- **Tana / Capacities** — both are closed databases that use opaque internal IDs and never expose them in filenames; the user navigates by title. The lesson is: *the database answer is "UUID in metadata only,"* but Crosswalker is file-based, not database-based, so we need a hybrid.

### Why the hybrid (filename = readable, frontmatter = canonical UUID)

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| (a) UUID in frontmatter only; filename fully human | Reviewers can browse the vault; Obsidian wikilinks work; matches Advanced URI | Filename collisions when two crosswalk edges map the same pair under different predicates | Default for ontology nodes & evidence notes |
| (b) UUID-based filenames | Globally unique; no collision risk | Reviewers cannot scan a folder; wikilinks become unreadable; fails the GRC "must be auditable by humans" test | Rejected |
| (c) Composite filename `<natural>--cw<short>.md` | Readable + collision-safe; greppable; sortable when UUIDv7 | Slightly longer filenames | **Recommended for junction classes** (crosswalk edges, evidence links, lifecycle records) |
| (d) Content-addressed filename | Tamper-evident; deterministic | Renaming a note breaks the hash → not appropriate for mutable artifacts | Recommended only for spine snapshots and schema releases |

Filename-friendliness constraints driving the suffix choice: Windows file systems disallow `:`, `<`, `>`, `"`, `/`, `\`, `|`, `?`, `*`, and reserved names. UUIDv7 in canonical form (`0190f3c8-8c41-7a3b-9f27-9e0aa1b3c4d5`) is filesystem-safe everywhere; ULID (`01HE...`) is also safe. Both are 26–36 chars — ULID's compactness almost wins this category, but the OSCAL alignment requirement breaks the tie for UUIDv7 as the canonical storage form. We use the **first 6 hex chars of the UUID** (post-version-nibble portion is fine — collision probability across a single vault remains ≪ 10⁻⁶ for any plausible vault size) as the filename short suffix, prefixed `cw` for grep-ability: `cw7a3b9f`.

---

## 5. Cross-Vault Federation — Foundation Stance

The challenge brief explicitly out-of-scopes cross-vault sync mechanics. The identifier scheme nevertheless either *enables* or *forecloses* federation, so the foundation must make one decision now: **use globally-unique identifiers everywhere**.

- **UUIDv7 is globally unique.** Two vaults independently minting UUIDv7s have collision probability bounded by birthday paradox over 2¹²² random bits within the same millisecond — astronomically negligible.
- **Vault-local content-addressing (sha256 CIDs)** also yields cross-vault deduplication for free: identical spine snapshots produce identical CIDs in any vault.
- **Vault-local sequential IDs** (e.g., `evidence-001`) would have made federation impossible without a renumbering migration. Rejected.
- **Vault UUID** stamped in `.crosswalker/vault.yaml` enables a future cross-vault sync layer to disambiguate edits "made in vault X vs vault Y" without per-edit author metadata.

Prior art on federated identity in knowledge graphs:
- **ActivityPub/Matrix** use globally-unique URI-shaped identifiers and a per-server prefix; the Crosswalker analogue is `urn:crosswalker:<vault-uuid>:<entity-uuid>` for inter-vault references. We do **not** use this URN form internally; it's only used in cross-vault export/import.
- **Wikidata QIDs** (`Q42`) are globally minted by a central authority — opposite design choice; not applicable.
- **DOIs / Handle System** rely on a registry — also not applicable.
- **ORCID** — used directly for `author_id` since SSSOM already mandates it.

**Recommendation**: defer the federation *protocol* to Phase 2 but commit to the *primitives* (UUIDv7 + vault UUID + content-addressed snapshots) in Foundation. This is a one-line change that costs nothing and would otherwise be expensive to retrofit.

---

## 6. What "CWUUID" Means — Naming and Display Convention

"CWUUID" is **not a new identifier algorithm**. It is a *display convention* and a *naming convention* for Crosswalker-minted identifiers, consisting of:

1. **Storage form**: a canonical UUIDv7, e.g., `0190f3c8-8c41-7a3b-9f27-9e0aa1b3c4d5`. This is exactly what OSCAL accepts.
2. **Short display form**: `cw:0190f3c8…3c4d5` (or just `cw7a3b9f` in filenames where colons are awkward). Used in:
   - Filename suffixes for collision-prone classes
   - Log lines, error messages, audit trails
   - Hover-cards / dataview tables in Obsidian
3. **URN form** (used only in cross-vault refs and OSCAL `link/@href`): `urn:crosswalker:<vault-uuid>:<entity-uuid>`.

### Why not invent a bespoke ID format?

- **Grep-ability**: `cw:` and `cw<hex>` are grep-friendly without inventing new bytes. `grep "cw7a3b9f" vault/` works.
- **OSCAL round-trip**: any non-UUID format would require translation tables on every export. UUIDv7 round-trips for free.
- **Library support**: every language has a UUID library; UUIDv7 is now in the Java standard library (JDK 26, `UUID.ofEpochMillis`), Python (per the cpython issue tracker), Postgres 18 (`uuidv7()`), and most JS runtimes.
- **Ecosystem alignment**: Obsidian plugins, Logseq, and SSSOM all accept canonical UUIDs.

### Comparison with other namespaced ID schemes

- **DOI** (`10.5281/zenodo.123456`): registry-backed; not applicable to a self-hosted vault.
- **ORCID** (`0000-0002-1825-0097`): used as-is for author/reviewer slots.
- **Handle System** (`hdl:2381/1234`): registry-backed; out of scope.
- **Wikidata QIDs** (`Q42`): centralized; out of scope.
- **CURIE** (`MITRE_ATTACK:T1078`): used for *external* references via the SSSOM `curie_map`; this is the natural-key complement to UUIDv7.

---

## 7. Migration Path

Crosswalker today (pre-Foundation) may already have vaults with markdown notes lacking UUIDs. The migration strategy:

1. **Annotation script** (`crosswalker migrate annotate-uuids`):
   - Walk the vault.
   - For each note matching a Crosswalker entity pattern (folder convention or recognized frontmatter), emit a UUIDv7 derived from the file's mtime (so the timestamp prefix is meaningful, not the migration moment) into a new `cw_uuid` frontmatter field.
   - For notes that *already* have a `uid` field (from Obsidian Advanced URI or other plugins), promote that value to `cw_uuid` if it parses as a UUID; otherwise add `cw_uuid` alongside.
   - Idempotent: re-running the script does not modify notes that already have `cw_uuid`.
2. **Spine and schema CID backfill** (`crosswalker migrate hash-content`):
   - Compute sha256 over normalized spine snapshot content; record `cid` in frontmatter.
   - Same for schema definitions.
3. **OSCAL UUID preservation pass** (`crosswalker migrate import-oscal-uuids`):
   - For every web that was originally imported from OSCAL XML/JSON, re-parse the source and lift any `@uuid` flags into the corresponding Crosswalker note frontmatter as `oscal_uuid`. This restores round-trip fidelity for vaults that lost it during ad-hoc imports.
4. **Filename rationalization** (optional, gated behind explicit flag):
   - For junction-note classes, add `--cw<short>` suffix to filenames if missing.
   - Rewrite all internal Obsidian wikilinks (`[[old-name]]` → `[[new-name]]`) using Obsidian's rename-with-link-update API. Do not run this without a vault backup.
5. **Lifecycle log seeding**:
   - Every change made by the migration is itself logged as a lifecycle change record (UUIDv7) so the migration is auditable.

The migration is reversible in principle (UUIDs can be removed) but the spine CIDs are not — content addressing is one-way. This is acceptable; spine CIDs are intended as immutable.

---

## 8. Reservation / Generation Conventions

### Who generates UUIDs?

| Context | Generator | Notes |
|---|---|---|
| Interactive note creation in Obsidian | Crosswalker plugin (in-process) | UUIDv7 minted at creation time using a CSPRNG-backed library. The plugin must use a monotonic counter (per RFC 9562 §6.2 method 1 or 2) within a millisecond to avoid same-ms collisions when batch-creating crosswalk edges. |
| CLI batch operations | Crosswalker CLI | Same library; shares a process-local monotonic counter. |
| Imports (OSCAL, SSSOM TSV) | Importer preserves source UUIDs verbatim | New UUIDv7 minted only for entities the source did not identify. |
| Manual user assignment | Allowed but discouraged | Plugin accepts a user-supplied UUIDv7 in the New Note dialog if explicitly entered; validates the canonical form. |
| Scripts / automations (third-party) | Must call into the CLI or use a documented UUIDv7 library | The Foundation contract is "any RFC 9562-compliant UUIDv7 is accepted"; we do not require a Crosswalker-specific generator. |

### Collision prevention in offline workflows

- **Within a single vault, single process**: monotonic UUIDv7 generator per RFC 9562 §6.2 (sub-millisecond fraction or counter). The `uuidv7-js`, `pg_uuidv7`, and similar libraries already implement this.
- **Within a single vault, multiple processes** (CLI + plugin running simultaneously): negligible risk because the 74 random bits per UUIDv7 give 2⁷⁴ ≈ 1.9 × 10²² distinct values per millisecond. A single user cannot produce a same-ms collision in any realistic scenario.
- **Across multiple vaults** (offline + later merge): each vault's UUIDs are independent. Birthday-paradox math: probability of one collision after 10⁹ UUIDs across N vaults is ≪ 10⁻¹⁵. The vault UUID adds an additional disambiguator.
- **Determinism for re-imports** (same SSSOM TSV imported twice should yield same edge UUIDs): use a UUIDv5 with a Crosswalker-reserved namespace UUID and the SSSOM `record_id` (or hash of subject+predicate+object+justification) as the name. UUIDv5 is the only RFC-compliant deterministic UUID; OSCAL accepts it.

### Reserved namespaces

For UUIDv5 deterministic minting, reserve a single namespace UUID (UUIDv4) at project level:

```
CW_NS_ROOT       = "cf01a000-0000-4000-8000-000000000001"  # randomly chosen v4 UUID
CW_NS_EDGE       = uuid5(CW_NS_ROOT, "crosswalk-edge")
CW_NS_EVIDENCE   = uuid5(CW_NS_ROOT, "evidence-link")
CW_NS_IMPORT     = uuid5(CW_NS_ROOT, "oscal-import")
```

Concrete namespace UUIDs are fixed at v0.1 release and never changed.

---

## 9. Minimum Viable Set for Foundation (v0.1)

**MUST have UUIDs at v0.1**:

1. **Vault** — needed for any future federation; trivial to mint at init.
2. **Ontology web** — root of every framework; needed for OSCAL catalog round-trip.
3. **Ontology node** (control / technique) — needed because they may be referenced from many crosswalk edges; UUID disambiguates renamed/split/merged controls across versions.
4. **Crosswalk edge junction note** — the *primary* entity Crosswalker manages.
5. **Evidence-link junction note** — same one-file-per-edge contract as crosswalks.
6. **Spine snapshot** — already content-addressed by sha256; confirmed.

**Can defer to v0.2**:

7. **Evidence note** — initially treated as opaque user-owned markdown; UUIDv7 added on first plugin interaction.
8. **Lifecycle change record** — implementable as soon as the plugin starts logging operations; not required to ship v0.1.
9. **Schema definition (marketplace)** — marketplace itself is post-Foundation; CIDs sufficient for now.
10. **Mapping author/reviewer** — SSSOM CURIE convention used directly; no Crosswalker-internal UUID needed unless OSCAL `party/@uuid` is being emitted.

---

## 10. Risks and Open Questions

1. **NIST OSCAL future tightening of UUID version**: the OSCAL identifier-use page still cites RFC 4122 and references "version 4." A future schema update could conceivably add a Schematron rule restricting `@uuid` to v4. **Mitigation**: monitor `usnistgov/OSCAL` for issues/PRs touching the UUID datatype; UUIDv5-based deterministic minting remains a fallback that is universally accepted.
2. **UUIDv7 entropy and clock-stability**: RFC 9562 §6.1 warns that timestamp values must come from a reliable source; clock skew on user machines is a real risk for filename ordering. **Mitigation**: the plugin's monotonic counter handles backward clock jumps by reusing the prior millisecond as the embedded timestamp.
3. **Composite filenames may exceed Windows 260-char limit** for deeply nested crosswalks. **Mitigation**: keep the `cw<6-hex>` suffix short; cap concatenated source/target IDs to 64 chars each, hashing the remainder.
4. **SSSOM `record_id` ambiguity**: the SSSOM PR #452 added `record_id` as optional for backward compat. Crosswalker treats it as required internally and emits it as a CURIE form of the edge UUID.
5. **OSCAL Control Mapping Model is pre-release** (per OSCAL docs). The mapping-to-OSCAL slot for crosswalk edges may shift before OSCAL stabilizes the model. **Mitigation**: emit edges as `link[rel='related']` with prop bag for OSCAL ≤ 1.1.x; switch to first-class `mapping` once stable.

---

## 11. Authoritative Sources Consulted

- **RFC 9562, "Universally Unique IDentifiers (UUIDs)"** (May 2024, IETF) — definitive UUID specification including UUIDv6, v7, v8, Max UUID; supersedes RFC 4122. Section 5.7 specifies UUIDv7's bit layout (48-bit ms timestamp + 74 bits rand/counter); §6.2 describes monotonic-within-ms options; §6.9 specifies entropy requirements. RFC explicitly says "Implementations SHOULD utilize UUIDv7 instead of UUIDv1 and UUIDv6 if possible."
- **NIST OSCAL — "Identifier Use and UUIDs"** (`pages.nist.gov/OSCAL/learn/concepts/identifier-use/`, last updated 2025-06-10) — defines machine-oriented (UUID, globally unique, 128-bit) vs. human-oriented (token, locally unique) identifiers; states UUIDs are globally unique, references RFC 4122; states identifier values must be per-subject consistent across revisions.
- **NIST OSCAL Reference Indices** — XML and JSON UUID indices listing every `@uuid` slot across catalog, profile, component-definition, SSP, AP, AR, POA&M models.
- **OSCAL Tutorial — Creating and Using Metadata** — explicitly recommends UUIDv4 for `document-id` ("OSCAL program recommends using a version 4 (random) UUID as the document identifier"); does not prohibit other versions.
- **OSCAL.io content-identifier convention** — community precedent for UUIDv5 use in OSCAL via `@scheme="http://oscal.io/oscal/identifier/contentuuid"`.
- **`usnistgov/oscal-cli` issue #191** — open feature request for first-class UUID generation tooling, indicating UUID strategy in OSCAL is still evolving.
- **SSSOM specification** (`mapping-commons.github.io/sssom/`) — Mapping class slots: `subject_id`, `object_id`, `predicate_id`, `mapping_justification` (mandatory); `author_id`, `creator_id`, `reviewer_id`, `record_id`, `mapping_set_id` (relevant). All identifiers in SSSOM/TSV serialisation MUST be CURIEs; full IRI form mandatory in OWL/RDF serialization. Examples use ORCID CURIEs for `creator_id`.
- **SSSOM PR #452** — adds the `record_id` slot to the Mapping class, optional for backward compatibility; explicitly does not specify whether content-derived IDs are allowed.
- **ULID specification** (`github.com/ulid/spec`) — 128-bit identifier, 48-bit ms timestamp + 80 bits randomness, 26-char Crockford base32 encoding, lexicographically sortable. Binary-equivalent to UUIDv7 (per ramsey/uuid Version 7 docs).
- **NanoID** (`github.com/ai/nanoid`) — 21-char default, A-Za-z0-9_- alphabet, ~126 bits of randomness, collision probability comparable to UUIDv4. Not OSCAL-shape compatible.
- **Obsidian Advanced URI plugin** (`vinzent03.github.io/obsidian-advanced-uri/concepts/file_identifiers`) — establishes the `uid` frontmatter convention for stable note linking that survives renames.
- **`obsidian-ulid-plugin`**, **`obsidian-unique-identifiers`**, **`obsidian-note-uid`** — community plugins demonstrating that frontmatter-only identifier storage is the prevailing Obsidian pattern; multi-format (UUID/CUID/NanoID/ULID/KSUID) support is mainstream.
- **Logseq DeepWiki / community forums** — `:block/uuid` is a UUID per block; `id::` property in markdown export. Forum thread "Drop UUID for blocks in favor of short codes" (discuss.logseq.com/t/21219) validates user demand for shorter display forms.
- **OpenJDK PR #25303 / JDK-8357251** — `java.util.UUID.ofEpochMillis(long)` added to JDK 26 specifically for UUIDv7 support per RFC 9562, demonstrating broad ecosystem adoption.
- **PostgreSQL 18 `uuidv7()`** — native UUIDv7 with optional sub-millisecond timestamp fraction; fboulnois/pg_uuidv7 extension for older versions.
- **AWS UUIDv7 in Postgres / Trusted Language Extensions** — production guidance on UUIDv7 as primary keys.

---

*This document is the recommended Foundation-phase identifier strategy for the Crosswalker project. The recommendation is opinionated: adopt UUIDv7 as the default machine identifier, sha256 CIDs for content-addressed entities, CURIEs for external references and SSSOM author IDs, and the "UUID-in-frontmatter, readable-in-filename, short-suffix-on-collision" file naming pattern. The OSCAL round-trip mapping in §2 and the per-entity decision table in §3 are intended to be lifted directly into the architecture decision record (ADR) for the v0.1 release.*
