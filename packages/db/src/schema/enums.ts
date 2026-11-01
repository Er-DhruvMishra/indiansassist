/**
 * Postgres enums (contracts section 4.1). Values are imported from @indiansassist/shared so the database and
 * the wire can never drift; pgEnum names are the snake_case names of section 4.1.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  AI_PROVIDERS,
  SSO_DOMAIN_STATUSES,
  SSO_PROTOCOLS,
  SUMMARY_STATES,
  SUMMARY_TRIGGERS,
  TICKET_PUSH_MODES,
  TICKET_PUSH_STATES,
  CHECKPOINT_KINDS,
  CONSENT_STATES,
  DEVICE_ACTION_KINDS,
  DEVICE_ACTION_STATES,
  DEVICE_PLATFORMS,
  ELEVATION_LEVELS,
  MIRROR_SCOPES,
  DEVICE_STATUSES,
  FILE_DIRECTIONS,
  INTEGRATION_TYPES,
  PACKAGE_TIERS,
  PARTICIPANT_ROLES,
  PLAYBOOK_INTERPRETERS,
  RECORDING_MODES,
  RECORDING_SOURCES,
  RECORDING_STATUSES,
  REGIONS,
  SESSION_END_REASONS,
  SESSION_PATHS,
  SESSION_STATES,
  STORED_CONSENT_LEVELS,
  TAMPER_STATES,
  TOKEN_STATUSES,
  TOKEN_TYPES,
  USER_ROLES,
  USER_STATUSES,
  WAKE_METHODS,
  WAKE_STATES,
} from '@indiansassist/shared';

export const regionEnum = pgEnum('region', REGIONS);
export const packageTierEnum = pgEnum('package_tier', PACKAGE_TIERS);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const userStatusEnum = pgEnum('user_status', USER_STATUSES);
export const tokenTypeEnum = pgEnum('token_type', TOKEN_TYPES);
export const tokenStatusEnum = pgEnum('token_status', TOKEN_STATUSES);
export const sessionStateEnum = pgEnum('session_state', SESSION_STATES);
export const consentStateEnum = pgEnum('consent_state', CONSENT_STATES);
export const sessionPathEnum = pgEnum('session_path', SESSION_PATHS);
export const sessionEndReasonEnum = pgEnum('session_end_reason', SESSION_END_REASONS);
export const participantRoleEnum = pgEnum('participant_role', PARTICIPANT_ROLES);
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES);
export const recordingStatusEnum = pgEnum('recording_status', RECORDING_STATUSES);
export const fileDirectionEnum = pgEnum('file_direction', FILE_DIRECTIONS);
export const checkpointKindEnum = pgEnum('checkpoint_kind', CHECKPOINT_KINDS);
export const integrationTypeEnum = pgEnum('integration_type', INTEGRATION_TYPES);
export const deviceStatusEnum = pgEnum('device_status', DEVICE_STATUSES);
// Phase B (docs/specs/phase-b-contracts.md section 11.1)
// Phase C section 13.2: one enum for both families (P2 levels plus `control`, `elevated`), read via consentLevelFamily.
export const consentLevelEnum = pgEnum('consent_level', STORED_CONSENT_LEVELS);
export const mirrorScopeEnum = pgEnum('mirror_scope', MIRROR_SCOPES);
// Phase A.2 (docs/specs/phase-a2-recorder.md section 9)
export const recordingModeEnum = pgEnum('recording_mode', RECORDING_MODES);
export const recordingSourceEnum = pgEnum('recording_source', RECORDING_SOURCES);
// Phase C (docs/specs/phase-c-contracts.md section 13.2)
export const playbookInterpreterEnum = pgEnum('playbook_interpreter', PLAYBOOK_INTERPRETERS);
export const elevationLevelEnum = pgEnum('elevation_level', ELEVATION_LEVELS);
// Phase D (docs/specs/phase-d-contracts.md section 13.2)
export const devicePlatformEnum = pgEnum('device_platform', DEVICE_PLATFORMS);
export const deviceActionKindEnum = pgEnum('device_action_kind', DEVICE_ACTION_KINDS);
export const deviceActionStateEnum = pgEnum('device_action_state', DEVICE_ACTION_STATES);
export const wakeMethodEnum = pgEnum('wake_method', WAKE_METHODS);
export const wakeStateEnum = pgEnum('wake_state', WAKE_STATES);
export const tamperStateEnum = pgEnum('tamper_state', TAMPER_STATES);
// Phase E (docs/specs/phase-e-contracts.md section 13.2; `integration_type` gains `webhook` through INTEGRATION_TYPES)
export const ssoProtocolEnum = pgEnum('sso_protocol', SSO_PROTOCOLS);
export const ssoDomainStatusEnum = pgEnum('sso_domain_status', SSO_DOMAIN_STATUSES);
export const ticketPushStateEnum = pgEnum('ticket_push_state', TICKET_PUSH_STATES);
export const ticketPushModeEnum = pgEnum('ticket_push_mode', TICKET_PUSH_MODES);
export const summaryStateEnum = pgEnum('summary_state', SUMMARY_STATES);
export const summaryTriggerEnum = pgEnum('summary_trigger', SUMMARY_TRIGGERS);
export const aiProviderEnum = pgEnum('ai_provider', AI_PROVIDERS);
