#!/usr/bin/env node
'use strict';
/**
 * SOLANA TOKEN INTELLIGENCE — FUNDING GRAPH COLLECTOR (Phase 8B, v1.0.0)
 *
 * Mengumpulkan data PENDANAAN (funding) untuk wallet-wallet Phase 8:
 * transfer SOL / token MASUK ke wallet SEBELUM akuisisi pertama token target.
 * Output: Output/<mint>/funding-graph.json
 *
 * Data ini membuka evaluator CTR-01 (shared funder links) dan CTR-02
 * (funding -> trade relationship). Tanpa file ini, kedua rule tetap
 * INSUFFICIENT_DATA secara jujur (tidak ada trigger palsu).
 *
 * Prinsip:
 *  - Bounded & fail-soft: tiap wallet dibatasi N transaksi pre-akuisisi
 *    (config funding_graph.pre_acquisition_txs); gagal fetch -> wallet
 *    dicatat gagal, bukan diasumsikan tak punya funder.
 *  - Atribusi funder bersifat HEURISTIK dan didokumentasikan:
 *    * SOL native: funder = signer dengan balance delta negatif terbesar
 *      (biasanya fee payer/pengirim). Tidak ada label pengirim eksplisit
 *      di transfer SOL native.
 *    * Token: funder = authority pada instruksi transfer/transferChecked
 *      yang destination-nya dimiliki wallet.
 *  - Hanya transfer MASUK (delta positif) yang dicatat sebagai funding.
 *  - Tidak ada RPC saat key placeholder; pacing mengikuti phase8.
 */

const fs = require('fs');
const path = require('path');
const { attachRunMetadata } = require('./run_metadata');
// Pacing global via Script/rpc_throttle.js — satu slot per proses,
// konsisten dengan phase 1-8. Interval per-panggilan tetap dari config lokal.
const throttle = require('./rpc_throttle');
// Opsi getTransaction bersama . Diekspor agar regresi
// maxSupportedTransactionVersion bisa di-test.
const GET_TRANSACTION_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 };

const ROOT = path.resolve(__dirname, '..');
const CFG_FILE = path.join(ROOT, 'Config', 'config.json');
const OUT_ROOT = path.join(ROOT, 'Output');
const VERSION = '1.0.1'; // v1.0.1: maxSupportedTransactionVersion 0->1 (bug yang sama dengan kolektor market-volume: tx v1 gagal RPC -32015, funder hilang diam-diam)
const started = Date.now();

const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const short = x => valid(x) ? `${x.slice(0,5)}…${x.slice(-4)}` : 'UNKNOWN';
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };

function loadConfig() {
  if (!fs.existsSync(CFG_FILE)) throw Error('CONFIG_NOT_FOUND');
  const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  c.helius = c.helius || {};
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if (!c.helius.api_key || c.helius.api_key.startsWith('PASTE_')) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}

async function rpc(rpcUrl, method, params, label, minIntervalMs, maxRetries = 3) {
  const body = { jsonrpc: '2.0', id: `funding-${Date.now()}-${Math.random()}`, method, params };
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      await throttle.takeSlot(minIntervalMs);
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const txt = await res.text();
      let data = {};
      try { data = txt ? JSON.parse(txt) : {}; } catch { /* keep {} */ }
      if (res.status === 429 && attempt < maxRetries) { await sleep(throttle.backoffMs(attempt, 2000, throttle.retryAfterMs(res.headers.get('retry-after')))); continue; }
      if (!res.ok) throw Error(`HTTP_${res.status}`);
      if (data?.error) throw Error(`RPC_${data.error.code}: ${data.error.message}`);
      return data?.result ?? null;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(throttle.backoffMs(attempt, 1000));
    } finally { clearTimeout(timer); }
  }
  throw Error('REQUEST_FAILED');
}

function locateInput(explicitMint) {
  const mint = String(explicitMint || process.argv[2] || process.env.SCAN_MINT || '').trim();
  if (!fs.existsSync(OUT_ROOT)) return null;
  const dirs = fs.readdirSync(OUT_ROOT, { withFileTypes: true }).filter(x => x.isDirectory());
  const found = [];
  for (const d of dirs) {
    const dir = path.join(OUT_ROOT, d.name);
    const p8 = readJson(path.join(dir, 'phase8-result.json'));
    if (!p8) continue;
    const m = p8?.mint || d.name;
    if (!valid(m)) continue;
    if (mint && m !== mint) continue;
    found.push({ dir, mint: m, phase8: p8 });
  }
  if (!found.length) return null;
  if (found.length > 1 && !mint) return null; // ambiguous
  return found[0];
}

/* Extract incoming value transfers TO `wallet` from a jsonParsed transaction.
 * Returns [{funder, asset, amount_raw, decimals}] with heuristic attribution. */
function extractInboundTransfers(tx, wallet) {
  const out = [];
  try {
    const msg = tx?.transaction?.message;
    const meta = tx?.meta;
    if (!msg || !meta) return out;
    const keys = (msg.accountKeys || []).map(k => typeof k === 'string' ? k : k?.pubkey).filter(Boolean);
    const pre = meta.preBalances || [], post = meta.postBalances || [];
    // --- Native SOL ---
    let walletGain = 0n, biggestLoser = null, biggestLoss = 0n;
    keys.forEach((k, i) => {
      const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
      if (k === wallet && delta > 0n) walletGain = delta;
      if (delta < -biggestLoss) { biggestLoss = -delta; biggestLoser = k; }
    });
    if (walletGain > 0n) {
      out.push({ funder: biggestLoser, asset: 'SOL', amount_raw: walletGain.toString(), decimals: 9,
        attribution: 'heuristic:largest_negative_delta_signer' });
    }
    // --- Token transfers (parsed instructions, outer + inner) ---
    const tokAcctOwner = new Map();
    for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) {
      if (b?.accountIndex != null && b?.owner) tokAcctOwner.set(Number(b.accountIndex), b.owner);
    }
    const ixns = [...(msg.instructions || [])];
    for (const inner of (meta.innerInstructions || [])) ixns.push(...(inner.instructions || []));
    for (const ix of ixns) {
      const p = ix?.parsed;
      if (!p || p.type !== 'transfer' && p.type !== 'transferChecked') continue;
      const info = p.info || {};
      const dest = info.destination;
      const destOwner = tokAcctOwner.get(keys.indexOf(dest));
      if (destOwner !== wallet && dest !== wallet) continue;
      const amountRaw = info.amount ?? (info.tokenAmount?.amount);
      if (!/^\d+$/.test(String(amountRaw ?? ''))) continue;
      out.push({ funder: info.authority || info.source || null,
        asset: info.mint || 'UNKNOWN_MINT', amount_raw: String(amountRaw),
        decimals: info.decimals ?? info.tokenAmount?.decimals ?? null,
        attribution: 'heuristic:instruction_authority' });
    }
  } catch { /* never throws */ }
  return out.filter(t => t.funder && t.funder !== wallet);
}

async function collectForWallet(rpcUrl, wallet, firstAcqTs, fg, minIntervalMs) {
  const rec = { wallet, first_acquisition_ts: firstAcqTs, funders: [], coverage: null, error: null };
  try {
    const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [wallet, { limit: 50 }], 'signatures', minIntervalMs) || [];
    const preAcq = sigs.filter(s => num(s.blockTime) != null && (firstAcqTs == null || s.blockTime < firstAcqTs));
    const target = preAcq.slice(0, Math.max(1, fg.pre_acquisition_txs)).reverse();
    let fetched = 0, failed = 0;
    for (const s of target) {
      try {
        // Note: maxSupportedTransactionVersion=1 — lihat komentar yang
        // sama di collect_market_volume.js (RPC -32015 deterministik untuk tx v1).
        const tx = await rpc(rpcUrl, 'getTransaction', [s.signature, GET_TRANSACTION_OPTS], 'tx', minIntervalMs);
        fetched++;
        if (!tx) continue;
        for (const t of extractInboundTransfers(tx, wallet)) {
          rec.funders.push({ ...t, signature: s.signature, block_time: s.blockTime,
            timestamp_utc: new Date(s.blockTime * 1000).toISOString() });
        }
      } catch { failed++; }
    }
    // Deduplicate identical (funder, asset, signature)
    const seen = new Set();
    rec.funders = rec.funders.filter(f => {
      const k = `${f.funder}|${f.asset}|${f.signature}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    rec.coverage = { status: failed ? 'PARTIAL' : 'COMPLETE', signatures_examined: target.length,
      signatures_available_pre_acquisition: preAcq.length, fetch_failed: failed,
      note: 'Bounded pre-acquisition window; absence of funders is not proof of self-funding.' };
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 160);
    rec.coverage = { status: 'FAILED', reason: rec.error };
  }
  return rec;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ FUNDING GRAPH COLLECTOR (Phase 8B)                    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  const config = loadConfig();
  throttle.configure(config);
  const fg = config.funding_graph || {};
  const input = locateInput();
  if (!input) { console.error('ERROR: phase8-result.json tidak ditemukan (atau mint ambigu). Pakai argumen <mint>.'); process.exitCode = 1; return; }
  const { dir, mint, phase8 } = input;
  const rpcBase = String(config.helius.rpc_url).trim();
  const rpcUrl = `${rpcBase}${rpcBase.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(config.helius.api_key)}`;
  const minIntervalMs = Math.max(0, Number(fg.min_request_interval_ms ?? 180));
  const maxWallets = Math.max(1, Number(fg.max_wallets ?? 100));

  const wallets = (phase8.wallets || [])
    .filter(w => w?.history?.first_observed_acquisition?.block_time != null)
    .slice(0, maxWallets);
  console.log(`Mint    : ${short(mint)}`);
  console.log(`Wallets : ${wallets.length} (bounded ${maxWallets})\n`);

  const records = {};
  let ok = 0, fail = 0;
  for (const w of wallets) {
    const ts = num(w.history.first_observed_acquisition.block_time);
    process.stdout.write(`  ${short(w.wallet)} ... `);
    const rec = await collectForWallet(rpcUrl, w.wallet, ts, fg, minIntervalMs);
    records[w.wallet] = rec;
    if (rec.error) { fail++; console.log('FAILED'); }
    else { ok++; console.log(`${rec.funders.length} funder(s)`); }
  }

  // Shared-funder index: funder -> [wallets]. This is the CTR-01 link signal.
  const funderIndex = {};
  for (const [w, rec] of Object.entries(records)) {
    for (const f of rec.funders) {
      if (!f.funder) continue;
      (funderIndex[f.funder] = funderIndex[f.funder] || []);
      if (!funderIndex[f.funder].includes(w)) funderIndex[f.funder].push(w);
    }
  }
  const sharedFunders = Object.entries(funderIndex)
    .filter(([, ws]) => ws.length >= 2)
    .map(([funder, wallets]) => ({ funder, wallet_count: wallets.length, wallets }))
    .sort((a, b) => b.wallet_count - a.wallet_count);

  const result = {
    phase: '8B', phase_name: 'FUNDING_GRAPH', version: VERSION, status: 'COMPLETE',
    timestamp: new Date().toISOString(),
    input: { mint, source: 'phase8-result.json', mode: 'PRE_ACQUISITION_FUNDING_SCAN' },
    config: { pre_acquisition_txs: fg.pre_acquisition_txs ?? 5, max_wallets: maxWallets, min_request_interval_ms: minIntervalMs },
    summary: { wallets_scanned: wallets.length, wallets_ok: ok, wallets_failed: fail,
      wallets_with_funders: Object.values(records).filter(r => r.funders.length > 0).length,
      shared_funders: sharedFunders.length },
    wallets: records,
    shared_funders: sharedFunders.slice(0, 100),
    shared_funders_truncated: sharedFunders.length > 100,
    coverage: { status: fail ? 'PARTIAL' : 'COMPLETE', reason: fail ? `${fail} wallet(s) failed` : 'all scanned wallets processed' },
    limitations: [
      'Funder attribution is heuristic (native SOL: largest negative-delta signer; token: instruction authority).',
      'Bounded pre-acquisition window; absence of funders is NOT proof of self-funding.',
      'Exchange/withdrawal funders (e.g. CEX hot wallets) link wallets only by shared service, not by common ownership — treat shared-funder links as investigative leads, not proof.',
      'A shared funder does not establish coordinated trading by itself.'
    ],
    data_sources: ['Helius RPC getSignaturesForAddress', 'Helius RPC getTransaction (jsonParsed)']
  };
  attachRunMetadata(result, '8B', mint);
  const out = path.join(dir, 'funding-graph.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`\nWallets OK      : ${ok}/${wallets.length}`);
  console.log(`With funders    : ${result.summary.wallets_with_funders}`);
  console.log(`Shared funders  : ${sharedFunders.length}`);
  console.log(`OUTPUT          : ${path.relative(ROOT, out)}`);
  console.log(`TIME            : ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (require.main === module) main().catch(e => { console.error('FATAL:', e.message); process.exitCode = 1; });

module.exports = { extractInboundTransfers, VERSION, GET_TRANSACTION_OPTS };
