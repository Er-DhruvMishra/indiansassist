-- Custom SQL migration (drizzle-kit generate --custom --name append_only).
-- Contracts section 4.2: audit_entry and audit_checkpoint are append-only; section 1.2 R1: org.data_region is immutable.
-- Triggers are a speed bump against the application role, not against a superuser; signed checkpoints (5.6) are the
-- tamper evidence. REVOKE of UPDATE / DELETE / TRUNCATE for DB_APP_ROLE runs from migrate() at runtime (env dependent).
CREATE OR REPLACE FUNCTION audit_entry_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_entry is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
-- The single permitted UPDATE on audit_checkpoint: setting anchored_entry_id once, from NULL, with every other
-- column unchanged (section 5.6 C1 writes the checkpoint, then the audit.anchored entry, then links them).
CREATE OR REPLACE FUNCTION audit_checkpoint_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.anchored_entry_id IS NULL
     AND NEW.anchored_entry_id IS NOT NULL
     AND (NEW.id, NEW.org_id, NEW.kind, NEW.seq, NEW.tail, NEW.ts, NEW.kid, NEW.sig,
          NEW.verify_ok, NEW.verify_checked, NEW.verify_failure, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.org_id, OLD.kind, OLD.seq, OLD.tail, OLD.ts, OLD.kid, OLD.sig,
          OLD.verify_ok, OLD.verify_checked, OLD.verify_failure, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_checkpoint is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_entry_immutable
  BEFORE UPDATE OR DELETE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION audit_entry_block();
--> statement-breakpoint
CREATE TRIGGER audit_entry_no_truncate
  BEFORE TRUNCATE ON audit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entry_block();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoint_immutable
  BEFORE UPDATE OR DELETE ON audit_checkpoint
  FOR EACH ROW EXECUTE FUNCTION audit_checkpoint_block();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoint_no_truncate
  BEFORE TRUNCATE ON audit_checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION audit_checkpoint_block();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_region_immutable_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'data_region is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER org_region_immutable
  BEFORE UPDATE ON org
  FOR EACH ROW EXECUTE FUNCTION org_region_immutable_fn();
