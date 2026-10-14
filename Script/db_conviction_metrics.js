'use strict';
/*
 * db_conviction_metrics.js
 *
 * Menjawab: "apakah CA populer di antara wallet DB, dan apa yang terjadi?"
 * Menghitung 6 metrik per token dari hasil Phase 7 (matching) + Phase 8
 * (behavior timeline) + Phase 5 (bundler candidates):
 *
 *   penetration        — berapa wallet DB bersentuhan dengan CA ini
 *   retention          — % wallet DB yang match dan MASIH holder
 *   coordinated_sell   — wallet DB yang sell bergerombol dalam satu window waktu
 *   fast_exit          — beli -> jual habis cepat -> menghilang
 *   conviction         — net bobot DB: yang hold minus yang sudah exit
 *   bundler_overlap    — wallet DB yang muncul di kandidat bundler Phase 5
 *   dev_concentration  — % supply dipegang wallet DB ber-role DEV (untuk token_control)
 *
 * Semua fungsi murni (pure) dan config-driven via `database_conviction`
 * di Config/config.json. Tidak ada trigger yang dipaksa: bila data tidak
 * cukup, status INSUFFICIENT_DATA dan adjustment dilewati (bukan nol).
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  min_matched_wallets: 3,
  db_total_wallets: 0, // 0 until the user adds their own wallets (synced by merge_config.js)
  sell_cluster_window_seconds: 3600,
  fast_exit_hours: 72,
  conviction_scale: 50,
  adjustment_clamp: [-15, 15],
  holder_distribution: { retention_weight: 10, conviction_weight: 5 },
  risk_findings: { coordinated_sell_weight: 12, fast_exit_weight: 8, negative_conviction_weight: 10 },
  creator_activity: { bundler_overlap_weight: 10 },
  token_control: { dev_concentration_weight: 8 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(Number(v) * 100) / 100;
const finite = v => typeof v === 'number' && Number.isFinite(v);

function resolveConfig(configLike) {
  const section = (configLike && configLike.database_conviction) || {};
  const merged = { ...DEFAULTS, ...section };
  // Nested bobot: merge per-dimensi agar override parsial tetap pakai default sisanya.
  for (const k of ['holder_distribution', 'risk_findings', 'creator_activity', 'token_control']) {
    merged[k] = { ...DEFAULTS[k], ...(section[k] || {}) };
  }
  return merged;
}

// Lenient: kembalikan {} bila config tidak ada (default dipakai). Tidak pernah throw.
function loadDbConvictionSection() {
  try {
    const p = path.join(__dirname, '..', 'Config', 'config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (c && c.database_conviction) || {};
  } catch { return {}; }
}

function eventTimes(events, cls) {
  return (Array.isArray(events) ? events : [])
    .filter(e => String(e?.event_class || '').toUpperCase() === cls && finite(Number(e?.block_time)))
    .map(e => Number(e.block_time))
    .sort((a, b) => a - b);
}

function normalizeWallet(w) {
  const db = w?.database || {};
  const roles = Array.isArray(db.roles) ? db.roles.map(String) : [];
  const totalWeight = finite(Number(db.total_database_weight))
    ? Number(db.total_database_weight)
    : (Number(db.role_weight) || 0) + (Number(db.modifier_weight) || 0);
  const isHolder = typeof w?.current?.is_holder === 'boolean' ? w.current.is_holder
    : typeof w?.position?.current_holder === 'boolean' ? w.position.current_holder
    : null;
  const spRaw = w?.current?.supply_percentage;
  const spNum = (spRaw === null || spRaw === undefined || spRaw === '') ? null : Number(spRaw);
  const events = Array.isArray(w?.history?.events) ? w.history.events : [];
  const buys = eventTimes(events, 'BUY');
  const sells = eventTimes(events, 'SELL');
  return {
    wallet: w?.wallet || null,
    name: db.name || w?.display || null,
    roles,
    total_weight: totalWeight,
    is_holder: isHolder,
    supply_pct: finite(spNum) ? spNum : null,
    buys,
    sells,
    activity_span_seconds: finite(Number(w?.position?.observed_activity_span_seconds))
      ? Number(w.position.observed_activity_span_seconds) : null,
    observed_sell_count: Number(w?.position?.observed_sell_count) || 0,
  };
}

function pickMatched({ matches, wallets }) {
  const from8 = (Array.isArray(wallets) ? wallets : [])
    .filter(w => w && w.database && (w.database.matched === true || w.database.name));
  if (from8.length) return from8.map(normalizeWallet).filter(w => w.wallet);
  return (Array.isArray(matches) ? matches : [])
    .filter(m => m && m.wallet)
    .map(normalizeWallet)
    .filter(w => w.wallet);
}

// Cluster terbesar: jumlah wallet berbeda dengan >=1 SELL dalam satu window.
function largestSellCluster(sellers, windowSec) {
  const pts = [];
  for (const w of sellers) for (const t of w.sells) pts.push({ t, w: w.wallet });
  pts.sort((a, b) => a.t - b.t);
  let best = new Set();
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (pts[j].t < pts[i].t - windowSec) j++;
    const s = new Set();
    for (let k = j; k <= i; k++) s.add(pts[k].w);
    if (s.size > best.size) best = s;
  }
  return best;
}

function computeDbConviction({ matches, wallets, p5, config } = {}) {
  const cfg = resolveConfig(config);
  const list = pickMatched({ matches, wallets });
  const matched = list.length;
  if (matched < cfg.min_matched_wallets) {
    return {
      status: 'INSUFFICIENT_DATA',
      reason: `Wallet DB yang match ${matched} < min_matched_wallets ${cfg.min_matched_wallets}; adjustment dilewati (bukan nol).`,
      matched_count: matched,
      metrics: null,
      config: cfg,
    };
  }

  const penetration = {
    matched,
    db_total_wallets: cfg.db_total_wallets,
    share_of_db: cfg.db_total_wallets > 0 ? round2(matched / cfg.db_total_wallets) : null,
  };

  const known = list.filter(w => w.is_holder !== null);
  const holders = known.filter(w => w.is_holder === true);
  const retention = known.length
    ? { rate: round2(holders.length / known.length), holders: holders.length, known: known.length }
    : null;

  const sellers = list.filter(w => w.sells.length > 0);
  const cluster = largestSellCluster(sellers, cfg.sell_cluster_window_seconds);
  const coordinated_sell = {
    rate: round2(cluster.size / matched),
    cluster_wallets: cluster.size,
    sellers_total: sellers.length,
    window_seconds: cfg.sell_cluster_window_seconds,
  };

  const fastExitSec = cfg.fast_exit_hours * 3600;
  const fastExited = list.filter(w => {
    if (w.is_holder === true) return false;
    if (w.buys.length && w.sells.length) {
      return (Math.max(...w.sells) - Math.min(...w.buys)) <= fastExitSec;
    }
    return w.activity_span_seconds !== null && w.observed_sell_count > 0 &&
      w.activity_span_seconds <= fastExitSec;
  });
  const fast_exit = { rate: round2(fastExited.length / matched), wallets: fastExited.length };

  const holderW = holders.reduce((s, w) => s + w.total_weight, 0);
  const exitedW = list.filter(w => w.is_holder === false).reduce((s, w) => s + w.total_weight, 0);
  const net = holderW - exitedW;
  const conviction = {
    net_weight: round2(net),
    holder_weight: round2(holderW),
    exited_weight: round2(exitedW),
    normalized: round2(clamp(net / cfg.conviction_scale, -1, 1)),
  };

  const bundlerWallets = new Set();
  for (const c of (p5?.initial_distribution?.bundler_candidates || [])) {
    for (const a of (c?.wallets || [])) bundlerWallets.add(String(a));
  }
  const overlapped = list.filter(w => bundlerWallets.has(String(w.wallet)));
  const bundler_overlap = { rate: round2(overlapped.length / matched), wallets: overlapped.length };

  const devWallets = list.filter(w => w.roles.includes('DEV') && w.supply_pct !== null);
  const dev_concentration = devWallets.length
    ? { dev_supply_pct: round2(devWallets.reduce((s, w) => s + w.supply_pct, 0)), dev_wallets: devWallets.length }
    : null;

  return {
    status: 'OK',
    reason: `${matched} wallet DB match; metrik dihitung pada data observasi.`,
    matched_count: matched,
    metrics: { penetration, retention, coordinated_sell, fast_exit, conviction, bundler_overlap, dev_concentration },
    config: cfg,
  };
}

// Menerapkan adjustment ke dimensi Phase 11 (aditif, per-dimensi di-clamp).
// dims: array {id, score, available, ...}. Mengembalikan array baru; base tidak dimutasi.
function applyDbAdjustments(dims, dbm, config) {
  const cfg = resolveConfig(config);
  const [lo, hi] = Array.isArray(cfg.adjustment_clamp) ? cfg.adjustment_clamp : DEFAULTS.adjustment_clamp;
  const noAdj = reason => ({ applied: false, reason, components: [], total_points: 0 });

  const partsFor = (id, m) => {
    switch (id) {
      case 'holder_distribution': {
        // retention+conviction DIPINDAHKAN KELUAR
        // dari holder_distribution — retention rendah di token yang naik adalah
        // take-profit rasional wallet, bukan sinyal kualitas token. Tidak ada
        // komponen DB untuk dimensi ini; coordinated_sell/fast_exit/
        // negative_conviction tetap hidup di risk_findings.
        return [];
      }
      case 'risk_findings':
        return [
          { key: 'coordinated_sell', points: round2(-cfg.risk_findings.coordinated_sell_weight * m.coordinated_sell.rate) },
          { key: 'fast_exit', points: round2(-cfg.risk_findings.fast_exit_weight * m.fast_exit.rate) },
          { key: 'negative_conviction', points: round2(cfg.risk_findings.negative_conviction_weight * Math.min(0, m.conviction.normalized)) },
        ];
      case 'creator_activity':
        return [{ key: 'bundler_overlap', points: round2(-cfg.creator_activity.bundler_overlap_weight * m.bundler_overlap.rate) }];
      case 'token_control': {
        if (!m.dev_concentration) return [];
        return [{ key: 'dev_concentration', points: round2(-cfg.token_control.dev_concentration_weight * clamp(m.dev_concentration.dev_supply_pct / 10, 0, 1)) }];
      }
      default:
        return []; // fee_utility: tidak ada pemetaan DB yang jujur -> tidak diadjust
    }
  };

  return (Array.isArray(dims) ? dims : []).map(d => {
    const details = { ...(d.details || {}) };
    if (!d.available) {
      details.db_adjustment = noAdj('Dimensi tidak tersedia; adjustment DB tidak diterapkan.');
      return { ...d, details };
    }
    if (!dbm || dbm.status !== 'OK' || !dbm.metrics) {
      details.db_adjustment = noAdj(dbm?.reason || 'Metrik DB conviction tidak tersedia; adjustment dilewati.');
      return { ...d, details };
    }
    const parts = partsFor(d.id, dbm.metrics).filter(p => finite(p.points));
    const raw = parts.reduce((s, p) => s + p.points, 0);
    const total = round2(clamp(raw, lo, hi));
    const clamped = total !== round2(raw);
    details.db_adjustment = {
      applied: parts.length > 0,
      reason: parts.length
        ? `Adjustment DB ${total >= 0 ? '+' : ''}${total} poin${clamped ? ` (di-clamp dari ${round2(raw)})` : ''}; matched ${dbm.matched_count} wallet.`
        : `Tidak ada pemetaan DB untuk dimensi ${d.id}; skor tidak diubah.`,
      components: parts,
      total_points: total,
      clamp: [lo, hi],
      matched_wallets: dbm.matched_count,
      metrics: dbm.metrics,
    };
    const score = clamp(d.score + total, 0, 100);
    return { ...d, score: round2(score), details,
      reason: `${d.reason} [DB: ${total >= 0 ? '+' : ''}${total} poin]` };
  });
}

module.exports = {
  DEFAULTS,
  resolveConfig,
  loadDbConvictionSection,
  computeDbConviction,
  applyDbAdjustments,
};
