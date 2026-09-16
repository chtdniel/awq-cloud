# Review Rencana Internal Authentication AWQ Cloud

Status: rekomendasi desain sebelum implementasi  
Tanggal: 2026-09-15  
Scope: `awq-cloud.pages.dev`, Cloudflare Pages Functions, D1, dan frontend SPA

## Ringkasan keputusan

Rencana login internal berbasis email + password dengan session cookie HttpOnly adalah arah yang layak. Namun, ini harus diperlakukan sebagai penggantian perimeter keamanan, bukan sekadar penambahan form login.

Rekomendasi utama:

1. Terapkan policy backend secara eksplisit dan deny-by-default. UI hanya membantu UX; UI bukan sumber otorisasi.
2. Hilangkan seluruh bypass legacy sebelum auth baru dianggap aktif, khususnya `allowLegacySameOriginWrite` pada `saveNotamData` dan `firBulkImportNotams`.
3. Bedakan tiga kondisi: tidak login, login-readonly, dan login dengan hak write/admin. Jangan lagi menganggap request tanpa identitas sebagai `unregistered` yang tetap boleh membaca.
4. Gunakan CSRF protection terpisah. `SameSite=Lax` membantu, tetapi bukan pengganti kontrol CSRF untuk write action.
5. Bootstrap admin pertama melalui one-time bootstrap secret dari environment atau prosedur deployment yang dapat diaudit, bukan SQL manual berisi hash yang diketik tangan.
6. Matikan Cloudflare Access hanya setelah production auth lulus checklist cutover dan rollback sudah terbukti.

## Temuan terhadap kondisi repo saat ini

Di `functions/api/rpc.js` saat ini:

- `rpcGuard()` masih menerima `Cf-Access-Jwt-Assertion` dan memeriksa header email Cloudflare Access.
- Bila tidak ada header Access, request same-origin dapat lolos guard.
- `getAccess()` membaca `SETTINGS_ADMIN_EMAILS` dan `OCC_ALLOWED_EMAILS` dari `meta`.
- `allowLegacySameOriginWrite` masih memberi jalur write tanpa user untuk `saveNotamData` dan `firBulkImportNotams`.
- Semua method RPC masuk melalui satu dispatcher, sehingga perubahan policy harus mencakup daftar method, bukan hanya tombol frontend.
- Test yang ada masih membuat database minimal dengan tabel `meta` dan mengandalkan perilaku legacy. Test harus diubah atau diberi fixture auth yang jelas; jangan mempertahankan bypass agar test lama tetap hijau.

Langkah pertama pada rencana, yaitu membersihkan bypass, bukan opsional. Selama bypass masih ada, login baru tidak benar-benar melindungi action sensitif.

## Desain target yang disarankan

### Status identitas dan policy

Gunakan helper tunggal, misalnya `getRequestUser(context)`, yang mengembalikan:

- `null): tidak ada session valid;
- `{ id, email, role, sessionId }`: session valid dan user aktif.

Gunakan policy matrix di backend:

| Kelompok method | Tidak login | readonly | registered | admin |
|---|---:|---:|---:|---:|
| `authLogin`, `authMe` | boleh | boleh | boleh | boleh |
| `authLogout` | idempotent | boleh | boleh | boleh |
| Dashboard/read/report generation | tolak atau sesuai keputusan produk | boleh | boleh | boleh |
| NOTAM/FIR/TAF/flight/route/briefing write | tolak | tolak | boleh | boleh |
| User/settings administration | tolak | tolak | tolak | boleh |

Daftar method harus ditinjau satu per satu. Jangan hanya mengandalkan nama `save`; contoh `generateBriefingPackage`, `saveBriefingForm`, `persistAnalysisResults`, dan `setActiveFlightRoute` juga harus mendapat policy yang tepat. Method baru yang belum dimasukkan ke policy sebaiknya ditolak, bukan otomatis dianggap public.

Untuk `authLogin`, `authMe`, dan `authLogout`, buat exception eksplisit sebelum guard session. Semua method lain memerlukan session valid. Jika produk ingin sebagian data public, nyatakan daftar read-public secara eksplisit; jangan gunakan status `unregistered` sebagai default permission.

### Skema D1

Skema awal sudah baik. Saya sarankan:

- `auth_users.id INTEGER PRIMARY KEY AUTOINCREMENT`, lalu session menyimpan `user_id`, bukan email sebagai relasi utama.
- `email_normalized TEXT NOT NULL UNIQUE` dan `email_display TEXT NOT NULL`.
- `password_hash`, `password_salt`, `password_iterations`, dan `password_algorithm` agar parameter hash dapat dinaikkan.
- `role TEXT NOT NULL CHECK (role IN ('admin','registered','readonly'))`.
- `is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))`.
- `failed_login_count`, `locked_until`, dan `must_change_password` dengan default serta constraint yang jelas.
- Session memiliki `id`, `user_id`, `token_hash UNIQUE`, `created_at`, `last_seen_at`, `expires_at`, dan `revoked_at`.
- Index pada `token_hash`, `user_id, revoked_at`, dan `email_normalized`.
- Audit log menyimpan actor, action, target, request id, timestamp, dan hasil. Jangan menyimpan password, temporary password, session token, atau raw credential.

`user_id` lebih aman terhadap perubahan email dan lebih jelas untuk revoke semua session seorang user.

### Password dan session

- Normalisasi email dengan `trim().toLowerCase()` sebelum lookup dan uniqueness check.
- Gunakan Web Crypto PBKDF2-HMAC-SHA-256 dengan salt random minimal 16 byte dan iteration count yang dikonfigurasi. Ukur iteration count pada runtime Workers; jangan mengunci angka tanpa benchmark. Argon2id lebih ideal, tetapi PBKDF2 adalah pilihan realistis bila runtime tidak menyediakan Argon2id.
- Bandingkan hash secara constant-time.
- Token session minimal 32 random bytes; simpan hanya hash token di D1.
- Cookie sebaiknya memakai prefix `__Host-`, misalnya `__Host-awq_session`, dengan `Secure; HttpOnly; SameSite=Lax; Path=/` dan tanpa `Domain`.
- Terapkan absolute expiry, misalnya 12 jam, serta idle timeout bila diperlukan. Update `last_seen_at` secara berkala, bukan pada setiap request.
- Login sukses melakukan session rotation. Perubahan password dan disable user merevoke semua session user tersebut. Logout merevoke session saat ini dan bersifat idempotent.
- Jangan mengembalikan detail “email tidak ditemukan” versus “password salah”. Gunakan pesan generik.

### CSRF, origin, dan abuse controls

- Pertahankan validasi `Origin`/`Host` untuk browser same-origin, tetapi perlakukan sebagai lapisan tambahan, bukan satu-satunya CSRF defense.
- Untuk semua state-changing RPC, minta header custom seperti `X-AWQ-CSRF` dengan token yang tidak dapat ditebak, atau gunakan pola CSRF token server-side/double-submit yang tepat.
- Pastikan frontend mengirim `credentials: 'same-origin'` pada fetch bila diperlukan oleh implementasi cookie.
- Tolak `Origin` yang tidak sama dengan origin production yang diizinkan. Jangan membangun allowlist origin dari header request.
- Rate-limit berdasarkan kombinasi IP dan normalized email. Gunakan lock sementara dengan backoff.
- Tambahkan batas ukuran body dan validasi tipe/panjang input pada auth RPC.
- Beri `Cache-Control: no-store` pada response auth/session dan jangan menaruh credential di URL, localStorage, atau analytics.

### Bootstrap, recovery, dan lifecycle admin

SQL seed manual rawan salah hash dan tidak punya jejak operator yang cukup. Pilihan yang lebih baik:

1. Migration membuat tabel kosong.
2. Endpoint bootstrap hanya aktif bila `AUTH_BOOTSTRAP_SECRET` tersedia, belum ada user admin aktif, dan request memenuhi rate limit.
3. Secret hanya boleh dipakai sekali; setelah admin dibuat, secret dihapus/dirotasi.
4. Admin pertama langsung wajib mengganti password temporary.
5. Setelah itu bootstrap endpoint selalu disabled.

Tambahkan invariant backend: user tidak boleh menonaktifkan atau menurunkan role admin terakhir tanpa admin pengganti. Sediakan minimal dua admin aktif agar recovery tidak bergantung pada satu akun.

Jika recovery manual tetap diperlukan, dokumentasikan prosedur operator terpisah dari aplikasi, termasuk cara membuat hash dengan script resmi. Jangan pernah menyimpan temporary password di migration atau repository.

### Migrasi allowlist lama

Migrasi `SETTINGS_ADMIN_EMAILS` dan `OCC_ALLOWED_EMAILS` dapat dilakukan dengan aturan:

- email dinormalisasi dan dideduplikasi;
- jika email ada di dua daftar, role final adalah `admin`;
- user hasil migrasi mendapat temporary password dan `must_change_password = 1`;
- migration menghasilkan laporan jumlah created, promoted, skipped, dan conflict;
- setelah cutover, `meta` lama menjadi read-only/legacy dan bukan sumber otorisasi.

Jangan melakukan dual-write jangka panjang antara `meta` dan `auth_users`; itu akan menciptakan dua sumber kebenaran dan membuka celah drift permission.

## Frontend dan cache

Frontend harus memanggil `authMe()` sebelum menginisialisasi fitur yang melakukan write. Sembunyikan atau disable tombol sesuai role untuk UX, tetapi response `401/403) dari backend tetap menjadi sumber kebenaran.

Tambahkan:

- loading state sampai `authMe()` selesai;
- halaman login tanpa membocorkan apakah email terdaftar;
- redirect UI ke login saat session expired;
- tombol logout yang membersihkan state in-memory;
- alur change-password yang memblokir operasi saat `must_change_password` aktif;
- invalidasi state ketika role berubah atau akun dinonaktifkan;
- tidak ada password, session token, atau credential di localStorage;
- aturan cache yang mencegah halaman/state user tersaji dari shared cache.

`public/index.html` adalah artifact build. Perubahan dilakukan di `src/`, lalu diverifikasi dengan `build.js); jangan mengedit artifact saja.

## Cron dan service-to-service access

`functions/api/cron.js` adalah jalur server terjadwal, bukan browser user. Jangan memaksa cron memakai session cookie. Pisahkan:

- request browser: session cookie + CSRF + role policy;
- request cron: Cloudflare Cron trigger/internal invocation yang diverifikasi oleh platform atau secret service-to-service yang tidak pernah dikirim ke frontend.

Pastikan cron tidak dapat dipanggil sebagai RPC public tanpa kontrol kuat. Tetapkan policy `fetchLatestTafFromApi` dan `saveTafData` secara terpisah.

## Urutan implementasi yang lebih aman

1. Inventaris dan klasifikasikan semua RPC method menjadi public-read, authenticated-read, registered-write, admin-only, dan internal-service.
2. Tambahkan migration auth dengan constraint/index dan audit log.
3. Implementasikan email normalization, password hash/verify, session lifecycle, CSRF, dan rate limit.
4. Ganti guard global menjadi authenticated-by-default; hapus bypass legacy.
5. Tambahkan auth RPC dan bootstrap admin one-time.
6. Migrasikan allowlist lama ke `auth_users` dan lakukan dry-run/report.
7. Tambahkan UI login/logout/change-password dan role-aware navigation.
8. Tambahkan test policy, session, CSRF, lockout, revoke, dan admin invariant.
9. Build dan manual QA lokal: refresh, expiry, logout, dua tab, readonly, registered, dan admin.
10. Deploy code + migration ke staging/preview bila tersedia. Seed admin dengan runbook terpisah.
11. Uji production dengan Cloudflare Access masih aktif sebagai safety net.
12. Matikan Access hanya setelah login, read, write, admin, logout, expiry, dan rollback lulus.

## Test matrix minimum

### Auth/security

- login sukses menghasilkan cookie dengan `HttpOnly`, `Secure`, `SameSite=Lax), dan `Path=/`;
- password salah menghasilkan response generik dan menaikkan counter;
- lockout mencegah brute force dan pulih sesuai policy;
- session expired/revoked menghasilkan `401`;
- logout merevoke session;
- change password merevoke session lama;
- disabled user tidak dapat memakai session lama;
- CSRF invalid/missing menolak seluruh write RPC;
- cross-origin `Origin` ditolak;
- token asli tidak pernah tersimpan di D1/log/response.

### Authorization

- anonymous tidak dapat write walaupun mengirim `Origin` valid;
- `readonly) dapat membaca sesuai policy tetapi selalu mendapat `403` untuk write;
- `registered) dapat menjalankan write yang disetujui dan tidak dapat mengelola user/settings;
- `admin) dapat mengelola user dan write;
- admin terakhir tidak dapat dihapus/dinonaktifkan tanpa pengganti;
- method RPC tidak dikenal atau belum dipetakan tidak mendapat akses otomatis.

### Regression dan production

- test NOTAM AD/FIR import lulus dengan fixture user `registered`, bukan bypass;
- FIR overwrite/collision dan stale update tetap lulus;
- `node build.js` menghasilkan `public/index.html` dari source;
- browser QA mencakup hard refresh, session expired, dua tab, login ulang, dan role transition;
- smoke test production dilakukan untuk ketiga role dan cron TAF.

## Cutover dan rollback

Sebelum cutover, backup/export D1 dan catat migration bookmark. Deploy code yang sudah memahami auth tetapi pertahankan Cloudflare Access. Jalankan bootstrap dan smoke test melalui production domain. Baru setelah itu ubah policy Access menjadi public.

Rollback harus berarti:

- kembalikan policy Access untuk menutup perimeter;
- jangan menghapus tabel atau session data auth;
- hentikan bootstrap endpoint bila ada indikasi penyalahgunaan;
- investigasi audit log dan failed-login spike;
- deploy versi code sebelumnya hanya jika kompatibel dengan schema baru.

Jangan menurunkan security check hanya untuk memulihkan akses admin. Sediakan prosedur break-glass yang terdokumentasi dan dapat diaudit.

## Kesimpulan

Custom login ini layak dilanjutkan, dengan tiga perubahan desain wajib: policy backend deny-by-default, CSRF/rate-limit/session revocation sebagai bagian inti, dan bootstrap/recovery admin yang aman. Poin paling berbahaya pada rencana awal adalah migrasi tanpa menghapus bypass legacy serta asumsi bahwa `SameSite=Lax` sudah cukup untuk CSRF. Setelah dua hal tersebut ditangani, desain ini masuk akal sebagai pengganti Cloudflare Access untuk role `admin`, `registered`, dan `readonly`.

