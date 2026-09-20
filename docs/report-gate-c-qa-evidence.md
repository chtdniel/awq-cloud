# Gate C — QA Matrix and Evidence Package

> ## ⛔ RENCANA DIHENTIKAN — 2026-09-20 (dokumen historis)
>
> Pekerjaan Report Handoff dihentikan. Paket ini **bukan** dokumen kerja aktif dan **tidak** menunggu
> kelanjutan apa pun: tidak ada Gate D, tidak ada deploy produksi, tidak ada QA tambahan.
>
> Isinya tetap valid sebagai catatan: apa yang diuji, apa hasilnya, dan defect apa yang ditemukan.
> Satu hal yang harus dibaca meski rencana berhenti:
>
> - **`reportFindBlockingRequest_` memblokir request baru bila request sebelumnya sudah `SUCCEEDED`** (§6.3 #1).
>   Ia bug produk, sudah diperbaiki, dan fix itu **kini live di deployment staging** — tetapi
>   `archive/Report_Handoff.gs` yang memuatnya **belum pernah melewati review produksi**.
> - **Produksi tidak pernah disentuh.** `public/index.html` tidak diregenerasi, jadi fitur ini tidak ada
>   di shell produksi.

**Gate:** PRD §11 Gate C (staging/manual QA) — *not* production approval.
**Scope:** 1/2/3/4-flight selections, failure modes, and template/data fidelity for the Web 2 → Web 1 report handoff.
**Status akhir:** QA staging selesai; **rencana dihentikan sebelum Gate D**.

---

## 1. What was tested, and how

| Layer | Implementation | Automation |
|---|---|---|
| Web 2 handoff (`src/Report_Ui.html`) | real inline script, extracted and executed unmodified except the documented test hooks | automated |
| Web 1 (`archive/Report.html`) | real page, served as-is | automated |
| Apps Script RPC boundary | deterministic `google.script.run` stub | mocked (no real Sheet) |
| Apps Script deployment | live staging, anonymous path | automated |
| Apps Script deployment, authenticated + generated Sheet | live staging + operator Google session | **manual (operator)** |
| Mozilla Firefox | real Firefox, live staging | **manual (operator)** |

Everything runs offline against one long-lived fixture server set (`8788` Web 2, `8789` Web 1, `8790` unrelated origin). Concurrent suites queue on the port rather than failing.

### Test hooks added to `src/Report_Ui.html` (test-only)

| Hook | Purpose | Production effect |
|---|---|---|
| `window.__REPORT_WEB1_URL_OVERRIDE` | point the handoff at the local Web 1 fixture instead of the deployed URL | none unless set |
| `window.__REPORT_READY_TIMEOUT_MS` | shorten the 30 s readiness window for boundary tests | none unless set |
| `window.__gatecPendingHandoff` | expose the pending `{nonce, reportRequestId}` for assertions | write-only global |
| `window.__gatecContextSent` / `window.__gatecTransferState` | expose transfer state transitions for assertions/evidence | write-only globals |

No validation, allowlist, timeout ordering, or generation rule was weakened.

### How the fixture serves the Apps Script boundary

The fixture Web 1 tab is the shipped page plus an injected `google.script` stub. The stub's `getLocation` callback supplies the fragment value (in production Apps Script supplies it from the real URL fragment), so the shipped `READY` path — nonce match, source-origin allowlist, `window.top.opener` relationship — runs unmodified. Because browsers strip the URL fragment from HTTP requests, the fixture learns the live nonce out of band and reloads the tab for each handshake; the harness documents this in `tests/gatec_harness.mjs`.

---

## 2. Automated results (2026-09-19/20, this checkout)

Run:

```powershell
cd "C:\Users\chris\OneDrive\Desktop\AWQ - CLOUD"
node tests/pull_staging_ad_notams.mjs   # tarik korpus aerodrome nyata dari staging (sekali; read-only)
npm run test:gatec                      # matrix + failure modes + Web 1 interop + summary
npm run test:gatec:smoke                # live staging deployment, anonymous path
```

| Suite | Result | Checks |
|---|---|---|
| Aerodrome-only rule, shipped code × 1/2/3/4 flight (`tests/test_gatec_aerodrome_only.mjs`) | **PASS** | 42/42 |
| Operator harness contract (`tests/test_gatec_operator_harness.mjs`) | **PASS** | 45/45 |
| Browser × selection matrix (Chrome 153, Edge 153, Chromium 153 × 1/2/3/4 flights) | **PASS** | 12/12 |
| Failure modes (same three engines × 11 scenarios) | **PASS** | 33/33 |
| Web 1 state-machine interop (same three engines × 8 scenarios) | **PASS** | 24/24 |
| Live staging deployment smoke (anonymous) | **PASS** | 12/12 |

Angka di atas adalah hasil run **setelah** deploy aerodrome-only (2026-09-20 ~16:0x lokal). Dua suite pertama baru: keduanya menjalankan kode yang benar-benar dikirim, bukan salinannya. `npm run test:gatec` sekarang menjalankan keduanya lebih dulu, jadi fixture yang rusak ketahuan sebelum suite browser yang mahal berjalan.

- `test_gatec_aerodrome_only.mjs` menjalankan `getReportNotamContext()` dari `src/Notam_Ui.html` **dan** `getReportWeb1Payload()` dari `src/Report_Ui.html` di dalam satu VM context dengan DOM stub, lalu menuntut: payload bebas stasiun FIR, tidak ada ID FIR yang lolos, `droppedFirWide` = jumlah baris FIR, tiap baris FIR yang terseleksi disebut di `dropped[]`, tidak ada NOTAM aerodrome yang ikut dibuang, dan satu kontrol negatif (respons tanpa baris FIR → tidak ada yang dibuang).
- `test_gatec_operator_harness.mjs` mem-parse halaman harness operator, memastikan blok aturan **asli** yang diekstrak dari `src/Notam_Ui.html` benar-benar ada dan tidak ada mock pengganti, serta bahwa capture fidelitas per ukuran seleksi lengkap untuk 1/2/3/4.

### 2.1 Verifikasi deploy aerodrome-only (2026-09-20)

Deployment staging **sudah memuat build aerodrome-only**. Yang diperiksa bukan sekadar "ada penanda", tetapi **fragmen kode yang persis** dari file lokal, diambil dari halaman sandbox Apps Script lalu di-decode (`scratch/verify_deployed_fragments.mjs`):

| Paruh | Fragmen yang dicocokkan verbatim | Hasil |
|---|---|---|
| Web 2 | `window.reportStationSet = function(flights)`, `window.isAerodromeReportNotam = function(notam, stationSet)`, `window.reportNotamScope.dropped.push({…})`, `rule: 'AERODROME_ONLY',`, `notamScope: notamScope,`, `window.openReportWeb1 = function() {` | **6/6 ada** |
| Web 1 | `rows += '<div class="kv"><b>Scope rule</b><span>AERODROME ONLY</span></div>';`, `' NOTAM tidak dimasukkan (bukan aerodrome)'`, `msg.warning = String(arguments[2]);`, `GENERATE GOOGLE SHEET` | **4/4 ada** |

Tambahan bukti bahwa build benar-benar berubah: dokumen `/exec` tumbuh 894.262 → **920.790** byte dan `?page=report` 32.124 → **33.672** byte, dan sebelum paste kesepuluh fragmen itu **0×** ada di deployment.

**Penting — `?page=report` bukan satu-satunya permukaan.** Sebelum deploy, Web 2 di deployment yang sama juga **belum punya `openReportWeb1`/`REPORT_WEB1_URL`** (handoff Gate B belum pernah ter-publish ke sana). Jadi `src/Notam_Ui.html` **dan** `src/Report_Ui.html` memang wajib ikut di-paste, bukan hanya `archive/Report.html`.

`npm run test:gatec:smoke` sesudah deploy: **PASS 12/12** (anonim, fail-closed, `templates CBR1/CBR2/CBR4` ada, `REPORT_AUDIT` ada, `activeUser: ""`).

---

### 2.2 Aerodrome-only NOTAM scope (aturan baru)

Report membawa **NOTAM aerodrome saja**. Aturannya ada di `src/Notam_Ui.html`:

- `window.reportStationSet(flights)` membangun himpunan stasiun aerodrome dari flight terpilih (DEP/ARR/ALT/ENR1-3).
- `window.isAerodromeReportNotam(notam, stationSet)` menerima NOTAM hanya jika `notam.station` ada di himpunan itu. NOTAM FIR/UIR dikunci oleh designator FIR-nya, jadi tidak pernah cocok dan dibuang.
- `getReportNotamContext()` mencatat yang dibuang ke `window.reportNotamScope`; `getReportWeb1Payload()` mengirimnya sebagai `notamScope { rule: 'AERODROME_ONLY', droppedFirWide, dropped[] }`.
- Drop terjadi **sebelum** cek ukuran, sebelum lock, dan sebelum hash audit — jadi `PAYLOAD_HASH` selalu menggambarkan data yang benar-benar masuk report.

**Koreksi penting (2026-09-20, sesi lanjutan):** deteksi "FIR vs aerodrome" di fixture QA dulu menebak dari **huruf terakhir kode** (`/[FI]$/`). Tebakan itu salah di dua arah:

- FIR/UIR yang **tidak** berakhiran F/I: `VTBB` (Bangkok), `YBBB` (Brisbane), `YMMM` (Melbourne), `WBFC` (Colombo), `WMFC` (Kuala Lumpur), `WSJC` (Singapura) — enam dari sembilan designator di korpus seed **lolos** dari assertion lama.
- Aerodrome yang berakhiran I: `WIII` (Jakarta) — 12 baris `kind='AD'` di staging nyaris diperlakukan sebagai UIR.

Sumber kebenaran yang dipakai sekarang adalah `notams.kind` (`migrations/005_notams_kind.sql`, dikoreksi `006_notams_kind_reset.sql`): korpus `archive/seed_notams.sql` adalah paruh **FIR** (sembilan designator di atas), snapshot staging adalah paruh **AD**. `tests/gatec_fixtures.mjs` mengekspor `FIR_DESIGNATORS` + `isFirStation()` dari keanggotaan korpus itu, dan fixture **gagal keras** kalau snapshot `kind='AD'` memuat designator FIR.

Fixture juga sekarang menaruh baris FIR ke dalam `savedNotamAnalysis`, bukan hanya ke respons mentah. Tanpa itu baris FIR ditolak selector karena *tidak dimiliki flight* — bukan karena aturan scope — sehingga fixture membuktikan aturan yang salah.

Terakhir, baris FIR pada fixture mempertahankan `station` = **designator FIR**-nya sendiri, bukan kode aerodrome tempat NOTAM itu menempel. Sebelum dikoreksi, preview Web 1 menampilkan `B2376/26-4 (WADD)` — menyebut aerodrome padahal isinya NOTAM FIR. Sekarang preview menampilkan `B2376/26-4 (RPHI)`, yang penting karena justru baris itulah yang dibaca operator untuk memutuskan apakah report sudah benar.

**Bukti preview per ukuran seleksi** (dari `test-results/gate-c/matrix-results.json`, Chrome, dijalankan ulang setelah koreksi):

| Seleksi | Template | Baris scope di preview Web 1 | NOTAM aerodrome dibawa |
|---|---|---|---|
| 1 flight | CBR1 | `AERODROME ONLY` · `FIR-wide excluded: 1 NOTAM tidak dimasukkan (bukan aerodrome)` · `B2376/26-4 (RPHI)` | 3 |
| 2 flights | CBR2 | idem · `2 NOTAM …` · `B2376/26-4 (RPHI), J5162/26-4 (VTBB)` | 6 |
| 3 flights | CBR4 | idem · `3 NOTAM …` · `…, B0685/26-4 (WAAF)` | 9 |
| 4 flights | CBR4 | idem · `4 NOTAM …` · `…, D0699/26-4 (WBFC)` | 12 |

Jadi bagian preview dari tabel fidelitas §3 sudah terbukti otomatis per ukuran; yang masih butuh operator adalah kesetaraan **isi Sheet** dan URL-nya.

Operator diberi tahu, bukan dibiarkan menebak: preview Web 1 menampilkan baris **`Scope rule: AERODROME ONLY`** dan, bila ada yang dibuang, **`FIR-wide excluded: N NOTAM tidak dimasukkan (bukan aerodrome)`** dengan daftar `id (station)`. Web 2 menampilkan peringatan yang sama di terminal setelah `AWQ_REPORT_ACCEPTED` (`warning` di envelope receipt).

Data uji untuk aturan ini **nyata dari staging**, bukan sintetis:
`tests/pull_staging_ad_notams.mjs` menarik `notams` dengan `kind='AD'` (read-only, `wrangler d1 execute --remote`) ke `test-results/gate-c/staging/notams-ad-staging.json` (gitignored — repo publik, teks NOTAM asli). Snapshot saat ini: **63 NOTAM**, `YPPH 31, WIII 12, WADD 4, YPKG 4, YPPD 4, WARR 3, WADL 2, WATO 2, WIPP 1`, teks terpanjang 527 byte.

Korpus seed lama (`archive/seed_notams.sql`, 829 baris) **seluruhnya FIR/UIR** (`WIIF`, `WAAF`, `RPHI`, `WSJC`, `WMFC`, `WBFC`, `VTBB`, `YBBB`, `YMMM`) dan tetap dipakai sebagai baris FIR yang **sengaja dicampurkan** ke setiap flight pada fixture, supaya aturan drop diuji: matrix sekarang memverifikasi bahwa 1 NOTAM FIR per flight dibuang, `droppedFirWide` sama dengan jumlah flight, tidak ada ID FIR yang lolos ke payload, dan preview memuat peringatannya.

Artifacts in `test-results/gate-c/`:

| File | Contents |
|---|---|
| `SUMMARY.json` / `SUMMARY.md` | roll-up of every suite, failures, and known gaps |
| `matrix-results.json` | per-case evidence: browser+version, expectations vs observations, payload hash/bytes, TAF/NOTAM counts, Web 1 preview text |
| `failure-results.json` | per-scenario evidence for popup blocked, both invalid-payload classes, origin/nonce mismatch, both timeouts, authorization failure |
| `interop-results.json` | preview-before-confirm, SUCCEEDED link, UNKNOWN + status check, RECONCILIATION_REQUIRED, BUSY, FAILED, confirm deadline, direct access, payload-only sourcing |
| `deployment-smoke-results.json` | live staging: page serving, fragment callback, Apps Script frame, anonymous-safe behaviour, anonymous identity handling |
| `manual/` | operator-run evidence exports |

### Matrix assertions, per browser and selection size

1. Web 1 tab opened synchronously from **DOWNLOAD SHEET**.
2. `AWQ_REPORT_READY` arrived from an allowlisted Web 1 origin with `event.source.top` equal to the opened tab (iframe-aware binding).
3. Nonce travelled in the URL **fragment**; the query string carried no report data.
4. Exactly one `AWQ_REPORT_CONTEXT`, answered by `AWQ_REPORT_ACCEPTED`.
5. Web 1 recorded exactly one receipt with the expected `CBR*` template and flights **in selection order**.
6. Payload identity: the SHA-256 of the canonical payload reconstructed from what Web 1 received equals the hash Web 1 computed on receipt; TAF/NOTAM text byte-identical to the Web 2 source text.
7. Payload completeness: version 1, full flight field set, non-empty full TAF and NOTAM context, `savedNotamAnalysis` covering every flight, `noSigStationMap` preserved, within the 64 KiB budget (four-flight fixture ≈ 9.5 KiB).
8. Web 1 preview shows request ID, template, flight list and NO SIG stations; **no generation before confirmation**.

### Failure-mode outcomes

| Scenario | Asserted outcome |
|---|---|
| Popup blocked | actionable *allow pop-ups* message, no success claim, state `POPUP_BLOCKED`, no tab |
| No flight selected / five flights | rejected before opening a tab |
| TAF text > 8 KiB | per-text limit named (station + byte count), no truncation, no tab |
| Total context > 64 KiB (84,250 B fixture, every text < 8 KiB) | total byte count vs the 64 KiB limit reported, no tab |
| Origin mismatch | unapproved origin is not on the allowlist, no message from it reaches Web 2, CONTEXT goes only to the allowlisted origin |
| Nonce mismatch | forged-nonce READY ignored; genuine handshake unaffected; exactly one CONTEXT |
| Readiness timeout | timeout reported, no CONTEXT sent, Web 1 recorded no context |
| Lost receipt | `RECEIPT_UNKNOWN` with the **same** request ID, no new ID, no duplicate CONTEXT, no success claim |
| New handoff after pre-send timeout | new request ID **and** new nonce |
| Authorization failure | rejection reason shown in Web 2 and Web 1, generation never invoked |

### Live staging smoke

Confirms `?page=report` answers 200, the page renders inside the Apps Script user-content frame with the confirmation/status controls, the fragment is read through the `google.script.url.getLocation` callback, an anonymous open halts safely with no preview and no READY, and the anonymous diagnostic returns `activeUser: ""`, `isAuthorized: false` with `allowedEmailsConfigured: true` and all three CBR templates present — i.e. the deployment runs *execute as the accessing user* and fails closed for anonymous callers.

---

## 3. Operator runbook — Firefox and the authenticated live run

```powershell
npm run qa:gatec:manual      # serves http://127.0.0.1:8788/
```

1. Open `http://127.0.0.1:8788/` in **real Firefox** (or a Chrome/Edge profile signed in to Google for the authenticated live run).
2. Work the scenarios in order. Each writes to the on-page evidence log and to `test-results/gate-c/manual/manual-incidents.json`:
   - `1 / 2 / 3 / 4 flight` → normal handoff. In the Web 1 tab: check the preview, then **GENERATE GOOGLE SHEET**, open the Sheet, record the URL.
   - `popup blocked`, `TAF text over 8 KiB`, `total context over 64 KiB` → rejection wording.
   - `ready never`, `no receipt` → timeout wording and request-ID identity.
3. Fill the on-page fidelity fields (Sheet URL, template, flights in sheet, NOTAM/NO SIG check, notes) **for each selection size** and tick the checklist.
4. **DOWNLOAD EVIDENCE JSON** → save as `test-results/gate-c/manual/firefox-<date>.json`.
5. Re-run `node tests/gatec_summary.mjs` so the summary counts the new record.

**Fidelitas sekarang terekam per ukuran seleksi, bukan sekali untuk run terakhir.** Sebelumnya field fidelity disimpan di satu slot bersama, jadi satu ekspor hanya membuktikan ukuran seleksi yang terakhir dikerjakan — inilah yang membuat §6.2 lama tidak bisa ditutup. Sekarang:

- Field fidelity dan checklist disimpan per skenario (`gatec-fidelity-by-scenario` di `localStorage`); berpindah skenario menyimpan milik skenario lama dan memuat kembali milik skenario baru.
- Baris **Per-size records** di halaman menampilkan, per ukuran: request ID, hash payload, `dropped/expected`, dan apakah Sheet URL sudah diisi.
- Baris **Coverage 1/2/3/4** menampilkan ukuran mana yang belum lengkap dan berubah merah sampai keempatnya terisi.
- Ekspor JSON membawa `coverage { covered, total: 4, missing, perSize }` sehingga `tests/gatec_summary.mjs` bisa **menyebut ukuran yang masih kosong** di `SUMMARY.md`, bukan hanya menghitung "ada N berkas manual".

`tests/test_gatec_operator_harness.mjs` (43 cek) menjaga kontrak ini: halaman harus memuat blok aturan **asli** hasil ekstraksi dari `src/Notam_Ui.html` (bukan mock), skrip inline harus parse, dan capture per ukuran harus ada untuk 1/2/3/4 — sehingga harness yang rusak ketahuan sebelum operator memakainya.

Verified harness behaviour (automated dry run of the network-free scenarios in Chromium): 9 scenario buttons, 9 checklist items, no page errors; the popup-blocked scenario reports *"Allow pop-ups to open the Google Sheets report."*, the per-text scenario reports the 12,288-byte TAF against the 8 KiB limit, and the total-size scenario reports 84,250 bytes against the 64 KiB limit.

### Fidelity checklist per confirmed run

Diisi **per ukuran seleksi**, dan hasilnya ikut ke ekspor JSON sebagai `coverage.perSize[n]`.

**Terisi dari run operator Firefox, 2026-09-20** (`test-results/gate-c/manual/firefox-gatec2-sel4.json`, ekspor final yang memuat keempat ukuran; ekspor `sel1`/`sel2`/`sel3` adalah snapshot bertahap dari sesi yang sama):

| Check | 1 flight | 2 flights | 3 flights | 4 flights |
|---|---|---|---|---|
| Template is CBR1 / CBR2 / CBR4 / CBR4 | ✅ CBR1 | ✅ CBR2 | ✅ CBR4 | ✅ CBR4 |
| Flights and order match the Web 2 selection | ✅ | ✅ | ✅ | ✅ |
| TAF block text matches the Web 2 TAF text | ✅ | ✅ | ✅ | ✅ |
| Selected NOTAMs present for the right stations | ✅ | ✅ | ✅ | ✅ |
| Preview shows `Scope rule: AERODROME ONLY` + FIR-wide warning | ✅ 1 dibuang | ✅ 2 | ✅ 3 | ✅ 4 |
| NO SIG stations rendered where applicable | ✅ | ✅ | ✅ | ✅ |
| Sheet URL recorded | ✅ | ✅ | ✅ | ✅ |
| No generation before confirmation | ✅ | ✅ | ✅ | ✅ |

Tidak ada kotak yang dikosongkan: checklist harness tercatat **8/8** pada setiap ekspor.

| Ukuran | Request ID | Template | Sheet |
|---|---|---|---|
| 1 flight | `842b56ff-6f1d-4361-aa0c-1cdce25270f0` | CBR1 | `https://docs.google.com/spreadsheets/d/1iHM6Vn7yV9BDPukpMg8_pBZiRwVwy2_MB9XmR9OH9XU/edit` |
| 2 flights | `b43702e2-8b24-4ddb-8f11-0cb987ccc113` | CBR2 | `https://docs.google.com/spreadsheets/d/1Rlec_kRvanc4yeqWm3lVcCmQQ891WAgh7lOUsQ5lSxU/edit` |
| 3 flights | `4f065182-8315-4c8a-8412-8c08e3e23d3c` | CBR4 | `https://docs.google.com/spreadsheets/d/1UZ7j4h6LbwgrVTUfZCQnMIlKZlAwIU-qmemXPoZyndw/edit` |
| 4 flights | `90702333-26c0-4fe3-bbac-c55075261639` | CBR4 | `https://docs.google.com/spreadsheets/d/1py6CggG3N2_BOhvBvZP2fLBuI7AIV2AMHhfYbFtzTc0/edit` |

Yang paling penting: **hitungan scope di preview sama dengan yang diprediksi suite otomatis.** Harness melaporkan `scope 1/1, 2/2, 3/3, 4/4` (`droppedFirWide` = jumlah flight, batas atas = jumlah baris FIR di fixture), persis seperti assertion matrix. Payload yang dikirim juga terekam per ukuran: 2.591 B / 4.195 B / 6.266 B / 7.900 B — jauh di bawah anggaran 64 KiB.

---

## 4. Environment limitations measured during this gate

| Limitation | Measurement | Consequence for the evidence |
|---|---|---|
| Playwright's Firefox build deadlocks here | `firefox.launch()` resolves (155.0), `newPage()` never resolves — reproduced headless, headed, bundled, channel and with sandbox prefs disabled | Firefox evidence comes from **real Firefox** via the manual harness; no automated Firefox matrix exists |
| Cross-origin frames cannot post to a non-opener sibling window | an iframe on `127.0.0.1:8790` inside the Web 1 tab could not deliver `postMessage` to the Web 2 window; a same-origin Web 1 tab could | a foreign-origin READY injection is not reproducible in-browser, so the origin-mismatch row asserts the allowlist decision, the absence of any message from the unapproved origin, and target-origin pinning instead |
| Playwright page handles cannot cross browser contexts | `JSHandles can be evaluated only in the context they were created` | a Playwright-driven foreign window cannot deliver the forged READY either |
| URL fragments never reach an HTTP server | fixture server sees `req.url` without `#nonce=…` | the fixture is told the live nonce out of band and the Web 1 tab is reloaded per handshake |

None of these change shipped code; they constrain how the QA evidence is produced.

---

## 6. Bukti manual yang sudah terkumpul

### 6.1 Firefox nyata — handoff 1/2/3/4 flight (2026-09-20)

Sumber: `test-results/gate-c/manual/firefox-2026-09-20.json` (Firefox 156.0, Windows, harness `qa:gatec:manual`, deployment staging yang sama).

| Seleksi | Request ID handoff | READY (dari klik) | ACCEPTED (dari CONTEXT) | Origin peer |
|---|---|---|---|---|
| 1 flight (CBR1) | `dacca5e2-76cf-4d29-9c85-313dfe469359` | +4,0 s | +4,8 s | `https://n-aknwylqugtad7abe6fzh5c47svchxgv7l53qtjy-0lu-script.googleusercontent.com` |
| 2 flight (CBR2) | `6bbf9ed7-6fde-45f8-9a29-7c348d01b05a` | +15,9 s | +10,8 s | sama |
| 3 flight (CBR4) | `c52d8203-efe9-46d3-bfe2-7a4e62f1c48d` | +2,9 s | +3,2 s | sama |
| 4 flight (CBR4) | `ec7bf98e-8388-4a47-a7ef-61780e545649` | +2,6 s | +2,6 s | sama |

Yang dibuktikan tabel ini:

- **Keempat ukuran seleksi menyelesaikan READY → CONTEXT → ACCEPTED di Firefox nyata**, bukan hanya CBR1 seperti di Gate B0.
- **Origin iframe nyata** persis cocok dengan pola yang diukur Gate B (`*-script.googleusercontent.com`) dan diterima allowlist Web 2 tanpa wildcard.
- **README paling lambat 15,9 detik** (cold start Apps Script), masih jauh di dalam jendela readiness 30 detik; ACCEPTED tercepat 2,6 detik dan terlama 10,8 detik, masih di dalam jendela receipt 45 detik. **Ini validasi runtime pertama untuk kedua anggaran waktu itu di browser nyata.**
- Checklist fidelitas operator: 8/8 tercentang (tab terbuka, template sesuai ukuran, daftar flight sama dan urut, hitungan TAF/NOTAM, NO SIG, konfirmasi eksplisit, Sheet terbuka dengan flight sama, terminal sesuai harapan).

**Catatan penting (jangan dibaca berlebihan):** JSON itu tidak memuat URL Sheet dan tidak memisahkan checklist per ukuran seleksi — checklist dicatat sekali untuk run terakhir. Jadi baris "Sheet fidelity 1/2/3/4" **masih perlu** diisi dengan URL Sheet per ukuran (atau verifikasi baris `REPORT_AUDIT` di spreadsheet). Baca §6.2.

**Apa yang run ini JANGAN diulang:** transport, urutan flight, template per ukuran, dan timing READY/ACCEPTED di Firefox **sudah terbukti** oleh run ini dan tidak perlu diambil ulang. Yang belum adalah **fidelitas isi Sheet + URL Sheet per ukuran**, karena ekspor itu hanya menyimpan satu checklist. Run ulang yang diminta §6.2 adalah run *pelengkap* untuk data itu — bukan pengulangan bukti transport.

### 6.1b Bukti preview per ukuran seleksi (otomatis, 2026-09-20)

Bagian preview dari tabel fidelitas sudah tertutup **tanpa** operator, dari `test-results/gate-c/matrix-results.json` (Chrome, halaman Web 1 asli, payload asli):

| Seleksi | Template | `Scope rule` | Peringatan FIR-wide | Daftar yang dibuang | NOTAM dibawa |
|---|---|---|---|---|---|
| 1 flight | CBR1 | `AERODROME ONLY` | 1 NOTAM | `B2376/26-4 (RPHI)` | 3 |
| 2 flights | CBR2 | `AERODROME ONLY` | 2 NOTAM | `B2376/26-4 (RPHI), J5162/26-4 (VTBB)` | 6 |
| 3 flights | CBR4 | `AERODROME ONLY` | 3 NOTAM | `…, B0685/26-4 (WAAF)` | 9 |
| 4 flights | CBR4 | `AERODROME ONLY` | 4 NOTAM | `…, D0699/26-4 (WBFC)` | 12 |

Jadi yang benar-benar tersisa untuk operator hanyalah **isi Sheet dan URL-nya**.

### 6.2 Yang masih harus dilengkapi operator

| Item | Status | Cara menutup |
|---|---|---|
| URL Sheet per ukuran seleksi 1/2/3/4 | ✅ **SELESAI** — empat request dengan Sheet-nya (§3) | — |
| Fidelitas isi Sheet (template + data + NOTAM/NO SIG) per ukuran | ✅ **SELESAI** — checklist 8/8 per ukuran, scope 1/1…4/4 | — |
| Status audit per request ID | ⬜ belum dikonfirmasi barisnya | jalankan `gatecAuditProbe` dengan empat ID di §3 (semua baris diharapkan `SUCCEEDED` + `SPREADSHEET_URL`) |
| Run ber-otentikasi di Chrome | ⬜ belum | `1` dan `4 flight` di profil Chrome yang login Google, lalu ekspor `chrome-gatec-<tanggal>.json` |
| Expiry preview 15 menit & deadline konfirmasi 6 menit | ⬜ suite hanya menguji 4 detik | satu observasi durasi penuh |

Setelah artifact baru diekspor, simpan ke `test-results/gate-c/manual/` dan jalankan `node tests/gatec_summary.mjs`. Ringkasan akan **menyebut ukuran seleksi mana yang belum punya catatan fidelitas** pada bagian "Operator Sheet-fidelity coverage" — sekarang barisnya sudah tidak memuat `**NO**`.

### 6.3 Defect yang ditemukan run manual (dan diperbaiki)

Run manual bukan sekadar mengisi checklist — ia menemukan satu bug produk dan tiga bug fixture yang tidak terlihat oleh suite otomatis:

| # | Defect | Bagaimana ditemukan | Perbaikan / bukti |
|---|---|---|---|
| 1 | **`reportFindBlockingRequest_` memblokir request baru bila request sebelumnya sudah `SUCCEEDED`.** Operator tidak bisa membuat briefing kedua untuk flight set yang sama — selamanya. | Operator menekan GENERATE dan menerima `RECONCILIATION_REQUIRED` yang menyebut request yang sudah `SUCCEEDED` | Baris riwayat `CREATED`/`CREATE_ATTEMPTED` dilewati bila request punya baris `SUCCEEDED`; reproduksi + regresi di `tests/test_report_handoff_protocol.mjs`; terverifikasi live (`SUCCEEDED` pada flight set yang sebelumnya diblokir) |
| 2 | Fixture mengarang stasiun ENR dari kolam TAF umum | Operator bertanya kenapa `VTSP`/`VVDN` muncul pada flight `WADD→WATO` | `tests/pull_staging_flights.mjs` menarik 55 record flight nyata; ENR kini dari record (`646 → enr1-3 kosong`, `544 → enr1 YPPD`) |
| 3 | `flightsStr` per stasiun hanya memuat flight pertama | Baris milik flight kedua tampak "tidak dimiliki" → ditolak sebagai bukan pilihan, bukan dinilai scope-nya | `flightsStr` kini gabungan flight yang dilayani stasiun itu |
| 4 | NOTAM aerodrome dipilih dari kolam global, bukan stasiun flight | NOTAM `WADL`/`WARR` muncul pada flight `WADD/VTSP/WIMM/WMKP` | Stasiun aerodrome dipilih dari stasiun flight itu sendiri |

Defect #1 adalah temuan tingkat produk: tanpa run manual, ia hanya akan muncul setelah go-live, ketika operator pertama kali perlu membuat briefing kedua untuk flight yang sama.

---

## 7. Gap yang belum ditutup paket ini

| Gap | Alasan | Jalur penutupan |
|---|---|---|
| Fidelitas **isi Sheet** + URL Sheet per ukuran seleksi | perlu run ber-otentikasi dan inspeksi Sheet | runbook §3; field fidelity kini tersimpan per skenario dan ikut ter-ekspor sebagai `coverage.perSize` |
| Status `REPORT_AUDIT` per request ID | belum ada baris audit yang direkam sebagai bukti | cocokkan request ID di `coverage.perSize[n].reportRequestId` dengan sheet `REPORT_AUDIT` |
| Expiry preview 15 menit (durasi penuh) | tidak praktis di suite cepat; transisinya sudah ditutup protocol test | satu run sengaja atau cek expiry via admin |
| Deadline konfirmasi 6 menit (durasi penuh) | sama | di suite diuji 4 detik (state + satu kali percobaan); perlu satu observasi penuh sebelum produksi |

Catatan freshness deployment: `archive/Report_Handoff.gs` (lookup `TextFinder` + trim retensi) ter-deploy sebagai **Version 42** pada 2026-09-20 06:09 lewat *Manage deployments → edit deployment*. Build berikutnya — **aerodrome-only** (`archive/Report.html` + `src/Notam_Ui.html` + `src/Report_Ui.html`) — ter-deploy lewat jalur yang sama pada 2026-09-20 sore, jadi **URL `/exec` tetap tidak berubah** dan tidak ada konstanta repo yang perlu diganti.

Keberadaan build aerodrome-only di deployment **sudah terbukti** dari luar, bukan dari asumsi: sepuluh fragmen kode dicocokkan verbatim terhadap file lokal (§2.2), ukuran dokumen berubah (894.262 → 920.790 B dan 32.124 → 33.672 B), dan smoke anonim PASS 12/12. Yang **belum** terbukti dari deployment itu adalah perilaku jalur ber-otentikasi (lookup `TextFinder`, trim retensi, penulisan `REPORT_AUDIT`) — jalur anonim tidak menyentuh kode tersebut, jadi bukti itu memang hanya bisa datang dari run operator.

---

## 8. Status Gate C

**Rencana dihentikan 2026-09-20 sebelum Gate D.** Ringkasan apa yang terbukti dan apa yang tidak:

- Otomatis: **semua suite PASS**, 0 kegagalan. `SUMMARY.json` melaporkan empat suite browser/deployment (matrix 12/12, failure 33/33, interop 24/24, smoke 12/12); `npm run test:gatec` menjalankan dua suite Node-level lebih dulu (rule 42/42, kontrak harness operator 45/45). Total **168 cek**.
- Deploy: **terverifikasi** (§2.1) — fragmen Web 2 6/6, Web 1 4/4, verbatim terhadap sumber lokal.
- Manual — Firefox nyata: **SELESAI** untuk transport 1/2/3/4 flight + timing anggaran waktu (§6.1).
- Manual — preview Web 1 per ukuran seleksi: **SELESAI**, terbukti otomatis (§6.1b) dan dikonfirmasi operator.
- Manual — **fidelitas isi Sheet + URL Sheet per ukuran: SELESAI** (§3), checklist 8/8 per ukuran, `coverage 4/4`, `SUMMARY.md` tanpa baris `**NO**`.
- Defect ditemukan & diperbaiki selama Gate C: **4** (§6.3), termasuk satu bug produk.
- ⛔ **Tidak dikerjakan (ditinggalkan):** run ber-otentikasi di Chrome, konfirmasi baris `REPORT_AUDIT`, dua observasi durasi penuh, review Gate D, baseline metrik PRD §7, regenerasi `public/index.html`.
- Checklist PRD §13 "Ready for production deployment" tetap `[ ]` — dan **akan tetap begitu** selama rencana ini dihentikan. Tidak ada yang boleh menganggap paket ini sebagai approval produksi.
- ⚠️ **Risiko yang ditinggalkan:** `archive/Report_Handoff.gs`, `src/Notam_Ui.html`, dan `src/Report_Ui.html` sudah live di **staging** tanpa review produksi. Jangan promosikan ke produksi tanpa review itu.
