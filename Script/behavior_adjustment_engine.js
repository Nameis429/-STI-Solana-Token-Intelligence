'use strict';

// Wallet Behavior Adjustment (BA) engine. Standalone and non-production until integrated.
// Missing components are omitted from the weighted sum (weights are NOT renormalized).
const WEIGHTS = Object.freeze({ holding: 0.25, sell: 0.50, flow: 0.25 });
// Locked operational decisions confirmed by the user.
const SELL_LARGE_PORTION_THRESHOLD_PERCENT = 50;
const SELL_FACTOR_COMPOSITION = 'MULTIPLICATIVE';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function holdingBaseScore(seconds) {
  if (!finite(seconds) || seconds < 0) return null;
  if (seconds < 2 * 3600) return 0;
  if (seconds < 12 * 3600) return 0;
  if (seconds < 24 * 3600) return 10;
  if (seconds <= 7 * 86400) return 20;
  return 15;
}
function retentionMultiplier(percent) {
  if (!finite(percent) || percent < 0 || percent > 100) return null;
  if (percent >= 90) return 1;
  if (percent >= 75) return 0.8;
  if (percent >= 50) return 0.6;
  if (percent >= 25) return 0.3;
  if (percent > 0) return 0.1;
  return 0;
}
function calculateHolding({ durationSeconds, retentionPercent, retentionReconciled = false } = {}) {
  const base = holdingBaseScore(durationSeconds);
  if (base === null) return { score: null, status: 'INSUFFICIENT_DATA', reason: 'HOLDING_DURATION_UNKNOWN' };
  if (!retentionReconciled) return { score: null, status: 'PARTIAL', base_score: base, reason: 'POSITION_RETENTION_NOT_RECONCILED' };
  const multiplier = retentionMultiplier(retentionPercent);
  if (multiplier === null) return { score: null, status: 'INSUFFICIENT_DATA', base_score: base, reason: 'RETENTION_PERCENT_INVALID_OR_UNKNOWN' };
  return { score: base * multiplier, status: 'AVAILABLE', base_score: base, retention_percent: retentionPercent, retention_multiplier: multiplier };
}

function sellBaseScore(soldPercent) {
  if (!finite(soldPercent) || soldPercent < 0 || soldPercent > 100) return null;
  if (soldPercent === 0) return 0;
  if (soldPercent <= 10) return -5;
  if (soldPercent <= 25) return -15;
  if (soldPercent <= 50) return -35;
  if (soldPercent <= 75) return -60;
  if (soldPercent < 100) return -85;
  return -100;
}
function transactionCountFactor(count) {
  if (!Number.isInteger(count) || count < 1) return null;
  if (count === 1) return 1;
  if (count <= 3) return 1.05;
  if (count <= 6) return 1.10;
  if (count <= 10) return 1.15;
  return 1.20;
}
function timeFactor(pattern, largePortion = false) {
  if (pattern === 'DISTRIBUTED') return 1;
  if (pattern === 'CONCENTRATED_LARGE_PORTION' || (pattern === 'CONCENTRATED' && largePortion)) return 1.20;
  if (pattern === 'CONCENTRATED') return 1.10;
  return null;
}
function calculateSell({ soldPercent, sellCount, historyComplete = false, timePattern = null, applyFactors = false } = {}) {
  if (soldPercent === 0 && !historyComplete) return { score: null, status: 'INSUFFICIENT_DATA', reason: 'NO_SELL_REQUIRES_COMPLETE_HISTORY' };
  const base = sellBaseScore(soldPercent);
  if (base === null) return { score: null, status: 'INSUFFICIENT_DATA', reason: 'SOLD_PERCENT_UNKNOWN_OR_INVALID' };
  if (base === 0) return { score: 0, status: 'AVAILABLE', base_score: 0, transaction_count_factor: 1, time_factor: 1 };
  const countFactor = transactionCountFactor(sellCount);
  if (!applyFactors) return { score: base, status: 'PARTIAL', base_score: base, reason: 'MODIFIERS_NOT_APPLIED', transaction_count_factor: countFactor, time_pattern: timePattern };
  const tFactor = timeFactor(timePattern);
  if (countFactor === null || tFactor === null) return { score: null, status: 'PARTIAL', base_score: base, reason: 'SELL_MODIFIER_INPUT_MISSING', transaction_count_factor: countFactor, time_pattern: timePattern };
  // Draft formula: multiply base penalty by count and time factors, then clamp to [-100, 0].
  return { score: clamp(base * countFactor * tFactor, -100, 0), status: 'AVAILABLE', base_score: base, transaction_count_factor: countFactor, time_factor: tFactor, time_pattern: timePattern };
}

function flowPenalty(percentSupply, repeatedDistribution = false) {
  if (!finite(percentSupply) || percentSupply < 0) return null;
  if (repeatedDistribution) {
    if (percentSupply >= 10) return -80;
    if (percentSupply >= 5) return -60;
    if (percentSupply >= 2) return -40;
    if (percentSupply >= 1) return -25;
    if (percentSupply >= 0.5) return -15;
    return 0;
  }
  if (percentSupply >= 20) return -100;
  if (percentSupply >= 10) return -75;
  if (percentSupply >= 5) return -55;
  if (percentSupply >= 2) return -35;
  if (percentSupply >= 1) return -20;
  if (percentSupply >= 0.5) return -10;
  return 0;
}
function calculateFlow({ largeFlowOutPercentSupply, repeatedDistributionPercentSupply, transferDataComplete = false } = {}) {
  const largeKnown = finite(largeFlowOutPercentSupply) && largeFlowOutPercentSupply >= 0;
  const repeatedKnown = finite(repeatedDistributionPercentSupply) && repeatedDistributionPercentSupply >= 0;
  if (!largeKnown && !repeatedKnown) return { score: null, status: 'INSUFFICIENT_DATA', reason: 'FLOW_OUT_AMOUNT_OR_SUPPLY_UNKNOWN' };
  const large = largeKnown ? flowPenalty(largeFlowOutPercentSupply, false) : null;
  const repeated = repeatedKnown ? flowPenalty(repeatedDistributionPercentSupply, true) : null;
  const known = [large, repeated].filter(finite);
  return {
    score: Math.min(...known),
    status: largeKnown && repeatedKnown && transferDataComplete ? 'AVAILABLE' : 'PARTIAL',
    large_flow_out_penalty: large,
    repeated_distribution_penalty: repeated,
    combination_rule: 'MOST_SEVERE_NOT_SUMMED'
  };
}
function calculateBA({ holding, sell, flow } = {}) {
  const components = { holding, sell, flow };
  const weighted = [];
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const component = components[key];
    if (component && finite(component.score)) weighted.push({ key, weight, contribution: component.score * weight });
  }
  if (!weighted.length) return { score: null, status: 'INSUFFICIENT_DATA', weights: WEIGHTS, available_components: [], coverage_weight: 0 };
  const coverage = weighted.reduce((s, x) => s + x.weight, 0);
  const score = clamp(weighted.reduce((s, x) => s + x.contribution, 0), -100, 100);
  return { score: Number(score.toFixed(4)), status: coverage === 1 ? 'AVAILABLE' : 'PARTIAL', weights: WEIGHTS, available_components: weighted.map(x => x.key), coverage_weight: coverage, weighted_contributions: weighted };
}


// Phase 7/8 adapter. Conservative by design: components requiring complete
// transaction coverage or reconciled balances remain null when inputs are partial.
function sumRaw(events, classes, totals = null) {
  if (totals && classes.every(cls => totals[cls] != null && /^\d+$/.test(String(totals[cls])))) {
    return classes.reduce((sum, cls) => sum + BigInt(String(totals[cls])), 0n);
  }
  let total = 0n, seen = false;
  for (const e of events) if (classes.includes(String(e?.event_class || '').toUpperCase())) {
    if (e?.amount_raw == null || !/^\d+$/.test(String(e.amount_raw))) continue;
    total += BigInt(String(e.amount_raw)); seen = true;
  }
  return seen ? total : null;
}
function isCompleteHistory(history) {
  const coverageStatus=String(history?.coverage?.status||'').toUpperCase();
  if(coverageStatus) return coverageStatus==='COMPLETE' && history?.events_truncated !== true;
  return history?.complete === true && history?.events_truncated !== true &&
    !/PARTIAL|FAILED|RATE_LIMIT|UNKNOWN/i.test(String(history?.status || ''));
}
function dedupeEvents(events = []) {
  const seen = new Set();
  return events.filter(e => {
    const key = [e?.signature, e?.event_class, e?.direction, e?.amount_raw, e?.counterparty, e?.block_time].join('|');
    if (!e?.signature || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function detectSellPattern(events, nowTs) {
  const start = nowTs - 3600;
  const priorStart = nowTs - 7 * 3600;
  const recent = events.filter(e => Number(e?.block_time) >= start && Number(e?.block_time) <= nowTs);
  const prior = events.filter(e => Number(e?.block_time) >= priorStart && Number(e?.block_time) < start);
  const volume = (arr, cls) => arr.filter(e => e.event_class === cls).reduce((s,e)=>s+BigInt(/^\d+$/.test(String(e.amount_raw??''))?String(e.amount_raw):'0'),0n);
  const recentSell = volume(recent, 'SELL'), recentBuy = volume(recent, 'BUY');
  const hourlySell = [];
  for (let h=0; h<6; h++) {
    const a=nowTs-(h+2)*3600, b=nowTs-(h+1)*3600;
    hourlySell.push(volume(prior.filter(e=>Number(e.block_time)>=a && Number(e.block_time)<b),'SELL'));
  }
  const positive = hourlySell.filter(v=>v>0n).sort((a,b)=>a<b?-1:a>b?1:0);
  const medianSell = positive.length ? positive[Math.floor(positive.length/2)] : 0n;
  const priorBuy = volume(prior, 'BUY');
  const priorHourlyBuy = priorBuy / 6n;
  const buyWeakening = priorHourlyBuy > 0n && recentBuy * 10n <= priorHourlyBuy * 7n;
  const sellElevated = medianSell > 0n && recentSell >= medianSell * 2n;
  const ratio = recentBuy > 0n && recentSell * 2n >= recentBuy * 3n;
  if (sellElevated && buyWeakening && ratio) return { pattern: 'CONCENTRATED', checks: { sell_elevated: true, buy_weakening: true, sell_buy_ratio: true }, note: 'Heuristic from observed events; only usable when event coverage spans comparator windows.' };
  const sells = recent.filter(e=>e.event_class==='SELL').length;
  return { pattern: sells >= 2 ? 'CONCENTRATED' : 'DISTRIBUTED', checks: { sell_elevated: sellElevated, buy_weakening: buyWeakening, sell_buy_ratio: ratio }, note: 'Fallback timing pattern; concentrated-with-weakening condition not met.' };
}
function buildWalletBehaviorAdjustment({ phase7 = {}, phase8 = {}, phase2 = {}, nowTs = Math.floor(Date.now()/1000) } = {}) {
  const largePortionThresholdPercent = SELL_LARGE_PORTION_THRESHOLD_PERCENT;
  const p7 = new Map((phase7.matches || []).map(w => [w.wallet, w]));
  const p8 = new Map((phase8.wallets || []).map(w => [w.wallet, w]));
  const addresses = [...new Set([...p7.keys(), ...p8.keys()])];
  const supplyRawText = phase2?.token?.supply ?? phase2?.token_info?.supply ?? null;
  const supplyRaw = /^\d+$/.test(String(supplyRawText ?? '')) ? BigInt(String(supplyRawText)) : null;
  const wallets = addresses.map(address => {
    const w7 = p7.get(address) || {}, w8 = p8.get(address) || {};
    const history = w8.history || {};
    const events = dedupeEvents(Array.isArray(history.events) ? history.events : []);
    const complete = isCompleteHistory(history);
    const currentRawText = w8.current?.balance_raw ?? w7.current?.balance_raw ?? null;
    const currentRaw = /^\d+$/.test(String(currentRawText ?? '')) ? BigInt(String(currentRawText)) : null;
    const totals = history.amount_totals_raw_observed || null;
    const acquisitions = sumRaw(events, ['BUY','RECEIVE'], totals);
    const sells = sumRaw(events, ['SELL'], totals);
    const outbound = sumRaw(events, ['TRANSFER_OUT'], totals);
    const ledgerRecon = complete && acquisitions !== null && sells !== null && outbound !== null && currentRaw !== null && acquisitions - sells - outbound === currentRaw;
    const active = currentRaw !== null && currentRaw > 0n;
    const firstAcq = history.first_observed_acquisition || history.first_buy || history.first_receive || w7.history?.first_acquisition;
    const firstTs = Number(firstAcq?.block_time);
    const duration = Number.isFinite(firstTs) && firstTs > 0 && nowTs >= firstTs ? nowTs-firstTs : null;
    let holding = { score: null, status: 'INSUFFICIENT_DATA', reason: 'ACQUISITION_TIME_UNKNOWN' };
    if (duration !== null) {
      if (ledgerRecon && acquisitions > 0n) {
        const retention = active ? Number(currentRaw * 1000000n / acquisitions) / 10000 : 0;
        holding = calculateHolding({ durationSeconds: duration, retentionPercent: Math.min(100, retention), retentionReconciled: true });
      } else {
        const base = holdingBaseScore(duration);
        holding = { score: null, status: 'PARTIAL', base_score: base, reason: 'POSITION_LEDGER_NOT_RECONCILED', active_holder: active };
      }
    }
    let sell = { score: null, status: 'INSUFFICIENT_DATA', reason: 'SELL_POSITION_DATA_UNKNOWN' };
    if (complete && ledgerRecon && acquisitions !== null && acquisitions > 0n && sells !== null) {
      const soldPct = Number(sells * 1000000n / acquisitions) / 10000;
      const count = events.filter(e=>e.event_class==='SELL').length;
      const pattern = detectSellPattern(events, nowTs);
      const largePortion = soldPct >= largePortionThresholdPercent;
      const base = sellBaseScore(Math.min(100, soldPct));
      const cf = count > 0 ? transactionCountFactor(count) : 1;
      const tf = pattern.pattern === 'DISTRIBUTED' ? 1 : (largePortion ? 1.2 : 1.1);
      sell = { score: base === 0 ? 0 : clamp(base * cf * tf, -100, 0), status: 'AVAILABLE', base_score: base,
        sold_percent: Math.min(100, soldPct), sell_count: count, transaction_count_factor: cf, time_factor: tf,
        time_pattern: pattern.pattern, time_pattern_checks: pattern.checks,
        modifier_formula: 'base_score × transaction_count_factor × time_factor (locked multiplicative rule)',
        large_portion_threshold_percent: largePortionThresholdPercent,
        assumptions: ['Position sold percent = observed SELL amount / observed BUY+RECEIVE amount; used only when ledger exactly reconciles.', 'Large portion threshold is locked at 50% of observed acquisition amount.'] };
    } else if (complete && ledgerRecon && sells === 0n) {
      sell = { score: 0, status: 'AVAILABLE', base_score: 0, sell_count: 0, reason: 'COMPLETE_RECONCILED_HISTORY_WITH_NO_SELL' };
    }
    let flow = { score: null, status: 'INSUFFICIENT_DATA', reason: 'FLOW_OUT_OR_SUPPLY_UNKNOWN' };
    if (complete && outbound !== null && supplyRaw !== null && supplyRaw > 0n) {
      const pct = Number(outbound * 1000000n / supplyRaw) / 10000;
      const outEvents = events.filter(e=>e.event_class==='TRANSFER_OUT');
      const windowEvents = outEvents.filter(e => Number(e?.block_time) >= nowTs-3600 && Number(e?.block_time) <= nowTs);
      const recipients = new Set(windowEvents.map(e=>e.counterparty).filter(Boolean));
      const windowSigs = new Set(windowEvents.map(e=>e.signature).filter(Boolean));
      const windowOut = windowEvents.reduce((sum,e)=>sum+BigInt(/^\d+$/.test(String(e.amount_raw??''))?String(e.amount_raw):'0'),0n);
      const windowPct = Number(windowOut * 1000000n / supplyRaw) / 10000;
      const largestOut = outEvents.reduce((max,e)=>{ const raw=/^\d+$/.test(String(e.amount_raw??''))?BigInt(String(e.amount_raw)):0n; return raw>max?raw:max; },0n);
      const largestOutPct = Number(largestOut * 1000000n / supplyRaw) / 10000;
      const repeatedDetected = windowSigs.size >= 3 && recipients.size >= 3 && windowPct >= 0.5;
      const repeatedPct = repeatedDetected ? windowPct : 0;
      flow = calculateFlow({ largeFlowOutPercentSupply: largestOutPct, repeatedDistributionPercentSupply: repeatedPct, transferDataComplete: true });
      flow = { ...flow, largest_single_flow_out_percent_supply: largestOutPct, cumulative_flow_out_percent_supply: pct, transfer_out_count: outEvents.length, distinct_recipients: recipients.size,
        repeated_distribution_detected: repeatedDetected, repeated_distribution_percent_supply: repeatedPct, repeated_distribution_transaction_count: windowSigs.size, repeated_distribution_window_seconds: 3600, supply_basis: 'PHASE2_TOKEN_SUPPLY_RAW',
        note: 'Recipient-based distribution is evaluated only from retained, complete event history.' };
    }
    const ba = calculateBA({ holding, sell, flow });
    return { wallet: address, display: w8.display || w7.display || null,
      database_weight: w7.database?.total_database_weight ?? w8.database?.total_database_weight ?? null,
      database_roles: w7.database?.roles || w8.database?.roles || [],
      holding, sell, flow, behavior_adjustment: ba,
      data_coverage: { history_complete: complete, coverage_status: String(history?.coverage?.status || (complete ? 'COMPLETE' : 'UNKNOWN')).toUpperCase(), coverage_reason: history?.coverage?.reason || null, events_stored: events.length, events_truncated: history.events_truncated === true,
        ledger_reconciled: ledgerRecon, current_holder: active, history_status: history.status || 'UNKNOWN' } };
  });
  const statusCounts = wallets.reduce((a,w)=>(a[w.behavior_adjustment.status]=(a[w.behavior_adjustment.status]||0)+1,a),{});
  return { version: 'ba-integration-v1', status: 'INTEGRATED_PRELIMINARY', weights: WEIGHTS,
    assumptions: { large_portion_threshold_percent: largePortionThresholdPercent, sell_factor_composition: SELL_FACTOR_COMPOSITION, position_reconciliation: 'acquisitions - sells - transfer_out = current_balance; exact equality required' },
    summary: { wallets_total: wallets.length, ba_available: wallets.filter(w=>w.behavior_adjustment.status==='AVAILABLE').length,
      ba_partial: wallets.filter(w=>w.behavior_adjustment.status==='PARTIAL').length,
      ba_insufficient: wallets.filter(w=>w.behavior_adjustment.status==='INSUFFICIENT_DATA').length, status_counts: statusCounts }, wallets };
}

module.exports = { buildWalletBehaviorAdjustment, WEIGHTS, SELL_LARGE_PORTION_THRESHOLD_PERCENT, SELL_FACTOR_COMPOSITION, holdingBaseScore, retentionMultiplier, calculateHolding, sellBaseScore, transactionCountFactor, timeFactor, calculateSell, flowPenalty, calculateFlow, calculateBA };
