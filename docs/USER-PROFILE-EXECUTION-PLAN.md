# Rencana Eksekusi Fitur Profil User — AWQ Cloud

Status: **APPROVED 2026-09-17 (checklist §9) — disetujui untuk eksekusi. BELUM dieksekusi; akan dilanjutkan di session baru, mulai dari Phase 0 (§4).**
Tanggal: 2026-09-17
Scope: profil per-user (NAME, EMAIL, IAA ID, LIC No.) — skema D1, backend RPC, UI menu akun, admin Internal Users, prefill output briefing, dan panduan pengelolaan data ke depan.

---

## 1. Ringkasan keputusan (hasil konfirmasi dengan pemilik produk)

| Aspek | Keputusan |
|---|---|
| EMAIL di profil | Memakai email akun yang sudah ada (dipakai login, format sudah tervalidasi). Tidak ada field email kedua. |
| Format IAA ID | `IAA-` diikuti **angka saja**, contoh `IAA-12345` |
| Format LIC No. | `FOOL-` diikuti **angka saja**, contoh `FOOL-881234` |
| Keunikan | IAA ID dan LIC No. **keduanya unik** antar user (dipaksa di database) |
| Penyimpanan | **Tabel baru `user_profiles`** berpasangan 1:1 dengan `auth_users` |
| Sifat field | **Opsional dulu** — boleh kosong, diisi kapan saja, tanpa paksaan/prompt wajib |
| Hak edit | **User + admin** — user mengedit profilnya sendiri; admin dapat melihat & mengoreksi via Internal Users |
| Pemakaian data | **Paling luas**: tampil di menu akun, daftar Internal Users (admin), nama user di UI, dan dipakai di output (briefing/report) |

Konsekuensi desain: karena EMAIL = email akun, field baru hanya **3** (`full_name`, `iaa_id`, `lic_no`).

---

## 2. Kondisi repo saat ini (temuan eksplorasi)

- **Stack**: Cloudflare Pages + Pages Functions, D1/SQLite (binding `DB`, database `awq-db`, lihat `wrangler.toml`). Frontend HTML/JS murni: sumber di `src/` → `node build.js` → `public/index.html` (artifact, jangan diedit langsung). UI akun/login hidup di `public/cloudflare-shim.js`.
- **Auth sudah ada dan berjalan** (migration 008/009): tabel `auth_users` (hanya email, password hash, role `admin`/`registered`/`readonly`, status — **tanpa** nama/IAA/LIC), `auth_sessions`, `auth_audit_log` dengan `change_summary`. Session cookie HttpOnly + CSRF + audit. Policy RPC deny-by-default di `functions/api/rpc.js` (method tak terdaftar = ditolak).
- **Validasi email sudah ada**: `normalizeEmail()` di `functions/api/auth.js` + mirror frontend. **Validasi `IAA-`/`FOOL-` belum ada sama sekali** — dibangun dari nol.
- **Admin UI sudah ada**: tab Internal Users di `src/Settings_Ui.html` (list/create/role/active/reset password via `adminListUsers`, `adminCreateUser`, dll.).
- **Output briefing**: form di `functions/briefing-form.js` punya input `dxrName` ("Dispatcher name") yang diisi **manual**; `functions/api/briefing-xlsx.js` menuliskannya ke template `public/briefing-template.xlsx` (sel `E48` dxrName, `O48` picName, NOTAM `B26` "CREATE BY"). Belum ada kaitan dengan identitas user yang login.
- **Migration**: sudah sampai `010`; berikutnya `011`. Backup D1 sebelum perubahan besar pernah diambil ke `docs/backups/awq-db-before-auth-20260915.sql`.
- **Test**: `npm test` = daftar file eksplisit di `package.json` → file test baru **wajib didaftarkan** di sana.

---

## 3. Desain target

### 3.1 Skema D1 — `migrations/011_user_profiles.sql`

```sql
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
```

Rationale:

- **Row dibuat lazy** — baris baru muncul saat profil pertama kali diisi; user yang belum mengisi profil tidak punya baris (setara "belum diisi").
- **NULL = belum diisi**, bukan string kosong — membuat unique index dan tampilan konsisten. SQLite memperbolehkan banyak NULL pada unique index (dipakai partial index agar eksplisit).
- **Tanpa clause FOREIGN KEY** — mengikuti konvensi tabel auth yang sudah ada (008 juga tanpa FK). Integritas dijaga di layer aplikasi; saat ini tidak ada fitur hapus user (hanya disable), jadi risiko orphan nihil. Bila kelak ada fitur hapus user, tambahkan cleanup `user_profiles` di handler yang sama.
- **`updated_by`** untuk jejak siapa yang mengubah (user sendiri vs admin).

### 3.2 Validasi (backend, dengan mirror di frontend)

Ditambahkan di `functions/api/auth.js` (pola sama seperti `normalizeEmail`):

- `normalizeFullName(value)`: trim; kosong → `NULL`; jika diisi: 1–100 karakter; **tolak** karakter `<`, `>`, dan kontrol (mencegah injeksi markup). Huruf, spasi, titik, koma, apostrof, hyphen diizinkan.
- `normalizeIaaId(value)`: trim → uppercase → harus match `^IAA-[0-9]{1,20}$` (maksimum **20 digit** — diputuskan 2026-09-17). Contoh valid: `IAA-12345`. (`iaa-123` dinormalisasi menjadi `IAA-123`.)
- `normalizeLicNo(value)`: trim → uppercase → harus match `^FOOL-[0-9]{1,20}$` (maksimum **20 digit**). Contoh valid: `FOOL-881234`.
- Error dikembalikan **field-level** (mengikuti pola rencana SETTINGS: response 4xx dengan detail per field), bukan error generik/500.
- Frontend memvalidasi format yang sama sebelum submit (mirror, seperti pola `invalidEmails`) — UX saja; backend tetap satu-satunya gerbang kebenaran.

### 3.3 Backend RPC — `functions/api/rpc.js`

Method baru (harus **didaftarkan ke policy set** — deny-by-default):

| Method | Akses | Perilaku |
|---|---|---|
| `profileSave` | Semua user yang login, **termasuk `readonly`** (profil = data identitas, bukan data operasional) | Simpan profil sendiri. `requireCsrf`, validasi §3.2, UPSERT lazy ke `user_profiles`. Scope self diambil dari session — tidak menerima parameter user id. Pre-check uniqueness + tangani constraint violation → error field ("IAA ID sudah dipakai user lain"). Audit `profile_save`. |
| `adminSaveProfile` | `ADMIN_ONLY_METHODS` | Admin mengubah profil user lain. Validasi sama. Audit `admin_profile_save` dengan target user. |

Perubahan method yang sudah ada:

- `adminListUsers` — diperluas dengan `LEFT JOIN user_profiles` agar daftar Internal Users menampilkan Name/IAA/LIC.
- `getAccess()` / payload `authMe` — menyertakan profil user (response sudah `Cache-Control: no-store`).
- Audit: catat field yang berubah di `change_summary` (migration 009) dengan nilai sebagian tersamar (mis. `IAA-**45`), tanpa menyimpan nilai penuh yang tidak diperlukan.

### 3.4 UI user — `public/cloudflare-shim.js`

- Tombol **"My profile"** di panel akun (`#awq-account-panel`), dialog mengikuti pola `showChangePasswordDialog()` yang sudah ada.
- Isi dialog: **Name**, **IAA ID**, **LIC No.** (dapat diedit) + **Email** (read-only, keterangan: email akun dipakai untuk login — sesuai keputusan, tidak ada email kedua).
- Setelah sukses simpan: perbarui `authState.user.profile`, dan **nama user tampil di panel akun** di atas label role (fallback ke email bila nama belum diisi) — memenuhi keputusan "nama user di UI".
- Validasi mirror + pesan error per field + tombol Save disabled saat input tidak valid/tidak berubah.

### 3.5 UI admin — `src/Settings_Ui.html` (tab Internal Users)

- Kolom **Name / IAA ID / LIC No.** di daftar user (nilai kosong tampil "—").
- Form edit profil per user via `adminSaveProfile`, mengikuti pola form admin yang sudah ada (seperti role change / reset password), dengan **konfirmasi sebelum menyimpan perubahan profil user lain**.

### 3.6 Integrasi output briefing — `functions/briefing-form.js`

- **Prefill `dxrName`** dari profil user yang login, **hanya bila field tidak punya nilai tersimpan**: `full_name` + ` (LIC: FOOL-…)` bila `lic_no` terisi. Tanpa profil / tanpa nama → tetap kosong seperti sekarang (degrade silently, pola yang sudah dipakai file ini saat `briefing_reports` tidak ada).
- Nilai tetap **bisa diedit manual** sebelum submit — prefill adalah default, bukan lock.
- `picName` tetap manual (PIC bukan user yang login).
- **Tidak ada perubahan di `briefing-xlsx.js`** — nilai mengalir lewat plumbing yang sudah ada (sel `E48`, NOTAM `B26` "CREATE BY").
- Format tanda tangan **dikunci (2026-09-17)**: nama + nomor FOOL license — `NAME (LIC: FOOL-…)`, contoh `CHRIS DANIEL (LIC: FOOL-881234)`.

---

## 4. Proses eksekusi (dijalankan HANYA setelah approval)

### Phase 0 — Backup & persiapan
1. Tambahkan `docs/backups/*.sql` ke `.gitignore` (keputusan 2026-09-17, karena repo PUBLIC — file dump tetap dibuat di folder yang sama, hanya tidak dipublikasikan ke GitHub), lalu export D1 mengikuti pola yang sudah ada: `npx wrangler d1 export awq-db --remote --output docs/backups/awq-db-before-profiles-20260917.sql` (keputusan #4: tetap export file ke `docs/backups/`). Mulai dump ini, isi dump mencakup hash password + PII profil — karena di-gitignore, dump tersimpan lokal di luar version control (trade-off yang disadari). Jaring pengaman tambahan otomatis: Time Travel D1 (selalu aktif, tanpa biaya) — bila migration berjalan salah: `npx wrangler d1 time-travel restore awq-db --timestamp=<waktu sebelum migration>` (sifat restore = rollback seluruh database, data setelah titik itu hilang — putuskan rollback secepatnya).
2. Buat `migrations/011_user_profiles.sql` (§3.1).

### Phase 1 — Database (local dulu)
3. Apply ke D1 lokal: `npx wrangler d1 execute awq-db --file migrations/011_user_profiles.sql --local` (atau perintah setara yang dipakai untuk migration 008–010).
4. Verifikasi skema (`--command ".schema user_profiles" --local`).

### Phase 2 — Backend
5. Validator di `functions/api/auth.js` + unit test.
6. `functions/api/rpc.js`: registrasi policy, `profileSave`, `adminSaveProfile`, `adminListUsers` JOIN, profil di `getAccess()`, audit.
7. Daftarkan `tests/test_user_profiles.mjs` ke daftar `scripts.test` di `package.json`.

### Phase 3 — UI user
8. Dialog profil + nama di panel akun di `public/cloudflare-shim.js`.
9. `node build.js` → regenerasi `public/index.html`.

### Phase 4 — UI admin
10. Tab Internal Users di `src/Settings_Ui.html` (kolom + form edit + konfirmasi) → rebuild.

### Phase 5 — Briefing prefill
11. Prefill `dxrName` di `functions/briefing-form.js` (§3.6).

### Phase 6 — Test & QA
12. `npm test` — semua test lama tetap hijau + file baru.
13. QA manual matrix (§5).
14. Browser test (pola `tests/test_account_menu_browser.mjs`): dialog profil, admin edit, prefill briefing.

### Phase 7 — Deploy & cutover
15. Deploy code ke Pages.
16. Apply migration ke production: `npx wrangler d1 execute awq-db --file migrations/011_user_profiles.sql --remote`.
17. Smoke test production: login → isi profil → cek penolakan duplikat → admin lihat daftar → prefill briefing → XLSX berisi nama di E48/B26.

### Phase 8 — QR tanda tangan Level A (terpisah dari core; TANPA perubahan database/endpoint)
18. Vendor encoder QR pure-JS kecil (lisensi terbuka, tanpa npm dependency — prinsip zero-dependency repo).
19. `functions/briefing-form.js`: render QR sebagai image (data URI) di samping blok tanda tangan DXR pada form/report HTML.
20. `functions/api/briefing-xlsx.js`: generate PNG QR dari matrix encoder (primitives deflate + CRC32 untuk format PNG sudah ada di file ini), tulis sebagai image part baru ke ZIP XLSX + anchor drawing di area tanda tangan sheet CBR — posisi persis diverifikasi terhadap template saat eksekusi.
21. Isi QR (kompak agar reliable saat discan dari cetakan): `AWQ OCC | DXR: NAME (LIC: FOOL-…) | <tanggal form> | REF: <flights_key>`. Nilai diambil dari field form yang sama dengan yang tercetak di dokumen (`dxrName`, `formDate`) — bukan clock render — agar QR selalu konsisten dengan isi dokumen.
22. Test: perluas pola `tests/test_briefing_xlsx.mjs` (image part QR ada di ZIP + header PNG valid) + QA manual: cetak XLSX → scan dengan HP → teks terbaca.

Catatan Phase 8: Level A tidak menyimpan apa pun di database — beban maintenance nol. Bila kelak ingin naik ke Level B (URL verifikasi), seluruh machinery QR & embed ini dipakai ulang; saat itu cukup tambah migration 012 + endpoint `/verify`.

**Catatan urutan aman**: migration 011 murni additive (tabel + index baru, `IF NOT EXISTS`) — code lama tetap berfungsi baik migration diterapkan sebelum ataupun sesudah deploy code. Tidak ada downtime.

---

## 5. Test matrix minimum

**Otorisasi & keamanan**
- Anonymous → `profileSave` ditolak; CSRF invalid/missing → ditolak.
- `readonly` **bisa** `profileSave` miliknya sendiri; **tidak bisa** `adminSaveProfile`; tidak ada jalur mengubah profil user lain (scope self dari session).
- `admin` bisa `adminSaveProfile` untuk user lain.
- Duplikat `iaa_id`/`lic_no` antar user → error field yang jelas (bukan 500).
- Validasi ditolak: `IAA-12a`, `IAA-`, `FOOL-12x`, IAA/LIC dengan **21 digit**, nama 101 karakter, nama berisi `<script>`. Normalisasi teruji: `iaa-123` → `IAA-123`.
- Mengosongkan field → kembali `NULL` (profil "belum diisi" lagi).
- Audit `profile_save` / `admin_profile_save` tercatat dengan `change_summary` tersamar.

**UI**
- Dialog profil: simpan sukses, error per field, Save disabled saat tidak valid/tidak berubah.
- Panel akun menampilkan nama setelah diisi; fallback email bila kosong.
- Internal Users menampilkan kolom profil; admin edit + konfirmasi berfungsi.
- Briefing: prefill hanya bila kosong; nilai tersimpan **tidak ditimpa**; XLSX E48/B26 berisi nilai.
- QR (Phase 8): image QR tampil di form HTML; XLSX memuat image part QR dengan header PNG valid; hasil cetak dapat discan dan teks terbaca; isi QR konsisten dengan field yang tercetak (dxrName, formDate, flights_key).

**Regression**
- `node build.js` menghasilkan `public/index.html` yang memuat perubahan; seluruh `npm test` lulus.

---

## 6. Rollback

- Code rollback = deploy versi sebelumnya. Tabel `user_profiles` **dibiarkan** (data tidak hilang; code lama tidak membacanya).
- Migration 011 additive + `IF NOT EXISTS` → idempotent, aman diterapkan ulang.
- `DROP TABLE user_profiles` hanya jika benar-benar diperlukan, **hanya setelah** export backup terbaru tersimpan di `docs/backups/`, dan didokumentasikan sebagai runbook terpisah. Jangan DROP saat sudah ada data profil terisi tanpa backup.
- Untuk kesalahan migration yang merusak (salah ALTER/UPDATE data): `npx wrangler d1 time-travel restore awq-db --timestamp=<waktu sebelum migration>` — ingat sifatnya rollback seluruh-database, bukan per-tabel.

---

## 7. Pengelolaan database user & profil ke depan

**Operasional harian**
- Alur baku: admin membuat akun (email + role + temp password) → user login, ganti password, **mengisi profilnya sendiri** kapan saja (opsional) → admin memantau via Internal Users + audit log.
- Koreksi data: user mengedit sendiri; bila user lupa/terkunci/nonaktif → admin via Internal Users.
- **Satu sumber kebenaran**: `auth_users` (akun) + `user_profiles` (identitas). Jangan duplikasi profil ke `meta`, localStorage, atau file JSON lain — mengikuti larangan dual-write pada rencana auth (`docs/internal-auth-plan-review.md`).

**Kebersihan data**
- `NULL` = belum diisi. Tidak pernah menyimpan string kosong/"-" sebagai nilai.
- Keunikan dijaga unique index; konflik (dua orang memakai IAA/LIC sama) diselesaikan admin berdasarkan error field + audit log.

**Evolusi skema**
- **Semua** perubahan skema lewat file migration bernomor (`012`, `013`, …) — jangan pernah ALTER/DDL manual langsung di production.
- **Backup = export file ke `docs/backups/`** (keputusan #4, dikoreksi 2026-09-17: tetap export file seperti pola sebelumnya): `npx wrangler d1 export awq-db --remote --output docs/backups/awq-db-<topik>-<tanggal>.sql` **sebelum setiap migration berisiko** (ALTER kolom existing / UPDATE data / DROP) dan sebelum perubahan besar; terapkan dulu di D1 lokal sebelum remote. **Time Travel D1** tetap aktif bawaan sebagai jaring pengaman tambahan (restore ke menit mana pun ≤30 hari, 7 hari pada plan Free; sifat restore seluruh-database) — berguna untuk kesalahan migration yang baru terjadi, sedangkan export file adalah salinan jangka panjang yang tidak kedaluwarsa.
- Menambah field profil baru (phone, dsb.) = `ALTER TABLE user_profiles ADD COLUMN ...` via migration berikutnya — tabel terpisah yang dipilih memudahkan jalur ini.
- Bila kelak butuh relasi satu-ke-banyak (riwayat sertifikat, dsb.) → buat tabel anak baru; jangan ubah relasi 1:1 yang ada.

**Keamanan & privasi**
- Profil = PII (nama, nomor license). Hanya pemilik + admin yang boleh melihat profil; **jangan pernah** mengekspos profil user lain ke user biasa.
- Tidak ada credential di profil; audit hanya menyimpan nilai tersamar.
- **Sensitivitas backup (diverifikasi & diputuskan 2026-09-17): repo GitHub ini PUBLIC** (`gh repo view` → `visibility: PUBLIC`). Keputusan: **`docs/backups/*.sql` ditambahkan ke `.gitignore`** (langkah Phase 0) — dump tetap dibuat di folder yang sama saat export, tetapi **tidak di-commit** ke repo publik. Alasan: mulai dump pasca-auth, isi dump mencakup tabel `auth_users` (email + PBKDF2 hash + salt) dan `user_profiles` (nama, IAA ID, LIC No.) — mempublikasikannya berarti kredensial ter-hash dan PII dapat diunduh siapa pun. Konsekuensi yang disadari: dump hanya ada di mesin lokal (di luar version control) — salinan tetap ada di Cloudflare (D1 + Time Travel ≤30 hari), jadi jangan hapus dump lokal sembarangan. Catatan pra-ada: dump lama `awq-db-before-auth-20260915.sql` memang sudah ter-commit di repo publik — isinya pra-auth (data operasional + beberapa email allowlist, tanpa hash password, risiko minor); dapat dibersihkan dari repo pada kesempatan terpisah bila diinginkan (butuh purge history, di luar scope rencana ini).

---

## 8. Poin terbuka untuk review (SEMUA TERJAWAB 2026-09-17)

1. ~~**Format tanda tangan DXR**~~ — **TERJAWAB (2026-09-17): nama + nomor FOOL license**, format `NAME (LIC: FOOL-…)` (lihat §3.6).
2. ~~**Batas digit** IAA/LIC~~ — **TERJAWAB (2026-09-17): maksimum 20 digit** (`{1,20}`, lihat §3.2).
3. ~~**Panjang nama**~~ — **TERJAWAB (2026-09-17): maksimum 100 karakter** (§3.2).
4. ~~**Lokasi backup D1**~~ — **TERJAWAB & dikoreksi (2026-09-17): tetap export file ke `docs/backups/` seperti pola sebelumnya, dengan `docs/backups/*.sql` di-`.gitignore`** karena repo PUBLIC (lihat §7); Time Travel aktif bawaan sebagai jaring pengaman tambahan.
5. ~~**Masking IAA/LIC di dialog profil sendiri**~~ — **TERJAWAB (2026-09-17): tampil penuh, tanpa masking** (ini data milik user sendiri).
6. ~~**Tanda tangan digital QR**~~ — **TERJAWAB (2026-09-17): Level A (teks identitas)**, penempatan **XLSX + HTML**. Opsi yang dipertimbangkan di §8.1; rincian eksekusi di §4 Phase 8.

### 8.1 Opsi tanda tangan digital QR (DIPUTUSKAN 2026-09-17: Level A, penempatan XLSX + HTML)

QR bisa dibuat di stack ini, tetapi **QR saja bukan tanda tangan digital** — QR hanya wadah data; siapa pun bisa membuat QR berisi data orang lain. Nilai keaslian datang dari apa yang diverifikasi saat QR discan. Tiga level yang realistis:

| Level | Isi QR | Nilai verifikasi | Kebutuhan |
|---|---|---|---|
| A — blok identitas scannable | Teks: nama, LIC No., tanggal, referensi briefing | Praktis dibaca scanner; **tidak membuktikan keaslian** (QR serupa bisa dibuat siapa pun) | Encoder QR pure-JS yang di-vendor (tanpa dependency — prinsip repo); render di HTML form/report = mudah; embed di XLSX = effort sedang (menulis image part baru ke ZIP — primitives ZIP/CRC32/deflate sudah ada di `briefing-xlsx.js`) |
| B — QR berisi URL verifikasi | URL ke endpoint publik read-only, mis. `/verify/<token>` — server konfirmasi: dokumen ada, penandatangan (nama + LIC), waktu, hash konten cocok | **Verifikasi nyata terhadap database** — pihak ketiga scan dan bisa cek keaslian | Migration 012 (kolom signature pada `briefing_reports`: token, signed_by, signed_at, content_hash); endpoint publik minimal; base URL produksi |
| C — kriptografi penuh (HMAC/Ed25519) | Payload berisi signature kripto; diverifikasi offline dengan kunci publik | Paling kuat; verifikasi tanpa server | Manajemen kunci + tool verifikasi — effort dan kompleksitas tertinggi |

Catatan:

1. Level B/C mengekspos identitas penandatangan (nama, license) kepada siapa pun yang scan — itu memang inheren dengan konsep tanda tangan pada dokumen yang dibagikan, tapi perlu disadari sebagai konsekuensi PII.
2. Rekomendasi: core profile (Phase 0–7) tetap dieksekusi dulu **tanpa** QR; QR menjadi phase terpisah setelahnya. Pilih **Level B** jika tujuannya verifikasi keaslian dokumen; **Level A** jika cukup identitas yang scannable.

**Keputusan (2026-09-17): Level A — teks identitas, penempatan XLSX + HTML.** Konsekuensi: tanpa perubahan database, tanpa endpoint publik, tanpa kewajiban maintenance baru (QR self-contained). Jalur upgrade ke Level B/C di masa depan tetap terbuka — machinery encoder QR + embed XLSX dipakai ulang, tinggal tambah migration 012 + endpoint `/verify` saat dibutuhkan.

---

## 9. Checklist approval — ✅ APPROVED 2026-09-17

- [x] Struktur tabel `user_profiles` (migration 011) — ✅ approved 2026-09-17
- [x] Validasi format (`IAA-[0-9]`, `FOOL-[0-9]`, nama) — ✅ approved 2026-09-17
- [x] Scope UI (menu akun, Internal Users, nama di panel, prefill briefing) — ✅ approved 2026-09-17
- [x] QR tanda tangan **Level A** — XLSX + HTML, Phase 8, tanpa database/endpoint baru — ✅ approved 2026-09-17
- [x] Dump backup ke repo PUBLIC — **`.gitignore` untuk `docs/backups/*.sql`** (dump tetap dibuat lokal, tidak dipublikasikan) — ✅ approved 2026-09-17 — lihat §7
- [x] Jawaban poin terbuka §8 — **semua terjawab 2026-09-17** (lihat §8)
- [x] **Approval eksekusi: ✅ YA — approved 2026-09-17 oleh pemilik produk**

**Status eksekusi: BELUM dieksekusi.** Approval diberikan 2026-09-17; eksekusi dilanjutkan di session baru, mulai dari **Phase 0** (§4) dan mengikuti urutan **Phase 0–8**. Tidak ada langkah yang boleh dilewati atau diubah dari rencana tanpa keputusan eksplisit baru dari pemilik produk.
