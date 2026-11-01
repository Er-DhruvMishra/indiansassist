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
    // Phase E (docs/specs/phase-e-contracts.md sections 7.4, 7.6, 13.1): the Linux platform, capture causes and
    // the inner-binary filename grammar.
    agentPlatforms: shared.AGENT_PLATFORMS,
    captureCauses: shared.CAPTURE_CAUSES,
    linuxFileNames: linuxFileNameVectors(shared),
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

/** Appends the Luhn check digit to 11 digits (the desk-code rule of Phase C section 2.3). */
function withLuhn(base11) {
  let sum = 0;
  for (let i = 0; i < base11.length; i++) {
    let d = base11.charCodeAt(base11.length - 1 - i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return base11 + String((10 - (sum % 10)) % 10);
}

/** Phase E section 7.6 vectors: each name with what `parseAgentLinuxFileName` returns for it (null = refused). */
function linuxFileNameVectors(shared) {
  const a = withLuhn('48219365771');
  const b = withLuhn('10000000000');
  const c = withLuhn('99999999999');
  const bad = a.slice(0, 11) + String((Number(a[11]) + 1) % 10);
  const names = [
    shared.agentLinuxFileName('in-mum', a),
    shared.agentLinuxFileName('eu-fra', b),
    shared.agentLinuxFileName('us-east', c),
    `IndiansAssist-in-mum-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}.exe`,
    `IndiansAssist-in-mum-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)} (1)`,
    `IndiansAssist-in-mum-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}.tar.gz`,
    `IndiansAssist-IN-MUM-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}`,
    `indiansassist-in-mum-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}`,
    `IndiansAssist-xx-abc-${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}`,
    `IndiansAssist-in-mum-${bad.slice(0, 4)}-${bad.slice(4, 8)}-${bad.slice(8)}`,
  ];
  return names.map((name) => ({ name, parsed: shared.parseAgentLinuxFileName(name) }));
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
