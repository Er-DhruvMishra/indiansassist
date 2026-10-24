CREATE TYPE "public"."recording_mode" AS ENUM('off', 'assist_only', 'server', 'both');--> statement-breakpoint
CREATE TYPE "public"."recording_source" AS ENUM('assist', 'server');--> statement-breakpoint
ALTER TYPE "public"."participant_role" ADD VALUE 'recorder';--> statement-breakpoint
ALTER TABLE "recording" DROP CONSTRAINT "recording_session_id_unique";--> statement-breakpoint
ALTER TABLE "recording" ALTER COLUMN "uploaded_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "recording_mode" "recording_mode" DEFAULT 'assist_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "recorded_by" "recording_source" DEFAULT 'assist' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "recording_mode" "recording_mode";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "server_recording" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_session_source_unique" UNIQUE("session_id","recorded_by");--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_uploader_present" CHECK (recorded_by = 'server' or uploaded_by is not null);