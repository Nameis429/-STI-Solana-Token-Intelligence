#!/usr/bin/env node
'use strict';
/**
 * SOLANA TOKEN INTELLIGENCE — PHASE 12
 * EARLY-TRADER SIGNALS (v1.0.0)
 *
 * Lensa "early trader memecoin": merangkum artefak Phase 1–11 menjadi
 * sinyal yang bisa dibaca cepat sebelum entry — BUKAN prediksi harga.
 *
 * Prinsip (diwarisi dari audit STI):
 *  - Deterministik & berbasis aturan; tidak ada probabilitas/score ramalan.
 *  - UNKNOWN tetap UNKNOWN; tidak pernah dihitung sebagai PASS.
 *  - Tidak mengubah formula/locked rule Phase 1–11. Modul ini murni baca.
 *  - 100% offline: hanya membaca Output/<mint>/phaseN-result.json.
 *    Tidak ada RPC call, jadi bisa jalan tanpa Helius API key.
 *
 * Keluaran: Output/<mint>/phase12-result.json
 * Sinyal sosial (X/Reddit) bersifat OPSIONAL via Data/social_signals.json —
 * hanya informasional, tidak pernah mengubah checklist/verdict.
 */

const fs = require('fs');
const path = require('path');
const { attachRunMetadata } = require('./run_metadata');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'Config', 'config.json');
const OUTPUT_ROOT = path.join(ROOT, 'Output');
const SOCIAL_FILE = path.join(ROOT, 'Data', 'social_signals.json');
const VERSION = '1.0.0';
const started = Date.now();

const VALID_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const rawBigInt = x => { try { return BigInt(String(x ?? '0')); } catch { return 0n; } };
const pctOf = (raw, den) => { const d = rawBigInt(den); return d > 0n ? Number(rawBigInt(raw) * 1000000n / d) / 10000 : null; };
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const short = x => (typeof x === 'string' && x.length > 12 ? `${x.slice(0, 6)}...${x.slice(-6)}` : x || 'UNKNOWN');

function loadConfig() {
  const c = readJson(CFG) || {};
  return c.early_signals || {};
}

function locateInput(explicitMint) {
  const mint = String(explicitMint || process.argv[2] || process.env.SCAN_MINT || '').trim();
  const pick = (m) => {
    const dir = path.join(OUTPUT_ROOT, m);
    if (!fs.existsSync(dir)) return null;
    const phases = {};
    for (let i = 1; i <= 11; i++) phases[i] = readJson(path.join(dir, `phase${i}-result.json`));
    if (!phases[11]) return null;
    return { mint: m, dir, phases };
  };
  if (mint && VALID_MINT.test(mint)) return pick(mint);
  if (!fs.existsSync(OUTPUT_ROOT)) return null;
  const dirs = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true }).filter(x => x.isDirectory());
  const withP11 = dirs.map(d => d.name).filter(m => fs.existsSync(path.join(OUTPUT_ROOT, m, 'phase11-result.json')));
  if (withP11.length === 1) return pick(withP11[0]);
  return null;
}

/* ------------------------- 1. Rug checklist ------------------------- */

function checkItem(id, label, status, detail) {
  if (!['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(status)) status = 'UNKNOWN';
  return { id, label, status, detail: detail || null };
}

function rugChecklist(phases, cfg) {
  const p2 = phases[2] || {}, p4 = phases[4] || {}, p5 = phases[5] || {};
  const items = [];

  // 1. Mint authority
  const mintAuth = String(p2?.authority?.mint?.status || 'UNKNOWN').toUpperCase();
  items.push(checkItem('MINT_AUTHORITY', 'Mint authority',
    mintAuth === 'REVOKED' ? 'PASS' : mintAuth === 'ACTIVE' ? 'FAIL' : 'UNKNOWN',
    `Status: ${mintAuth}. Mint authority aktif = supply bisa dicetak ulang sewaktu-waktu.`));

  // 2. Freeze authority
  const freezeAuth = String(p2?.authority?.freeze?.status || 'UNKNOWN').toUpperCase();
  items.push(checkItem('FREEZE_AUTHORITY', 'Freeze authority',
    freezeAuth === 'REVOKED' ? 'PASS' : freezeAuth === 'ACTIVE' ? 'WARN' : 'UNKNOWN',
    `Status: ${freezeAuth}. Freeze aktif = holder bisa dibekukan (sering dipakai token "resmi", tapi risiko untuk memecoin).`));

  // 3. LP burn/lock
  const summary = p4?.liquidity_mapping?.lock_status_summary || {};
  const sigPools = p4?.liquidity_mapping?.significant_pools || [];
  let lpStatus = 'UNKNOWN', lpDetail = 'Tidak ada pool signifikan terdeteksi / status tak diketahui.';
  if (sigPools.length) {
    const worst = ['UNLOCKED', 'PARTIALLY_LOCKED', 'UNKNOWN', 'LOCKED', 'BURNED'];
    const seen = sigPools.map(p => String(p?.lp_status?.status || 'UNKNOWN').toUpperCase());
    const rank = s => worst.indexOf(s);
    const worstSeen = seen.slice().sort((a, b) => rank(a) - rank(b))[0] || 'UNKNOWN';
    lpDetail = `Pool signifikan: ${sigPools.length}. Ringkasan: ${Object.entries(summary).map(([k, v]) => `${k}:${v}`).join(', ') || 'n/a'}.`;
    lpStatus = worstSeen === 'BURNED' || worstSeen === 'LOCKED' ? 'PASS'
      : worstSeen === 'PARTIALLY_LOCKED' ? 'WARN'
      : worstSeen === 'UNLOCKED' ? 'FAIL' : 'UNKNOWN';
  } else if (p4?.liquidity_mapping?.status === 'NOT_FOUND') {
    lpDetail = 'Phase 4 tidak menemukan liquidity pool. Token mungkin belum punya likuiditas terdeteksi.';
  }
  items.push(checkItem('LP_LOCK', 'LP burn / lock', lpStatus, lpDetail));

  // 4. Top-10 concentration
  const conc = p4?.concentration?.adjusted_confirmed_normal || p4?.concentration?.raw || {};
  const top10 = num(conc?.top_10?.share_of_total_supply_pct);
  const tWarn = num(cfg.top10_warn_pct ?? 35), tFail = num(cfg.top10_fail_pct ?? 55);
  items.push(checkItem('TOP10_CONCENTRATION', 'Konsentrasi top-10 holder',
    top10 == null ? 'UNKNOWN' : top10 >= tFail ? 'FAIL' : top10 >= tWarn ? 'WARN' : 'PASS',
    top10 == null ? 'Data konsentrasi tidak tersedia.' : `Top-10 menguasai ${top10}% supply (ambang WARN ≥${tWarn}%, FAIL ≥${tFail}%).`));

  // 5. Creator current share
  const creatorPct = num(p5?.ownership?.current_percentage_supply);
  const cWarn = num(cfg.creator_warn_pct ?? 10), cFail = num(cfg.creator_fail_pct ?? 25);
  items.push(checkItem('CREATOR_SHARE', 'Porsi creator saat ini',
    creatorPct == null ? 'UNKNOWN' : creatorPct >= cFail ? 'FAIL' : creatorPct >= cWarn ? 'WARN' : 'PASS',
    creatorPct == null ? 'Kepemilikan creator tidak terlacak.' : `Creator memegang ${creatorPct}% supply (ambang WARN ≥${cWarn}%, FAIL ≥${cFail}%).`));

  // 6. Creator sell — jangan FAIL atas atribusi
  // creator yang lemah (mis. POOL_COIN_CREATOR confidence LOW).
  const sell = p5?.creator_events?.sell || {};
  const sellCount = Number(sell.sell_count || 0);
  const creatorConf = String(p5?.creator_discovery?.selected?.confidence || 'UNKNOWN').toUpperCase();
  const weakCreator = !['HIGH','MEDIUM'].includes(creatorConf);
  const sellStatus = sellCount > 0
    ? (weakCreator ? 'WARN' : 'FAIL')
    : String(sell.status || '').toUpperCase() === 'NO_SELL_OBSERVED_WITHIN_COVERAGE' ? 'PASS' : 'UNKNOWN';
  const sellReason = sellCount > 0
    ? (weakCreator
        ? `Atribusi creator LEMAH (${creatorConf}); ${sellCount}x penjualan tercatat pada kandidat creator — tidak dijadikan vonis.`
        : `Creator tercatat menjual ${sellCount}x dalam cakupan.`)
    : `Status: ${sell.status || 'UNKNOWN'}. "Tidak terdeteksi" hanya dalam cakupan scan, bukan bukti tak menjual.`;
  items.push(checkItem('CREATOR_SELL', 'Aktivitas jual creator', sellStatus, sellReason));

  return items;
}

/* ------------------------- 2. Early birds ------------------------- */

function earlyBirds(phases, cfg) {
  const p5 = phases[5] || {}, p8 = phases[8] || {}, p3 = phases[3] || {};
  const windowMin = Math.max(1, num(cfg.early_window_minutes ?? 60));
  const t0iso = p5?.initial_distribution?.first_distribution_time || null;
  const t0 = t0iso ? Math.floor(Date.parse(t0iso) / 1000) : null;
  const holders = new Map((p3?.holders || []).map(h => [h.owner, h]));
  const out = [];
  if (t0) {
    for (const w of (p8?.wallets || [])) {
      const acq = w?.history?.first_observed_acquisition || null;
      const ts = num(acq?.block_time);
      if (ts == null) continue;
      const deltaMin = (ts - t0) / 60;
      if (deltaMin < 0 || deltaMin > windowMin) continue;
      const h = holders.get(w.wallet);
      const bal = h ? String(h.amount_raw ?? '0') : (w?.current?.balance_raw ?? '0');
      out.push({
        wallet: w.wallet,
        first_acquisition_minutes_after_launch: Math.round(deltaMin * 100) / 100,
        first_acquisition_iso: acq.timestamp_utc || acq.timestamp_wib || null,
        still_holding: rawBigInt(bal) > 0n,
        current_balance_raw: String(bal),
        sell_count: num(w?.history?.counts_observed?.SELL ?? w?.history?.activity_summary?.sell_count) || 0,
        sources: w.sources || w.source_context || []
      });
    }
  }
  out.sort((a, b) => a.first_acquisition_minutes_after_launch - b.first_acquisition_minutes_after_launch);
  const bundlers = (p5?.initial_distribution?.bundler_candidates || []).map(c => ({
    cluster_key: c.cluster_key, wallet_count: c.wallet_count,
    wallets: c.wallets || [], total_amount_raw: c.total_amount_raw || null,
    confidence: c.confidence || 'LOW',
    note: 'Kandidat clustering distribusi awal; BUKAN bukti bundling/kepemilikan bersama.'
  }));
  return {
    launch_time_iso: t0iso,
    early_window_minutes: windowMin,
    launch_time_source: t0iso ? 'phase5.initial_distribution.first_distribution_time' : null,
    early_bird_count: out.length,
    early_birds_still_holding: out.filter(x => x.still_holding).length,
    early_birds: out.slice(0, 50),
    early_birds_truncated: out.length > 50,
    bundler_candidates: bundlers.slice(0, 20),
    note: 'Early bird = akuisisi pertama dalam window setelah distribusi pertama teramati. Window & data bersifat bounded (bukan lifetime).'
  };
}

/* ------------------------- 3. Insider concentration ------------------------- */

function insiderConcentration(phases) {
  const p5 = phases[5] || {}, p3 = phases[3] || {};
  const holders = new Map((p3?.holders || []).map(h => [h.owner, rawBigInt(h.amount_raw)]));
  const addrs = new Set();
  const creator = p5?.creator_discovery?.selected?.address;
  if (creator) addrs.add(creator);
  for (const r of (p5?.creator_distribution?.recipients || [])) if (r.address) addrs.add(r.address);
  for (const w of (p5?.related_wallets?.wallets || [])) if (w.address) addrs.add(w.address);
  let total = 0n;
  for (const a of addrs) total += holders.get(a) || 0n;
  return {
    tracked_addresses: addrs.size,
    combined_balance_raw: total.toString(),
    note: 'Gabungan saldo creator + penerima distribusi + related wallets (bounded Phase 5). Bukan % supply — supply diambil dari Phase 2 bila tersedia.',
    addresses: [...addrs].slice(0, 100)
  };
}

/* ------------------------- 4. Social signals (opsional) ------------------------- */

function socialSignals(mint) {
  const doc = readJson(SOCIAL_FILE);
  if (!doc || doc.mint !== mint) return { status: 'NOT_PROVIDED', note: 'Isi Data/social_signals.json untuk melampirkan sinyal X/Reddit manual.' };
  const x = num(doc.x_mentions_24h) || 0, rd = num(doc.reddit_mentions_24h) || 0;
  const heat = (x + rd) >= 500 ? 'HIGH' : (x + rd) >= 100 ? 'MEDIUM' : 'LOW';
  return {
    status: 'PROVIDED', heat, as_of: doc.as_of || null,
    x_mentions_24h: x, reddit_mentions_24h: rd,
    sentiment: doc.sentiment || 'unknown', notes: doc.notes || null, sources: doc.sources || [],
    disclaimer: 'Sinyal sosial hanya informasional; tidak mengubah checklist/verdict.'
  };
}

/* ------------------------- 5. Verdict ------------------------- */

function verdict(checklist, cfg) {
  const byStatus = s => checklist.filter(i => i.status === s);
  const fails = byStatus('FAIL'), warns = byStatus('WARN'), unknowns = byStatus('UNKNOWN');
  const criticalUnknown = unknowns.filter(i => ['MINT_AUTHORITY', 'LP_LOCK'].includes(i.id));
  let label = 'NEUTRAL_OK', reasons = [];
  if (fails.length) {
    label = 'AVOID';
    reasons = fails.map(i => `FAIL: ${i.label} — ${i.detail}`);
  } else if (warns.length >= 2 || (warns.length >= 1 && criticalUnknown.length)) {
    label = 'CAUTION';
    reasons = [...warns.map(i => `WARN: ${i.label} — ${i.detail}`), ...criticalUnknown.map(i => `UNKNOWN (kritis): ${i.label}`)];
  } else if (warns.length === 1) {
    label = 'WATCH';
    reasons = warns.map(i => `WARN: ${i.label} — ${i.detail}`);
  } else {
    reasons = ['Tidak ada FAIL/WARN pada checklist deterministik.'];
  }
  if (unknowns.length && label !== 'AVOID') {
    reasons.push(`Caveat: ${unknowns.length} item UNKNOWN (${unknowns.map(i => i.id).join(', ')}) — bukan sinyal aman, hanya data tak tersedia.`);
  }
  return {
    verdict: label,
    rule: 'AVOID jika ada FAIL; CAUTION jika ≥2 WARN (atau 1 WARN + UNKNOWN kritis); WATCH jika 1 WARN; NEUTRAL_OK jika tidak ada.',
    counts: { PASS: byStatus('PASS').length, WARN: warns.length, FAIL: fails.length, UNKNOWN: unknowns.length },
    reasons,
    disclaimer: 'Verdict berbasis aturan dari data on-chain teramati; BUKAN rekomendasi investasi dan BUKAN probabilitas.'
  };
}

/* ------------------------- Build & CLI ------------------------- */

function buildResult({ mint, dir, phases, cfg }) {
  const checklist = rugChecklist(phases, cfg);
  const birds = earlyBirds(phases, cfg);
  const insider = insiderConcentration(phases);
  const social = socialSignals(mint);
  const v = verdict(checklist, cfg);
  const p11 = phases[11] || {};
  return {
    phase: 12,
    phase_name: 'EARLY_TRADER_SIGNALS',
    version: VERSION,
    status: 'COMPLETE',
    timestamp: new Date().toISOString(),
    input: { mint, source: 'phase1-result.json ... phase11-result.json', mode: 'OFFLINE_ARTIFACT_ONLY' },
    scope: {
      purpose: 'Sinyal cepat gaya early-trader dari artefak yang sudah ada; deterministik, tanpa prediksi.',
      reads: ['phase2 (authority)', 'phase3 (holder balances)', 'phase4 (concentration, LP)', 'phase5 (creator, distribution)', 'phase8 (wallet timelines)', 'phase11 (context score)'],
      writes: 'none — modul ini tidak mengubah artefak Phase 1–11.',
      social_signals: 'optional via Data/social_signals.json'
    },
    context: {
      phase11_final_quality_score: p11?.summary?.final_quality_score ?? null,
      phase11_classification: p11?.summary?.classification?.label ?? null
    },
    rug_checklist: checklist,
    early_birds: birds,
    insider_concentration: insider,
    social: social,
    verdict: v,
    limitations: [
      'Semua metrik bounded oleh cakupan scan (halaman/API limit); bukan lifetime.',
      'Early-bird memakai first_distribution_time Phase 5 sebagai proksi launch; bisa meleset bila history terpangkas.',
      'Bundler candidate = clustering waktu/slot; bukan bukti kepemilikan bersama.',
      'Verdict adalah aturan deterministik, bukan nasihat keuangan.'
    ],
    data_sources: ['Output/<mint>/phase2..phase11 result JSON', 'Data/social_signals.json (opsional)']
  };
}

function save(result, dir, mint) {
  attachRunMetadata(result, 12, mint);
  const out = path.join(dir, 'phase12-result.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const mi = args.indexOf('--mint');
  const explicit = mi >= 0 ? args[mi + 1] : args[0];
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ PHASE 12 — EARLY-TRADER SIGNALS                      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  const input = locateInput(explicit);
  if (!input) { console.error('STATUS: FAILED ✗\nERROR: PHASE11_INPUT_NOT_FOUND — jalankan Phase 1–11 dulu atau pakai --mint <CA>.'); process.exitCode = 1; return; }
  const cfg = loadConfig();
  const result = buildResult({ mint: input.mint, dir: input.dir, phases: input.phases, cfg });
  const out = save(result, input.dir, input.mint);
  const v = result.verdict;
  console.log(`TOKEN   : ${short(input.mint)}`);
  console.log(`CTX     : Phase 11 score ${result.context.phase11_final_quality_score ?? 'N/A'} (${result.context.phase11_classification ?? 'N/A'})`);
  console.log('\nRUG CHECKLIST');
  for (const i of result.rug_checklist) console.log(`  [${i.status.padEnd(7)}] ${i.label}`);
  console.log(`\nEARLY BIRDS : ${result.early_birds.early_bird_count} (holding: ${result.early_birds.early_birds_still_holding}) / window ${result.early_birds.early_window_minutes} mnt`);
  console.log(`BUNDLER CAND: ${result.early_birds.bundler_candidates.length}`);
  console.log(`SOCIAL      : ${result.social.status}${result.social.heat ? ` (${result.social.heat})` : ''}`);
  console.log(`\nVERDICT     : ${v.verdict}`);
  for (const r of v.reasons.slice(0, 6)) console.log(`  - ${r}`);
  console.log(`\nOUTPUT: ${path.relative(ROOT, out)}`);
  console.log(`TIME  : ${((Date.now() - started) / 1000).toFixed(2)}s`);
}

if (require.main === module) main();

module.exports = { buildResult, rugChecklist, earlyBirds, insiderConcentration, socialSignals, verdict, VERSION };
