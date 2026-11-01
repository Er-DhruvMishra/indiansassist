/** The `schema` object of contracts section 4.3: every table, pgEnum and relation. */
import * as relations from './relations.js';
import * as tables from './tables.js';

export * from './tables.js';
export * from './relations.js';
export type { OrgBranding } from './org.js';

export const schema = { ...tables, ...relations };
export type Schema = typeof schema;

export type OrgRow = typeof tables.org.$inferSelect;
export type UserRow = typeof tables.user.$inferSelect;
export type NewUserRow = typeof tables.user.$inferInsert;
export type TechnicianSeatRow = typeof tables.technicianSeat.$inferSelect;
export type AuthSessionRow = typeof tables.authSession.$inferSelect;
export type LoginAttemptRow = typeof tables.loginAttempt.$inferSelect;
export type DeviceRow = typeof tables.device.$inferSelect;
export type TokenRow = typeof tables.token.$inferSelect;
export type NewTokenRow = typeof tables.token.$inferInsert;
export type SessionRow = typeof tables.session.$inferSelect;
export type NewSessionRow = typeof tables.session.$inferInsert;
export type SessionParticipantRow = typeof tables.sessionParticipant.$inferSelect;
export type SessionHostRow = typeof tables.sessionHost.$inferSelect;
export type SessionFileRow = typeof tables.sessionFile.$inferSelect;
export type AuditEntryRow = typeof tables.auditEntry.$inferSelect;
export type AuditCheckpointRow = typeof tables.auditCheckpoint.$inferSelect;
export type RecordingRow = typeof tables.recording.$inferSelect;
export type NewRecordingRow = typeof tables.recording.$inferInsert;
export type IntegrationRow = typeof tables.integration.$inferSelect;
export type PlaybookRow = typeof tables.playbook.$inferSelect;
export type NewPlaybookRow = typeof tables.playbook.$inferInsert;
export type PlaybookRunRow = typeof tables.playbookRun.$inferSelect;
export type ElevationHandoverRow = typeof tables.elevationHandover.$inferSelect;
export type NewDeviceRow = typeof tables.device.$inferInsert;
export type DeviceGroupRow = typeof tables.deviceGroup.$inferSelect;
export type DeviceActionRow = typeof tables.deviceAction.$inferSelect;
export type NewDeviceActionRow = typeof tables.deviceAction.$inferInsert;
export type WakeAttemptRow = typeof tables.wakeAttempt.$inferSelect;
export type AmtSolRow = typeof tables.amtSol.$inferSelect;
// Phase E (docs/specs/phase-e-contracts.md section 13.2)
export type SsoDomainRow = typeof tables.ssoDomain.$inferSelect;
export type SsoIdentityRow = typeof tables.ssoIdentity.$inferSelect;
export type SessionSummaryRow = typeof tables.sessionSummary.$inferSelect;
export type NewSessionSummaryRow = typeof tables.sessionSummary.$inferInsert;
export type TicketPushRow = typeof tables.ticketPush.$inferSelect;
export type NewTicketPushRow = typeof tables.ticketPush.$inferInsert;
