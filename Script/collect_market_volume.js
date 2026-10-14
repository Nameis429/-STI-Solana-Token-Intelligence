#!/usr/bin/env node
'use strict';
/**
 * SOLANA TOKEN INTELLIGENCE — MARKET VOLUME COLLECTOR (Phase 8C)
 *
 * Mengumpulkan volume perdagangan market-wide untuk sebuah mint dengan
 * memindai SEMUA transaksi yang menyentuh alamat mint (getSignaturesForAddress
 * + getTransaction jsonParsed), lalu mengklasifikasikan aliran token per wallet.
 *
 * Output: Output/<mint>/market-volume.json
 *
 * Data ini membuka evaluator yang selama ini terkunci karena butuh total
 * volume market-wide (bukan sampel bounded Phase 8):
 *   SPR-03 (connected sell share), CTR-04 (connected group volume share),
 *   TCR-01/TCR-02 (top seller/buyer share), TCR-03 (connected concentration).
 * Tanpa file ini — atau bila completeness != 'complete' — kelima rule tetap
 * INSUFFICIENT_DATA secara jujur (tidak ada trigger palsu dari sampel parsial).
 *
 * HEURISTIK KLASIFIKASI (didokumentasikan, bukan kebenaran mutlak):
 *  - Per transaksi, hitung delta balance token mint per owner (dari
 *    preTokenBalances/postTokenBalances) dan delta SOL (lamports) di SEMUA
 *    akun yang pubkey-nya == owner (akun native SOL-nya, bukan ATA tokennya).
 *  - BUY  = token_delta > 0  dan sol_delta < -FEE_BUFFER (SOL keluar).
 *  - SELL = token_delta < 0  dan sol_delta > +FEE_BUFFER (SOL masuk).
 *  - Selain itu = TRANSFER/other (mis. transfer antar wallet, quote USDC,
 *    swap multi-hop / agregator yang tak terbaca pola SOL-nya, atau
 *    route WSOL di mana kaki SOL muncul sebagai transfer token WSOL).
 *  - Heuristik ini hanya valid untuk pair ber-quote SOL langsung. Pair
 *    USDC/USDT atau route Jupiter multi-hop dapat terlewat -> volume BUY/SELL
 *    bisa UNDER-estimate; selalu baca field `method` dan `coverage_notes`.
 *
 * BATASAN & KEJUJURAN COMPLETENESS:
 *  - completeness='complete' HANYA bila paginasi mencapai halaman kosong
 *    (tidak ada lagi signature) TANPA menyentuh --max-tx. Bila cap tersentuh
 *    atau ada error halaman -> 'partial'.
 *  - Evaluator Phase 9 bertingkat: 'complete' -> klaim market-wide;
 *    'partial' dengan >=500 transaksi ter-parse -> evaluasi WINDOW TERAMATI
 *    (transaksi terbaru, scope diungkap di metric); di bawah itu
 *    INSUFFICIENT_DATA. Tidak ada trigger dari data yang tidak cukup.
 *
 * BIAYA RPC: ~1 getTransaction per signature (+ paginasi signature).
 * Default --max-tx 1500. Untuk meme coin ramai, kumpulkan dari jaringan yang
 * murah/cepat; trial key Helius punya rate limit — hormati --delay-ms.
 *
 * KONFIGURASI FLEKSIBEL (tanpa bongkar script):
 *  Semua angka di atas bisa diatur permanen di Config/config.json, section
 *  "market_volume": max_tx, delay_ms, page_limit, retry_passes,
 *  retry_delay_ms, timeout_ms. Prioritas: flag CLI > config.json > bawaan.
 *  Menu 15 (tanpa flag) otomatis memakai config.json.
 *
 * KETAHANAN (v1.0.3): kegagalan dibedakan menjadi
 *  - retryable (error jaringan/RPC/timeout) -> dikumpulkan dan di-fetch ulang
 *    pada --retry-passes pass khusus (default 2) dengan timeout 2x dan jeda
 *    lebih longgar, TANPA mengulang signature yang sudah sukses;
 *  - permanent (tx tidak ditemukan / hasil parse tak bisa dipakai) ->
 *    dicatat dan tidak di-retry (retry tak ada gunanya).
 */

const fs = require('fs');
const path = require('path');
const { attachRunMetadata } = require('./run_metadata');
// Pacing global via Script/rpc_throttle.js — satu slot per proses,
// konsisten dengan phase 1-8. Interval per-panggilan tetap dari config lokal
// (delay_ms), worker pool tidak menaikkan laju karena slot bersifat global.
const throttle = require('./rpc_throttle');
const { loadCexIndex, withoutCexWallets } = require('./cex_registry');

const ROOT = path.resolve(__dirname, '..');
const CFG_FILE = path.join(ROOT, 'Config', 'config.json');
const OUT_ROOT = path.join(ROOT, 'Output');
const VERSION = '1.0.8'; // v1.0.8: maxSupportedTransactionVersion 0->1 (Helius -32015: tx v1 deterministik gagal; retry takkan pernah pulih). v1.0.7: alasan retryable dinormalisasi + "Penyebab gagal". v1.0.6: worker pool concurrency — hilangkan head-of-line blocking saat timeout
const VALID_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FEE_BUFFER_LAMPORTS = 8000; // buffer di atas fee tipikal agar transfer murni tak dikira swap

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const short = x => (typeof x === 'string' && VALID_MINT.test(x)) ? `${x.slice(0,5)}…${x.slice(-4)}` : 'UNKNOWN';

function loadConfig() {
  if (!fs.existsSync(CFG_FILE)) throw Error('CONFIG_NOT_FOUND');
  const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  c.helius = c.helius || {};
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if (!c.helius.api_key || c.helius.api_key.startsWith('PASTE_')) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}

async function rpc(rpcUrl, method, params, minIntervalMs, maxRetries = 4, timeoutMs = 25000) {
  const body = { jsonrpc: '2.0', id: `mktvol-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, params };
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      await throttle.takeSlot(minIntervalMs);
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const txt = await res.text();
      let data = {};
      try { data = txt ? JSON.parse(txt) : {}; } catch { /* keep {} */ }
      if (res.status === 429 && attempt < maxRetries) { await sleep(throttle.backoffMs(attempt, 2500, throttle.retryAfterMs(res.headers.get('retry-after')))); continue; }
      if (!res.ok) throw Error(`HTTP_${res.status}`);
      if (data?.error) throw Error(`RPC_${data.error.code}: ${data.error.message}`);
      return data?.result ?? null;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(throttle.backoffMs(attempt, 1200));
    } finally { clearTimeout(timer); }
  }
}

/* ------------------------------------------------------------------
 * PURE: klasifikasikan aliran token sebuah transaksi parsed.
 * Input : parsedTx = hasil getTransaction(encoding jsonParsed),
 *         mint    = alamat mint target.
 * Output: { flows:[{owner, token_delta_raw(BigInt), sol_delta_lamports(Number),
 *                    kind:'BUY'|'SELL'|'TRANSFER'}],
 *           block_time, slot, signature, skipped_reason }
 * Tidak menyentuh jaringan — bisa di-unit-test.
 * ------------------------------------------------------------------ */
function classifyTxFlow(parsedTx, mint) {
  const empty = r => ({ flows: [], block_time: null, slot: null, signature: null, skipped_reason: r });
  if (!parsedTx || parsedTx?.meta?.err) return empty('failed_or_missing_tx');
  const meta = parsedTx.meta, msg = parsedTx.transaction?.message;
  if (!meta || !msg) return empty('missing_meta_or_message');
  // blockTime lives at the TOP LEVEL of the getTransaction result
  // (sibling of meta/transaction), not inside meta. v1.0.0/v1.0.1 read
  // meta.blockTime -> always null -> window timestamps were lost.
  const _bt = parsedTx?.blockTime;
  const blockTime = typeof _bt === 'number' ? _bt
    : (typeof meta?.blockTime === 'number' ? meta.blockTime : null);
  const keys = msg.accountKeys || [];
  const pubkeyOf = i => {
    const k = keys[i];
    if (!k) return null;
    return typeof k === 'string' ? k : (k.pubkey || null);
  };
  const preT = meta.preTokenBalances || [], postT = meta.postTokenBalances || [];
  const byAcct = new Map(); // accountIndex -> {owner, mint, pre(BigInt), post(BigInt)}
  const rawOf = b => {
    try {
      const amt = b?.uiTokenAmount?.amount;
      return typeof amt === 'string' && /^\d+$/.test(amt) ? BigInt(amt) : null;
    } catch { return null; }
  };
  for (const b of preT) {
    if (b?.mint !== mint) continue;
    const r = rawOf(b); if (r === null) continue;
    const e = byAcct.get(b.accountIndex) || { owner: b.owner || null, pre: 0n, post: null };
    e.pre = r; if (b.owner) e.owner = b.owner;
    byAcct.set(b.accountIndex, e);
  }
  for (const b of postT) {
    if (b?.mint !== mint) continue;
    const r = rawOf(b); if (r === null) continue;
    const e = byAcct.get(b.accountIndex) || { owner: b.owner || null, pre: 0n, post: null };
    e.post = r; if (b.owner) e.owner = b.owner;
    byAcct.set(b.accountIndex, e);
  }
  // Agregasi per owner (satu owner bisa punya beberapa ATA dalam satu tx).
  const perOwner = new Map(); // owner -> {tokenDelta:BigInt, acctIndexes:Set, closedAny:boolean}
  for (const [idx, e] of byAcct) {
    let d, closed = false;
    if (e.post === null) {
      // Akun DITUTUP dalam tx ini — pola umum "jual habis lalu tutup ATA".
      // Seluruh saldo pre keluar: delta = -pre. Versi lama melewati kasus ini
      // total sehingga SELL-all hilang diam-diam dari volume. Agregasi per owner
      // di bawah tetap menetralkan bila token hanya pindah ke ATA lain miliknya.
      if (e.pre <= 0n) continue;
      d = -e.pre; closed = true;
    } else {
      d = e.post - e.pre;
      if (d === 0n) continue;
    }
    const o = e.owner || pubkeyOf(idx);
    if (!o) continue;
    const cur = perOwner.get(o) || { tokenDelta: 0n, acctIndexes: new Set(), closedAny: false };
    cur.tokenDelta += d; cur.acctIndexes.add(idx); if (closed) cur.closedAny = true;
    perOwner.set(o, cur);
  }
  // Peta pubkey -> semua index akun miliknya. PENTING (bugfix v1.0.1):
  // delta SOL harus diukur pada akun NATIVE SOL milik owner (index akun
  // sistemnya), BUKAN pada akun token (ATA) — ATA tidak menyimpan SOL,
  // sehingga versi lama selalu mengukur 0 dan semua swap terklasifikasi
  // TRANSFER. Sekarang: jumlahkan delta lamports di SEMUA index yang
  // pubkey-nya == owner.
  const idxByPubkey = new Map();
  keys.forEach((k, i) => {
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (!pk) return;
    const a = idxByPubkey.get(pk) || [];
    a.push(i); idxByPubkey.set(pk, a);
  });
  const preB = meta.preBalances || [], postB = meta.postBalances || [];
  const flows = [];
  for (const [owner, info] of perOwner) {
    let solDelta = 0, solKnown = false;
    for (const idx of (idxByPubkey.get(owner) || [])) {
      const a = preB[idx], b = postB[idx];
      if (typeof a === 'number' && typeof b === 'number') { solDelta += (b - a); solKnown = true; }
    }
    let kind = 'TRANSFER';
    if (solKnown) {
      if (info.tokenDelta > 0n && solDelta < -FEE_BUFFER_LAMPORTS) kind = 'BUY';
      else if (info.tokenDelta < 0n && solDelta > FEE_BUFFER_LAMPORTS) kind = 'SELL';
    }
    flows.push({ owner, token_delta_raw: info.tokenDelta, sol_delta_lamports: solKnown ? solDelta : null, kind, account_closed: info.closedAny === true });
  }
  return {
    flows,
    block_time: blockTime,
    slot: typeof parsedTx.slot === 'number' ? parsedTx.slot : null,
    signature: parsedTx.transaction?.signatures?.[0] || null,
    skipped_reason: null
  };
}

/* ------------------------------------------------------------------
 * Fetch + klasifikasi satu signature dengan hasil berstatus.
 *  - {status:'ok', flows, block_time}
 *  - {status:'retryable', reason}  : error jaringan/RPC/timeout/429 —
 *    layak dicoba lagi pada retry pass khusus.
 *  - {status:'permanent', reason}  : tx tidak ditemukan (null) atau hasil
 *    parse tak bisa dipakai (mis. tx on-chain gagal) — retry tak ada gunanya.
 * doRpc dapat di-inject untuk unit test; default-nya rpc() asli.
 * ------------------------------------------------------------------ */
async function fetchAndClassify(sig, doRpc, mint, { minIntervalMs, timeoutMs }) {
  let tx;
  try {
    // Note: maxSupportedTransactionVersion=1. Nilai 0 membuat SEMUA
    // transaksi v1 gagal deterministik dengan RPC -32015 ("Transaction
    // version (1) is not supported by the requesting client" — dok. Helius);
    // retry takkan pernah memulihkannya. Parser (classifyTxFlow) hanya
    // membaca meta balances yang version-agnostic, jadi aman.
    tx = await doRpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], minIntervalMs, 4, timeoutMs);
  } catch (e) {
    return { status: 'retryable', reason: `fetch_error:${e.message || e}` };
  }
  if (!tx) return { status: 'permanent', reason: 'not_found' };
  const c = classifyTxFlow(tx, mint);
  if (c.skipped_reason) return { status: 'permanent', reason: `parse_skipped:${c.skipped_reason}` };
  return { status: 'ok', flows: c.flows, block_time: c.block_time };
}

/* Agregasi hasil klasifikasi ke state kolektor. */
function aggregateFlows(st, flows, blockTime, half) {
  if (blockTime != null) {
    if (st.firstTs == null || blockTime < st.firstTs) st.firstTs = blockTime;
    if (st.lastTs == null || blockTime > st.lastTs) st.lastTs = blockTime;
  }
  // Paruh window (v1.0.5): diagnostik stabilitas untuk rule tier windowed di
  // Phase 9. half: 'recent' (separuh urutan-pertama = transaksi terbaru) atau
  // 'older'. Default 'recent' agar pemanggil lama/test tidak rusak.
  const H = half === 'older' ? 'older' : 'recent';
  if (!st.halfTotals) st.halfTotals = { recent: { buy: 0n, sell: 0n, txs: 0 }, older: { buy: 0n, sell: 0n, txs: 0 } };
  st.halfTotals[H].txs++;
  const newHalves = () => ({ recent: { buy: 0n, sell: 0n, txs: 0 }, older: { buy: 0n, sell: 0n, txs: 0 } });
  for (const f of flows) {
    const amt = f.token_delta_raw < 0n ? -f.token_delta_raw : f.token_delta_raw;
    if (f.account_closed === true) st.closedAccountFlows++;
    if (f.kind === 'BUY') st.buyVol += amt;
    else if (f.kind === 'SELL') st.sellVol += amt;
    else st.transferVol += amt;
    if (f.kind === 'BUY') st.halfTotals[H].buy += amt;
    else if (f.kind === 'SELL') st.halfTotals[H].sell += amt;
    let w = st.perWallet.get(f.owner);
    if (!w) { w = { buy: 0n, sell: 0n, txs: 0, halves: newHalves() }; st.perWallet.set(f.owner, w); }
    if (f.kind === 'BUY') { w.buy += amt; w.halves[H].buy += amt; }
    else if (f.kind === 'SELL') { w.sell += amt; w.halves[H].sell += amt; }
    w.txs++; w.halves[H].txs++;
  }
  st.parsed++;
}

/* ------------------------------------------------------------------
 * PURE: progress bar + format baris progres untuk tampilan terminal.
 * Dipakai menu 15 — selain "200/1500",
 * tampilkan bar persen, jumlah ok/gagal/skip, kecepatan (tx/dtk),
 * dan estimasi sisa waktu — supaya terlihat proses berjalan vs terhenti.
 * Tidak menyentuh jaringan — bisa di-unit-test.
 * ------------------------------------------------------------------ */
const PROGRESS_BAR_WIDTH = 30;
function progressBar(done, total, width = PROGRESS_BAR_WIDTH) {
  const w = Math.max(1, Math.floor(Number(width) || PROGRESS_BAR_WIDTH));
  const t = Math.max(0, Number(total) || 0);
  const d = t > 0 ? Math.max(0, Math.min(Number(done) || 0, t)) : 0;
  const frac = t > 0 ? d / t : 0;
  const pct = Math.round(frac * 100);
  const fill = Math.round(frac * w);
  return `[${'█'.repeat(fill)}${'░'.repeat(w - fill)}] ${String(pct).padStart(3)}%`;
}
function formatScanProgress({ done, total, ok, failed, permanent, elapsedMs }) {
  const bar = progressBar(done, total);
  const secs = Math.max(0.001, (Number(elapsedMs) || 0) / 1000);
  const rate = (Number(done) || 0) / secs;
  const etaS = rate > 0 ? Math.round(((Number(total) || 0) - (Number(done) || 0)) / rate) : null;
  const eta = etaS == null ? 'ETA ?' : (etaS >= 120 ? `ETA ~${Math.round(etaS / 60)} mnt` : `ETA ~${etaS} dtk`);
  return `${bar} | ${done}/${total} tx | ok ${ok} | gagal ${failed} | skip ${permanent} | ${rate.toFixed(1)} tx/dtk | ${eta}`;
}
function formatRetryProgress({ pass, passDone, passTotal, recovered }) {
  const bar = progressBar(passDone, passTotal);
  return `↻ retry ${pass} ${bar} | ${passDone}/${passTotal} | pulih ${recovered}`;
}

/* ------------------------------------------------------------------
 * Orkestrasi pengumpulan: main pass + retry passes khusus untuk yang
 * gagal jaringan. fetchOne di-inject (asli = fetchAndClassify via rpc).
 * Mengembalikan {state, failed, recovered}.
 *
 * onProgress(done, total, failedCount, pass, recovered, info): dipanggil
 * tiap item selesai pada pass 0, dan tiap 50 item + tiap akhir pass pada
 * retry pass. info = { ok, permanent, elapsedMs, passDone, passTotal,
 * passComplete } — pemanggil lama yang tak memakai info tetap aman.
 * ------------------------------------------------------------------ */
async function collectSignatures(sigs, fetchOne, opts, onProgress) {
  const newHalves = () => ({ recent: { buy: 0n, sell: 0n, txs: 0 }, older: { buy: 0n, sell: 0n, txs: 0 } });
  const st = { perWallet: new Map(), buyVol: 0n, sellVol: 0n, transferVol: 0n,
    parsed: 0, permanent: 0, permanentReasons: {}, closedAccountFlows: 0,
    halfTotals: newHalves(), firstTs: null, lastTs: null };
  const markPermanent = r => {
    st.permanent++;
    const k = String(r?.reason || 'unknown');
    st.permanentReasons[k] = (st.permanentReasons[k] || 0) + 1;
  };
  let retryable = [], recovered = 0, done = 0;
  const t0 = Date.now(); // untuk kecepatan tx/dtk & ETA di tampilan progres
  // Paruh window (v1.0.5): signature di-fetch newest-first; separuh urutan
  // pertama = 'recent' (transaksi terbaru), sisanya = 'older'. Index asli
  // dibawa saat retry agar paruh tetap konsisten.
  const halfOf = idx => idx < Math.ceil(sigs.length / 2) ? 'recent' : 'older';
  // Worker pool (v1.0.6): batasi worker RPC concurrent seperti
  // phase 8. Slot throttle bersifat GLOBAL (Script/rpc_throttle.js, module-level), jadi N worker tetap
  // menghormati jeda antar-request — throughput tidak naik, tetapi satu
  // request yang timeout tidak lagi memblokir seluruh antrean (sebelumnya
  // sequential: tiap timeout 25-60 detik menghentikan semuanya -> "terhenti").
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
  async function runPool(items, fn) {
    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  }
  // Note: "gagal jaringan" menutupi banyak
  // penyebab (jaringan HP, timeout, 429, HTTP/RPC error). Alasan kini disimpan
  // dan dinormalisasi agar run berikutnya menjawabnya dengan pasti.
  const retryReasons = {};
  const noteRetryReason = (reason) => {
    const m = String(reason || '').replace(/^fetch_error:/, '');
    let k;
    if (/^HTTP_429/.test(m)) k = 'HTTP_429_rate_limited';
    else if (/^HTTP_(\d+)/.test(m)) k = 'HTTP_' + m.match(/^HTTP_(\d+)/)[1];
    else if (/^RPC_-?\d+/.test(m)) k = m.match(/^RPC_-?\d+/)[0];
    else if (/abort/i.test(m)) k = 'timeout_aborted';
    else {
      const net = m.match(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/i);
      k = net ? 'network_' + net[0].toUpperCase() : (/fetch failed/i.test(m) ? 'network_fetch_failed' : m.slice(0, 60) || 'unknown');
    }
    retryReasons[k] = (retryReasons[k] || 0) + 1;
  };
  const indexed = sigs.map((sig, idx) => ({ sig, idx }));
  await runPool(indexed, async ({ sig, idx }) => {
    const r = await fetchOne(sig, { minIntervalMs: opts.delayMs, timeoutMs: opts.timeoutMs });
    if (r.status === 'ok') aggregateFlows(st, r.flows, r.block_time, halfOf(idx));
    else if (r.status === 'retryable') { retryable.push({ sig, idx, reason: r.reason }); noteRetryReason(r.reason); }
    else markPermanent(r);
    done++;
    if (onProgress) onProgress(done, sigs.length, retryable.length, 0, 0,
      { ok: st.parsed, permanent: st.permanent, elapsedMs: Date.now() - t0 });
  });
  for (let pass = 1; pass <= opts.retryPasses && retryable.length; pass++) {
    const still = [];
    const items = retryable; retryable = [];
    let rdone = 0;
    const rinfo = passComplete => ({ ok: st.parsed, permanent: st.permanent, elapsedMs: Date.now() - t0, passDone: rdone, passTotal: items.length, passComplete: !!passComplete });
    await runPool(items, async ({ sig, idx }) => {
      const r = await fetchOne(sig,
        { minIntervalMs: opts.retryDelayMs, timeoutMs: Math.min(60000, opts.timeoutMs * 2) });
      if (r.status === 'ok') { aggregateFlows(st, r.flows, r.block_time, halfOf(idx)); recovered++; }
      else if (r.status === 'retryable') { still.push({ sig, idx, reason: r.reason }); noteRetryReason(r.reason); }
      else markPermanent(r);
      rdone++;
      if (onProgress && rdone % 50 === 0) onProgress(done, sigs.length, still.length, pass, recovered, rinfo(false));
    });
    retryable = still;
    if (onProgress) onProgress(done, sigs.length, retryable.length, pass, recovered, rinfo(true));
  }
  return { state: st, failed: retryable.map(x => x.sig), recovered, retryReasons };
}

const DEFAULT_COLLECTOR_OPTS = { maxTx: 1500, delayMs: 300, pageLimit: 1000, retryPasses: 2, retryDelayMs: 1500, timeoutMs: 25000, concurrency: 3 };
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
/* ------------------------------------------------------------------
 * Resolusi setting dengan precedence: flag CLI > Config/config.json
 * (section market_volume) > default bawaan. Semua nilai disanitasi
 * dengan batas yang sama. Pure — bisa di-unit-test.
 * ------------------------------------------------------------------ */
function resolveCollectorOpts(cli, fileCfg) {
  const f = fileCfg && typeof fileCfg === 'object' ? fileCfg : {};
  const pick = (cliKey, fileKey, sanitize) => {
    const c = cli ? cli[cliKey] : undefined;
    if (c !== null && c !== undefined) return sanitize(c);
    const n = toInt(f[fileKey]);
    if (n !== null) return sanitize(n);
    return DEFAULT_COLLECTOR_OPTS[cliKey];
  };
  return {
    maxTx: pick('maxTx', 'max_tx', n => Math.max(1, n)),
    delayMs: pick('delayMs', 'delay_ms', n => Math.max(0, n)),
    pageLimit: pick('pageLimit', 'page_limit', n => Math.min(1000, Math.max(1, n))),
    retryPasses: pick('retryPasses', 'retry_passes', n => Math.max(0, n)),
    retryDelayMs: pick('retryDelayMs', 'retry_delay_ms', n => Math.max(0, n)),
    timeoutMs: pick('timeoutMs', 'timeout_ms', n => Math.max(5000, n)),
    concurrency: pick('concurrency', 'concurrency', n => Math.max(1, Math.min(8, n)))
  };
}
function parseArgs(argv) {
  const o = { mint: null, maxTx: null, delayMs: null, pageLimit: null, retryPasses: null, retryDelayMs: null, timeoutMs: null, concurrency: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && !o.mint && VALID_MINT.test(a)) o.mint = a;
    else if (a === '--max-tx') o.maxTx = toInt(argv[++i]);
    else if (a === '--delay-ms') o.delayMs = toInt(argv[++i]);
    else if (a === '--page-limit') o.pageLimit = toInt(argv[++i]);
    else if (a === '--retry-passes') o.retryPasses = toInt(argv[++i]);
    else if (a === '--retry-delay-ms') o.retryDelayMs = toInt(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = toInt(argv[++i]);
    else if (a === '--concurrency') o.concurrency = toInt(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help || !cli.mint) {
    console.log('Penggunaan: node Script/collect_market_volume.js <MINT> [--max-tx 1500] [--delay-ms 300] [--page-limit 1000]');
    console.log('           [--retry-passes 2] [--retry-delay-ms 1500] [--timeout-ms 25000] [--concurrency 3]');
    console.log('  Mengumpulkan volume market-wide -> Output/<mint>/market-volume.json');
    console.log('  BIAYA: ~1 RPC getTransaction per signature. Hormati rate limit key Anda.');
    console.log('  Signature yang gagal karena jaringan di-retry otomatis (--retry-passes) tanpa mengulang yang sukses.');
    console.log('  Semua angka di atas juga bisa diatur permanen di Config/config.json -> market_volume');
    console.log('  (prioritas: flag CLI > config.json > bawaan).');
    process.exit(cli.help ? 0 : 1);
  }
  const mint = cli.mint;
  const config = loadConfig();
  throttle.configure(config);
  // Setting fleksibel: flag CLI > Config/config.json (market_volume) > bawaan.
  // Menu 15 (tanpa flag) otomatis memakai config.json — tanpa bongkar script.
  const args = { mint, ...resolveCollectorOpts(cli, config.market_volume) };
  const OPT_KEYS = ['maxTx', 'delayMs', 'pageLimit', 'retryPasses', 'retryDelayMs', 'timeoutMs'];
  const cfgSrc = OPT_KEYS.some(k => cli[k] !== null && cli[k] !== undefined)
    ? 'flag CLI' : (config.market_volume ? 'Config/config.json (market_volume)' : 'bawaan');
  const rpcBase = String(config.helius.rpc_url || 'https://mainnet.helius-rpc.com').trim();
  const rpcUrl = `${rpcBase}${rpcBase.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(config.helius.api_key)}`;

  console.log(`\nMARKET VOLUME COLLECTOR v${VERSION} (Phase 8C)`);
  console.log(`Mint      : ${short(mint)}`);
  console.log(`Setting   : maks ${args.maxTx} tx | jeda ${args.delayMs} ms | retry ${args.retryPasses}x (jeda ${args.retryDelayMs} ms) | timeout ${args.timeoutMs} ms | worker ${args.concurrency}`);
  console.log(`Sumber    : ${cfgSrc}`);
  console.log('PERINGATAN: tiap signature = 1 panggilan getTransaction ke RPC Anda.');
  console.log('Lanjut dalam 3 detik... (Ctrl+C untuk batal)');
  await sleep(3000);

  const outDir = path.join(OUT_ROOT, mint);
  fs.mkdirSync(outDir, { recursive: true });

  // 1) Paginasi signature
  const sigs = [];
  let before = undefined, pages = 0, hitCap = false, pageError = null;
  while (true) {
    const params = [{ limit: args.pageLimit }];
    if (before) params[0].before = before;
    let page;
    try {
      page = await rpc(rpcUrl, 'getSignaturesForAddress', [mint, params[0]], args.delayMs);
    } catch (e) { pageError = e.message; break; }
    if (!Array.isArray(page) || page.length === 0) break;
    pages++;
    for (const s of page) if (s?.signature) sigs.push(s.signature);
    if (sigs.length >= args.maxTx) { hitCap = true; break; }
    if (page.length < args.pageLimit) break; // halaman terakhir
    before = page[page.length - 1].signature;
  }
  const sigsToFetch = sigs.slice(0, args.maxTx);

  // 2) Fetch + klasifikasikan (dengan retry pass khusus untuk gagal jaringan)
  const doRpc = (method, params, minIntervalMs, maxRetries, timeoutMs) =>
    rpc(rpcUrl, method, params, minIntervalMs, maxRetries, timeoutMs);
  const fetchOne = (sig, o) => fetchAndClassify(sig, doRpc, mint, o);
  const { state: st, failed: failedSigs, recovered, retryReasons } = await collectSignatures(
    sigsToFetch, fetchOne,
    { delayMs: args.delayMs, timeoutMs: args.timeoutMs, retryPasses: args.retryPasses, retryDelayMs: args.retryDelayMs },
    (done, total, failedCount, pass, rec, info = {}) => {
      if (pass === 0) {
        // Baris progres tiap 100 tx: bar persen + ok/gagal/skip + kecepatan + ETA.
        if (done % 100 === 0 || done === total) console.log('  ' + formatScanProgress({
          done, total, ok: info.ok ?? 0, failed: failedCount,
          permanent: info.permanent ?? 0, elapsedMs: info.elapsedMs ?? 0,
        }));
      } else if (info.passComplete) {
        console.log(`  ↻ retry pass ${pass} selesai: pulih ${rec} total, tersisa ${failedCount}`);
      } else {
        console.log('  ' + formatRetryProgress({
          pass, passDone: info.passDone ?? 0, passTotal: info.passTotal ?? 0, recovered: rec,
        }));
      }
    });
  if (failedSigs.length === 0 && args.retryPasses > 0) console.log('  Semua signature yang sempat gagal jaringan berhasil dipulihkan via retry.');
  const failed = failedSigs.length; // sisa gagal jaringan setelah semua retry
  const parsed = st.parsed, firstTs = st.firstTs, lastTs = st.lastTs;
  const perWallet = st.perWallet, buyVol = st.buyVol, sellVol = st.sellVol, transferVol = st.transferVol;

  const completeness = (!hitCap && pageError == null) ? 'complete' : 'partial';
  const big = b => b.toString();
  // CEX exclusion: wallet CEX dikecualikan dari ranking top
  // buyer/seller — aktivitas bursa bukan sinyal holder. Totals tidak diubah.
  const cexIndex = loadCexIndex(ROOT);
  const { clean: tradeWallets, excluded: cexExcludedTops } =
    withoutCexWallets(cexIndex, [...perWallet.entries()], ([w]) => w);
  const top = (key, n) => tradeWallets
    .filter(([, v]) => v[key] > 0n)
    .sort((a, b) => (a[1][key] < b[1][key] ? 1 : -1))
    .slice(0, n)
    .map(([wallet, v]) => ({ wallet, [`${key}_volume_raw`]: big(v[key]), txs: v.txs }));

  const out = {
    phase: '8C', phase_name: 'MARKET_VOLUME_COLLECTOR', version: VERSION,
    status: failed > parsed ? 'DEGRADED' : 'COMPLETE',
    collected_at_utc: new Date().toISOString(),
    collector_config: {
      max_tx: args.maxTx, delay_ms: args.delayMs, page_limit: args.pageLimit,
      retry_passes: args.retryPasses, retry_delay_ms: args.retryDelayMs,
      timeout_ms: args.timeoutMs, concurrency: args.concurrency, source: cfgSrc
    },
    mint,
    method: {
      source: 'getSignaturesForAddress(mint) + getTransaction(jsonParsed)',
      classification: 'heuristic: token-delta per owner vs SOL-delta on owner native accounts per tx; SOL-quoted pairs only',
      fee_buffer_lamports: FEE_BUFFER_LAMPORTS,
      buy_definition: 'token_delta>0 AND sol_delta<-fee_buffer',
      sell_definition: 'token_delta<0 AND sol_delta>+fee_buffer',
      otherwise: 'TRANSFER/other (incl. USDC-quoted, WSOL-routed, or multi-hop swaps not matching the SOL pattern)'
    },
    window: { first_block_time: firstTs, last_block_time: lastTs },
    coverage: {
      signatures_seen: sigs.length,
      transactions_requested: sigsToFetch.length,
      transactions_parsed: parsed,
      transactions_failed: failed,
      transactions_failed_network_remaining: failed,
      transactions_permanent_skipped: st.permanent,
      permanent_skip_reasons: st.permanentReasons,
      retryable_reasons: retryReasons,
      retryable_reasons_note: 'Kelompok penyebab tiap signature yang gagal total (4x percobaan): network_* = jaringan HP/DNS ke RPC; timeout_aborted = RPC lambat/tidak merespons; HTTP_429_rate_limited = limit RPC; HTTP_*/RPC_* = error sisi server RPC.',
      closed_account_flows_recovered: st.closedAccountFlows,
      retry_passes_configured: args.retryPasses,
      retry_recovered: recovered,
      signature_pages: pages,
      max_tx_cap: args.maxTx,
      hit_cap: hitCap,
      page_error: pageError,
      completeness,
      completeness_note: completeness === 'complete'
        ? 'Pagination reached an empty page without hitting the cap: every known signature for this mint was parsed.'
        : 'PARTIAL: cap reached or a page failed. Totals are a lower bound, NOT market-wide. Phase 9 (tiered evaluation) may still evaluate the 5 market rules on the OBSERVED WINDOW (most recent transactions) when >=500 were parsed — with the windowed scope disclosed; below that it stays INSUFFICIENT_DATA.'
    },
    totals: {
      buy_volume_raw: big(buyVol),
      sell_volume_raw: big(sellVol),
      trade_volume_raw: big(buyVol + sellVol),
      transfer_volume_raw: big(transferVol)
    },
    // Paruh window (v1.0.5): diagnostik stabilitas untuk rule tier windowed.
    // recent = separuh signature pertama (newest-first = transaksi terbaru).
    halves: {
      basis: 'split by fetch order (getSignaturesForAddress newest-first): recent = first half of requested signatures (most recent), older = second half. Diagnostic only; does not change totals.',
      recent: {
        buy_volume_raw: big(st.halfTotals.recent.buy),
        sell_volume_raw: big(st.halfTotals.recent.sell),
        trade_volume_raw: big(st.halfTotals.recent.buy + st.halfTotals.recent.sell),
        transactions: st.halfTotals.recent.txs
      },
      older: {
        buy_volume_raw: big(st.halfTotals.older.buy),
        sell_volume_raw: big(st.halfTotals.older.sell),
        trade_volume_raw: big(st.halfTotals.older.buy + st.halfTotals.older.sell),
        transactions: st.halfTotals.older.txs
      }
    },
    wallets_observed: perWallet.size,
    top_sellers: top('sell', 25),
    top_buyers: top('buy', 25),
    cex_registry: {
      found: cexIndex.size > 0, registry_size: cexIndex.size,
      wallets_excluded_from_tops: cexExcludedTops.length,
      excluded: cexExcludedTops.slice(0, 50).map(x => ({ wallet: x.address, cex_label: x.cex_label })),
      note: 'Wallet CEX dikecualikan dari ranking top buyer/seller; totals tidak diubah.'
    },
    // Per-wallet map (bounded to wallets with buy/sell activity) — dipakai
    // evaluator SPR-03/CTR-04/TCR-03 untuk numerator connected-wallet, dan
    // diagnostik stabilitas window (halves) oleh Phase 9.
    wallets: Object.fromEntries([...perWallet.entries()]
      .filter(([, v]) => v.buy > 0n || v.sell > 0n)
      .map(([w, v]) => [w, { buy_raw: big(v.buy), sell_raw: big(v.sell), txs: v.txs,
        halves: {
          recent: { buy_raw: big(v.halves.recent.buy), sell_raw: big(v.halves.recent.sell), txs: v.halves.recent.txs },
          older: { buy_raw: big(v.halves.older.buy), sell_raw: big(v.halves.older.sell), txs: v.halves.older.txs }
        } }])),
    coverage_notes: [
      'Buy/sell classification is heuristic and SOL-quote only; USDC-quoted, WSOL-routed, or aggregator multi-hop swaps may be counted as TRANSFER.',
      'Signatures paginate newest-first: a PARTIAL file covers the MOST RECENT transactions (recency-biased window, not a random sample).',
      'Phase 9 evaluates market rules market-wide only on COMPLETE files; on PARTIAL files with >=500 parsed txs it evaluates the observed window with disclosed scope; otherwise INSUFFICIENT_DATA.'
    ]
  };
  attachRunMetadata(out, '8C', mint);
  const outFile = path.join(outDir, 'market-volume.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('\nSELESAI');
  console.log(`  Signature terlihat : ${sigs.length}`);
  console.log(`  Transaksi ter-parse: ${parsed} (gagal jaringan tersisa: ${failed}, permanen skip: ${st.permanent}, pulih via retry: ${recovered}, flow akun-ditutup: ${st.closedAccountFlows})`);
  { const rr = Object.entries(retryReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (rr.length) console.log(`  Penyebab gagal    : ${rr.map(([k, v]) => `${k}(${v})`).join(', ')}`); }
  console.log(`  Completeness      : ${completeness.toUpperCase()}`);
  console.log(`  Volume BUY/SELL   : ${buyVol} / ${sellVol} (raw)`);
  console.log(`  Output            : ${outFile}`);
  if (completeness !== 'complete') {
    console.log('  CATATAN: file PARTIAL — bukan market-wide.');
    console.log('  Phase 9 tetap bisa mengevaluasi 5 rule market pada WINDOW TERAMATI');
    console.log('  (transaksi terbaru) bila >=500 ter-parse; di bawah itu INSUFFICIENT_DATA.');
    console.log('  Naikkan --max-tx dan jalankan ulang bila ingin cakupan penuh.');
  }
}

if (require.main === module) { main().catch(e => { console.error(`MKTVOL_ERROR: ${e.message}`); process.exit(1); }); }
module.exports = { classifyTxFlow, fetchAndClassify, aggregateFlows, collectSignatures, resolveCollectorOpts, DEFAULT_COLLECTOR_OPTS, FEE_BUFFER_LAMPORTS, VERSION, progressBar, formatScanProgress, formatRetryProgress, PROGRESS_BAR_WIDTH };
