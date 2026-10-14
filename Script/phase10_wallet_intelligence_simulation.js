#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT_ROOT = path.join(ROOT, 'Output');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const uniq = arr => [...new Set(arr.filter(Boolean))];
const eventClass = e => String(e?.event_class || e?.type || '').trim().toUpperCase();
const sig = e => e?.signature || e?.tx_signature || e?.transaction_signature || null;

function eventCounts(events = []) {
  const byClass = { BUY: [], SELL: [], TRANSFER_OUT: [], RECEIVE: [] };
  for (const e of events) {
    const c = eventClass(e);
    if (c === 'BUY') byClass.BUY.push(e);
    else if (c === 'SELL') byClass.SELL.push(e);
    else if (c === 'TRANSFER_OUT' || c === 'OUTBOUND_TRANSFER') byClass.TRANSFER_OUT.push(e);
    else if (c === 'RECEIVE' || c === 'TRANSFER_IN') byClass.RECEIVE.push(e);
  }
  const countUnique = xs => {
    const signatures = uniq(xs.map(sig));
    // If an event has no signature, count that observed event separately rather than dropping it.
    const noSig = xs.filter(x => !sig(x)).length;
    return signatures.length + noSig;
  };
  return Object.fromEntries(Object.entries(byClass).map(([k, xs]) => [k.toLowerCase() + '_tx_count', countUnique(xs)]));
}

function walletBehavior(p7w, p8w) {
  const events = Array.isArray(p8w?.history?.events) ? p8w.history.events : Array.isArray(p7w?.history?.events) ? p7w.history.events : [];
  const counts = eventCounts(events);
  const position = p7w?.position || p8w?.position || {};
  const duration = finite(position.duration_seconds) && position.duration_seconds >= 0 ? position.duration_seconds : null;
  const historyStatus = p8w?.history?.status || p7w?.history?.status || 'UNKNOWN';
  const historyComplete = p8w?.history?.complete === true || /COMPLETE/i.test(String(p8w?.history?.coverage || p7w?.history?.coverage || ''));
  const current = p8w?.current || p7w?.current || {};
  return {
    current_holder: current.is_holder === true,
    position_status: position.status || 'UNKNOWN',
    holding_duration_seconds: duration,
    holding_duration_basis: position.duration_basis || null,
    holding_duration_confidence: position.score_confidence || 'UNKNOWN',
    history_status: historyStatus,
    history_complete: historyComplete,
    ...counts,
    observed_event_count: events.length,
    behavior_adjustment_score: null,
    behavior_adjustment_status: events.length || duration !== null ? 'OBSERVED_METRICS_ONLY_WEIGHTING_NOT_CONFIGURED' : 'INSUFFICIENT_DATA',
    note: 'Metrik perilaku ditampilkan apa adanya. Tidak diberi skor positif/negatif karena bobot dan aturan konversi belum ditetapkan.'
  };
}

function summarizeCa(dir) {
  const p7 = readJson(path.join(dir, 'phase7-result.json'));
  const p8 = readJson(path.join(dir, 'phase8-result.json'));
  const p11 = readJson(path.join(dir, 'phase11-result.json'));
  if (!p7 && !p8) return null;
  const mint = p7?.input?.mint || p8?.input?.mint || p11?.input?.mint || path.basename(dir);
  const p8Map = new Map((p8?.wallets || []).filter(w => w?.wallet).map(w => [w.wallet, w]));
  const matches = (p7?.matches || []).filter(w => w?.wallet);
  const wallets = matches.map(w => {
    const db = w.database || {};
    const behavior = walletBehavior(w, p8Map.get(w.wallet));
    const roles = uniq(Array.isArray(db.roles) ? db.roles.map(String) : []);
    const dbWeight = finite(db.total_database_weight) ? db.total_database_weight :
      (finite(db.role_weight) ? db.role_weight : null) !== null
        ? Number(db.role_weight || 0) + Number(db.modifier_weight || 0)
        : null;
    return {
      wallet: w.wallet,
      display: w.display || w.wallet.slice(0, 4),
      database_name: db.name || null,
      database_roles: roles,
      database_groups: Array.isArray(db.groups) ? db.groups : [],
      database_modifiers: Array.isArray(db.modifiers) ? db.modifiers : [],
      database_role_weight: finite(db.role_weight) ? db.role_weight : null,
      database_modifier_weight: finite(db.modifier_weight) ? db.modifier_weight : null,
      database_weight: dbWeight,
      behavior
    };
  });
  const weights = wallets.map(w => w.database_weight).filter(finite);
  const durations = wallets.map(w => w.behavior.holding_duration_seconds).filter(finite);
  const roleCounts = {};
  for (const w of wallets) for (const role of w.database_roles) roleCounts[role] = (roleCounts[role] || 0) + 1;
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const totalEvents = key => sum(wallets.map(w => Number(w.behavior[key] || 0)));
  const baselineScore = p11?.summary?.final_quality_score;
  return {
    mint,
    source_directory: path.basename(dir),
    baseline_phase11_final_quality_score: finite(baselineScore) ? baselineScore : null,
    database_wallet_intelligence: {
      matched_wallet_count: wallets.length,
      unique_wallet_count: new Set(wallets.map(w => w.wallet)).size,
      role_counts: roleCounts,
      database_weight_sum_raw: weights.length ? sum(weights) : null,
      database_weight_average_raw: weights.length ? Number((sum(weights) / weights.length).toFixed(4)) : null,
      positive_weight_wallets: wallets.filter(w => finite(w.database_weight) && w.database_weight > 0).length,
      zero_weight_wallets: wallets.filter(w => w.database_weight === 0).length,
      negative_weight_wallets: wallets.filter(w => finite(w.database_weight) && w.database_weight < 0).length,
      weight_available_wallets: weights.length,
      note: 'Raw aggregate of existing database weights; not normalized and not merged into Phase 11 final score.'
    },
    wallet_behavior_adjustment: {
      behavior_adjustment_score: null,
      status: 'SIMULATION_METRICS_ONLY_WEIGHTING_NOT_CONFIGURED',
      wallets_with_observed_events: wallets.filter(w => w.behavior.observed_event_count > 0).length,
      current_holders: wallets.filter(w => w.behavior.current_holder).length,
      known_holding_duration_wallets: durations.length,
      unknown_holding_duration_wallets: wallets.length - durations.length,
      mean_observed_holding_duration_seconds: durations.length ? Number((sum(durations) / durations.length).toFixed(2)) : null,
      total_unique_observed_buy_transactions: totalEvents('buy_tx_count'),
      total_unique_observed_sell_transactions: totalEvents('sell_tx_count'),
      total_unique_observed_transfer_out_transactions: totalEvents('transfer_out_tx_count'),
      total_unique_observed_receive_transactions: totalEvents('receive_tx_count'),
      history_complete_wallets: wallets.filter(w => w.behavior.history_complete).length,
      history_incomplete_or_unknown_wallets: wallets.filter(w => !w.behavior.history_complete).length,
      note: 'SELL, transfer-out, holding duration, and other observed behavior remain separate metrics. No risk/quality adjustment is assigned without approved scoring rules.'
    },
    wallet_profiles: wallets
  };
}

function buildSimulation(inputRoot = DEFAULT_INPUT_ROOT) {
  if (!fs.existsSync(inputRoot)) throw new Error(`INPUT_ROOT_NOT_FOUND: ${inputRoot}`);
  const dirs = fs.readdirSync(inputRoot, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => path.join(inputRoot, x.name));
  const reports = dirs.map(summarizeCa).filter(Boolean).sort((a, b) => a.mint.localeCompare(b.mint));
  return {
    report_type: 'WALLET_INTELLIGENCE_SCORING_SIMULATION',
    version: '0.1.0',
    generated_at: new Date().toISOString(),
    mode: 'NON_PRODUCTION_SIMULATION',
    production_formula_changed: false,
    scoring_principles: {
      database_weight: 'Positive/negative raw weight based on existing role and modifier values; shown independently.',
      behavior_adjustment: 'Separate observed behavior metrics; score intentionally null until conversion weights/rules are approved.',
      combination: 'No combined score computed; no implicit offset between components.'
    },
    ca_count: reports.length,
    reports
  };
}

function parseArgs(argv) {
  const out = { inputRoot: DEFAULT_INPUT_ROOT, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input-root') out.inputRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--output') out.output = path.resolve(argv[++i]);
  }
  return out;
}
if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildSimulation(args.inputRoot);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, json, 'utf8');
      console.log(`Simulation report saved: ${args.output}`);
    } else console.log(json);
    console.log(`CA processed: ${report.ca_count}; production formula changed: no`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { eventCounts, walletBehavior, summarizeCa, buildSimulation };
