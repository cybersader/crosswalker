/**
 * Crosswalker Settings Data
 *
 * Defines the structure of plugin settings and defaults.
 */

import { SavedConfig } from '../types/config';
import type { DebugLevel } from '../utils/debug';
import type { Enrichment } from '../import/mapping/types';
import type { StackDefinition, StackRunRecord } from '../import/stack/stack-persistence';

export interface CrosswalkerSettings {
	// ==========================================================================
	// General / Output
	// ==========================================================================
	defaultOutputPath: string;

	// ==========================================================================
	// Import Defaults
	// ==========================================================================
	defaultKeyNamingStyle: KeyNamingStyle;
	defaultArrayHandling: ArrayHandling;
	defaultEmptyHandling: EmptyHandling;
	defaultFrontmatterStyle: FrontmatterStyle;

	// ==========================================================================
	// Link Syntax
	// ==========================================================================
	linkSyntaxPreset: LinkSyntaxPreset;
	customLinkNamespace: string;

	// ==========================================================================
	// Connections — vault-wide defaults for the six enrichment knobs
	// (spec/recipe.schema.json target.enrichment). A settings section (§
	// Connections) so every import doesn't start over from a preset's
	// hardcoded values or the adaptive parent_note detection alone.
	//
	// Precedence (highest to lowest): a recognized built-in configuration >
	// the user's resumed draft or saved mapping > these vault defaults > the
	// active preset's own defaults > adaptive detection (folder-notes-style
	// plugin presence). Only keys actually SET here participate — an empty
	// `{}` (the default) means "defer entirely to the preset."
	// ==========================================================================
	defaultEnrichment: Enrichment;

	// ==========================================================================
	// Config Matching & Suggestions
	// ==========================================================================
	enableConfigSuggestions: boolean;           // Show "Use saved config?" prompts
	configMatchThreshold: number;               // Minimum score (0-100) to suggest a config
	enablePatternDetection: boolean;            // Detect data patterns for smarter matching
	promptToSaveConfig: boolean;                // Ask to save config after successful import
	/**
	 * Skip the recognized-source card straight to the review screen when a
	 * bundled recipe scores a 100% (exact) match (settings § Suggestions).
	 * Review stays mandatory either way — this only removes the extra click
	 * past the trust card, never a jump straight to generate. Below 100 the
	 * card always shows regardless of this setting.
	 */
	autoApplyExactMatch: boolean;

	// ==========================================================================
	// Wizard Behavior
	// ==========================================================================
	showColumnStatistics: boolean;              // Show unique counts, types in Step 2
	showSampleValues: boolean;                  // Show sample data in column config
	sampleValueCount: number;                   // How many samples to show (1-10)
	confirmBeforeGenerate: boolean;             // Show confirmation before creating files
	showProgressNotices: boolean;               // Show parsing/generation progress
	enableShapeWorkbench: boolean;              // Beta: shape-first mapping workbench in Step 2 (spec 2026-07-05)

	// ==========================================================================
	// Advanced
	// ==========================================================================
	maxRowsForPreview: number;                  // Limit rows in preview (performance)
	streamingThresholdMB: number;               // File size to trigger streaming parser

	// ==========================================================================
	// Tier 2 sidecar (v0.1.5)
	// ==========================================================================
	enableTier2Projection: boolean;             // Auto-project Tier 1 → Tier 2 on vault load
	tier2SidecarPath: string;                   // Vault-relative path; default '.crosswalker.sqlite'
	evidenceReportFolder: string;               // Folder for generated coverage reports; default 'Reports'
	evidenceJunctionFolder: string;             // Folder for evidence link notes; default 'Evidence/Junctions'

	// ==========================================================================
	// Debug (Phase 3.5 — wide-event NDJSON logger)
	// ==========================================================================
	enableDebugLog: boolean;                    // Master toggle; writes NDJSON events to crosswalker-debug.log
	verboseLogging: boolean;                    // When true, trace-level events are emitted; otherwise only error/warn/info. Kept for back-compat; debugLogLevel is the preferred control.
	debugLogCategoryFilters: Record<string, boolean>;  // Per-category opt-out. Key = category name (e.g. "generation", "wizard"); value=false suppresses. Default empty (all categories emit).
	debugLogLevel: DebugLevel;                  // Minimum severity written to the log file when enabled (file-write filter only; the in-memory ring buffer always keeps every level for diagnostics).

	// ==========================================================================
	// Draft sessions (Phase 3.6 — wizard auto-save / resume)
	// ==========================================================================
	enableDraftSessions: boolean;               // Auto-save wizard state mid-flow; show resume picker on wizard open
	draftExpiryDays: number;                    // Drafts older than this auto-purge. 0 = never expire.
	maxDrafts: number;                          // Cap on total draft files. Oldest deleted when exceeded. 0 = no cap.

	// ==========================================================================
	// Saved Configurations
	// ==========================================================================
	savedConfigs: SavedConfig[];
	/** Recipe compositions; vault-specific run facts are stored separately. */
	stacks: StackDefinition[];
	stackRuns: StackRunRecord[];
}

export type KeyNamingStyle = 'as-is' | 'lowercase' | 'snake_case' | 'camelCase' | 'kebab-case';
export type ArrayHandling = 'as_array' | 'stringify' | 'first' | 'last' | 'join';
export type EmptyHandling = 'omit' | 'empty_string' | 'null' | 'default';
export type FrontmatterStyle = 'flat' | 'dot_to_nest' | 'group_by_prefix';
export type LinkSyntaxPreset = 'simple' | 'standard' | 'full' | 'custom';

export const DEFAULT_SETTINGS: CrosswalkerSettings = {
	// General / Output
	defaultOutputPath: 'Ontologies',

	// Import defaults
	defaultKeyNamingStyle: 'snake_case',
	defaultArrayHandling: 'as_array',
	defaultEmptyHandling: 'omit',
	defaultFrontmatterStyle: 'flat',

	// Link syntax
	linkSyntaxPreset: 'standard',
	customLinkNamespace: 'crosswalker',

	// Connections — empty means "defer entirely to the active preset."
	defaultEnrichment: {},

	// Config Matching & Suggestions
	enableConfigSuggestions: true,
	configMatchThreshold: 50,          // Suggest configs scoring 50+
	enablePatternDetection: true,
	promptToSaveConfig: true,
	autoApplyExactMatch: false,        // Don't auto-apply, let user confirm

	// Wizard Behavior
	showColumnStatistics: true,
	showSampleValues: true,
	sampleValueCount: 3,
	confirmBeforeGenerate: true,
	showProgressNotices: true,
	enableShapeWorkbench: false,

	// Advanced
	maxRowsForPreview: 100,
	streamingThresholdMB: 5,           // Use streaming for files > 5MB

	// Tier 2 sidecar (v0.1.5)
	enableTier2Projection: true,
	tier2SidecarPath: '.crosswalker.sqlite',
	evidenceReportFolder: 'Reports',
	evidenceJunctionFolder: 'Evidence/Junctions',

	// Debug (Phase 3.5)
	enableDebugLog: false,
	verboseLogging: false,
	debugLogCategoryFilters: {},
	debugLogLevel: 'info',

	// Draft sessions (Phase 3.6)
	enableDraftSessions: true,
	draftExpiryDays: 30,
	maxDrafts: 20,

	// Saved configs and stack recipe compositions (run facts kept separately)
	savedConfigs: [],
	stacks: [],
	stackRuns: []
};
