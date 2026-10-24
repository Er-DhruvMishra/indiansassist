/**
 * Postgres enums (contracts section 4.1). Values are imported from @indiansassist/shared so the database and
 * the wire can never drift; pgEnum names are the snake_case names of section 4.1.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  CHECKPOINT_KINDS,
  CONSENT_LEVELS,
  CONSENT_STATES,
  MIRROR_SCOPES,
  DEVICE_STATUSES,
  FILE_DIRECTIONS,
  INTEGRATION_TYPES,
  PACKAGE_TIERS,
  PARTICIPANT_ROLES,
  RECORDING_MODES,
  RECORDING_SOURCES,
  RECORDING_STATUSES,
  REGIONS,
  SESSION_END_REASONS,
  SESSION_PATHS,
  SESSION_STATES,
  TOKEN_STATUSES,
  TOKEN_TYPES,
  USER_ROLES,
  USER_STATUSES,
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
export const consentLevelEnum = pgEnum('consent_level', CONSENT_LEVELS);
export const mirrorScopeEnum = pgEnum('mirror_scope', MIRROR_SCOPES);
// Phase A.2 (docs/specs/phase-a2-recorder.md section 9)
export const recordingModeEnum = pgEnum('recording_mode', RECORDING_MODES);
export const recordingSourceEnum = pgEnum('recording_source', RECORDING_SOURCES);
