# Crosswalker Logo Prompts

## Brand Core

**Name origin**: "Crosswalk" = GRC term for mapping between compliance frameworks.
**Visual language**: Intersecting paths, network graph, bridging structured systems.
**Vibe**: Professional, techy, cybersecurity. Not playful — authoritative.

## Colors

| Name | Hex | Role |
|------|-----|------|
| Void | `#0d1117` | Dark bg |
| Accent | `#00d4aa` | Primary teal |
| Glow | `#7ff5d8` | Highlights |
| Red | `#e06c75` | ATT&CK / threat |
| Green | `#98c379` | Evidence |
| White | `#e8edf2` | Text |

## Base Prompt (prepend to all)

```
Clean flat vector logo. No gradients except subtle glow. Software product icon style (like Linear, Vercel, Notion). Must work at 32px and 512px.
```

## Concepts × Variants Grid

Each concept row + each variant column = one prompt. Combine base + concept + variant.

### Concepts

| # | Concept | Core Prompt |
|---|---------|------------|
| 1 | **Graph** | 5-6 small circles (nodes) connected by thin lines (edges) forming a compact interconnected graph. Connecting lines create a subtle cross/intersection pattern at center. 1-2 edges have tiny rectangular metadata badges. |
| 2 | **Shield+Graph** | Minimal shield outline (rounded bottom, flat top) containing a small 4-5 node network graph with crossing lines inside. Feel: "protected knowledge network." |
| 3 | **Crossroads** | Two horizontal parallel lines connected by 3-4 diagonal crossing lines forming a bridge/X pattern. Small glowing dots at intersection points. Geometric, architectural. |
| 4 | **Diamond+Graph** | Obsidian-style rotated square/rhombus outline with network graph nodes extending beyond its bounds. Diamond = Obsidian; extending graph = knowledge Crosswalker creates. |
| 5 | **CW Mono** | Letters "CW" where strokes are made of thin lines and small circles (graph network elements). C curves around nodes, W peaks connect to nodes with short edges. |

### Variants

| Variant | Modifiers |
|---------|-----------|
| **Dark** | Teal (#00d4aa) elements, dark (#0d1117) bg. Subtle glow on nodes. |
| **Light** | Dark teal (#0a6b56) elements, white (#f8f9fa) bg. No glow. |
| **Mono** | Single color (#0d1117) on transparent. Works at 16px favicon. |
| **Multi-color** | Teal nodes (#00d4aa) + red node (#e06c75) + green node (#98c379). Shows multi-domain concept. |
| **+ Wordmark** | Below icon: "CROSSWALKER" in geometric sans-serif, 0.15em spacing. Below that: "compliance knowledge graph" in muted gray. |

### Quick Reference: Concept × Variant

| | Dark | Light | Mono | Multi | +Word |
|---|---|---|---|---|---|
| Graph | Primary | Docs | Favicon | Hero | Social |
| Shield | Alt | Print | - | - | Landing |
| Crossroads | Alt | Alt | - | - | - |
| Diamond | Plugin listing | - | - | - | - |
| CW Mono | Avatar | Print | Favicon | - | Header |

## Full Prompt Examples

**Primary (Concept 1 × Dark)**:
```
Clean flat vector logo, software product icon style. 5-6 small circles connected by thin lines forming a compact graph with crossing pattern at center. 1-2 edges have tiny metadata badges. Teal (#00d4aa) nodes with subtle glow. Dark (#0d1117) background. No text. Works at 32px and 512px.
```

**Plugin Listing (Concept 4 × Dark)**:
```
Clean flat vector logo. Obsidian-style rotated square outline in teal (#00d4aa) with 3-4 graph nodes and edges extending beyond the diamond. Teal on dark (#0d1117). No text.
```

**Favicon (Concept 1 × Mono)**:
```
Extremely simplified: 4-5 dots connected by lines forming a compact cluster with crossing pattern. Single color (#0d1117) on transparent. Recognizable at 16x16.
```

## Usage

| Context | Recipe | Size |
|---------|--------|------|
| Obsidian plugin | C4 × Dark | 256×256 |
| GitHub repo | C1 × Dark | 400×400 |
| Favicon | C1 × Mono | 32×32 |
| Social/OG | C1 × Multi + Word | 1200×630 |
| Docs header | C5 × Dark + Word | Variable |

## Tools

- ChatGPT/DALL-E — iterative refinement
- Midjourney — `--style raw` for vectors
- [Obsidian Logo Maker](https://obsidian.md/logo) — Concept 4
- Figma — final vector cleanup
