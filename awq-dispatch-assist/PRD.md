# Product Requirements Document: Dispatch Assist

**Status:** Baseline siap untuk implementasi bertahap  
**Produk:** Dispatch Assist  
**Pengguna utama:** Flight Dispatcher  
**Dokumen ini:** Kebutuhan produk dan perilaku yang disepakati dari percakapan perencanaan. Implementasi belum dimulai sebagai bagian dari penyusunan PRD ini.

## 1. Ringkasan Produk

Dispatch Assist adalah dashboard dispatcher untuk menganalisis laporan cuaca terhadap flight yang dipilih dari Flight Board. Produk menggabungkan konteks flight, TAF/weather, NOTAM dari AWQ Cloud, data minima airport, serta aturan dari Operations Manual Part A dan Flight Dispatch Manual.

Sistem menyajikan **Assessment outcome** sebagai dukungan keputusan dispatcher. Hasilnya bukan dispatch release dan bukan sertifikasi kepatuhan. Assessment harus dapat ditelusuri ke data dan referensi yang digunakan, disimpan sebagai snapshot, dan diekspor ke PDF.

## 2. Masalah yang Diselesaikan

Informasi flight, weather, NOTAM, minima, dan manual tersebar. Dispatcher membutuhkan satu workspace yang:

- Mengaitkan analisis dengan flight yang dipilih.
- Menguji weather pada waktu dan lokasi yang tepat.
- Mengevaluasi destination dan minimal satu alternate.
- Menjelaskan dampak minima, NOTAM, dan fuel dengan referensi yang dapat diperiksa.
- Menyimpan hasil yang bisa diaudit dan diekspor.

## 3. Pengguna

### Pengguna utama

Flight Dispatcher yang meninjau kondisi operasional, menilai alternate, melihat kebutuhan fuel yang memiliki dasar manual, dan menyiapkan assessment untuk review.

### Pengguna pendukung

Duty Manager, Flight Operations Manager, Safety/Compliance reviewer, serta pilot atau operational reviewer yang membutuhkan hasil dan bukti assessment.

## 4. Tujuan dan Batas Produk

### Tujuan

1. Memilih flight dari Flight Board dan memulai analisis dari konteks flight tersebut.
2. Menghitung ETA window destination dan satu primary alternate dengan DOF dan waktu Zulu.
3. Mengevaluasi TAF, weather, minima, NOTAM, alternate, dan fuel berdasarkan data serta aturan yang memiliki sumber.
4. Menampilkan citation clause dan halaman untuk keputusan fuel/minima.
5. Membuat assessment snapshot yang immutable dan PDF yang identik dengan snapshot yang direview.
6. Menyediakan assistant AI yang menjelaskan sumber dan hasil assessment.

### Batas release pertama

- Satu primary alternate; secondary alternate belum didukung payload AWQ Cloud.
- Setiap flight wajib memiliki minimal satu alternate. Pengecualian isolated aerodrome tidak diterapkan.
- Fuel burn rate per aircraft dan konversi fuel ke kilogram tidak termasuk scope.
- Perhitungan runway-in-use dan wind limitation tidak termasuk scope.
- Automatic alternate nomination tanpa pemilihan/approval dispatcher tidak termasuk scope.
- TAF3 exemption tidak diterapkan karena sumber yang disetujui untuk aturan produk adalah OM-A dan Dispatch Manual.
- CASR tidak digunakan sebagai reference manual.

## 5. Referensi dan Urutan Otoritas

### Aturan operasional

- Operations Manual Part A (OM-A), Doc. No. IAA/FOP/M/001.
- Flight Dispatch Manual, Doc. No. IAA/FOP/M/008.

OM-A menjadi rujukan utama. Dispatch Manual menjadi prosedur pendukung. Jika ada konflik, sistem harus menampilkan `REVIEW REQUIRED` dan tidak menyelesaikannya secara diam-diam.

CASR harus dikeluarkan dari reference library, clause references, prompt AI, search index, dan laporan.

### Sumber data minima

Database minima Cloudflare menggunakan **AIP yang berlaku untuk aerodrome terkait** sebagai sumber data approach chart/minima. Gunakan publikasi AIP dari otoritas AIS yang sesuai untuk negara/aerodrome tersebut; chart contoh YPPH berasal dari Airservices Australia. AIP adalah sumber data minima, sedangkan OM-A dan Dispatch Manual tetap menjadi sumber aturan perusahaan tentang cara menerapkan minima. Penggunaan AIP untuk data minima tidak memperluas sumber aturan evaluasi TAF; TAF3 exemption tetap di luar scope.

File sumber airport chart disimpan sebagai PDF saja di R2 bucket `awq-dispatch-documents`, prefix `airport/`; YPPH sudah tersedia di lokasi tersebut. Jangan membuat atau mensyaratkan file Markdown sidecar. PDF asli menjadi bukti sumber dan rujukan audit. Jika sistem membutuhkan pencarian teks, gunakan ekstraksi/index turunan yang dapat dibangun ulang dari PDF; ekstraksi tersebut bukan sumber kebenaran numerik. Layout tabel, kategori, simbol, dan peta dapat menjadi ambigu saat PDF diratakan menjadi teks. Angka minima yang digunakan engine harus masuk ke record terstruktur di database dan diverifikasi terhadap PDF chart oleh reviewer.

AI dapat mengekstrak informasi dari PDF dan mengisi **draft** minima, termasuk airport, chart identifier, halaman, runway, approach type, kategori aircraft, jenis/nilai/unit minima, dan effective date/siklus jika terbaca. Simpan hubungan setiap nilai dengan halaman/area sumbernya jika dapat ditentukan. AI tidak boleh menebak nilai yang tidak terbaca; tandai sebagai perlu pemeriksaan. Draft tidak dapat digunakan oleh assessment sampai dispatcher berakses `ADMIN` membandingkannya dengan PDF asli dan menyetujui record. Simpan nilai hasil ekstraksi, koreksi admin, identitas approver, dan waktu persetujuan dalam audit history.

Setiap record minima harus menyimpan negara/otoritas AIS, aerodrome, chart identifier, runway, approach type, kategori aircraft, nilai minima dan unit, jenis nilai (misalnya DA/H, visibility/RVR), nomor halaman, siklus/revision AIP, effective date, R2 object key, PDF hash, status verifikasi, approver, dan timestamp. Dispatcher yang memiliki akun AWQ dengan akses `ADMIN` dapat memeriksa dan menyetujui transkripsi angka minima dari PDF AIP sebelum record dapat digunakan assessment. Jangan menentukan validity dari nama file saja; gunakan identitas dan tanggal efektif yang ditetapkan publikasi AIP serta mekanisme update yang berlaku.

### Citation

Citation untuk keputusan fuel/minima wajib menyertakan:

- Nama dan nomor dokumen.
- Revision dokumen yang digunakan.
- Clause atau nama tabel.
- Nomor halaman.
- Kutipan atau ringkasan teks yang mendukung assessment.

Jika citation wajib tidak lengkap, aturan terkait tidak boleh dipakai untuk menghasilkan hasil yang tampak terverifikasi; tandai `REVIEW REQUIRED`.

## 6. Workflow Utama

1. Dispatcher memilih flight dari Flight Board.
2. Dispatch Assist membuat Flight Notebook untuk flight tersebut.
3. Sistem menampilkan flight context, DOF, route, destination, STA, dan alternate.
4. Sistem mengambil weather dan NOTAM dari AWQ Cloud; dispatcher memilih NOTAM yang relevan.
5. Sistem memuat minima dari database airport yang disetujui.
6. Deterministic assessment menghitung ETA window dan mengevaluasi cuaca, minima, NOTAM, alternate, dan fuel yang bersumber.
7. Dispatcher memeriksa evidence dan citation. AI dapat menjelaskan assessment berdasarkan sumber yang tersedia.
8. Sistem menyimpan immutable snapshot.
9. Dispatcher mengekspor PDF yang dibuat dari snapshot tersebut.

## 7. Aturan ETA dan Waktu

Semua pencocokan cuaca harus menggunakan DOF, waktu UTC/Zulu, validity period, lokasi, dan ETA window yang sesuai. Data yang tidak cocok waktunya atau sudah tidak valid tidak boleh dianggap evidence yang valid.

### Destination

`Destination ETA window = STA - 1 jam sampai STA + 1 jam`.

### Primary alternate

Jika diversion time tersedia:

`Alternate nominal ETA = Destination STA + diversion time`

`Alternate ETA window = Alternate nominal ETA ± 1 jam`

Jika diversion time tidak tersedia:

- Default diversion time adalah **2 jam**.
- Alternate ETA window menjadi **Destination STA + 1 jam sampai Destination STA + 3 jam**.
- UI dan PDF wajib menyebut `Default diversion time: 2 hours` serta `Source diversion time unavailable`.
- Jika diversion time diperbarui, sistem menghitung ulang dan menyimpan assessment snapshot baru.

## 8. Weather dan TAF

Sistem mengevaluasi prevailing conditions dan change groups yang waktunya beririsan dengan ETA window, termasuk FM, BECMG, INTER, TEMPO, dan PROB. Evaluasi mencakup visibility, ceiling, wind, serta fenomena weather relevan seperti TS, SH, FG, BR, HZ, DS/SS, dan presipitasi kontinu, sejauh tersedia pada data.

### Destination TEMPO dan PROB

Rujukan: **OM-A, Doc. IAA/FOP/M/001, §8.1.6.4, Tabel 8.1-20 (lanjutan), halaman 8.1-47**, tabel *Application of Forecast Following Change Indicators in TAF and Trend*.

Untuk kolom `DEST AT ETA ±1HR`, pada `TEMPO (alone)`, `TEMPO FM`, `TEMPO TL`, dan `PROB 30/40 (alone)`:

- Deterioration transient/showery, contohnya TS dan SH: `Not applicable`.
- Deterioration persisten/kontinu, contohnya HZ, BR, FG, DS/SS, dan presipitasi kontinu: `Applicable`.
- Improvement pada grup tersebut harus diabaikan untuk perencanaan minima.

Untuk `PROB TEMPO`:

- Deterioration boleh diabaikan sesuai tabel.
- Improvement harus diabaikan, termasuk mean wind dan gusts.

Interpretasi ini berlaku untuk destination. Jangan menerapkannya otomatis pada alternate tanpa dasar tabel/aturan yang sesuai.

Aturan TAF3 exemption tidak diterapkan pada release pertama karena bukan bagian dari sumber yang disepakati.

## 9. Minima, Airport, dan NOTAM

### Minima

Database minima sekurang-kurangnya menyimpan negara/otoritas AIS, ICAO, chart identifier, runway, approach type, aircraft category, jenis/nilai/unit landing minima, alternate minima bila tercantum, nomor halaman, siklus/revision AIP, validity/effective date, R2 object key, PDF hash, status approval/verifikasi, identitas dan role approver, waktu persetujuan, dan riwayat perubahan.

Rekomendasi tata kelola:

- PDF AIP asli di R2 dipertahankan sebagai satu-satunya file sumber; Markdown sidecar tidak digunakan.
- Data baru atau perubahan minima ditinjau terhadap PDF chart dan disetujui oleh dispatcher berakun AWQ dengan akses `ADMIN` sebelum dipakai assessment.
- Data tanpa sumber/revision, belum disetujui, atau kedaluwarsa dianggap unavailable.
- Minima unavailable menghasilkan `REVIEW REQUIRED`.
- Riwayat nilai yang diganti tetap tersimpan untuk audit.

### NOTAM

- NOTAM diambil dari AWQ Cloud dan dipilih manual oleh dispatcher.
- Pilihan otomatis dibatasi berdasarkan airport dan validity period yang relevan.
- Assessment tetap dapat dibuat walaupun daftar NOTAM belum diperiksa.
- Jika belum diperiksa, tampilkan `NOTAM REVIEW PENDING`; status itu tidak boleh ditampilkan sebagai kondisi NOTAM bersih.
- Catat NOTAM yang dipilih, airport, validity, source, dan waktu pengambilan.

Evaluasi harus dapat menandai dampak seperti ILS U/S, runway closure, approach/lighting unavailable, dan restriction jika informasinya terdapat pada NOTAM.

## 10. Alternate

- Setiap flight harus memiliki minimal satu alternate.
- Release pertama mendukung satu primary alternate.
- Secondary alternate belum tersedia dalam payload saat ini.
- Alternate dinilai terhadap ETA window, weather, landing minima, alternate planning minima, dan NOTAM yang tersedia.
- Jika alternate yang dipilih tidak memenuhi kriteria, sistem menampilkan alasan dan merekomendasikan dispatcher memilih alternate lain.
- Ketidaksesuaian satu alternate tidak otomatis menghasilkan `NO-GO`. Assessment menunggu alternate pengganti atau review yang diperlukan.
- Sistem tidak memilih alternate pengganti secara otomatis.

Status alternate yang dapat digunakan: `Suitable`, `Suitable with additional fuel`, `Marginal`, `Not suitable`, `Not assessed`, dan `Review required`.

## 11. Fuel Evaluation

Pisahkan fuel requirement yang bersumber dari manual, fuel padding standar, dan informasi yang belum dapat dinilai. Jangan mengubah waktu menjadi kilogram karena fuel burn rate per aircraft tidak termasuk scope.

### Tambahan holding 30 menit pada destination alternate TEMPO

Rujukan: **OM-A, Doc. IAA/FOP/M/001, Bab 8, bagian Destination Alternate, halaman 8.1-47**; teks berada sebelum subjudul *En-route Meteorological Data*.

Untuk destination alternate dengan forecast TEMPO di bawah planning minima pada ETA ±1 jam, alternate dapat dipertimbangkan jika:

1. Kondisi meteorologi di atas applicable landing minima.
2. Kondisi destination pada atau di atas destination alternate planning minima.
3. Tambahan holding fuel 30 menit dibawa.

Teks ini tidak menetapkan aturan `TEMPO tanpa alternate = 60 menit`. Sistem tidak boleh menyatakan aturan 60 menit tersebut sebagai OM-A atau Dispatch Manual requirement.

### Standard fuel padding 10 menit @ 1.500 ft

Rujukan: **Flight Dispatch Manual, Doc. IAA/FOP/M/008, Bab 5, tabel FUEL PADDING - Standard, halaman tercetak 5.11-16**.

Tambahan 10 menit @ 1.500 ft wajib disertakan apabila salah satu kriteria berikut terpenuhi:

1. Pada ETA ±1 jam, ceiling/visibility destination berada pada atau di bawah planning minima yang diperlukan untuk Destination Alternate; atau
2. Pada ETA ±1 jam, visibility destination ≤ 3.000 m **dan** TSRA.

Kriteria tambahan lain tidak boleh diasumsikan dari rangkuman sebelumnya jika belum memiliki citation lengkap.

## 12. Assessment Outcome

Gunakan label **Assessment outcome**. Hasil adalah dukungan keputusan dispatcher, bukan dispatch release atau compliance certification.

| Kondisi | Outcome/perilaku |
|---|---|
| Minima atau citation fuel/minima yang dibutuhkan tidak tersedia/tidak lengkap | `REVIEW REQUIRED` |
| NOTAM belum diperiksa | Assessment tetap dapat dibuat; tampilkan `NOTAM REVIEW PENDING` dan jangan menyiratkan NOTAM sudah bersih |
| Alternate belum dipilih | Assessment draft dapat dibuat; outcome `REVIEW REQUIRED` sampai alternate ditetapkan |
| Alternate yang dipilih tidak sesuai | Tampilkan alasan dan rekomendasikan pemilihan alternate lain; jangan otomatis menetapkan `NO-GO` |
| Konflik manual atau aturan yang tidak dapat ditentukan dari evidence | `REVIEW REQUIRED` |
| Semua data wajib lengkap dan kriteria yang bersumber terpenuhi | `GO`, sebagai dukungan keputusan dispatcher |
| Evidence menunjukkan kriteria manual tidak terpenuhi | `NO-GO` |
| Kondisi berada di ambang yang ditentukan manual atau memerlukan penilaian dispatcher | `MARGINAL` atau `REVIEW REQUIRED` sesuai aturan yang memiliki sumber |

`MARGINAL` tidak boleh menggunakan ambang buatan produk. Jika manual tidak menetapkan ambang atau tidak cukup untuk mengklasifikasikan situasi, gunakan `REVIEW REQUIRED`.

## 13. AI Assistant

Model DeepSeek gateway yang digunakan saat ini tetap tersedia. Integrasi harus memungkinkan penambahan provider/model lain melalui API.

AI boleh menjelaskan assessment, merangkum manual, menjawab pertanyaan sumber, dan menunjukkan data yang kurang. AI tidak boleh:

- Mengubah outcome deterministic engine.
- Membuat atau menebak citation.
- Menggunakan CASR atau sumber di luar Flight Notebook untuk menjawab assessment.
- Menetapkan fuel requirement tanpa citation.
- Memilih alternate atau memberi dispatch release.

## 14. Flight Notebook dan Dashboard

Nama produk adalah **Dispatch Assist**. Dashboard menggunakan gaya dark operations cockpit AWQ Cloud dengan tampilan profesional, bersih, dan lapang. Gunakan token warna dari design system proyek:

| Peran | Warna |
|---|---|
| Latar utama | `#11161d` |
| Permukaan sekunder | `#171e27` |
| Permukaan elevated | `#202a35` |
| Teks utama | `#f2f5f7` |
| Teks sekunder | `#aab6c2` |
| Border utama | `#30404d` |
| Aksen AWQ amber | `#e6a93a` |
| Status berhasil | `#5ec28b` |
| Status warning | `#e6a93a` |
| Status error | `#e47777` |
| Status informasi | `#78b7d8` |

Gunakan layout lapang yang mudah dibaca; tampilkan ringkasan utama dan biarkan dispatcher membuka detail saat diperlukan. Status wajib memiliki label teks dan ikon, jadi warna hanya memperkuat makna.

### Struktur desktop

Gunakan layout dua panel:

- **Panel analisis utama:** konten analisis flight.
- **Sidebar yang dapat dibuka/tutup:** memiliki dua tab, **Flight context** dan **Assessment details**.

Assessment outcome tetap terlihat sebagai status ringkas di header walaupun sidebar ditutup. Detail outcome, risks, evidence, fuel recommendation, dan alternate recommendation tersedia pada tab **Assessment details**.

### Urutan dan isi panel analisis

1. **Perbandingan cuaca:** destination dan primary alternate ditampilkan berdampingan. Setiap kolom menampilkan ICAO, ETA window, weather ringkas, dan data freshness.
2. **Fuel dan alternate recommendation.**
3. **Minima dan NOTAM.**

TAF ditampilkan sebagai prevailing dan conditional weather. Change groups seperti TEMPO/PROB dapat dibuka untuk melihat periode dan detail. Citation ditampilkan dengan nomor rujukan di dekat temuan; citation lengkap dikumpulkan dalam daftar di akhir assessment.

### Flight context dan pemilihan alternate

Tab **Flight context** menampilkan flight identity, DOF, route, destination, STA, alternate, diversion time, source checklist, freshness, dan data gaps.

Dispatcher mencari airport dari database dan memilih alternate secara manual. Sebelum pilihan dikonfirmasi, tampilkan ringkasan minima dan status ketersediaan/approval datanya. Sistem tidak memilih alternate secara otomatis.

### Aksi utama

- Tombol utama bersifat kontekstual: arahkan dispatcher ke data yang perlu ditinjau jika ada blocker; setelah review selesai, aksi utama dapat menjadi **Buat PDF**.
- **Pilih/ganti alternate** tetap tersedia sebagai tombol kedua.
- PDF boleh dibuat ketika assessment masih `REVIEW REQUIRED` atau `NOTAM REVIEW PENDING`, tetapi PDF harus menampilkan status tersebut dengan jelas, termasuk label draft bila sesuai.

### Visual status dan kondisi data

- Status seperti `GO`, `NO-GO`, `MARGINAL`, `REVIEW REQUIRED`, dan `NOTAM REVIEW PENDING` harus memakai warna, label teks, dan ikon. Makna status tidak boleh bergantung pada warna saja.
- Gunakan skeleton saat data sedang dimuat.
- Tampilkan banner yang jelas untuk error, data stale, dan data unavailable, beserta waktu pembaruan. Sediakan aksi coba lagi bila relevan.
- Source state harus membedakan available/current, stale, missing, manual selection pending, dan not selected.
- Aksi utama dapat digunakan dengan keyboard, indikator fokus selalu terlihat, dan kontras teks mendukung keterbacaan.

### Layout tablet dan ponsel

- **Tablet:** sidebar menjadi drawer yang dapat dibuka/tutup; analisis tetap menjadi area utama.
- **Ponsel:** layout responsif penuh dengan analisis satu kolom. Sidebar menjadi drawer layar penuh.
- Di ponsel, Assessment outcome tetap terlihat sebagai header ringkas yang menempel saat halaman digulir.

### PDF

Gunakan gaya laporan operasional formal dengan branding AWQ Cloud, tabel yang mudah dicetak, dan tata letak lebih sederhana daripada dashboard. Isi dan status PDF harus mengikuti assessment snapshot yang direview.

### Language policy

- Seluruh UI produk ditulis dalam bahasa Inggris, termasuk navigasi, label, tombol, validasi, error, notifikasi, status, tooltip, dan laporan/PDF.
- Source code ditulis dalam bahasa Inggris, termasuk identifiers, comments, test names, dan developer-facing messages.
- In-app Knowledge Assistant mendukung English dan Indonesian. Secara default, balasan mengikuti bahasa pesan dispatcher; dispatcher dapat meminta pergantian bahasa kapan saja. Fixed UI chrome, istilah assessment, dan laporan/PDF tetap berbahasa Inggris.
- Percakapan Codex/Harness dengan user boleh menggunakan bahasa Indonesia.

### Area produk terkait

- **Knowledge Assistant:** tanya jawab yang grounded pada dokumen dan evidence flight.
- **Reference Manuals/Documents:** OM-A dan Dispatch Manual yang berlaku serta dokumen flight terkait.

## 15. Snapshot, Audit, dan PDF

Setiap assessment disimpan sebagai immutable snapshot. Snapshot menyertakan:

- Flight inputs termasuk DOF, STA, destination, alternate, dan diversion time.
- Default yang diterapkan dan keterangannya.
- Weather/TAF yang digunakan, validity, source, dan waktu pengambilan.
- NOTAM terpilih, status review, validity, source, dan waktu pengambilan.
- Minima dan chart source/revision.
- Rule-engine version, hasil evaluasi, evidence, citation, outcome, timestamp, serta reviewer jika tersedia.

PDF release pertama harus dibuat dari snapshot tersimpan, bukan dari data live yang dapat berubah. PDF harus menampilkan informasi yang sama dengan assessment yang direview, termasuk data gaps, asumsi, citation, status NOTAM, dan Assessment outcome. Perubahan data menghasilkan snapshot dan PDF baru; versi lama tetap dapat diaudit.

## 16. Kebutuhan Fungsional

### P0 - wajib release pertama

- Membatasi akses Dispatch Assist kepada dispatcher dengan akun AWQ dan akses `ADMIN`.
- Mengizinkan dispatcher berakses `ADMIN` meninjau dan menyetujui minima AIP; simpan identitas approver dan waktu persetujuan.
- Mengekstrak kandidat minima dari PDF AIP ke draft terstruktur yang belum aktif sampai disetujui dispatcher `ADMIN`.
- Memilih flight dari Flight Board.
- Membentuk Flight Notebook per flight.
- Menghitung ETA window sesuai DOF/UTC dan default diversion time.
- Mengambil dan mengevaluasi TAF/weather dalam ETA window.
- Memilih NOTAM dari AWQ Cloud dengan filter airport dan validity.
- Menampilkan status pending jika NOTAM belum diperiksa tanpa memblokir pembuatan assessment.
- Memuat minima dari database airport dan menandai data/citation yang hilang.
- Mengevaluasi satu alternate wajib.
- Menghitung hanya fuel rule yang didukung citation manual lengkap.
- Menyimpan assessment snapshot immutable.
- Menghasilkan PDF dari snapshot.
- Menampilkan clause dan page citation.
- AI grounded pada sumber dan assessment yang dipilih.

### P1 - peningkatan setelah alur inti

- Evidence drawer untuk membuka source/citation dari tiap status.
- Riwayat snapshot dan perbandingan perubahan assessment.
- Pengelolaan approval/revision database minima.
- Penambahan provider/model AI.

## 17. Kriteria Penerimaan

1. Flight yang dipilih menjadi konteks semua weather, NOTAM, minima, assessment, dan PDF.
2. Destination ETA window adalah STA ±1 jam.
3. Jika diversion time unavailable, UI dan PDF menampilkan default 2 jam dan alternate window STA destination +1 sampai +3 jam.
4. TAF dievaluasi berdasarkan DOF, UTC, validity, airport, dan ETA window.
5. Tabel TEMPO destination diterapkan sesuai OM-A §8.1.6.4, Tabel 8.1-20 lanjutan, halaman 8.1-47.
6. TAF3 exemption tidak dijalankan.
7. Setiap flight memerlukan minimal satu alternate; isolated aerodrome exception tidak diterapkan.
8. Minima unavailable atau citation minima/fuel tidak lengkap menghasilkan `REVIEW REQUIRED`.
9. Assessment dapat dibuat ketika NOTAM belum diperiksa, dengan `NOTAM REVIEW PENDING` yang terlihat.
10. Alternate yang tidak sesuai memunculkan alasan dan rekomendasi memilih alternate lain, bukan otomatis `NO-GO`.
11. Holding 30 menit dan fuel padding 10 menit hanya muncul dengan kondisi serta citation yang tercantum di PRD.
12. Tidak ada aturan resmi `TEMPO tanpa alternate = 60 menit`.
13. AI tidak mengubah outcome dan tidak menghasilkan citation tanpa sumber.
14. PDF sama dengan snapshot yang direview dan tetap bisa diaudit setelah data live berubah.
15. CASR tidak muncul di reference corpus maupun output.
16. Pada desktop, assessment menggunakan dua panel dengan sidebar yang dapat ditutup dan dua tab: Flight context dan Assessment details.
17. Assessment outcome ringkas tetap terlihat di header saat sidebar ditutup dan saat halaman ponsel digulir.
18. Destination dan alternate ditampilkan berdampingan; TAF conditional details dapat dibuka sesuai kebutuhan.
19. Nomor citation terlihat di dekat temuan dan daftar citation lengkap berada di akhir assessment.
20. Dispatcher dapat memilih alternate secara manual dari pencarian database setelah melihat minima dan status datanya.
21. Aksi utama menyesuaikan status assessment; aksi pilih/ganti alternate selalu tersedia sebagai tombol kedua.
22. PDF dapat dibuat untuk assessment yang belum selesai dan label status review tampil jelas.
23. Layout tablet menggunakan drawer sidebar; layout ponsel satu kolom dengan drawer layar penuh.
24. Loading, error, stale, dan unavailable states memiliki tampilan yang jelas; status memiliki warna, teks, dan ikon.
25. PDF menggunakan desain formal yang ramah cetak dengan branding AWQ Cloud.
26. Aksi utama dapat diakses dengan keyboard, fokus terlihat, dan kontras teks memadai.
27. AIP PDF di R2 menjadi satu-satunya file sumber; tidak ada Markdown sidecar; angka minima diverifikasi terhadap PDF dan disimpan dalam record terstruktur.
28. Hanya dispatcher dengan akun AWQ berakses `ADMIN` yang dapat memakai Dispatch Assist dan menyetujui record minima; setiap persetujuan tercatat dengan identitas dan waktu.
29. AI dapat mengisi draft minima dari PDF, tetapi draft tidak digunakan assessment sebelum persetujuan `ADMIN`; nilai yang tidak terbaca ditandai, tidak ditebak, dan koreksi tercatat.
30. UI dan laporan/PDF menggunakan bahasa Inggris; source code ditulis dalam bahasa Inggris; Knowledge Assistant mendukung English dan Indonesian serta mengikuti bahasa pesan dispatcher secara default.

## 18. Risiko dan Mitigasi

| Risiko | Mitigasi produk |
|---|---|
| Data minima salah atau kedaluwarsa | Approval, source/revision, effective date, dan audit history; data tidak valid menjadi unavailable |
| Weather atau NOTAM di luar validity | Filter validity dan tampilkan source timestamp/status |
| AI memberi jawaban tanpa dasar | Grounding ke evidence terpilih, citation wajib, AI tidak dapat mengubah outcome |
| Assessment dianggap dispatch release | Label Assessment outcome dan keterangan batas penggunaan pada UI/PDF |
| Ambang outcome tidak ada di manual | Jangan membuat ambang sendiri; gunakan `REVIEW REQUIRED` |
| Manual berubah | Simpan revision sumber pada snapshot dan tandai data/rules yang perlu diperbarui |

## 19. Hal Teknis untuk Sesi Implementasi

Hal-hal berikut dapat diselesaikan dengan inspeksi sistem dan keputusan desain implementasi, tanpa mengubah aturan operasional yang telah disepakati:

- Kontrak endpoint aktual untuk flight board, weather, NOTAM, assessment, dan report.
- Skema Cloudflare untuk airport/minima, versioning, approval, dan audit history.
- Proses memperoleh AIP yang berlaku per negara/aerodrome, menentukan siklus efektif, dan memutakhirkan database minima.
- Tata letak PDF dan identitas reviewer yang tersedia dari sistem.
- Implementasi backend snapshot dan penyimpanan artefak PDF.

Jika AIP yang berlaku atau approval minima belum tersedia saat implementasi, gunakan status unavailable/`REVIEW REQUIRED`; jangan mengisi minima dengan asumsi.

## 20. Deployment dan Go-live

- Target production: `assist.christiandaniel.my.id`.
- Release pertama dideploy langsung ke production; staging terpisah tidak diwajibkan.
- Sebelum migrasi database production, buat backup. Jika deployment gagal, rollback versi aplikasi tanpa otomatis memulihkan database.
- Setelah deployment dan smoke test lulus, aplikasi dapat langsung digunakan oleh dispatcher `ADMIN`; tidak ada persetujuan UAT terpisah sebagai release gate.
- Smoke test minimum memeriksa login dan akses `ADMIN`, pemilihan flight dari Flight Board, pemuatan data integrasi, perilaku `REVIEW REQUIRED` saat minima belum disetujui, status NOTAM yang belum diperiksa, serta pembuatan dan pembacaan kembali PDF dari snapshot.
- Jika smoke test gagal, penggunaan operasional ditunda dan versi aplikasi sebelumnya dipulihkan sesuai prosedur rollback.
