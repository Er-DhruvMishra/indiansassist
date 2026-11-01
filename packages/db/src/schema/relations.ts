/** Drizzle relational-query metadata (`db.query.*`). No SQL is generated from this file. */
import { relations } from 'drizzle-orm';
import { auditCheckpoint, auditEntry } from './audit.js';
import { sessionFile } from './files.js';
import { authSession, org, technicianSeat, user } from './org.js';
import { integration, recording } from './recording.js';
import { session, sessionHost, sessionParticipant } from './session.js';
import { device, deviceGroup, token } from './token.js';

export const orgRelations = relations(org, ({ many }) => ({
  users: many(user),
  seats: many(technicianSeat),
  tokens: many(token),
  sessions: many(session),
  auditEntries: many(auditEntry),
  auditCheckpoints: many(auditCheckpoint),
  recordings: many(recording),
  devices: many(device),
  integrations: many(integration),
}));

export const userRelations = relations(user, ({ one, many }) => ({
  org: one(org, { fields: [user.orgId], references: [org.id] }),
  seat: one(technicianSeat, { fields: [user.id], references: [technicianSeat.userId] }),
  authSessions: many(authSession),
  tokens: many(token, { relationName: 'token_creator' }),
  assistedSessions: many(session),
}));

export const technicianSeatRelations = relations(technicianSeat, ({ one }) => ({
  org: one(org, { fields: [technicianSeat.orgId], references: [org.id] }),
  user: one(user, { fields: [technicianSeat.userId], references: [user.id] }),
}));

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(user, { fields: [authSession.userId], references: [user.id] }),
}));

export const tokenRelations = relations(token, ({ one, many }) => ({
  org: one(org, { fields: [token.orgId], references: [org.id] }),
  creator: one(user, { fields: [token.createdBy], references: [user.id], relationName: 'token_creator' }),
  sessions: many(session),
}));

export const deviceRelations = relations(device, ({ one }) => ({
  org: one(org, { fields: [device.orgId], references: [org.id] }),
  enrolledByToken: one(token, { fields: [device.enrolledByTokenId], references: [token.id] }),
  group: one(deviceGroup, { fields: [device.groupId], references: [deviceGroup.id] }),
}));

export const deviceGroupRelations = relations(deviceGroup, ({ one, many }) => ({
  org: one(org, { fields: [deviceGroup.orgId], references: [org.id] }),
  devices: many(device),
}));

export const sessionRelations = relations(session, ({ one, many }) => ({
  org: one(org, { fields: [session.orgId], references: [org.id] }),
  token: one(token, { fields: [session.tokenId], references: [token.id] }),
  assist: one(user, { fields: [session.assistUserId], references: [user.id] }),
  participants: many(sessionParticipant),
  files: many(sessionFile),
  hosts: many(sessionHost),
  auditEntries: many(auditEntry),
  recording: one(recording, { fields: [session.id], references: [recording.sessionId] }),
}));

export const sessionParticipantRelations = relations(sessionParticipant, ({ one }) => ({
  session: one(session, { fields: [sessionParticipant.sessionId], references: [session.id] }),
  user: one(user, { fields: [sessionParticipant.userId], references: [user.id] }),
}));

export const sessionFileRelations = relations(sessionFile, ({ one }) => ({
  session: one(session, { fields: [sessionFile.sessionId], references: [session.id] }),
}));

export const auditEntryRelations = relations(auditEntry, ({ one }) => ({
  org: one(org, { fields: [auditEntry.orgId], references: [org.id] }),
  session: one(session, { fields: [auditEntry.sessionId], references: [session.id] }),
}));

export const auditCheckpointRelations = relations(auditCheckpoint, ({ one }) => ({
  org: one(org, { fields: [auditCheckpoint.orgId], references: [org.id] }),
  anchoredEntry: one(auditEntry, { fields: [auditCheckpoint.anchoredEntryId], references: [auditEntry.id] }),
}));

export const recordingRelations = relations(recording, ({ one }) => ({
  org: one(org, { fields: [recording.orgId], references: [org.id] }),
  session: one(session, { fields: [recording.sessionId], references: [session.id] }),
  uploader: one(user, { fields: [recording.uploadedBy], references: [user.id] }),
}));

export const integrationRelations = relations(integration, ({ one }) => ({
  org: one(org, { fields: [integration.orgId], references: [org.id] }),
}));

export const sessionHostRelations = relations(sessionHost, ({ one }) => ({
  session: one(session, { fields: [sessionHost.sessionId], references: [session.id] }),
  org: one(org, { fields: [sessionHost.orgId], references: [org.id] }),
}));
