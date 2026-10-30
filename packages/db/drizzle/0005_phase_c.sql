CREATE TYPE "public"."elevation_level" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."playbook_interpreter" AS ENUM('powershell', 'cmd', 'sh');--> statement-breakpoint
ALTER TYPE "public"."consent_level" ADD VALUE 'control';--> statement-breakpoint
ALTER TYPE "public"."consent_level" ADD VALUE 'elevated';--> statement-breakpoint
CREATE TABLE "elevation_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"op_id" char(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	"claimed_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "elevation_handover_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "playbook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"interpreter" "playbook_interpreter" NOT NULL,
	"body" text NOT NULL,
	"body_sha256" char(64) NOT NULL,
	"requires_elevation" boolean DEFAULT false NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timeout_sec" integer DEFAULT 120 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_org_name_unique" UNIQUE("org_id","name"),
	CONSTRAINT "playbook_timeout_range" CHECK (timeout_sec between 1 and 900),
	CONSTRAINT "playbook_body_size" CHECK (octet_length(body) between 1 and 65536)
);
--> statement-breakpoint
CREATE TABLE "playbook_run" (
	"run_id" char(32) PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"playbook_id" uuid NOT NULL,
	"body_sha256" char(64) NOT NULL,
	"op_id" char(16) NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"ran_as" text,
	"error" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "require_sas_confirm" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "consent_monitors" integer;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "consent_clipboard" boolean;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "elevation" "elevation_level";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "handover_hash" char(64);--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "handover_opid" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "handover_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevation_handover" ADD CONSTRAINT "elevation_handover_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elevation_handover" ADD CONSTRAINT "elevation_handover_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook" ADD CONSTRAINT "playbook_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook" ADD CONSTRAINT "playbook_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run" ADD CONSTRAINT "playbook_run_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run" ADD CONSTRAINT "playbook_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run" ADD CONSTRAINT "playbook_run_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "elevation_handover_session_idx" ON "elevation_handover" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "elevation_handover_org_created_idx" ON "elevation_handover" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playbook_org_updated_idx" ON "playbook" USING btree ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playbook_run_session_idx" ON "playbook_run" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "playbook_run_org_requested_idx" ON "playbook_run" USING btree ("org_id","requested_at" DESC NULLS LAST);