CREATE TYPE "public"."consent_level" AS ENUM('view', 'tab_control', 'in_page', 'deep_control');--> statement-breakpoint
CREATE TYPE "public"."mirror_scope" AS ENUM('current_tab', 'all_tabs');--> statement-breakpoint
CREATE TABLE "session_host" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"host_hash" char(64) NOT NULL,
	"host" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_host_session_hash_unique" UNIQUE("session_id","host_hash")
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "extension_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "recording_retention_days" integer;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "consent_level" "consent_level";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "consent_scope" "mirror_scope";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "consent_backstage" boolean;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "desk_client" jsonb;--> statement-breakpoint
ALTER TABLE "session_host" ADD CONSTRAINT "session_host_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_host" ADD CONSTRAINT "session_host_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_recording_retention_days_range" CHECK (recording_retention_days is null or recording_retention_days between 1 and 3650);