CREATE TABLE IF NOT EXISTS assist_auth_codes (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    return_origin TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assist_auth_codes_expiry
    ON assist_auth_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS assist_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assist_tokens_user_active
    ON assist_tokens(user_id, revoked_at, expires_at);
