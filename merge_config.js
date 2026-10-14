'use strict';
/* merge_config.js — Tambah section config yang hilang TANPA menyentuh nilai
 * yang sudah ada (terutama helius.api_key). Idempoten: aman dijalankan
 * berulang kali. Jalankan sekali dari folder project:  node merge_config.js
 */
const fs = require('fs');
const path = require('path');

const CFG = path.join(__dirname, 'Config', 'config.json');
const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const added = [];

function ensure(obj, key, value, label) {
  if (obj[key] === undefined) { obj[key] = value; added.push(label); }
}
function ensureDeep(obj, key, sub, label) {
  if (obj[key] === undefined) obj[key] = {};
  for (const [k, v] of Object.entries(sub)) {
    if (obj[key][k] === undefined) { obj[key][k] = v; added.push(`${label}.${k}`); }
  }
}

// Global Helius RPC throttle.
// Satu section untuk mengatur laju request ke Helius dari SEMUA phase &
// kolektor. min_interval_ms=110 -> ~9 request/detik, aman di bawah limit
// 10/dtk. Saat memakai API key asli, naikkan kecepatan dengan MENURUNKAN
// angka ini (mis. 60), atau naikkan bila masih kena 429 (mis. 200).
// Modul yang sudah punya interval sendiri (phase8.min_request_interval_ms,
// market_volume.delay_ms, funding_graph.min_request_interval_ms) tetap
// memakai nilainya sebagai override; section ini menjadi default global.
ensure(c, 'rpc_throttle', {
  min_interval_ms: 110,
  max_delay_ms: 30000,
  retryable_statuses: [408, 429, 500, 502, 503, 504],
}, 'rpc_throttle');

// Liquidity credibility guard
ensure(c, 'evaluation_guards', { liquidity_credibility_ratio: 0.01 }, 'evaluation_guards');

// Market-volume collector settings
// Add concurrency (worker pool) — deep-ensure so existing
// punya section market_volume tetap dapat key baru ini.
if (!c.market_volume || typeof c.market_volume !== 'object') c.market_volume = {};
for (const [k, v] of Object.entries({
  max_tx: 1500, delay_ms: 300, page_limit: 1000,
  retry_passes: 2, retry_delay_ms: 1500, timeout_ms: 25000, concurrency: 3,
})) {
  if (c.market_volume[k] === undefined) { c.market_volume[k] = v; added.push(`market_volume.${k}`); }
}

// Emoji modifiers (merged into scoring.modifiers when present)
if (!c.scoring || typeof c.scoring !== 'object') c.scoring = {};
if (!c.scoring.modifiers || typeof c.scoring.modifiers !== 'object') {
  c.scoring.modifiers = {};
  added.push('scoring.modifiers');
}
// pastikan tiap key modifier ada
for (const [k, v] of Object.entries({ star: 5, priority: 2, flag: -5, blocked: -10 })) {
  if (c.scoring.modifiers[k] === undefined) { c.scoring.modifiers[k] = v; added.push(`scoring.modifiers.${k}`); }
}

// database_conviction (wallet conviction adjustments)
ensure(c, 'database_conviction', {
  min_matched_wallets: 3,
  db_total_wallets: 0, // 0 until the user adds their own wallets (synced below)
  sell_cluster_window_seconds: 3600,
  fast_exit_hours: 72,
  conviction_scale: 50,
  adjustment_clamp: [-15, 15],
  holder_distribution: { retention_weight: 10, conviction_weight: 5 },
  risk_findings: { coordinated_sell_weight: 12, fast_exit_weight: 8, negative_conviction_weight: 10 },
  creator_activity: { bundler_overlap_weight: 10 },
  token_control: { dev_concentration_weight: 8 },
}, 'database_conviction');
// Wallet database: the curated list is personal, so only a format example
// ships with the repo. Create an empty database file when missing so Phase 7
// runs (0 matches -> INSUFFICIENT_DATA, honestly). Add wallets manually —
// see README ("Wallet database") and Data/database-wallet.example.json.
const DB_FILE = path.join(__dirname, 'Data', 'database-wallet.json');
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, '[]\n', 'utf8');
  added.push('Data/database-wallet.json (empty — add your wallets manually)');
}
// Keep db_total_wallets in sync with the actual Data/database-wallet.json count
// (penyebut penetrasi harus jujur mengikuti ukuran DB).
try {
  const dbCount = JSON.parse(fs.readFileSync(path.join(__dirname, 'Data', 'database-wallet.json'), 'utf8')).length;
  if (Number.isInteger(dbCount) && dbCount > 0 && c.database_conviction.db_total_wallets !== dbCount) {
    c.database_conviction.db_total_wallets = dbCount;
    added.push(`database_conviction.db_total_wallets=${dbCount}`);
  }
} catch { /* DB tidak terbaca — biarkan nilai yang ada */ }

// CTR-05 data path
ensure(c, 'relationships', {
  enabled: true,
  note: 'Jalur data CTR-05: anotasi relationship dari funding-graph.json (shared funder). false = matikan anotasi.',
}, 'relationships');

fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n', 'utf8');
if (added.length) console.log('Ditambahkan: ' + added.join(', '));
else console.log('Semua section sudah ada — tidak ada yang diubah.');
console.log('helius.api_key tidak disentuh.');
