# Conflict Report: voter UMA yang memegang posisi di pasar Polymarket yang mereka putus

Backfill 11 Okt 2026, diperbarui setiap hari oleh monitor (lihat bawah). Angka di bawah per 12 Okt 2026; sumber kebenarannya `out/summary.json`. Jendela: semua request DVM UMA `YES_OR_NO_QUERY` yang sudah resolved sejak 1 Jan 2025.

## Angka utama (`out/summary.json`)

| Metrik | Nilai |
|---|---|
| Request DVM yang dipetakan ke pasar Polymarket | **4.121** (3.592 pasar unik; sebagian pasar punya 2 request DVM) |
| Voter unik | 6.198 |
| Voter yang Safe Polymarket-nya (diturunkan dari alamat vote) punya aktivitas trading | **3.743 (60,4%)** |
| Sengketa dengan ≥1 voter yang memegang posisi di pasar itu saat vote | **834 (20,2%)** |
| Hal yang sama, khusus pasar dengan volume ≥ $1 jt | **423 dari 644 (65,7%)** |
| Voter konflik unik / baris vote konflik | 405 / 2.256 |
| Total biaya posisi yang dipegang voter konflik | ≈ $8,0 jt |
| Porsi suara konflik yang memilih sisi yang mereka pegang | 47% |
| Bobot token konflik (seluruh sengketa / maksimum per sengketa) | 0,004% / 1,32% |
| Hasil berubah jika voter konflik dikeluarkan | **0** (dan 0 yang turun di bawah supermayoritas 65%) |

Cara membacanya: konflik itu **sering terjadi** (1 dari 5 sengketa, 2 dari 3 untuk pasar besar). Ini cocok dengan angka WSJ "~1 dari 5" dan "≥60% voter terhubung ke Polymarket". Namun, **bobot konflik yang bisa dideteksi kecil**, dan tidak ada hasil yang berubah. Ini cocok dengan Bitquery (0/489). Jadi argumen yang didukung data adalah soal legitimasi dan kepatuhan: juri konflik ikut memutus, dan tidak ada yang menyaringnya. Data ini tidak mendukung klaim bahwa voter konflik membalik hasil.

## Studi kasus (`out/case_studies.json`, 2 teratas sudah dicek ulang secara live)

1. **Thailand strikes Cambodia by Friday?** (vote ±30 Jul 2025, volume $15 jt). Voter `0xacb1…6272` memegang 1,12 jt saham YES lewat Safe `0xbcb6…c7c9` pada akhir reveal (biaya bersih ≈ $1,12 jt), memilih YES, lalu masih menambah posisi setelah vote, lalu me-redeem 1,96 jt saham. `getOwners()` Safe = alamat voter (dicek on-chain).
2. **Maduro in U.S. custody by January 31?** (vote ±6 Jan 2026, volume $11 jt). Voter `0xe5c3…0391` memegang 698 rb saham YES (≈ $698 rb), memilih YES, lalu me-redeem 800 rb.
3. **Will Zelenskyy wear a suit before July?** (Jul 2025, volume $242 jt). Voter `0x93a6…ced4` memegang 381 rb saham NO (≈ $372 rb) dan memilih NO. Voter yang sama juga muncul di Fordow, Robotaxi, dan "cyberattack on Iran" (54 sengketa konflik).
4. **US government shutdown Saturday?** (Feb 2026, volume $157 jt). Ada 25 voter konflik. Salah satunya `0x86cc…273d`, yang punya 249 baris vote konflik di seluruh data (memilih sisi sendiri 158 kali, total posisi ≈ $1,04 jt).
5. Bobot terbesar: **Honduran turnout** (Apr 2026), 1,32% token berasal dari voter konflik (`0x2c26…`, 224 rb UMA).

## Metode

1. **Vote UMA**: subgraph publik Goldsky `mainnet-voting-v2/0.1.0` (tanpa API key). Yang diambil: `priceRequests` YES_OR_NO_QUERY yang resolved, beserta `revealedVotes` (voter, harga, token) dari **ronde terakhir/penentu**.
2. **Teks pertanyaan**: sekitar 92% request menyimpan `ancillaryDataHash` + `childBlockNumber`. Teks aslinya diambil dari log `OracleChildTunnel` di Polygon (RPC publik drpc/1rpc) dan dicocokkan lewat keccak.
3. **Pasar Polymarket**: `questionID = keccak(ancillary sebelum ",ooRequester:")`, lalu dicari di Gamma `markets?question_ids=…&closed=true`. Hasil diterima hanya jika questionID sama (2.895) atau judulnya persis sama (1.198, sebagian besar negRisk).
4. **Tautan voter ke wallet**: alamat Safe Polymarket diturunkan secara deterministik (CREATE2, factory `0xaacF…541b`) dari alamat voter. Rumusnya diverifikasi dengan `getOwners()` on-chain pada sampel. EOA-nya sendiri juga dicek. **Kepastian tinggi**: Safe itu hanya bisa dikendalikan kunci yang sama yang dipakai untuk vote (kecuali owner Safe pernah diganti). Funding link **tidak** dipakai.
5. **Posisi saat vote**: aktivitas Data API (`TRADE/SPLIT/MERGE/REDEEM`) di pasar itu sampai `lastRevealTime` ronde. "Konflik" = net ≥ 1 saham di salah satu outcome.
6. **Counterfactual**: token per harga dihitung ulang tanpa voter konflik, lalu dicek apakah pemenang berubah dan apakah masih >65% (SPAT) dan di atas GAT.

## Keterbatasan (jangan diklaim berlebihan)

- **Batas bawah.** Voter yang trading dari wallet lain (wallet terpisah, CEX, akun magic/email, deposit wallet baru) tidak terdeteksi. Whale besar kemungkinan besar memisahkan wallet, jadi angka 0,004% hampir pasti di bawah nilai sebenarnya.
- Transfer token CTF antar-wallet dan konversi negRisk tidak dihitung dalam rekonstruksi posisi.
- Offset Data API dibatasi sekitar 10 rb event per chunk pasar, jadi trader ekstrem bisa terpotong.
- Volume Gamma bisa 0 atau hilang untuk sebagian pasar. 332 request belum/tidak bisa dipetakan ke pasar (termasuk yang masih pending).
- "Memilih sisi sendiri" (47%) bukan bukti niat jahat. Sebagian besar voter memang memilih jawaban mayoritas yang benar.
- DNS ISP lokal memblokir `*.polymarket.com`. Skrip me-resolve lewat DNS-over-HTTPS Cloudflare (`common.py`).

## Reproduce in one command

Dari root repo (tanpa cache, tanpa API key):

```
pip install requests pycryptodome && PYTHONIOENCODING=utf-8 python conflict-report/conflict_report.py --incremental && python conflict-report/test_conflict.py && python conflict-report/site/build_site.py
```

Ini mengambil semua sengketa yang resolved setelah kursor di `out/state.json`, mengecek ulang posisi setiap voter-nya, menggabungkannya ke `out/*`, lalu membangun ulang `docs/index.html` dan dataset publik `docs/data/`.

Mode lain:

```
python conflict_report.py --incremental              # hanya request yang resolved setelah out/state.json:cursor (menit, tanpa cache)
python conflict_report.py --since 1791590423         # sama, tapi mulai dari unix time tertentu (duplikat otomatis dilewati)
python conflict_report.py [--window-start 2025-01-01] # backfill penuh ±1 jam, di-cache di cache/ (atau $CONFLICT_CACHE)
python conflict_report.py --offline                  # hitung ulang dari cache saja
python test_conflict.py                              # atau: python -m pytest conflict-report
```

- **DNS-over-HTTPS** untuk `*.polymarket.com` aktif secara default di mesin lokal (ISP memblokir domain itu) dan mati di CI (`CI=true`). Atur manual dengan `CONFLICT_DOH=0/1`.
- **Hasil identik dengan backfill penuh.** Mode incremental memakai fungsi analisis yang sama (`analyse`) dan headline dihitung ulang dari semua baris (`summarize`). Diuji dengan menghapus 557 request terakhir dari state lalu mengambilnya ulang secara live: baris sengketa dan konflik yang dihasilkan sama dengan backfill. `test_conflict.py` juga memastikan `summary.json` persis bisa diturunkan dari `disputes.json` + `conflicts.json` + `state.json`.
- Bedanya: incremental mengecek EOA + Safe **setiap** voter langsung di pasar baru (tidak bergantung pada probe link lama), jadi voter yang baru mulai trading tetap terdeteksi.
- Request yang belum bisa dipetakan (Gamma baru mencantumkan pasar setelah ditutup) atau yang fetch-nya gagal disimpan di `state.json:pending` dan dicoba ulang selama 7 hari, lalu dihitung sebagai tidak terpetakan.

Output: `out/summary.json`, `out/disputes.{csv,json}` (1 baris per request DVM), `out/conflicts.{csv,json}` (1 baris per vote konflik), `out/case_studies.json`, `out/state.json` (kursor resolusi, hash id request yang sudah diproses, pasar, status link voter, request pending). Cache mentah backfill (±330 MB) ada di `cache/` dan tidak dibutuhkan untuk mode incremental.

## Monitor harian

`.github/workflows/conflict-report.yml` berjalan setiap hari pukul 06:00 UTC (dan manual lewat *workflow_dispatch*): menjalankan update incremental (3 percobaan, timeout per percobaan), tes, membangun ulang situs, lalu meng-commit `docs/` dan `conflict-report/out/` ke `main` sebagai `github-actions[bot]` dengan `GITHUB_TOKEN` bawaan. Tidak butuh secret. Hasilnya tampil di <https://pugarhuda.github.io/saring/>: angka utama, tabel **Latest disputes** (25 vote DVM terbaru dengan tanda konflik dan waktu update UTC), dan dataset unduhan di `docs/data/` (CC BY 4.0, lihat `docs/data/README.md`).
