CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,              -- 1:1 dengan auth_users.id
    full_name TEXT,                            -- NULL = belum diisi
    iaa_id TEXT,                               -- NULL = belum diisi
    lic_no TEXT,                               -- NULL = belum diisi
    updated_by INTEGER,                        -- auth_users.id pengubah terakhir
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_iaa_id
    ON user_profiles(iaa_id) WHERE iaa_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_lic_no
    ON user_profiles(lic_no) WHERE lic_no IS NOT NULL;
