# AWQ DISPATCH ASSISTANCE INTEGRATION CONTRACT

Status: Approved contract; SSO bridge implementation deployed for smoke testing

Dokumen ini mencatat keputusan integrasi yang disetujui setelah audit AWQ Cloud. Endpoint SSO bridge dan read-only flight-board proxy sekarang sudah diimplementasikan; happy path tetap membutuhkan login operator nyata di AWQ Cloud.

## 1. Approved Product Decisions

- Dispatch Assistance adalah aplikasi terpisah dengan origin sementara `https://assist.christiandaniel.my.id`.
- Active flight adalah flight yang sedang aktif pada Flight Board milik user AWQ Cloud yang sedang login.
- `alt` adalah destination alternate, dengan target dukungan satu atau dua alternate.
- `enr1`, `enr2`, dan `enr3` adalah enroute alternate 1–3.
- Aircraft type direpresentasikan oleh `aircraft.type_code` seperti `A320`; tidak ada field display name `type` yang redundant.
- Identitas flight harus mendukung operator IATA `QZ`, operator ICAO `AWQ`, dan flight number seperti `534`, `535`, `536`, `537`, `246`, `247`, `809`, dan `808`.
- Aircraft identity harus memisahkan `aircraft.type_code` dari `aircraft.registration`; `type_code` boleh `null` jika authoritative source belum tersedia.
- Sumber authoritative yang direkomendasikan adalah aircraft master berdasarkan registration, dengan flight context menyimpan snapshot `type_code` dan registration saat tersedia.
- Implementasi awal read-only dan ADMIN-only.
- Flight context selalu terikat pada `flight_id`.

## 2. Current Repository Constraints

Session AWQ Cloud saat ini tidak dapat langsung digunakan oleh aplikasi terpisah:

- Cookie `__Host-awq_session` bersifat host-only dan tidak dapat dibagikan ke `assist.christiandaniel.my.id`.
- RPC guard saat ini mewajibkan `Origin` yang sama.
- Board state disimpan per-user dalam `user_board_state.row_ids`.
- RPC `getActiveFlightList` saat ini mengembalikan semua flight dan tidak menerapkan pilihan Flight Board.
- Field `flights.alt` saat ini satu text field; delimiter untuk dua alternate belum didefinisikan.
- Field `flights.enr1`–`enr3` tersedia, tetapi arti operasionalnya belum encoded dalam typed upstream contract.
- Tabel `aircraft` sudah menjadi registration master, tetapi migration seed saat ini mengisi `aircraft.ac_type` sebagai `NULL`; repository belum memiliki authoritative aircraft-type catalog.

Read-only validation terhadap materi legacy lokal menambahkan caveat berikut:

- `archive/flights.csv` memakai kolom `QZ` dengan nilai numerik, dan `archive/seed_flights.sql` juga menyimpan nilai seperti `534`, `535`, `246`, `247`, `809`, dan `808` pada `flights.callsign`. UI/test fixture menampilkan bentuk `QZ534`, sehingga `QZ` saat ini adalah mapping presentasi yang perlu dikonfirmasi, bukan bukti bahwa database menyimpan operator code.
- Tidak ditemukan field operator ICAO `AWQ` yang terpisah. Contract tidak boleh membuat `AWQ` atau `QZ` secara otomatis sebelum sumber authoritative dan aturan mapping disetujui.
- Pada seed lokal, nilai `flights.ac_type` terlihat seperti registration (`PK-AZK`), bukan aircraft type (`Airbus A320`). Aircraft type karena itu harus tetap nullable sampai production source atau aircraft master untuk type dikonfirmasi; registration juga belum boleh dipublikasikan dari field ini tanpa persetujuan mapping.
- Sample lokal hanya membuktikan satu destination alternate per row. Dukungan satu atau dua alternate tetap menjadi target contract, tetapi alternate kedua harus tetap `null`/unavailable bila format upstream belum disepakati.
- Sample legacy `enr1`–`enr3` memuat nilai airport/station-like dan route-token-like. Field tersebut dapat dipetakan ke `enroute alternate 1–3` sesuai keputusan produk, tetapi validasi ICAO airport dan ETOPS/EDTO tidak boleh diinferensikan dari isi field.

Evidence: `functions/api/auth.js:3-4,72-95`; `functions/api/rpc.js:68-115,2139-2156`; `migrations/012_user_board_state.sql:9-14`; `schema.sql:4-24`.

## 3. SSO Handoff Contract

### 3.1 Recommended protocol

Gunakan short-lived, single-use authorization-code handoff. Jangan menaruh access token atau identity payload langsung dalam URL redirect.

    1. Browser membuka Dispatch Assistance.
    2. Dispatch backend membuat pending login state dan PKCE verifier.
    3. Browser redirect ke AWQ Cloud authorization endpoint.
    4. AWQ memvalidasi cookie `__Host-awq_session`.
    5. AWQ memvalidasi `role = admin`.
    6. AWQ membuat one-time code yang terikat pada client, redirect URI, state, PKCE challenge, user ID, dan expiry.
    7. AWQ redirect kembali dengan `code` dan `state`.
    8. Dispatch backend memvalidasi state dan menukar code + verifier secara server-to-server.
    9. AWQ menggunakan code sekali saja dan mengembalikan minimal identity assertion.
    10. Dispatch backend membuat session lokalnya sendiri.

Tidak boleh ada password atau long-lived AWQ bearer token yang disimpan oleh Dispatch Assistance.

### 3.2 New endpoints required

Endpoint berikut belum ada dan belum diimplementasikan:

    GET /sso/dispatch/authorize
    GET /sso/dispatch/callback
    POST /sso/dispatch/token

`/sso/dispatch/authorize` berada di AWQ Cloud. Parameter minimal:

    client_id
    redirect_uri
    state
    code_challenge
    code_challenge_method=S256

Behavior:

- Redirect URI harus berasal dari fixed allowlist.
- Session AWQ harus valid.
- Role harus `admin`.
- No session menghasilkan `401`.
- Non-ADMIN menghasilkan `403`.
- Code single-use dan expiry maksimum lima menit.
- Code disimpan dalam bentuk hash.
- Jangan mengungkap apakah email tertentu terdaftar.

`/sso/dispatch/callback` berada di Dispatch Assistance dan hanya menerima `code` dan `state`.

`/sso/dispatch/token` digunakan oleh backend Dispatch Assistance secara server-to-server:

    {
      "grant_type": "authorization_code",
      "code": "one-time-code",
      "code_verifier": "pkce-verifier",
      "client_id": "dispatch-assistance"
    }

Identity response minimum:

    {
      "user_id": 123,
      "role": "admin",
      "email": "operator@example.com",
      "issuer": "awq-cloud",
      "issued_at": "2026-09-21T00:00:00Z",
      "expires_at": "2026-09-21T00:05:00Z"
    }

### 3.3 SSO security requirements

- HTTPS only.
- Fixed redirect URI allowlist.
- PKCE dan state validation.
- Single-use hashed code dengan expiry singkat.
- Tidak ada AWQ password atau AWQ session cookie yang disalin.
- Tidak ada access token di URL.
- Tidak ada identity assertion di localStorage.
- Audit success, denial, expiry, replay, dan exchange failure tanpa menyimpan code/token.
- Role harus divalidasi ulang pada request sensitif atau menggunakan local session yang sangat singkat.

## 4. Dispatch Local Session

Dispatch Assistance boleh membuat session lokal setelah AWQ handoff berhasil.

Minimum claims:

    dispatch_session_id
    awq_user_id
    email
    role
    issued_at
    expires_at

Session harus Secure, HttpOnly, SameSite sesuai kebutuhan, host-scoped, revocable, tidak disimpan di localStorage, dan tidak pernah dimasukkan ke operational assessment sebagai secret.

AWQ Cloud tetap menjadi sumber kebenaran identity. Jika validasi AWQ tidak tersedia, hasil aman adalah access denial atau `UPSTREAM_DATA_UNAVAILABLE`.

## 5. Flight Board Contract

### 5.1 Target endpoint

    GET /api/dispatch/v1/flight-board

Ini adalah `NEW CONTRACT REQUIRED`. Endpoint harus membaca `user_board_state` berdasarkan identity AWQ yang sudah diverifikasi, lalu membaca ulang row pada `flights`.

Dispatch Assistance tidak boleh membaca D1 secara langsung dari browser dan tidak boleh menggunakan seluruh `flights` table sebagai fallback.

### 5.2 Response

    {
      "contract_version": "1",
      "board_state_updated_at": "2026-09-21T07:00:00Z",
      "flights": [
        {
          "flight_id": 123,
          "callsign": "QZ534",
          "flight_number": "534",
          "iata_operator": "QZ",
          "icao_operator": "AWQ",
          "origin": "WIII",
          "destination": "WADD",
          "flight_date": "20260921",
          "std": "04:00",
          "sta": "07:00"
        }
      ],
      "data_quality": []
    }

Behavior:

- Hanya mengembalikan flight pada Flight Board user tersebut.
- Mempertahankan urutan board.
- Board kosong menghasilkan array kosong.
- Stale/deleted row ID tidak menghasilkan fake row.
- Jika board tidak dapat dibaca, return `UPSTREAM_DATA_UNAVAILABLE`.
- Setiap item wajib memiliki `flight_id`.
- Tidak boleh mengembalikan seluruh flight database sebagai fallback.

## 6. Flight Context Contract

### 6.1 Target endpoint

    GET /api/dispatch/v1/flights/{flight_id}/context

Ini adalah `NEW CONTRACT REQUIRED`. RPC `getSelectedFlightsData` dapat menjadi implementation reference, tetapi tidak boleh dipakai tanpa explicit ID karena dapat mengembalikan semua flight ketika ID tidak diberikan.

### 6.2 Response shape

    {
      "contract_version": "1",
      "flight_id": 123,
      "board_membership": "ACTIVE",
      "identity": {
        "callsign": "QZ534",
        "flight_number": "534",
        "iata_operator": "QZ",
        "icao_operator": "AWQ"
      },
      "schedule": {
        "flight_date": "20260921",
        "std": "04:00",
        "sta": "07:00",
        "etd": null,
        "eta": null
      },
      "aerodromes": {
        "origin": "WIII",
        "destination": "WADD",
        "destination_alternates": [],
        "destination_alternate_raw": null
      },
      "aircraft": {
        "type_code": "A320",
        "registration": "PK-AZK"
      },
      "route": {
        "active_route_id": null,
        "route_string": null,
        "eet": null,
        "flight_level": null
      },
      "enroute": {
        "alternates": [],
        "etops_edto_active": null
      },
      "source": {
        "system": "awq-cloud",
        "observed_at": "2026-09-21T07:01:00Z",
        "flight_created_at": "2026-09-20T01:00:00Z",
        "revision": null
      },
      "data_quality": []
    }

`null` digunakan ketika source tidak menyediakan data. Jangan mengisi fake operational values.

### 6.3 Current source mapping

| Contract field | AWQ Cloud source | Status |
|---|---|---|
| `flight_id` | `flights.id` | available |
| `identity.callsign` | `flights.callsign` | available; local legacy data is numeric, display prefix is not canonical |
| `identity.flight_number` | no dedicated field | nullable until parsing rule is approved |
| `identity.iata_operator` | no dedicated field | nullable until authoritative `QZ` mapping is approved |
| `identity.icao_operator` | no dedicated field | nullable until authoritative `AWQ` mapping is approved |
| `schedule.flight_date` | `flights.dof` | available |
| `schedule.std` | `flights.etd` | available; legacy formats exist |
| `schedule.sta` | `flights.eta` | available; legacy formats exist |
| `aerodromes.origin` | `flights.dep` | available |
| `aerodromes.destination` | `flights.dest` | available |
| `destination_alternates` | `flights.alt` | one text field; normalization required |
| `aircraft.type_code` | `aircraft.type_code` master by registration; future flight snapshot | nullable until authoritative type source is confirmed |
| `aircraft.registration` | aircraft master or future `flights.aircraft_registration` snapshot | nullable; never infer aircraft type from registration |
| `route.active_route_id` | `flights.active_route_id` | available |
| `route.route_string` | related `routes` row | available when route resolves |
| `route.eet` | no field | nullable |
| `route.flight_level` | no field | nullable |
| `enroute.alternates` | `flights.enr1`–`enr3` | available after approved mapping |
| `enroute.etops_edto_active` | no field | nullable/not implemented |
| `source.flight_created_at` | `flights.created_at` | available |
| `source.revision` | no field | nullable |

## 7. Alternate Normalization

Target shape:

    {
      "destination_alternates": [
        { "sequence": 1, "icao": "WAAA" },
        { "sequence": 2, "icao": "WARR" }
      ]
    }

Database saat ini tidak mendefinisikan bagaimana dua value disimpan dalam `flights.alt`. Sebelum implementasi:

- confirm delimiter dan validation rule dari representative non-sensitive values;
- preserve raw value;
- jangan split arbitrary text;
- return explicit `AMBIGUOUS_ALTERNATE_DATA` saat normalisasi tidak tersedia;
- jangan pernah mengarang alternate kedua.

Approved enroute mapping:

    enr1 → enroute alternate 1
    enr2 → enroute alternate 2
    enr3 → enroute alternate 3

Mapping ini tidak mengaktifkan ETOPS/EDTO. `etops_edto_active` tetap explicit dan tidak boleh diinfer dari enroute alternates.

## 8. Flight Context Isolation Rules

- `flight_id` wajib untuk context dan weather request.
- Request tanpa `flight_id` gagal validasi.
- Flight yang tidak ada pada board user menghasilkan `FLIGHT_NOT_ON_ACTIVE_BOARD`.
- Saat user mengganti flight, client menghapus context sebelumnya sebelum memuat context baru.
- Server membaca ulang flight berdasarkan ID pada setiap request.
- Callsign bukan primary lookup key karena dapat tidak unik antar tanggal.
- Stale board state menghasilkan refresh-required response.
- Context satu flight tidak boleh terbawa diam-diam ke flight lain.

## 9. Weather Contract Boundary

Target endpoint:

    GET /api/dispatch/v1/flights/{flight_id}/weather

Ini adalah fase read-only berikutnya. Scope normal:

    origin
    destination
    destination_alternates[]

Hanya saat `etops_edto_active === true`:

    enroute_alternates[]

Minimum weather item:

    {
      "station": "WADD",
      "raw_taf": "TAF ...",
      "issued_at": null,
      "valid_from": null,
      "valid_to": null,
      "retrieved_at": "2026-09-21T07:02:00Z",
      "source": null,
      "status": "UNKNOWN",
      "errors": []
    }

Metadata TAF yang tidak tersedia harus tetap explicit dan tidak boleh diinterpretasikan sebagai compliance.

## 10. Error Contract

Stable machine-readable errors:

    AUTH_REQUIRED
    ADMIN_REQUIRED
    SSO_STATE_INVALID
    SSO_CODE_EXPIRED
    SSO_CODE_REPLAYED
    UPSTREAM_DATA_UNAVAILABLE
    FLIGHT_NOT_ON_ACTIVE_BOARD
    FLIGHT_NOT_FOUND
    MISSING_REQUIRED_DATA
    AMBIGUOUS_ALTERNATE_DATA
    WEATHER_DATA_INVALID
    WEATHER_DATA_STALE

Automated output tidak boleh menggunakan `safe`, `legal`, `approved`, atau `dispatchable` sebagai final verdict.

## 11. Proof-of-Life Acceptance Criteria

1. AWQ ADMIN dapat membuka Dispatch Assistance pada separate origin.
2. Non-ADMIN menerima explicit access denial.
3. Unauthenticated user diarahkan ke AWQ authentication.
4. Tidak ada AWQ password atau AWQ session token yang diduplikasi.
5. Active-flight list sama dengan urutan Flight Board user.
6. Board kosong menghasilkan empty list, bukan semua D1 flights.
7. Pemilihan flight menghasilkan explicit `flight_id` dan source fields.
8. Pergantian Flight A ke Flight B menghapus context Flight A terlebih dahulu.
9. Stale atau removed ID gagal secara explicit.
10. Data EET, flight level, ETOPS/EDTO, registration, atau alternate yang tidak tersedia ditampilkan sebagai unavailable.
11. Tidak ada assessment, rule verdict, citation, atau AI explanation pada fase ini.

## 12. Implementation Status

- `migrations/016_dispatch_assist_auth.sql` membuat one-time authorization code dan short-lived read-only assist token.
- `functions/api/assist.js` menyediakan start, exchange, dan active flight board read-only flow.
- `awq-dispatch-assist` menyimpan assist token dalam `HttpOnly` cookie dan melakukan proxy server-side ke AWQ Cloud.
- Active flights mengikuti `user_board_state.row_ids`, bukan seluruh rows pada tabel `flights`.
- Aircraft output menggunakan `aircraft.type_code` dan registration secara terpisah; display name tidak dibuat.
- Deployment smoke test anonim sudah lulus dengan `AUTH_REQUIRED` dan `SSO_REQUIRED`.

## 13. Remaining Verification

- Operator harus login di AWQ Cloud lalu menguji tombol `Connect AWQ Cloud` pada live Dispatch Assist.
- Perlu memastikan `assist.christiandaniel.my.id` sudah resolve publik sebelum origin final dipakai sebagai return origin.
- Happy-path verification perlu dilakukan dengan board user yang memiliki minimal satu active flight.
