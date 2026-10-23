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
export type SessionFileRow = typeof tables.sessionFile.$inferSelect;
export type AuditEntryRow = typeof tables.auditEntry.$inferSelect;
export type AuditCheckpointRow = typeof tables.auditCheckpoint.$inferSelect;
export type RecordingRow = typeof tables.recording.$inferSelect;
export type NewRecordingRow = typeof tables.recording.$inferInsert;
export type IntegrationRow = typeof tables.integration.$inferSelect;
