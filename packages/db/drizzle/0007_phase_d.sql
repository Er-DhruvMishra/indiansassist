CREATE TYPE "public"."device_action_kind" AS ENUM('playbook_run', 'file_push', 'print', 'message');--> statement-breakpoint
CREATE TYPE "public"."device_action_state" AS ENUM('queued', 'dispatched', 'awaiting_approval', 'running', 'done', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('windows', 'macos', 'linux');--> statement-breakpoint
CREATE TYPE "public"."tamper_state" AS ENUM('ok', 'alerted', 'suspected');--> statement-breakpoint
CREATE TYPE "public"."wake_method" AS ENUM('wol', 'amt', 'auto');--> statement-breakpoint
CREATE TYPE "public"."wake_state" AS ENUM('pending', 'dispatched', 'woke', 'failed');--> statement-breakpoint
ALTER TYPE "public"."actor_type" ADD VALUE 'device';--> statement-breakpoint
ALTER TYPE "public"."device_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TYPE "public"."device_status" ADD VALUE 'retired';--> statement-breakpoint
ALTER TYPE "public"."device_status" ADD VALUE 'deregistered';--> statement-breakpoint
ALTER TYPE "public"."session_end_reason" ADD VALUE 'consent_required';--> statement-breakpoint
ALTER TYPE "public"."session_end_reason" ADD VALUE 'policy_timeout';--> statement-breakpoint
ALTER TYPE "public"."session_end_reason" ADD VALUE 'device_disabled';--> statement-breakpoint
CREATE TABLE "amt_sol" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"via_device_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"transcript_ref" text,
	"transcript_sha256" char(64)
);
--> statement-breakpoint
CREATE TABLE "device_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" "device_action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "device_action_state" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"approved_by" text,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_email" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_group_org_name_unique" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "wake_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"method" "wake_method" NOT NULL,
	"via" text,
	"state" "wake_state" DEFAULT 'pending' NOT NULL,
	"cause" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "token_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "region" "region" NOT NULL;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "platform" "device_platform" DEFAULT 'windows' NOT NULL;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "kex_public_key" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "os_version" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "service_version" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "arch" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "hw_fingerprint" char(64);--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "last_ip" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "unattended_policy" jsonb;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "interactive" jsonb;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "lan_segment" jsonb;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "mac_enc" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "mac_hash" char(64);--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "amt" jsonb;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "tamper_state" "tamper_state" DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "notify_email" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "rotation_nonce" text;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "waker_mesh_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "fleet_scoping_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "unattended_policy" jsonb DEFAULT '{"mode":"approval_only","requireLocalApprovalWhenPresent":true,"autoAllowAfterSec":null,"allowedHours":null,"recordingRequired":true,"allowLogonScreen":false,"allowSecureDesktop":false,"allowPrivileged":true,"allowInputLock":false,"allowPrivacyScreen":false,"allowAmtSol":false,"allowAmtBootRedirect":false,"notifyLocalUser":true,"maxUnattendedMinutes":120}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook" ADD COLUMN "vault_refs" jsonb;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "unattended" boolean;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "unattended_policy" jsonb;--> statement-breakpoint
ALTER TABLE "token" ADD COLUMN "max_devices" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "token" ADD COLUMN "devices_enrolled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "device_group_ids" uuid[];--> statement-breakpoint
ALTER TABLE "amt_sol" ADD CONSTRAINT "amt_sol_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amt_sol" ADD CONSTRAINT "amt_sol_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amt_sol" ADD CONSTRAINT "amt_sol_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_action" ADD CONSTRAINT "device_action_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_action" ADD CONSTRAINT "device_action_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_action" ADD CONSTRAINT "device_action_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_group" ADD CONSTRAINT "device_group_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_group" ADD CONSTRAINT "device_group_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_attempt" ADD CONSTRAINT "wake_attempt_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_attempt" ADD CONSTRAINT "wake_attempt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_attempt" ADD CONSTRAINT "wake_attempt_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amt_sol_org_id_idx" ON "amt_sol" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "amt_sol_device_idx" ON "amt_sol" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "device_action_org_id_idx" ON "device_action" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "device_action_device_state_idx" ON "device_action" USING btree ("device_id","state");--> statement-breakpoint
CREATE INDEX "device_action_expires_idx" ON "device_action" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_group_org_id_idx" ON "device_group" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wake_attempt_org_id_idx" ON "wake_attempt" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wake_attempt_device_state_idx" ON "wake_attempt" USING btree ("device_id","state");--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_group_id_device_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."device_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_org_status_idx" ON "device" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "device_org_group_idx" ON "device" USING btree ("org_id","group_id");--> statement-breakpoint
CREATE INDEX "device_lan_subnet_idx" ON "device" USING btree (("lan_segment"->>'subnetHash'));--> statement-breakpoint
CREATE INDEX "device_org_mac_hash_idx" ON "device" USING btree ("org_id","mac_hash");--> statement-breakpoint
CREATE INDEX "session_device_id_idx" ON "session" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_device_open_unique" ON "session" USING btree ("device_id") WHERE state <> 'ended' and device_id is not null;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_token_or_device" CHECK (token_id is not null or device_id is not null);--> statement-breakpoint
ALTER TABLE "token" ADD CONSTRAINT "token_max_devices_range" CHECK (max_devices between 1 and 10000);--> statement-breakpoint
ALTER TABLE "token" ADD CONSTRAINT "token_devices_enrolled_cap" CHECK (devices_enrolled between 0 and max_devices);