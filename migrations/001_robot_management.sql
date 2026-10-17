-- Additive, separately namespaced tables. Run manually against the chosen database.
BEGIN;
CREATE TABLE IF NOT EXISTS public.robot_workspaces (id text PRIMARY KEY, payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'));
CREATE TABLE IF NOT EXISTS public.robot_workspace_members (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.robot_workspaces(id),
 user_id text NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin','viewer')), payload jsonb NOT NULL,
 UNIQUE(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.robot_devices (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.robot_workspaces(id),
 mac text NOT NULL CHECK(mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'), paired boolean NOT NULL DEFAULT false,
 payload jsonb NOT NULL, UNIQUE(id,workspace_id)
);
-- A pending MAC claim does not reserve hardware. Only successful proof is unique.
CREATE UNIQUE INDEX IF NOT EXISTS robot_devices_paired_mac ON public.robot_devices(mac) WHERE paired;
CREATE INDEX IF NOT EXISTS robot_devices_workspace ON public.robot_devices(workspace_id);
CREATE TABLE IF NOT EXISTS public.robot_character_templates (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.robot_workspaces(id), payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.robot_conversation_sessions (id text PRIMARY KEY, workspace_id text NOT NULL, device_id text NOT NULL, payload jsonb NOT NULL, FOREIGN KEY(device_id,workspace_id) REFERENCES public.robot_devices(id,workspace_id));
CREATE INDEX IF NOT EXISTS robot_sessions_device ON public.robot_conversation_sessions(workspace_id,device_id);
CREATE TABLE IF NOT EXISTS public.robot_audit_logs (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.robot_workspaces(id), payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.robot_bootstrap_identities (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.robot_pairing_requests (id text PRIMARY KEY, workspace_id text NOT NULL, device_id text NOT NULL, payload jsonb NOT NULL, FOREIGN KEY(device_id,workspace_id) REFERENCES public.robot_devices(id,workspace_id));
CREATE TABLE IF NOT EXISTS public.robot_device_credentials (id text PRIMARY KEY, workspace_id text NOT NULL, device_id text NOT NULL, payload jsonb NOT NULL, FOREIGN KEY(device_id,workspace_id) REFERENCES public.robot_devices(id,workspace_id));
CREATE TABLE IF NOT EXISTS public.robot_ingestion_jobs (id text PRIMARY KEY, workspace_id text NOT NULL, device_id text NOT NULL, payload jsonb NOT NULL, FOREIGN KEY(device_id,workspace_id) REFERENCES public.robot_devices(id,workspace_id));
CREATE TABLE IF NOT EXISTS public.robot_vector_stores (id text PRIMARY KEY, workspace_id text NOT NULL, device_id text NOT NULL UNIQUE, payload jsonb NOT NULL, FOREIGN KEY(device_id,workspace_id) REFERENCES public.robot_devices(id,workspace_id));
CREATE TABLE IF NOT EXISTS public.robot_rate_limits (id text PRIMARY KEY, payload jsonb NOT NULL);

-- No anonymous or authenticated client writes. The server uses a dedicated DB
-- role and performs membership checks before loading workspace information.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['robot_workspaces','robot_workspace_members','robot_devices','robot_character_templates','robot_conversation_sessions','robot_audit_logs','robot_bootstrap_identities','robot_pairing_requests','robot_device_credentials','robot_ingestion_jobs','robot_vector_stores','robot_rate_limits'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated',t); END IF;
 END LOOP;
END $$;
-- Defense in depth for Supabase read-only member access. Secrets have no policy.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='auth') THEN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.robot_is_member(target_workspace text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $fn$ SELECT EXISTS(SELECT 1 FROM public.robot_workspace_members WHERE workspace_id=target_workspace AND user_id=auth.uid()::text) $fn$';
  EXECUTE 'REVOKE ALL ON FUNCTION public.robot_is_member(text) FROM PUBLIC';
 END IF;
END $$;
COMMIT;
