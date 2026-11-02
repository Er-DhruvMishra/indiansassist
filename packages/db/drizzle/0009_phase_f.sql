-- Phase F (docs/specs/phase-f-contracts.md section 13.2, the E rule 12.1). Additive except org.audit_pepper, which
-- drops NOT NULL so an erasure can destroy it (the org_pepper_erased check ties it to erased_at). The three
-- ALTER TYPE ... ADD VALUE statements run in the migration transaction, so nothing in this file (no default, check,
-- insert or index predicate) refers to 'camera', 'zsh' or 'org_erased'; the new erasure_state type is unaffected.
-- user.role_since is added with DEFAULT now() and backfilled to created_at (no role history is invented);
-- recording_session_source_unique gains camera_id with NULLS NOT DISTINCT, so every Desk recording (camera_id
-- null) keeps the A.2 one-per-session-per-recorder rule and each phone camera gets its own recording.
CREATE TYPE "public"."erasure_state" AS ENUM('pending_confirmation', 'pending_approval', 'cooling_off', 'executing', 'completed', 'cancelled', 'expired');--> statement-breakpoint
ALTER TYPE "public"."participant_role" ADD VALUE 'camera';--> statement-breakpoint
ALTER TYPE "public"."playbook_interpreter" ADD VALUE 'zsh';--> statement-breakpoint
ALTER TYPE "public"."session_end_reason" ADD VALUE 'org_erased';--> statement-breakpoint
CREATE TABLE "org_erasure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"state" "erasure_state" NOT NULL,
	"solo" boolean DEFAULT false NOT NULL,
	"confirm_token_hash" char(64),
	"confirm_expires_at" timestamp with time zone,
	"reason" text,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cooling_off_until" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb,
	"certificate" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"superseded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "recording" DROP CONSTRAINT "recording_session_source_unique";--> statement-breakpoint
ALTER TABLE "org" ALTER COLUMN "audit_pepper" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "erasing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "source" text DEFAULT 'desk' NOT NULL;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "camera_id" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "invite_mailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "user" SET "role_since" = "created_at";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role_granted_by" uuid;--> statement-breakpoint
ALTER TABLE "org_erasure" ADD CONSTRAINT "org_erasure_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_erasure" ADD CONSTRAINT "org_erasure_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_erasure" ADD CONSTRAINT "org_erasure_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_erasure" ADD CONSTRAINT "org_erasure_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset" ADD CONSTRAINT "password_reset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_erasure_org_id_idx" ON "org_erasure" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_erasure_open_unique" ON "org_erasure" USING btree ("org_id") WHERE state in ('pending_confirmation', 'pending_approval', 'cooling_off', 'executing');--> statement-breakpoint
CREATE INDEX "org_erasure_due_idx" ON "org_erasure" USING btree ("state","cooling_off_until");--> statement-breakpoint
CREATE INDEX "password_reset_user_id_idx" ON "password_reset" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_granted_by_user_id_fk" FOREIGN KEY ("role_granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_session_source_unique" UNIQUE NULLS NOT DISTINCT("session_id","recorded_by","camera_id");--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_pepper_erased" CHECK ((audit_pepper is null) = (erased_at is not null));--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_source_check" CHECK (source in ('desk', 'camera'));--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_camera_id_present" CHECK ((source = 'camera') = (camera_id is not null));