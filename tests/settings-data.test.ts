import { DEFAULT_SETTINGS, CrosswalkerSettings } from '../src/settings/settings-data';

describe('DEFAULT_SETTINGS', () => {
  it('has all required keys', () => {
    const requiredKeys: (keyof CrosswalkerSettings)[] = [
      'defaultOutputPath',
      'defaultKeyNamingStyle',
      'defaultArrayHandling',
      'defaultEmptyHandling',
      'defaultFrontmatterStyle',
      'linkSyntaxPreset',
      'customLinkNamespace',
      'enableConfigSuggestions',
      'configMatchThreshold',
      'enableDebugLog',
      'savedConfigs',
      'defaultEnrichment',
      'autoApplyExactMatch',
    ];

    for (const key of requiredKeys) {
      expect(DEFAULT_SETTINGS).toHaveProperty(key);
    }
  });

  it('stores new mapping sets as notes unless the user opts into tables', () => {
    expect(DEFAULT_SETTINGS.defaultMappingForm).toBe('notes');
  });

  it('starts with no vault-wide Connections defaults set (defers entirely to the preset)', () => {
    expect(DEFAULT_SETTINGS.defaultEnrichment).toEqual({});
  });

  it('does not auto-apply exact-match recognized recipes by default (the card always shows)', () => {
    expect(DEFAULT_SETTINGS.autoApplyExactMatch).toBe(false);
  });

  it('has sensible default output path', () => {
    expect(DEFAULT_SETTINGS.defaultOutputPath).toBe('Ontologies');
  });

  it('starts with empty saved configs', () => {
    expect(DEFAULT_SETTINGS.savedConfigs).toEqual([]);
  });

  it('has debug disabled by default', () => {
    expect(DEFAULT_SETTINGS.enableDebugLog).toBe(false);
    expect(DEFAULT_SETTINGS.verboseLogging).toBe(false);
  });

  it('has a standard (info) debug log level by default', () => {
    expect(DEFAULT_SETTINGS.debugLogLevel).toBe('info');
  });

  it('has config match threshold in valid range', () => {
    expect(DEFAULT_SETTINGS.configMatchThreshold).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SETTINGS.configMatchThreshold).toBeLessThanOrEqual(100);
  });

  it('has streaming threshold > 0', () => {
    expect(DEFAULT_SETTINGS.streamingThresholdMB).toBeGreaterThan(0);
  });
});
