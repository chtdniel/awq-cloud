ALTER TABLE auth_audit_log ADD COLUMN change_summary TEXT;
CREATE INDEX IF NOT EXISTS idx_auth_audit_created_at ON auth_audit_log(created_at);
