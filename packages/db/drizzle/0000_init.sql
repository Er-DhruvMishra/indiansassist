CREATE TYPE "public"."actor_type" AS ENUM('user', 'desk', 'system');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_kind" AS ENUM('periodic', 'verify', 'export');--> statement-breakpoint
CREATE TYPE "public"."consent_state" AS ENUM('pending', 'granted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('enrolled', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."file_direction" AS ENUM('assist_to_desk', 'desk_to_assist');--> statement-breakpoint
CREATE TYPE "public"."integration_type" AS ENUM('zoho_desk', 'servicenow', 'jira', 'freshdesk');--> statement-breakpoint
CREATE TYPE "public"."package_tier" AS ENUM('p1_browser', 'p2_extension', 'p3_portable', 'p4_installed');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('assist', 'desk', 'supervisor');--> statement-breakpoint
CREATE TYPE "public"."recording_status" AS ENUM('uploading', 'stored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('in-mum', 'eu-fra', 'us-east');--> statement-breakpoint
CREATE TYPE "public"."session_end_reason" AS ENUM('denied', 'timeout', 'desk_left', 'desk_stopped', 'consent_revoked', 'assist_ended', 'token_revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."session_path" AS ENUM('unknown', 'p2p', 'relay');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('knocked', 'accepted', 'consent_pending', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('active', 'used', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."token_type" AS ENUM('one_time', 'timed', 'enrollment');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('technician', 'senior_technician', 'org_admin', 'auditor', 'observer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_checkpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "checkpoint_kind" NOT NULL,
	"seq" bigint NOT NULL,
	"tail" char(64) NOT NULL,
	"ts" timestamp (3) with time zone NOT NULL,
	"kid" text NOT NULL,
	"sig" text NOT NULL,
	"anchored_entry_id" uuid,
	"verify_ok" boolean,
	"verify_checked" bigint,
	"verify_failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"session_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"region" "region" NOT NULL,
	"ts" timestamp (3) with time zone NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"hash" char(64) NOT NULL,
	CONSTRAINT "audit_entry_hash_unique" UNIQUE("hash"),
	CONSTRAINT "audit_entry_org_seq_unique" UNIQUE("org_id","seq")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"region" "region" NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"status" "device_status" DEFAULT 'enrolled' NOT NULL,
	"group_name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enrolled_by_token_id" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "integration_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_org_type_unique" UNIQUE("org_id","type")
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" char(64) NOT NULL,
	"ip" text,
	"success" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"data_region" "region" NOT NULL,
	"plan_tier" "package_tier" DEFAULT 'p1_browser' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_pepper" char(64) NOT NULL,
	"sso_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_slug_unique" UNIQUE("slug"),
	CONSTRAINT "org_slug_format" CHECK (slug ~ '^[a-z0-9-]{3,40}$')
);
--> statement-breakpoint
CREATE TABLE "recording" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"status" "recording_status" DEFAULT 'uploading' NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text DEFAULT 'video/webm' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" char(64),
	"duration_ms" integer,
	"chained_into" uuid,
	"upload_id" text,
	"upload_expires_at" timestamp with time zone,
	"region" "region" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone,
	CONSTRAINT "recording_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "recording_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"assist_user_id" uuid NOT NULL,
	"desk_label" text,
	"desk_ref" text NOT NULL,
	"desk_user_agent" text,
	"resume_key_hash" char(64),
	"tier" "package_tier" NOT NULL,
	"state" "session_state" DEFAULT 'knocked' NOT NULL,
	"consent_state" "consent_state" DEFAULT 'pending' NOT NULL,
	"consent_surface" text,
	"path" "session_path" DEFAULT 'unknown' NOT NULL,
	"region" "region" NOT NULL,
	"node_id" text NOT NULL,
	"knocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"knock_expires_at" timestamp with time zone,
	"consent_deadline_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" "session_end_reason",
	"last_stats" jsonb,
	"recording_started" boolean DEFAULT false NOT NULL,
	"hash_chain_tail" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"direction" "file_direction" NOT NULL,
	"file_id" integer NOT NULL,
	"name" text NOT NULL,
	"bytes" bigint NOT NULL,
	"assist_sha256" char(64),
	"desk_sha256" char(64),
	"assist_entry_id" uuid,
	"desk_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_file_session_direction_file_unique" UNIQUE("session_id","direction","file_id")
);
--> statement-breakpoint
CREATE TABLE "session_participant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "participant_role" NOT NULL,
	"user_id" uuid,
	"label" text NOT NULL,
	"connection_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "technician_seat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" "package_tier" DEFAULT 'p1_browser' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_seat_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"tier" "package_tier" NOT NULL,
	"typ" "token_type" NOT NULL,
	"status" "token_status" DEFAULT 'active' NOT NULL,
	"short_code" char(12) NOT NULL,
	"label" text,
	"region" "region" NOT NULL,
	"kid" text NOT NULL,
	"signature" text NOT NULL,
	"nonce" text NOT NULL,
	"issued_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"denied_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"auth_provider" text DEFAULT 'local' NOT NULL,
	"auth_ref" text,
	"invite_token_hash" char(64),
	"invite_expires_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_checkpoint" ADD CONSTRAINT "audit_checkpoint_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_checkpoint" ADD CONSTRAINT "audit_checkpoint_anchored_entry_id_audit_entry_id_fk" FOREIGN KEY ("anchored_entry_id") REFERENCES "public"."audit_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_enrolled_by_token_id_token_id_fk" FOREIGN KEY ("enrolled_by_token_id") REFERENCES "public"."token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_chained_into_audit_entry_id_fk" FOREIGN KEY ("chained_into") REFERENCES "public"."audit_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_token_id_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_assist_user_id_user_id_fk" FOREIGN KEY ("assist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_assist_entry_id_audit_entry_id_fk" FOREIGN KEY ("assist_entry_id") REFERENCES "public"."audit_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_desk_entry_id_audit_entry_id_fk" FOREIGN KEY ("desk_entry_id") REFERENCES "public"."audit_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participant" ADD CONSTRAINT "session_participant_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participant" ADD CONSTRAINT "session_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_seat" ADD CONSTRAINT "technician_seat_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_seat" ADD CONSTRAINT "technician_seat_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token" ADD CONSTRAINT "token_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token" ADD CONSTRAINT "token_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token" ADD CONSTRAINT "token_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_checkpoint_org_seq_idx" ON "audit_checkpoint" USING btree ("org_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_entry_session_id_idx" ON "audit_entry" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "audit_entry_org_action_idx" ON "audit_entry" USING btree ("org_id","action");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_org_id_idx" ON "device" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "login_attempt_email_hash_idx" ON "login_attempt" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "recording_org_id_idx" ON "recording" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "session_org_created_idx" ON "session" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "session_token_id_idx" ON "session" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "session_assist_user_id_idx" ON "session" USING btree ("assist_user_id");--> statement-breakpoint
CREATE INDEX "session_org_state_idx" ON "session" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "session_participant_session_id_idx" ON "session_participant" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "technician_seat_org_id_idx" ON "technician_seat" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "token_org_id_idx" ON "token" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "token_created_by_idx" ON "token" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "token_org_status_idx" ON "token" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "token_expires_at_idx" ON "token" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_short_code_active_unique" ON "token" USING btree ("short_code") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "user_org_id_idx" ON "user" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_lower_unique" ON "user" USING btree (lower("email"));