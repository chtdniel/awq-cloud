-- Flight Board aktif per akun.
--
-- Sebelum ini, daftar flight yang sedang ada di board hanya hidup di
-- localStorage browser (key `occ_active_board`, lihat src/Flight_Ui.html).
-- Akibatnya login yang sama di browser/device lain selalu mulai dari board
-- kosong, dan susunan yang dibuat di browser B tidak pernah terlihat di
-- browser A. Sheet ini membuat server jadi sumber kebenaran; localStorage
-- turun peran jadi cache untuk paint pertama saja.
CREATE TABLE IF NOT EXISTS user_board_state (
    user_id INTEGER PRIMARY KEY,              -- 1:1 dengan auth_users.id
    row_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array flights.id, urut sesuai tampilan board
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
