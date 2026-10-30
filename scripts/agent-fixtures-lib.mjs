/**
 * Pure builders of the Phase C cross-language name fixtures (no I/O). Used by scripts/gen-agent-fixtures.mjs and by
 * packages/shared test/agent-names.test.ts, which passes the shared source exports so the fixture cannot drift.
 */
export function agentNames(shared) {
  return {
    v: 1,
    description:
      'Phase C wire names generated from @indiansassist/shared by scripts/gen-agent-fixtures.mjs. Asserted by packages/shared test/agent-names.test.ts, agent ia-core tests/shared_vectors.rs and apps/android HelpersParityTest.',
    agentConsentLevels: shared.AGENT_CONSENT_LEVELS,
    elevationLevels: shared.ELEVATION_LEVELS,
    agentFeatures: shared.AGENT_FEATURES,
    videoEncoders: shared.VIDEO_ENCODERS,
    qualityPresets: shared.QUALITY_PRESETS,
    tokenSources: shared.TOKEN_SOURCES,
    playbookInterpreters: shared.PLAYBOOK_INTERPRETERS,
    playbookErrors: shared.PLAYBOOK_ERRORS,
    elevationDenyCauses: shared.ELEVATION_DENY_CAUSES,
    elevationFailErrors: shared.ELEVATION_FAIL_ERRORS,
    navActions: shared.NAV_ACTIONS,
    capturePaths: shared.CAPTURE_PATHS,
    secFailReasons: shared.SEC_FAIL_REASONS,
    p3DataChannelLabels: shared.P3_DATA_CHANNEL_LABELS,
    secEncryptedLabels: shared.SEC_ENCRYPTED_LABELS,
    secLabelIds: shared.SEC_LABEL_IDS,
    agentControlOps: shared.AGENT_CONTROL_OPS,
    agentMinLevels: Object.fromEntries(shared.AGENT_CONTROL_OPS.map((op) => [op, shared.agentMinLevelFor(op)])),
    agentControlErrorCodes: shared.AGENT_CONTROL_ERROR_CODES,
    agentControlEventKinds: shared.AGENT_CONTROL_EVENT_KINDS,
    wsCloseHandedOver: shared.WS_CLOSE.handedOver,
    androidCapabilities: shared.ANDROID_CAPABILITIES,
    limits: Object.fromEntries(
      [
        'secHandshakeTimeoutMs',
        'secFrameMaxBytes',
        'downloadGrantTtlSec',
        'downloadGrantMaxUses',
        'handoverTtlSec',
        'handoverMintsPer10Min',
        'iaconfigMaxBytes',
        'clipboardMaxBytes',
        'agentMaxKbps',
        'agentStatsIntervalMs',
        'pointerMovesPerSecNative',
        'textCharsPerSec',
        'textQueueMaxUnits',
        'textBurstChars',
        'playbookBodyMaxBytes',
        'playbookTimeoutMaxSec',
        'playbookOutputMaxBytes',
        'playbookCatalogueMax',
        'playbookManifestMaxBytes',
        'playbookParamsMax',
        'fileMaxBytesNative',
        'monitorsMax',
      ].map((k) => [k, shared.LIMITS[k]]),
    ),
  };
}

export function fileLists(shared) {
  return {
    v: 1,
    description:
      'Phase C section 6.1 F3/F4 file lists, generated from @indiansassist/shared files.ts. packages/shared test/agent-sec.test.ts asserts this file equals the exported lists; agent ia-core tests/shared_vectors.rs asserts the Rust constants equal it.',
    executableExtensions: shared.EXECUTABLE_EXTENSIONS,
    passiveRiskExtensions: shared.PASSIVE_RISK_EXTENSIONS,
    reservedDeviceStems: shared.RESERVED_DEVICE_STEMS,
  };
}
