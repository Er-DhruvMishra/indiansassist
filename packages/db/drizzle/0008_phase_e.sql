-- Phase E (docs/specs/phase-e-contracts.md section 13.2, rule 12.1). Additive: every new column has a default or is
-- nullable. ALTER TYPE integration_type ADD VALUE 'webhook' runs in the migration transaction, so nothing in this
-- file (no default, check, insert or index predicate) refers to 'webhook'; the new CREATE TYPE enums are unaffected.
CREATE TYPE "public"."ai_provider" AS ENUM('none', 'local', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."sso_domain_status" AS ENUM('pending', 'verified', 'lapsed');--> statement-breakpoint
CREATE TYPE "public"."sso_protocol" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TYPE "public"."summary_state" AS ENUM('pending', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."summary_trigger" AS ENUM('session_end', 'on_demand', 'edit');--> statement-breakpoint
CREATE TYPE "public"."ticket_push_mode" AS ENUM('create', 'append');--> statement-breakpoint
CREATE TYPE "public"."ticket_push_state" AS ENUM('pending', 'delivered', 'retrying', 'failed');--> statement-breakpoint
ALTER TYPE "public"."integration_type" ADD VALUE 'webhook';--> statement-breakpoint
CREATE TABLE "session_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" "summary_state" NOT NULL,
	"trigger" "summary_trigger" NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"served_model" text,
	"inference_geo" text,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"transcript_included" boolean DEFAULT false NOT NULL,
	"normalised" boolean DEFAULT false NOT NULL,
	"input_sha256" char(64),
	"output" jsonb,
	"output_sha256" char(64),
	"redaction_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb,
	"cause" text,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"base_version" integer,
	"created_by" uuid,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "session_summary_session_version_unique" UNIQUE("session_id","version")
);
--> statement-breakpoint
CREATE TABLE "sso_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" "sso_domain_status" DEFAULT 'pending' NOT NULL,
	"verify_token" char(32) NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"misses" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_domain_org_domain_unique" UNIQUE("org_id","domain")
);
--> statement-breakpoint
CREATE TABLE "sso_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"protocol" "sso_protocol" NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "sso_identity_org_protocol_issuer_subject_unique" UNIQUE("org_id","protocol","issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "ticket_push" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"type" "integration_type" NOT NULL,
	"mode" "ticket_push_mode" NOT NULL,
	"external_id_in" text,
	"source" text NOT NULL,
	"summary_id" uuid,
	"summary_version" integer,
	"content" jsonb NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"state" "ticket_push_state" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"manual_retries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"external_id" text,
	"external_url" text,
	"last_failure" jsonb,
	"client_push_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_push_org_client_push_unique" UNIQUE("org_id","client_push_id"),
	CONSTRAINT "ticket_push_source_check" CHECK (source in ('summary', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "login_method" text;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "credentials_enc" text;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "credentials_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "credentials_fp" char(8);--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "last_test" jsonb;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_secret_enc" text;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_secret_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_secret_fp" char(8);--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_sp_key_enc" text;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_sp_key_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_sp_key_fp" char(8);--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_sp_cert" text;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "sso_last_test" jsonb;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "ai_policy" jsonb DEFAULT '{"provider":"none","autoSummarize":false,"includeTranscript":false,"anthropicAck":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "sso_break_glass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_summary" ADD CONSTRAINT "session_summary_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summary" ADD CONSTRAINT "session_summary_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summary" ADD CONSTRAINT "session_summary_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summary" ADD CONSTRAINT "session_summary_edited_by_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domain" ADD CONSTRAINT "sso_domain_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domain" ADD CONSTRAINT "sso_domain_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identity" ADD CONSTRAINT "sso_identity_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identity" ADD CONSTRAINT "sso_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_push" ADD CONSTRAINT "ticket_push_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_push" ADD CONSTRAINT "ticket_push_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_push" ADD CONSTRAINT "ticket_push_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_push" ADD CONSTRAINT "ticket_push_summary_id_session_summary_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."session_summary"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_push" ADD CONSTRAINT "ticket_push_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_summary_org_id_idx" ON "session_summary" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "session_summary_due_idx" ON "session_summary" USING btree ("next_attempt_at") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "sso_domain_org_id_idx" ON "sso_domain" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domain_verified_unique" ON "sso_domain" USING btree ("domain") WHERE status = 'verified';--> statement-breakpoint
CREATE INDEX "sso_identity_user_id_idx" ON "sso_identity" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_push_org_id_idx" ON "ticket_push" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ticket_push_session_id_idx" ON "ticket_push" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ticket_push_due_idx" ON "ticket_push" USING btree ("next_attempt_at") WHERE state = 'retrying';--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_login_method_check" CHECK (login_method is null or login_method in ('local', 'invite', 'oidc', 'saml'));