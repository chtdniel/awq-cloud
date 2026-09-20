# Review: Menu Navigasi Utama AWQ OCC di Layar HP

Status: **review saja — belum ada kode aplikasi yang diubah.**
Tanggal review: dari build `public/index.html` yang sedang di-serve (hasil `build.js` atas `src/Index.html`).
Metode: pengukuran layout nyata di headless Chromium pada beberapa lebar viewport HP, dalam **kondisi sudah login** (login gate disembunyikan + chip akun disuntikkan persis seperti `cloudflare-shim.js` melakukannya).

---

## 1. Ringkasan

Di HP, **memang tidak mungkin semua tab terlihat** — dan sebagian tab **tidak bisa dijangkau sama sekali**, bukan sekadar tersembunyi.

Terukur pada viewport 390x844 (ukuran iPhone 14/15, sudah login):

| Metrik | Nilai |
|---|---|
| Tinggi pill navigasi | **144 px** (3 baris) + `top: 12px` sticky |
| Lebar area tab yang terlihat | **330 px** |
| Lebar total isi strip tab | **478 px** (overflow 148 px) |
| Tab terlihat penuh | **6 dari 11**: TAF, NOTAM, REPORT, WX, ROUTE, FIR |
| Tab tidak terlihat | FLIGHT, DATA, FIR NOTAM, CHECKLIST, SETTINGS |
| Tab yang **tidak bisa dicapai** | **FLIGHT, DATA** (terpotong di kiri, tidak bisa di-scroll) |
| Lebar tiap tab | dipaksa **44 px**, padahal isi butuh 26–71 px |

Perbandingan antar lebar viewport (kondisi login):

| Viewport | Tab terlihat penuh | Terpotong di kiri (tak terjangkau) | Overflow |
|---|---|---|---|
| 320 px | 5 | FLIGHT, DATA, TAF | 183 px |
| 360 px | 5 | FLIGHT, DATA, TAF | 163 px |
| **390 px** | **6** | **FLIGHT, DATA** | 148 px |
| 414 px | 7 | FLIGHT, DATA | 136 px |
| 480 px | 7 | FLIGHT, DATA | 103 px |
| 768 px (tablet) | 5 | FLIGHT, DATA, TAF | 162 px |

Catatan penting: **FLIGHT adalah tab default saat aplikasi dibuka**, dan justru tab itulah yang paling tidak terlihat/terjangkau di HP. Di tablet pun hanya 5 tab yang tampil.

Bukti visual ada di `scratch/navshot-390.png` (dan varian 360/414/768).

---

## 2. Akar masalah (terverifikasi)

### 2.1 `justify-content: center` + `overflow-x: auto` → tab kiri tidak bisa dijangkau
`src/Index.html:409` memberi `.occ-nav-bar .nav-btn-group { flex: 1; justify-content: center; }`, sementara `src/Index.html:411-423` memberi `overflow-x: auto`.
Ketika isi (478 px) lebih lebar dari wadah (330 px), `justify-content: center` membagi kekurangan ruang ke **kedua** sisi, sehingga isi meluber keluar ke kiri. Area scroll hanya bisa bergerak ke kanan (`scrollLeft` tidak bisa negatif).
Hasil terukur: `scrollLeft = 0` tetapi tab FLIGHT berada di `left = -79px`. Artinya FLIGHT dan DATA **permanen tidak bisa discroll masuk** — ini bug, bukan sekadar keterbatasan tempat. Terjadi di semua lebar: 320, 360, 390, 414, 480, dan 768 px.

### 2.2 Strip tab hanya mendapat ruang sisa, bukan lebar penuh
Di `src/Index.html:853-857` (breakpoint 768 px) ada `.nav-btn-group { width: 100%; order: 3; }`, **tetapi aturan itu tidak pernah menang**: `.occ-nav-bar .nav-btn-group { flex: 1 }` (specificity lebih tinggi) menetapkan `flex-basis: 0%`, dan untuk flex item `flex-basis` mengalahkan `width`.
Akibatnya `width: 100%` di media query itu **dead code**, dan strip tab hanya kebagian sisa ruang: **301 px di tablet 768 px**, hanya karena baris atas (brand + jam UTC + LINKS + toggle tema + chip akun) sudah memakan sisanya.

### 2.3 Tidak ada petunjuk bahwa strip bisa di-scroll
`scrollbar-width: none` + `.nav-btn-group::-webkit-scrollbar { display: none }` (`src/Index.html:419-423`). Di HP, scrollbar memang tersembunyi secara default — jadi tidak ada satu pun affordance (scrollbar, fade tepi, tanda `›`). Operator hanya melihat deretan tab yang "berhenti" begitu saja.

### 2.4 Label tab meluber keluar tombol → area sentuh ≠ yang terlihat
`.nav-tab` punya `min-width: 44px` (`src/Index.html:857`) sementara `white-space: nowrap` + `overflow: visible` (`src/Index.html:443,455`). Wadah yang sempit menekan setiap tab ke 44 px, tetapi isi tab butuh lebih banyak:

| Tab | Lebar kotak | Ruang isi tersedia | Kebutuhan isi |
|---|---|---|---|
| NOTAM | 44 px | 16 px | 49 px |
| REPORT | 44 px | 16 px | 52 px |
| FIR NOTAM | 44 px | 16 px | 69 px |
| CHECKLIST | 44 px | 16 px | 71 px |
| SETTINGS | 44 px | 16 px | 62 px |

Semua tab kecuali DATA (69 px, berada di dalam `.nav-data-container` yang `flex-shrink: 0`) meluber. Konsekuensinya: **teks yang Anda lihat dan tekan tidak berada di dalam kotak tombolnya**. Tap pada tulisan "CHECKLIST" bisa jatuh ke tombol tetangga. Label yang berdekatan (FIR NOTAM/CHECKLIST/SETTINGS) juga saling menimpa.

### 2.5 Nav jadi 3 baris setinggi 144 px di HP, di dalam pill `border-radius: 999px`
`public/cloudflare-shim.js:106` menyuntikkan CSS **hanya saat login**:
```
@media(max-width:480px){.occ-nav-bar .nav-actions{width:100%;justify-content:flex-end;gap:8px}.occ-nav-bar .utc-heartbeat{margin-right:auto}}
```
Itu memaksa `.nav-actions` mengambil satu baris penuh → pill berisi 3 baris (brand / actions / tab) setinggi 144 px, memakan ~18% tinggi layar HP dan permanen karena `position: sticky`.
Karena `border-radius: 999px` diterapkan pada kotak setinggi 144 px, ujung kiri-kanan pill membentuk setengah lingkaran radius ~72 px sehingga tepi baris tab terlihat terpotong.

**Penting:** ada **dua sumber kebenaran CSS navigasi** — `src/Index.html` dan media query yang disuntikkan `public/cloudflare-shim.js`. Perbaikan yang hanya menyentuh `src/Index.html` tidak akan menyelesaikan masalah 3 baris ini.

### 2.6 Membuka submenu DATA merusak strip tab
`src/Index.html:427` — `.nav-btn-group.menu-open { overflow: visible; }`. Saat dropdown DATA dibuka, strip kehilangan wadah scroll-nya. Terukur di 390 px: `lastTabRight = 469` sedangkan `navRight = 378`, dan tab meluber menimpa area `.nav-actions` (`actionsLeft = 29`) di **semua** lebar yang diuji. Submenu sendiri sudah `position: fixed` (`src/Index.html:1765-1777`), jadi `overflow: visible` sebenarnya tidak lagi diperlukan.

### 2.7 Tab aktif tidak pernah dibawa ke dalam viewport
`window.switchTab` (`src/Index.html:1542`) tidak memanggil `scrollIntoView` (terverifikasi: pencarian string `scrollIntoView` di source fungsi = tidak ada). Jika tab berpindah secara programatik (mis. SETTINGS dari dialog akses, atau kembali dari sebuah modul), tab aktif bisa berada di luar layar tanpa indikasi.

---

## 3. Rekomendasi

Urutan dari risiko paling kecil ke paling struktural. Rekomendasi **A** wajib apa pun opsi yang dipilih, karena memperbaiki bug "tab tak terjangkau".

### A. Perbaikan wajib (perilaku scroll) — risiko rendah
1. **Hilangkan `justify-content: center` dari container yang bisa scroll** (atau ubah menjadi `justify-content: flex-start`). Ini saja langsung membuat FLIGHT dan DATA bisa dijangkau.
2. **Biarkan tab sesuai lebar isinya**: `flex: 0 0 auto` agar tab tidak dipaksa 44 px; jangan andalkan `min-width` untuk memaksa ukuran.
3. **Buang `overflow: visible` pada `.nav-tab`** agar label tidak meluber keluar area sentuh. Jika perlu, tampilkan elipsis atau label pendek.
4. **Hapus `.nav-btn-group.menu-open { overflow: visible }`** dan pastikan submenu DATA di-portal ke `body` (mis. dipindahkan saat dibuka) supaya tidak lagi bergantung pada `overflow` induknya.
5. **Bawa tab aktif ke viewport**: panggil `scrollIntoView({ inline: 'nearest', block: 'nearest' })` di akhir `switchTab`. Ini juga berlaku untuk tab yang dipilih secara programatik.

### B. Tambahkan affordance scroll (risiko rendah, cepat)
- Fade/gradient mask di tepi kanan-kiri strip selama masih ada tab tersembunyi (dan hilang di ujung).
- Tombol panah `‹ ›` kecil, atau indikator titik.
- Tampilkan scrollbar tipis khusus perangkat sentuh (`.nav-btn-group { scrollbar-width: thin }` pada `@media (pointer: coarse)`), karena aturan "sembunyikan scrollbar" adalah penyebab operator tidak tahu masih ada tab lain.

### C. Pola "Primary + More" untuk layar ≤480 px (rekomendasi utama untuk HP)
Kurangi tab yang tampil langsung dan pindahkan sisanya ke menu overflow:
- **Terlihat langsung (4–5):** FLIGHT, NOTAM, TAF, WX, REPORT.
- **Masuk menu "MORE" (bottom sheet):** DATA (NOTAM UPDATE / FIR UPDATE / WAYPOINT), ROUTE, FIR, FIR NOTAM, CHECKLIST, SETTINGS.
- Keuntungan: strip tidak perlu scroll sama sekali di 360–390 px, semua modul tetap terjangkau, dan submenu DATA tidak lagi bergantung pada satu tab di dalam scroller.
- Baris menu sheet minimal 44–48 px, ikon + label, dan tutup otomatis setelah memilih.

### D. Alternatif paling bersih: bottom navigation / drawer untuk mobile
- Pada ≤768 px, pindahkan navigasi ke **bottom nav** (4–5 tujuan utama) + sheet "More" untuk seluruh modul, atau **hamburger drawer**.
- Keuntungan: menghapus pill sticky 144 px dari atas layar, menghilangkan seluruh masalah overflow/tak-terjangkau, dan memberi tempat alami untuk SETTINGS, profil, dan Logout (chip akun saat ini ikut berebut ruang di baris atas).
- Perlu perhatian: `env(safe-area-inset-bottom)` untuk iPhone, dan `padding-bottom` konten agar tidak tertutup bottom nav.

### E. Jika tetap ingin satu baris atas: chip grid 2 baris
`flex-wrap: wrap` pada strip tab sehingga seluruh 11 tab terlihat sekaligus dalam 2 baris chip (46 px x 2 ≈ 100 px), alih-alih scroll horizontal.
Trade-off: menambah tinggi, tetapi pill-nya sudah 144 px sekarang — jadi ini bisa jadi **lebih hemat** daripada kondisi saat ini, dan tidak ada tab yang tersembunyi.

---

## 4. Perbaikan pendukung (pelengkap, bukan pengganti)

1. **Ringankan baris atas di HP.** Jam UTC + tanggal + LINKS sudah diduplikasi di status strip di bawahnya. Menyembunyikannya pada ≤480 px mengembalikan ~330 px ruang dan membuat nav cukup 2 baris, bukan 3.
2. **Benahi CSS yang disuntikkan dari shim** (`public/cloudflare-shim.js:106`) atau pindahkan aturan itu ke stylesheet utama `src/Index.html` supaya layout navigasi hanya punya satu sumber kebenaran.
3. **Ganti bentuk pill saat multi-baris.** `border-radius: 999px` hanya cocok untuk satu baris. Untuk nav multi-baris gunakan radius tetap (mis. 20–28 px) agar tepi baris tab tidak terpotong.
4. **Label ramah layar kecil.** Singkatkan ("FIR NOTAM" → "FIR-N", "CHECKLIST" → "CHK") atau mode ikon-saja dengan `aria-label`, agar tab dapat mengecil tanpa teks meluber.
5. **Target sentuh.** Setelah tab tidak lagi dipaksa 44 px, pastikan tinggi tetap ≥44 px dan jarak antar tab ≥8 px supaya tidak salah tekan.
6. **Catat ambang batas jumlah tab.** 11 tujuan operasional dalam satu strip horizontal melebihi kapasitas 360–390 px; jadikan ini aturan desain (maksimum ~5 langsung + overflow).
7. **Kinerja mobile (sekunder).** `public/index.html` adalah satu file ~795 KB dengan font Google eksternal; pada koneksi seluler ini memperlambat render pertama dan membuat masalah layout di atas terasa lebih lama. Bukan penyebab, tapi layak dipertimbangkan bersamaan.

---

## 5. Cara memverifikasi setelah perbaikan

Karena `public/index.html` adalah hasil generate (`build.js` membaca `src/Index.html` dan meng-inline `include(...)`), **jalankan `node build.js` sebelum menguji**.

Tambahkan uji browser (pola sudah ada di `tests/*_browser.mjs`, memakai Playwright) pada viewport 360, 390, dan 414 dengan kondisi login, yang memastikan:

1. Setiap `.nav-tab` punya `rect.left >= strip.left` dan `rect.right <= strip.right` **setelah** di-scroll maksimum — yaitu tidak ada tombol yang tidak terjangkau.
2. Jumlah tab yang terlihat penuh = jumlah seluruh tab, **atau** setiap tab yang tersembunyi dapat dibawa masuk dengan scroll dan/atau tersedia di menu overflow.
3. `label` tiap tab berada di dalam kotak tombolnya (`contentNeed <= clientWidth`), sehingga area sentuh = yang terlihat.
4. Setelah `switchTab(x)`, tab aktif berada di dalam viewport.
5. Saat submenu DATA terbuka, tidak ada tab yang meluber melewati batas kanan navigasi.
6. Tidak ada scroll horizontal pada `document.documentElement` (`scrollWidth <= clientWidth`).

---

## 6. Berkas/rujukan yang diperiksa

- `src/Index.html` — markup nav (baris 1418-1474), CSS nav (365-479, 551-707, 827-874), JS `switchTab` (1542-1650), gate akses settings (1698-1725), submenu DATA (1761-1810).
- `public/index.html` — artefak yang benar-benar di-serve (aturan identik, sudah dikonfirmasi).
- `public/cloudflare-shim.js` — login gate (60-94) dan chip akun + CSS `@media(max-width:480px)` (96-121).
- `build.js` — alur build `src` → `public`.
- `scratch/navshot-360.png`, `navshot-390.png`, `navshot-414.png`, `navshot-768.png` — bukti visual kondisi login.
- `scratch/make-nav-probe.mjs`, `scratch/cdp-measure-nav.mjs`, `scratch/make-shot.mjs` — skrip diagnostik (bukan bagian aplikasi; `scratch/` ada di `.gitignore`).
