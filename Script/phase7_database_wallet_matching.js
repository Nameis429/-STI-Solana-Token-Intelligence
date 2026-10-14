#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { attachRunMetadata } = require('./run_metadata');
const throttle = require('./rpc_throttle');
const { phase7HistoryCoverage } = require('./coverage_contract');
const { normalizeWalletRoles, calculateRoleWeight, extractModifiers } = require('./wallet_role_normalizer');
const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'Config', 'config.json');
const DB_FILE = path.join(ROOT, 'Data', 'database-wallet.json');
const OUTPUT_ROOT = path.join(ROOT, 'Output');
const started = Date.now();

const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const rawBigInt = x => { try { return BigInt(String(x ?? '0')); } catch { return 0n; } };
const normalizeTs = v => { const n = Number(v); return Number.isFinite(n) ? (n > 20000000000 ? Math.floor(n / 1000) : Math.floor(n)) : null; };
const iso = v => { const n = normalizeTs(v); return n ? new Date(n * 1000).toISOString() : null; };
const short4 = x => valid(x) ? x.slice(0, 4) : 'UNKNOWN';
const unique = a => [...new Set((a || []).filter(Boolean))];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function loadConfig() {
  if (!fs.existsSync(CFG)) throw Error('CONFIG_NOT_FOUND');
  const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if (!c.helius.api_key || c.helius.api_key.startsWith('PASTE_')) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}
function locateInput() {
  if (!fs.existsSync(OUTPUT_ROOT)) return null;
  const dirs = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true }).filter(x => x.isDirectory());
  const candidates = [];
  for (const d of dirs) {
    const dir = path.join(OUTPUT_ROOT, d.name);
    const files = ['phase6-result.json','phase5-result.json','phase4-result.json','phase3-result.json','phase2-result.json','phase1-result.json'];
    const f = files.map(n => path.join(dir, n)).find(fs.existsSync);
    if (!f) continue;
    const x = readJson(f);
    const mint = x?.input?.mint || x?.token?.mint || d.name;
    if (valid(mint)) candidates.push({ mint, dir, source: path.basename(f) });
  }
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested) for(let i=candidates.length-1;i>=0;i--) if(candidates[i].mint!==requested) candidates.splice(i,1);
  const rank = { 'phase6-result.json': 6, 'phase5-result.json': 5, 'phase4-result.json': 4, 'phase3-result.json': 3, 'phase2-result.json': 2, 'phase1-result.json': 1 };
  candidates.sort((a,b) => (rank[b.source] || 0) - (rank[a.source] || 0));
  const x = candidates[0];
  if (!x) return null;
  return {
    ...x,
    phase1: readJson(path.join(x.dir, 'phase1-result.json')),
    phase2: readJson(path.join(x.dir, 'phase2-result.json')),
    phase3: readJson(path.join(x.dir, 'phase3-result.json')),
    phase4: readJson(path.join(x.dir, 'phase4-result.json')),
    phase5: readJson(path.join(x.dir, 'phase5-result.json')),
    phase6: readJson(path.join(x.dir, 'phase6-result.json'))
  };
}
function save(result, mint) {
  const dir = path.join(OUTPUT_ROOT, mint);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'phase7-result.json');
  attachRunMetadata(result,7,mint); fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}
async function requestJson(url, options, label, config, quiet = false, requestPolicy = {}) {
  throttle.configure(config);
  const max = Math.max(1, Number(config.database_wallet_matching?.max_retries ?? config.scanner?.max_retries ?? 3));
  const timeout = Math.max(1000, Number(config.database_wallet_matching?.request_timeout_ms ?? config.scanner?.request_timeout_ms ?? 15000));
  const retryBase = Math.max(250, Number(config.database_wallet_matching?.retry_delay_ms ?? config.scanner?.retry_delay_ms ?? 1000));
  const retryMax = Math.max(retryBase, Number(config.database_wallet_matching?.max_retry_delay_ms ?? config.scanner?.max_retry_delay_ms ?? 10000));
  const jitterMax = Math.max(0, Number(config.database_wallet_matching?.retry_jitter_ms ?? config.scanner?.retry_jitter_ms ?? 250));
  const retry429 = requestPolicy.retry429 !== false;

  for (let attempt = 1; attempt <= max; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      if (!quiet) console.log(`  ${label} : request (${attempt}/${max})`);
      await throttle.takeSlot();
      const res = await fetch(url, { ...options, signal: ctl.signal });
      const txt = await res.text();
      let body = {};
      try { body = txt ? JSON.parse(txt) : {}; } catch { body = { raw: txt }; }

      if (res.status === 400) {
        const detail = body?.error?.message || body?.message || body?.raw || 'Bad Request';
        const e = new Error(`HTTP_400: ${detail}`); e.retryable = false; throw e;
      }
      if (res.status === 401) { const e = new Error('HTTP_401_UNAUTHORIZED'); e.retryable = false; throw e; }
      if (res.status === 403) { const e = new Error('HTTP_403_FORBIDDEN'); e.retryable = false; throw e; }
      if (res.status === 404 || res.status === 410) { const e = new Error(`HTTP_${res.status}`); e.retryable = false; throw e; }

      if (res.status === 429) {
        const e = new Error('HTTP_429'); e.retryable = false; e.status = 429;
        e.retry_after = res.headers.get('retry-after');
        e.rate_limit = { limit: res.headers.get('x-ratelimit-limit'), remaining: res.headers.get('x-ratelimit-remaining'), reset: res.headers.get('x-ratelimit-reset') };
        if (!retry429) throw e;
        if (attempt >= max) throw e;
        const retryAfter = Number(res.headers.get('retry-after'));
        const serverDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const backoff = Math.min(retryMax, retryBase * (2 ** (attempt - 1)));
        const jitter = jitterMax ? Math.floor(Math.random() * (jitterMax + 1)) : 0;
        const delay = Math.max(serverDelay, backoff) + jitter;
        if (!quiet) console.log(`  ↻ RETRY   : HTTP 429 in ${delay}ms`);
        await sleep(delay); continue;
      }
      if (res.status >= 500) {
        if (attempt >= max) throw Error(`HTTP_${res.status}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        const serverDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const backoff = Math.min(retryMax, retryBase * (2 ** (attempt - 1)));
        const jitter = jitterMax ? Math.floor(Math.random() * (jitterMax + 1)) : 0;
        const delay = Math.max(serverDelay, backoff) + jitter;
        if (!quiet) console.log(`  ↻ RETRY   : HTTP ${res.status} in ${delay}ms`);
        await sleep(delay); continue;
      }
      if (!res.ok) throw Error(`HTTP_${res.status}: ${body?.error?.message || body?.message || body?.raw || ''}`);
      if (body?.error) throw Error(`RPC_${body.error.code ?? 'UNKNOWN'}: ${body.error.message ?? 'Unknown RPC error'}`);
      return body;
    } catch (e) {
      if (e.retryable === false) throw e;
      if (attempt >= max) throw e;
      const delay = Math.min(retryMax, retryBase * (2 ** (attempt - 1))) + (jitterMax ? Math.floor(Math.random() * (jitterMax + 1)) : 0);
      if (!quiet) console.log(`  ↻ RETRY   : ${e.name === 'AbortError' ? 'TIMEOUT' : e.message} in ${delay}ms`);
      await sleep(delay);
    } finally { clearTimeout(timer); }
  }
  throw Error('REQUEST_FAILED');
}
async function rpc(rpcUrl, method, params, label, config, result, quiet = false) {
  const body = { jsonrpc: '2.0', id: `phase7-${Date.now()}-${Math.random()}`, method, params };
  const out = await requestJson(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) }, label, config, quiet);
  if (result) result.data_sources.push(`Helius RPC ${method}`);
  return out?.result;
}

function roleFromWallet(w) { return normalizeWalletRoles(w); }
function roleWeight(roles, config) { return calculateRoleWeight(roles, config.scoring || {}); }
function modifiers(w, config) { return extractModifiers(w, config.scoring || {}); }
function phase3Map(p3) { const m = new Map(); for (const h of (p3?.holders || [])) if (valid(h?.owner)) m.set(h.owner, h); return m; }
function phase4Map(p4) { const m = new Map(); for (const h of (p4?.holders || [])) if (valid(h?.owner)) m.set(h.owner, h); return m; }
function addAppearance(map, address, source, context = {}) {
  if (!valid(address)) return;
  if (!map.has(address)) map.set(address, []);
  const arr = map.get(address);
  if (!arr.some(x => x.source === source)) arr.push({ source, ...context });
}
function extractAppearances(p3, p4, p5, p6, mint) {
  const map = new Map();
  for (const h of (p3?.holders || [])) addAppearance(map, h?.owner, 'PHASE3_HOLDER', { balance_raw: String(h.amount_raw ?? '0'), balance_ui: h.amount_ui ?? null });
  for (const h of (p4?.holders || [])) addAppearance(map, h?.owner, 'PHASE4_CLASSIFICATION', { classification: h.classification || null, confidence: h.confidence || null });
  const creator = p5?.creator_discovery?.selected?.address;
  if (valid(creator)) addAppearance(map, creator, 'PHASE5_CREATOR', { role: p5.creator_discovery.selected.role, confidence: p5.creator_discovery.selected.confidence });
  for (const c of (p5?.creator_discovery?.candidates || [])) addAppearance(map, c.address, 'PHASE5_CREATOR_CANDIDATE', { role: c.role, confidence: c.confidence });
  for (const x of (p5?.creator_distribution?.recipients || [])) addAppearance(map, x.address, 'PHASE5_CREATOR_RECIPIENT', { received_raw: String(x.received_raw ?? '0'), received_pct_supply: x.received_pct_supply ?? null });
  for (const x of (p5?.related_wallets?.wallets || [])) addAppearance(map, x.address, 'PHASE5_RELATED_WALLET', { relation: 'DIRECT_CREATOR_RECIPIENT', received_raw: String(x.received_raw ?? '0'), received_pct_supply: x.received_pct_supply ?? null });
  for (const x of (p5?.initial_distribution?.clusters || [])) for (const a of (x.wallets || [])) addAppearance(map, a, 'PHASE5_INITIAL_DISTRIBUTION', { cluster_key: x.cluster_key, cluster_confidence: x.confidence });
  for (const c of (p6?.fee_components || [])) for (const a of (c?.destination?.addresses || [])) addAppearance(map, a, 'PHASE6_FEE_RECIPIENT', { component: c.name, venue: c.venue, verification: c.verification });
  for (const d of (p6?.fee_destinations?.components || [])) for (const a of (d?.addresses || d?.destination?.addresses || [])) addAppearance(map, a, 'PHASE6_FEE_RECIPIENT', { component: d.name || d.component || null });
  for (const x of (p6?.downstream_usage?.flows || [])) if (valid(x?.address)) addAppearance(map, x.address, 'PHASE6_DOWNSTREAM_RECIPIENT', { ownership_status: x.ownership_status || 'UNKNOWN' });
  return map;
}

function expandDecimalString(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  let sign = '';
  let x = s;
  if (x[0] === '+' || x[0] === '-') { sign = x[0] === '-' ? '-' : ''; x = x.slice(1); }
  const parts = x.toLowerCase().split('e');
  const mantissa = parts[0];
  const exponent = parts.length === 2 ? Number(parts[1]) : 0;
  if (!Number.isInteger(exponent) || !Number.isSafeInteger(exponent)) return null;
  const [whole0, frac0 = ''] = mantissa.split('.');
  const whole = whole0 || '0';
  const digits = `${whole}${frac0}`;
  const decimalPos = whole.length + exponent;
  if (decimalPos <= 0) return `${sign}0.${'0'.repeat(-decimalPos)}${digits}`;
  if (decimalPos >= digits.length) return `${sign}${digits}${'0'.repeat(decimalPos - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
}

function deriveRawAmount(uiAmount, decimals) {
  const d = Number(decimals);
  if (uiAmount == null || !Number.isInteger(d) || d < 0 || d > 255) return null;
  const expanded = expandDecimalString(uiAmount);
  if (expanded == null || expanded.startsWith('-')) return null;
  const [whole0, frac0 = ''] = expanded.split('.');
  const whole = (whole0 || '0').replace(/^0+(?=\d)/, '');
  const frac = frac0.replace(/0+$/, '');
  if (frac.length > d) {
    // The displayed UI amount has more precision than the token supports.
    // Do not silently invent/truncate a raw integer.
    return null;
  }
  const padded = frac.padEnd(d, '0');
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function tokenTransferEvents(tx, wallet, mint, tokenDecimals) {
  const arr = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  const events = [];
  for (const t of arr) {
    if (t?.mint !== mint) continue;
    const from = t.fromUserAccount || t.from_user_account || null;
    const to = t.toUserAccount || t.to_user_account || null;
    const rawAmount = t.rawTokenAmount?.tokenAmount ?? t.raw_token_amount?.token_amount ?? t.token_amount_raw ?? null;
    const uiAmount = t.tokenAmount ?? t.uiAmount ?? t.token_amount ?? t.amount ?? null;
    if (rawAmount == null && uiAmount == null) continue;
    const explicitDecimals = t.rawTokenAmount?.decimals ?? t.raw_token_amount?.decimals ?? null;
    const decimals = explicitDecimals != null ? Number(explicitDecimals) : tokenDecimals;
    const raw = rawAmount != null ? String(rawAmount) : deriveRawAmount(uiAmount, decimals);
    const amountRawSource = rawAmount != null ? 'HELIUS_RAW_TOKEN_AMOUNT' : (raw != null ? 'DERIVED_FROM_UI_AMOUNT_AND_PHASE_DECIMALS' : null);
    const decimalsSource = explicitDecimals != null ? 'HELIUS_RAW_TOKEN_AMOUNT' : (raw != null && tokenDecimals != null ? 'PHASE2_TOKEN_DECIMALS' : null);
    const outgoing = from === wallet;
    const incoming = to === wallet;
    if (!outgoing && !incoming) continue;
    const type = String(tx.type || '').toUpperCase();
    let event_class = incoming ? 'RECEIVE' : 'TRANSFER_OUT';
    if (type === 'SWAP') event_class = incoming ? 'BUY' : 'SELL';
    events.push({ signature: tx.signature || null, slot: tx.slot ?? null, timestamp: iso(tx.timestamp ?? tx.blockTime ?? tx.block_time), block_time: normalizeTs(tx.timestamp ?? tx.blockTime ?? tx.block_time), event_class, amount_raw: raw, amount_ui: uiAmount, decimals: Number.isInteger(decimals) ? decimals : null, amount_raw_source: amountRawSource, decimals_source: decimalsSource, counterparty: incoming ? from : to, source: 'HELIUS_ENHANCED_TRANSACTION', tx_type: tx.type || null, description: tx.description || null });
  }
  return events;
}
function classifyPosition(events, currentHolder, scanComplete, nowTs) {
  const ordered = [...events].filter(e => e.block_time).sort((a,b) => a.block_time - b.block_time);
  const buys = ordered.filter(e => e.event_class === 'BUY');
  const sells = ordered.filter(e => e.event_class === 'SELL');
  const acquisitions = ordered.filter(e => e.event_class === 'BUY' || e.event_class === 'RECEIVE');
  const exits = ordered.filter(e => e.event_class === 'SELL' || e.event_class === 'TRANSFER_OUT');
  const firstAcq = acquisitions[0] || null;
  const lastSell = sells[sells.length - 1] || null;
  const lastEvent = ordered[ordered.length - 1] || null;
  let status = 'UNKNOWN';
  if (currentHolder) status = firstAcq ? 'CURRENT_HOLDER' : 'CURRENT_HOLDER_NO_OBSERVED_ACQUISITION';
  else if (sells.length || exits.length) status = 'NO_LONGER_HOLDER';
  else if (acquisitions.length) status = 'HISTORICAL_ONLY';
  else status = 'NO_TOKEN_HISTORY_FOUND';
  const start = firstAcq?.block_time || null;
  let end = null;
  let duration_basis = null;
  if (start) {
    if (currentHolder) { end = nowTs; duration_basis = 'FIRST_OBSERVED_ACQUISITION_TO_SCAN_TIME'; }
    else if (lastSell?.block_time) { end = lastSell.block_time; duration_basis = 'FIRST_OBSERVED_ACQUISITION_TO_LAST_OBSERVED_SELL'; }
    else if (lastEvent?.block_time) { end = lastEvent.block_time; duration_basis = 'FIRST_OBSERVED_ACQUISITION_TO_LAST_OBSERVED_TOKEN_ACTIVITY'; }
  }
  const duration = start && end && end >= start ? end - start : null;
  return { status, first_acquisition: firstAcq, last_sell: lastSell, last_event: lastEvent, buy_count: buys.length, sell_count: sells.length, acquisition_count: acquisitions.length, outbound_count: exits.length, duration_seconds: duration, duration_basis, history_complete: Boolean(scanComplete) };
}
function positionScore(position, config) {
  if (position?.duration_seconds == null) return null;
  const d = Number(position.duration_seconds);
  if (!Number.isFinite(d)) return null;
  const min = d / 60;
  const t = Array.isArray(config.database_wallet_matching?.hold_profile_thresholds_minutes) ? config.database_wallet_matching.hold_profile_thresholds_minutes.map(Number) : [15,60,360,1440];
  if (min <= t[0]) return 1;
  if (min <= t[1]) return 2;
  if (min <= t[2]) return 3;
  if (min <= t[3]) return 4;
  return 5;
}
function positionLabel(score) { return score == null ? 'UNKNOWN' : `${score}/5`; }
function positionDescription(position) {
  if (position.status === 'CURRENT_HOLDER') return position.duration_seconds == null ? 'HOLDING — duration unknown' : `HOLDING — observed ${formatDuration(position.duration_seconds)}`;
  if (position.status === 'NO_LONGER_HOLDER') return position.duration_seconds == null ? 'EXITED / NO LONGER HOLDING' : `EXITED — observed ${formatDuration(position.duration_seconds)}`;
  if (position.status === 'HISTORICAL_ONLY') return 'HISTORICAL INVOLVEMENT';
  return 'NO TOKEN HISTORY FOUND';
}
function formatDuration(sec) {
  if (!Number.isFinite(Number(sec))) return 'UNKNOWN';
  let s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
async function fetchEnhancedHistorySummary(address, mint, config, result, maxPages, apiBase, key, maxEvents = 50, tokenDecimals = null) {
  let before = null;
  let pages = 0;
  let transactions = 0;
  let complete = false;
  const retained = [];
  let firstInteraction = null;
  let lastInteraction = null;
  let firstAcquisition = null;
  let lastSell = null;
  let lastOutbound = null;
  let buyCount = 0;
  let sellCount = 0;
  let receiveCount = 0;
  let outboundCount = 0;

  const keepEvent = (event) => {
    // Keep only a small bounded event sample for the final JSON. Counts and
    // first/last markers are calculated independently, so retaining events
    // does not affect the historical totals.
    retained.push(event);
    if (retained.length > maxEvents) retained.shift();
  };

  const olderThan = (a, b) => {
    const at = Number(a?.block_time ?? 0), bt = Number(b?.block_time ?? 0);
    return at < bt;
  };
  const newerThan = (a, b) => {
    const at = Number(a?.block_time ?? 0), bt = Number(b?.block_time ?? 0);
    return at > bt;
  };

  for (let p = 1; p <= maxPages; p++) {
    let url = `${apiBase}/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(key)}&limit=100`;
    if (before) url += `&before-signature=${encodeURIComponent(before)}`;

    const body = await requestJson(
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      `History ${short4(address)} p${p}`,
      config,
      true,
      { retry429: false }
    );

    const rows = Array.isArray(body) ? body : [];
    pages = p;
    transactions += rows.length;

    // IMPORTANT: process each page immediately and release the Helius page
    // before requesting the next page. Never accumulate raw transaction rows.
    for (const tx of rows) {
      const events = tokenTransferEvents(tx, address, mint, tokenDecimals);
      if (!events.length) continue;
      for (const event of events) {
        keepEvent(event);

        if (!firstInteraction || olderThan(event, firstInteraction)) firstInteraction = event;
        if (!lastInteraction || newerThan(event, lastInteraction)) lastInteraction = event;

        if (event.event_class === 'BUY') {
          buyCount++;
          if (!firstAcquisition || olderThan(event, firstAcquisition)) firstAcquisition = event;
        } else if (event.event_class === 'RECEIVE') {
          receiveCount++;
          if (!firstAcquisition || olderThan(event, firstAcquisition)) firstAcquisition = event;
        }

        if (event.event_class === 'SELL') {
          sellCount++;
          if (!lastSell || newerThan(event, lastSell)) lastSell = event;
          outboundCount++;
          if (!lastOutbound || newerThan(event, lastOutbound)) lastOutbound = event;
        } else if (event.event_class === 'TRANSFER_OUT') {
          outboundCount++;
          if (!lastOutbound || newerThan(event, lastOutbound)) lastOutbound = event;
        }
      }
    }

    // Once this page contains fewer than 100 transactions, there is no older
    // page to fetch. Otherwise continue with the oldest signature.
    if (rows.length < 100) {
      complete = true;
      break;
    }
    before = rows[rows.length - 1]?.signature;
    if (!before) {
      complete = true;
      break;
    }
  }

  return {
    complete,
    pages,
    transactions,
    events: retained.sort((a,b) => (a.block_time || 0) - (b.block_time || 0)),
    first_interaction: firstInteraction,
    last_interaction: lastInteraction,
    first_acquisition: firstAcquisition,
    last_sell: lastSell,
    last_outbound: lastOutbound,
    buy_count: buyCount,
    sell_count: sellCount,
    receive_count: receiveCount,
    outbound_count: outboundCount
  };
}

function walletName(w) { return String(w?.name || '').trim(); }
function displayWallet(w) { return walletName(w) || short4(w.address); }
function percentageFromRaw(raw, supply) {
  const den = rawBigInt(supply);
  const num = rawBigInt(raw);
  if (den <= 0n || num < 0n) return null;
  return Number(num) / Number(den) * 100;
}
function formatPercentage(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'UNKNOWN';
  if (pct === 0) return '0%';
  if (pct < 0.001) return '<0.001%';
  if (pct < 0.01) return `${pct.toFixed(3)}%`;
  if (pct < 0.1) return `${pct.toFixed(3)}%`;
  return `${pct.toFixed(2)}%`;
}

function sortWallets(a,b) {
  const an = Boolean(a.database?.name), bn = Boolean(b.database?.name);
  if (an !== bn) return an ? -1 : 1;
  const ah = a.current?.is_holder ? 1 : 0, bh = b.current?.is_holder ? 1 : 0;
  if (ah !== bh) return bh - ah;
  return String(a.database?.name || a.wallet).localeCompare(String(b.database?.name || b.wallet));
}
function buildBaseWallet(w, appearances, p3m, p4m, config) {
  const roleInfo = roleFromWallet(w); const roles = roleInfo.roles; const mods = modifiers(w, config); const h = p3m.get(w.address); const c = p4m.get(w.address);
  const role_weight = roleWeight(roles, config);
  return {
    wallet: w.address,
    display: displayWallet(w),
    database: { matched: true, name: walletName(w) || null, roles, role_source: roleInfo.role_source, role_conflicts: roleInfo.role_conflicts, unrecognized_groups: roleInfo.unrecognized_groups, groups: Array.isArray(w.groups) ? w.groups : [], modifiers: mods.symbols, role_weight, modifier_weight: mods.weight, total_database_weight: role_weight + mods.weight },
    appearances,
    current: { is_holder: Boolean(h && rawBigInt(h.amount_raw) > 0n), balance_raw: h ? String(h.amount_raw ?? '0') : '0', balance_ui: h?.amount_ui ?? null, supply_percentage: null, classification: c?.classification || null, classification_confidence: c?.confidence || null, holder_rank: null },
    history: { status: 'NOT_SCANNED', pages: 0, transactions: 0, first_interaction: null, last_interaction: null, first_acquisition: null, last_sell: null, last_outbound: null, buy_count: 0, sell_count: 0, receive_count: 0, outbound_count: 0, events: [], coverage: null },
    position: { status: 'UNKNOWN', hold_profile_score: null, duration_seconds: null, duration_display: null, duration_basis: null, score_confidence: 'UNKNOWN', note: 'Phase 7 position score is based on observed token history; Phase 8 performs deeper behavioral/timeline analysis.' }
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          🔎 SOLANA TOKEN ANALYZER — PHASE 7                ║');
  console.log('║              DATABASE WALLET MATCHING                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  let config; try { config = loadConfig(); } catch (e) { console.log(`STATUS     : FAILED ✗\nERROR      : ${e.message}`); process.exitCode = 1; return; }
  const input = locateInput(); if (!input) { console.log('STATUS     : FAILED ✗\nERROR      : PHASE_INPUT_NOT_FOUND'); process.exitCode = 1; return; }
  const db = readJson(DB_FILE); if (!Array.isArray(db)) { console.log('STATUS     : FAILED ✗\nERROR      : DATABASE_WALLET_NOT_FOUND_OR_INVALID'); process.exitCode = 1; return; }
  const mint = input.mint; const p2 = input.phase2 || {}; const p3 = input.phase3 || {}; const p4 = input.phase4 || {}; const p5 = input.phase5 || {}; const p6 = input.phase6 || {};
  const decimalsCandidate = p2?.token?.decimals ?? p3?.holders?.[0]?.decimals ?? null;
  const decimalsNumber = Number(decimalsCandidate);
  const decimals = Number.isInteger(decimalsNumber) && decimalsNumber >= 0 && decimalsNumber <= 255 ? decimalsNumber : null;
  const supply = String(p2?.token?.supply ?? input.phase1?.token?.supply ?? '0');
  const p3m = phase3Map(p3), p4m = phase4Map(p4), appearances = extractAppearances(p3,p4,p5,p6,mint);
  const cfg = config.database_wallet_matching || {};
  const result = {
    phase: 7, phase_name: 'DATABASE_WALLET_MATCHING', version: '2.6', status: 'FAILED', timestamp: new Date().toISOString(), elapsed_seconds: null,
    input: { mint, source: input.source }, database: { file: 'data/database-wallet.json', wallet_count: db.length },
    scope: { purpose: 'Exact database wallet matching plus bounded token-history state. No behavioral verdicts, risk scoring, predictions, wallet ranking, or final evidence score.', principles: ['Exact address matching only.', 'Current holders and historical participants are both retained.', 'A wallet is not removed from Phase 7 when its current balance is zero.', 'Multiple roles and multiple appearances are preserved.', 'Role weight and token-position profile are separate dimensions.', 'Phase 7 records observed facts; Phase 8 performs deeper behavior/timeline analysis.', 'UNKNOWN is preserved when history coverage is insufficient.', 'A transfer-out is not automatically classified as a sell unless Helius enhanced transaction type supports SWAP/SELL evidence.'], configuration: { history_enabled: cfg.history_enabled !== false, history_max_pages: Number(cfg.history_max_pages ?? 2), history_concurrency: Number(cfg.history_concurrency ?? 4), max_history_events_per_wallet: Number(cfg.max_history_events_per_wallet ?? 50), position_score_enabled: cfg.position_score_enabled !== false, scheduler: 'FIXED_BOUNDED_QUEUE_THEN_429_RETRY_PASS', adaptive_concurrency: false, global_request_pacing: false, retry_429_during_main_scan: false, retry_429_after_main_scan: true, retry_429_attempts_after_main_scan: 1, retry_pass_concurrency: 1 } },
    summary: { known_wallets: db.length, matched_wallets: 0, current_holders: 0, historical_wallets: 0, no_longer_holding: 0, historical_buyers: 0, historical_sellers: 0, fee_recipient_matches: 0, creator_matches: 0, initial_distribution_matches: 0, related_wallet_matches: 0, current_holder_matches: 0 },
    matches: [], unmatched: { current_holders_not_in_database: [], phase5_known_not_in_database: [], phase6_fee_recipients_not_in_database: [] },
    history_scan: { enabled: cfg.history_enabled !== false, wallets_targeted: 0, wallets_scanned: 0, complete_wallet_histories: 0, partial_wallet_histories: 0, failed_wallet_histories: 0, rate_limited_wallets: 0, rate_limited_wallet_list: [], retry_pass_wallets: 0, retry_pass_attempted: 0, retry_pass_recovered: 0, retry_pass_still_rate_limited: 0, pages_fetched: 0, transactions_seen: 0, events_extracted: 0, coverage: null },
    data_sources: ['data/database-wallet.json','Phase 3 holder snapshot','Phase 4 holder classification','Phase 5 creator/distribution/related-wallet evidence','Phase 6 fee-recipient evidence'], missing: [], errors: []
  };

  console.log(`TOKEN\n  Mint       : ${short4(mint)}\n  Network    : ${config.helius.network}\n\nDATABASE\n  Known wallets : ${db.length}\n  Exact matching: enabled`);
  console.log('\nMATCHING SOURCES');
  console.log(`  Phase 3 holders        : ${p3m.size}`);
  console.log(`  Phase 5 appearances    : ${[...appearances.values()].filter(a=>a.some(x=>x.source.startsWith('PHASE5'))).length}`);
  console.log(`  Phase 6 fee recipients : ${[...appearances.values()].filter(a=>a.some(x=>x.source==='PHASE6_FEE_RECIPIENT')).length}`);

  const wallets = db.filter(w => valid(w?.address)).map(w => buildBaseWallet(w, appearances.get(w.address) || [], p3m, p4m, config));
  wallets.sort((a,b) => (Number(b.current.is_holder) - Number(a.current.is_holder)) || String(a.wallet).localeCompare(String(b.wallet)));
  const byAddress = new Map(wallets.map(w => [w.wallet, w]));
  for (const w of wallets) {
    const h = w.current.is_holder;
    if (h) result.summary.current_holder_matches++;
    const ap = w.appearances.map(x=>x.source);
    if (ap.includes('PHASE5_CREATOR')) result.summary.creator_matches++;
    if (ap.includes('PHASE5_INITIAL_DISTRIBUTION')) result.summary.initial_distribution_matches++;
    if (ap.includes('PHASE5_RELATED_WALLET')) result.summary.related_wallet_matches++;
    if (ap.includes('PHASE6_FEE_RECIPIENT')) result.summary.fee_recipient_matches++;
  }
  for (const [address,h] of p3m) if (!byAddress.has(address)) result.unmatched.current_holders_not_in_database.push({ wallet: address, display: short4(address), balance_raw: String(h.amount_raw ?? '0'), balance_ui: h.amount_ui ?? null });
  for (const [address,ap] of appearances) if (!byAddress.has(address) && ap.some(x=>x.source.startsWith('PHASE5'))) result.unmatched.phase5_known_not_in_database.push({ wallet: address, display: short4(address), sources: unique(ap.map(x=>x.source)) });
  for (const [address,ap] of appearances) if (!byAddress.has(address) && ap.some(x=>x.source==='PHASE6_FEE_RECIPIENT')) result.unmatched.phase6_fee_recipients_not_in_database.push({ wallet: address, display: short4(address), sources: ['PHASE6_FEE_RECIPIENT'] });

  // Holder ranks are derived only from Phase 3 snapshot, not behavioral ranking.
  const holderRank = new Map([...p3m.values()].sort((a,b)=>rawBigInt(b.amount_raw)>rawBigInt(a.amount_raw)?1:-1).map((h,i)=>[h.owner,i+1]));
  for (const w of wallets) { w.current.holder_rank = holderRank.get(w.wallet) || null; w.current.supply_percentage = w.current.is_holder ? percentageFromRaw(w.current.balance_raw, supply) : null; }

  const historyEnabled = cfg.history_enabled !== false;
  const maxPages = Math.max(1, Number(cfg.history_max_pages ?? 2));
  if (historyEnabled) {
    const apiBase = String(config.helius.api_base_url || '').replace(/\/$/, '');
    const maxEvents = Math.max(1, Number(cfg.max_history_events_per_wallet ?? 50));
    result.history_scan.wallets_targeted = wallets.length;
    // v2.3: bounded async worker pool. Each worker processes one wallet at a time;
    // raw Helius pages are converted immediately and released. No 452-wallet
    // Promise.all() and no second recovery array are created.
    // v2.4 uses a fixed bounded async queue. This workload is network I/O-bound,
    // so Node's native async I/O is preferred over worker_threads. An isolated
    // 429 is retried only for its wallet and does not throttle the whole queue.
    const concurrency = Math.max(1, Number(cfg.history_concurrency ?? 5));
    const nowTs = Math.floor(Date.now() / 1000);
    let cursor = 0;
    let completed = 0;
    let active = 0;
    let found = 0;
    let buyers = 0;
    let sellers = 0;
    let rateLimited = 0;
    let errors = 0;
    const rateLimitedWallets = [];
    const startedHistory = Date.now();
    let lastHeartbeat = startedHistory;

    result.history_scan.wallets_targeted = wallets.length;
    console.log(`\nHISTORICAL TOKEN ACTIVITY\n  Wallets targeted : ${wallets.length}\n  Max pages        : ${maxPages}\n  Concurrency      : ${concurrency}\n  Scheduler        : FIXED BOUNDED QUEUE\n  Request pacing   : NONE\n  Memory mode      : STREAMING / BOUNDED\n  Progress         : LIVE`);

    function applyHistoryResult(w, hr, error, recovery = false) {
      if (!recovery) result.history_scan.wallets_scanned++;
      if (error) {
        errors++;
        const msg = error.message || String(error);
        if (msg === 'HTTP_429') { rateLimited++; result.history_scan.rate_limited_wallets++; if (!result.history_scan.rate_limited_wallet_list.includes(w.wallet)) result.history_scan.rate_limited_wallet_list.push(w.wallet); }
        w.history.status = msg === 'HTTP_429' ? 'RATE_LIMITED' : 'FAILED';
        w.history.error = msg;
        w.history.pages = 0; w.history.transactions = 0; w.history.events = [];
        w.history.coverage = phase7HistoryCoverage({ pagesFetched: 0, maxPages, transactionsObserved: 0, eventsRetained: 0, complete: false, failed: true, rateLimit: { encountered: msg === 'HTTP_429', retry_count: 0, recovered: false, retry_exhausted: msg === 'HTTP_429', final_state: msg === 'HTTP_429' ? 'RETRY_EXHAUSTED' : 'FAILED' } });
        w.history.coverage_legacy = 'UNKNOWN';
        w.history.buy_count = null; w.history.sell_count = null;
        w.history.receive_count = null; w.history.outbound_count = null;
        w.position = { status:'UNKNOWN', hold_profile_score:null, duration_seconds:null,
          duration_display:null, duration_basis:null, score_confidence:'UNKNOWN',
          note:'Historical scan failed or was rate-limited; no behavioral conclusion is made.' };
        if (!recovery) result.history_scan.failed_wallet_histories++;
        return;
      }

      if (recovery) {
        result.history_scan.retry_pass_wallets++;
        result.history_scan.retry_pass_recovered++;
        result.history_scan.failed_wallet_histories = Math.max(0, result.history_scan.failed_wallet_histories - 1);
        
        w.history.recovery = { initial_status: 'RATE_LIMITED', retry_attempted: true, retry_status: 'FOUND' };
      }
      w.history.status = hr.transactions > 0 ? 'FOUND' : 'NO_TOKEN_HISTORY_FOUND';
      w.history.pages = hr.pages; w.history.transactions = hr.transactions; w.history.events = hr.events;
      w.history.coverage = phase7HistoryCoverage({ pagesFetched: hr.pages, maxPages, transactionsObserved: hr.transactions, eventsRetained: hr.events.length, complete: hr.complete, empty: hr.transactions === 0, rateLimit: { encountered: Boolean(recovery), retry_count: recovery ? 1 : 0, recovered: recovery ? true : null, final_state: recovery ? 'RECOVERED' : 'NOT_ENCOUNTERED' } });
      w.history.coverage_legacy = hr.complete ? (hr.transactions > 0 ? 'COMPLETE_WITHIN_CONFIGURED_PAGES' : 'EMPTY_WITHIN_CONFIGURED_PAGES') : 'PARTIAL_PAGE_CAP';
      w.history.first_interaction = hr.first_interaction; w.history.last_interaction = hr.last_interaction;
      w.history.first_acquisition = hr.first_acquisition; w.history.last_sell = hr.last_sell;
      w.history.last_outbound = hr.last_outbound;
      w.history.buy_count = hr.buy_count; w.history.sell_count = hr.sell_count;
      w.history.receive_count = hr.receive_count; w.history.outbound_count = hr.outbound_count;
      result.history_scan.pages_fetched += hr.pages;
      result.history_scan.transactions_seen += hr.transactions;
      result.history_scan.events_extracted += hr.events.length;
      if (hr.complete) result.history_scan.complete_wallet_histories++; else result.history_scan.partial_wallet_histories++;

      const acquisitionCount = hr.buy_count + hr.receive_count;
      let positionStatus = 'UNKNOWN';
      if (w.current.is_holder) positionStatus = hr.first_acquisition ? 'CURRENT_HOLDER' : 'CURRENT_HOLDER_NO_OBSERVED_ACQUISITION';
      else if (hr.sell_count > 0 || hr.outbound_count > 0) positionStatus = 'NO_LONGER_HOLDER';
      else if (acquisitionCount > 0) positionStatus = 'HISTORICAL_ONLY';
      else positionStatus = hr.complete ? 'NO_TOKEN_HISTORY_FOUND' : 'NOT_FOUND_WITHIN_COVERAGE';

      const pos = { status:positionStatus, first_acquisition:hr.first_acquisition, last_sell:hr.last_sell,
        last_event:hr.last_interaction, buy_count:hr.buy_count, sell_count:hr.sell_count,
        acquisition_count:acquisitionCount, outbound_count:hr.outbound_count, duration_seconds:null,
        duration_basis:null, history_complete:Boolean(hr.complete) };
      if (hr.first_acquisition?.block_time) {
        const startTs = hr.first_acquisition.block_time;
        let endTs = null, durationBasis = null;
        if (w.current.is_holder) { endTs = nowTs; durationBasis = 'FIRST_OBSERVED_ACQUISITION_TO_SCAN_TIME'; }
        else if (hr.last_sell?.block_time) { endTs = hr.last_sell.block_time; durationBasis = 'FIRST_OBSERVED_ACQUISITION_TO_LAST_OBSERVED_SELL'; }
        else if (hr.last_interaction?.block_time) { endTs = hr.last_interaction.block_time; durationBasis = 'FIRST_OBSERVED_ACQUISITION_TO_LAST_OBSERVED_TOKEN_ACTIVITY'; }
        pos.duration_seconds = endTs != null && endTs >= startTs ? endTs - startTs : null;
        pos.duration_basis = durationBasis;
      }
      const score = cfg.position_score_enabled === false ? null : positionScore(pos, config);
      w.position = { status:pos.status, hold_profile_score:score, duration_seconds:pos.duration_seconds,
        duration_display:formatDuration(pos.duration_seconds), duration_basis:pos.duration_basis,
        score_confidence:score == null ? 'UNKNOWN' : (hr.complete ? 'MEDIUM' : 'LOW'),
        note:pos.duration_basis ? 'Observed duration is a bounded Phase 7 history span, not a complete behavioral holding analysis.' : 'Insufficient observed history for duration.' };
      if (hr.transactions > 0) result.summary.historical_wallets++;
      if (pos.status === 'NO_LONGER_HOLDER') result.summary.no_longer_holding++;
      if (hr.buy_count > 0) result.summary.historical_buyers++;
      if (hr.sell_count > 0) result.summary.historical_sellers++;
      if (hr.transactions > 0) found++;
      if (hr.buy_count > 0) buyers++;
      if (hr.sell_count > 0) sellers++;
    }

    async function processOne(i) {
      const w = wallets[i];
      const walletStart = Date.now();
      let hr = null, error = null;
      try {
        hr = await fetchEnhancedHistorySummary(w.wallet, mint, config, result, maxPages, apiBase, config.helius.api_key, maxEvents, decimals);
      } catch (e) { error = e; }

      if (error?.message === 'HTTP_429') rateLimitedWallets.push(i);
      applyHistoryResult(w, hr, error);
      completed++;
      active--;
      const elapsed = (Date.now() - startedHistory) / 1000;
      const avg = completed > 0 ? elapsed / completed : 0;
      const eta = Math.max(0, avg * (wallets.length - completed));
      const status = error ? (error.message === 'HTTP_429' ? 'RATE_LIMITED' : 'ERROR') : (w.history.status === 'NO_TOKEN_HISTORY_FOUND' ? 'NO ACTIVITY' : 'FOUND');
      const detail = error ? error.message : `BUY:${w.history.buy_count ?? '-'} SELL:${w.history.sell_count ?? '-'}`;
      console.log(`  [${String(completed).padStart(3)}/${wallets.length}] ${w.display.padEnd(10)} ${status.padEnd(12)} ${detail.padEnd(18)} ${formatDuration((Date.now()-walletStart)/1000)} | ETA ${formatDuration(Math.round(eta))}`);
      if (completed % 10 === 0 || completed === wallets.length) {
        console.log(`      Progress: ${completed}/${wallets.length} | Active:${active} Found:${found} Buyers:${buyers} Sellers:${sellers} 429:${rateLimited} Errors:${errors} | Elapsed:${formatDuration(Math.round(elapsed))} | ETA:${formatDuration(Math.round(eta))}`);
      }
    }

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= wallets.length) return;
        active++;
        await processOne(i);
      }
    }

    const heartbeat = setInterval(() => {
      const now = Date.now();
      lastHeartbeat = now;
      const elapsed = (now - startedHistory) / 1000;
      const avg = completed > 0 ? elapsed / completed : 0;
      const eta = Math.max(0, avg * (wallets.length - completed));
      console.log(`      [HEARTBEAT] ${completed}/${wallets.length} | Active:${active} | Workers:${concurrency} | 429:${rateLimited} Errors:${errors} | Elapsed:${formatDuration(Math.round(elapsed))} | ETA:${formatDuration(Math.round(eta))}`);
    }, 30000);

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, wallets.length) }, () => worker()));
    } finally {
      clearInterval(heartbeat);
    }
    console.log(`\n      ✓ History workers drained — ${completed}/${wallets.length} wallets processed`);

    if (rateLimitedWallets.length > 0 && cfg.retry_429_after_main_scan !== false) {
      const delayBeforeRetry = Math.max(0, Number(cfg.retry_429_pass_delay_ms ?? 3000));
      console.log(`\n      ✓ MAIN SCAN COMPLETE — ${completed}/${wallets.length}`);
      console.log('\nRETRY PASS — HTTP 429 ONLY');
      console.log(`  Queued        : ${rateLimitedWallets.length}`);
      console.log('  Retry attempts: 1 per wallet');
      console.log('  Concurrency   : 1');
      console.log(`  Delay before  : ${delayBeforeRetry}ms`);
      if (delayBeforeRetry) await sleep(delayBeforeRetry);
      for (let r = 0; r < rateLimitedWallets.length; r++) {
        const i = rateLimitedWallets[r], w = wallets[i];
        result.history_scan.retry_pass_attempted++;
        console.log(`  [RETRY ${r + 1}/${rateLimitedWallets.length}] ${w.display.padEnd(10)} ...`);
        try {
          const hr = await fetchEnhancedHistorySummary(w.wallet, mint, config, result, maxPages, apiBase, config.helius.api_key, maxEvents, decimals);
          applyHistoryResult(w, hr, null, true);
          console.log(`  [RETRY ${r + 1}/${rateLimitedWallets.length}] ${w.display.padEnd(10)} FOUND`);
        } catch (e) {
          if (e?.message === 'HTTP_429') {
            result.history_scan.retry_pass_still_rate_limited++;
            w.history.status = 'RATE_LIMITED';
            w.history.recovery = { initial_status: 'RATE_LIMITED', retry_attempted: true, retry_status: 'RATE_LIMITED' };
            w.history.error = 'HTTP_429';
            console.log(`  [RETRY ${r + 1}/${rateLimitedWallets.length}] ${w.display.padEnd(10)} STILL 429`);
          } else {
            w.history.status = 'FAILED';
            w.history.recovery = { initial_status: 'RATE_LIMITED', retry_attempted: true, retry_status: 'FAILED' };
            w.history.error = e?.message || String(e);
            console.log(`  [RETRY ${r + 1}/${rateLimitedWallets.length}] ${w.display.padEnd(10)} FAILED ${w.history.error}`);
          }
        }
      }
      console.log(`\nRETRY RESULT\n  Attempted      : ${result.history_scan.retry_pass_attempted}\n  Recovered      : ${result.history_scan.retry_pass_recovered}\n  Still 429      : ${result.history_scan.retry_pass_still_rate_limited}`);
    } else if (rateLimitedWallets.length === 0) {
      console.log('\nRETRY PASS — no HTTP 429 wallets queued.');
    }
  } else {
    result.missing.push('DATABASE_WALLET_HISTORY_SCAN_DISABLED');
  }

  result.history_scan.coverage = result.history_scan.enabled === false
    ? { retrieval_mode:'SNAPSHOT', status:'UNKNOWN', reason:'NOT_AVAILABLE', scope:'UNKNOWN_SCOPE', pagination:{enabled:false,pages_requested:0,pages_fetched:0,cursor_used:false,stopped_reason:'NOT_AVAILABLE',has_more_possible:null}, records:{requested:0,observed:0,retained:0}, caps:{page_cap:null,record_cap:null,wallet_cap:null,event_cap:null,cap_triggered:false}, rate_limit:{encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'} }
    : phase7HistoryCoverage({ pagesFetched: result.history_scan.pages_fetched, maxPages, transactionsObserved: result.history_scan.transactions_seen, eventsRetained: result.history_scan.events_extracted, complete: result.history_scan.partial_wallet_histories === 0 && result.history_scan.failed_wallet_histories === 0, empty: result.history_scan.transactions_seen === 0, failed: result.history_scan.failed_wallet_histories === result.history_scan.wallets_targeted && result.history_scan.wallets_targeted > 0, rateLimit: { encountered: result.history_scan.rate_limited_wallets > 0, retry_count: result.history_scan.retry_pass_attempted, recovered: result.history_scan.retry_pass_attempted > 0 ? result.history_scan.retry_pass_recovered > 0 : null, final_state: result.history_scan.retry_pass_still_rate_limited > 0 ? 'RATE_LIMITED' : (result.history_scan.rate_limited_wallets > 0 ? 'RECOVERED_OR_PARTIAL' : 'NOT_ENCOUNTERED') } });

  console.log('\nFINALIZING PHASE 7');
  console.log('  [1/5] Aggregating current-holder state...');
  for (const w of wallets) {
    if (w.current.is_holder) result.summary.current_holders++;
  }
  console.log('  [2/5] Building exact database matches...');
  const matchedWallets = wallets.filter(w => w.current.is_holder || w.appearances.length > 0 || (w.history.events || []).length > 0);
  result.summary.matched_wallets = matchedWallets.length;
  console.log('  [3/5] Building unmatched-wallet counts...');
  result.database.unmatched_wallet_count = Math.max(0, db.length - matchedWallets.length);
  console.log('  [4/5] Sorting compact result...');
  result.matches = matchedWallets.sort(sortWallets);
  result.status = result.history_scan.failed_wallet_histories > 0 && result.history_scan.failed_wallet_histories === result.history_scan.wallets_targeted ? 'FAILED' : (result.history_scan.partial_wallet_histories > 0 || result.history_scan.failed_wallet_histories > 0 ? 'PARTIAL' : 'COMPLETE');
  result.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(2));
  console.log('  [5/5] Result structure ready.');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║ DATABASE MATCH SUMMARY                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Known wallets matched       : ${result.summary.matched_wallets}`);
  console.log(`  Current holders             : ${result.summary.current_holders}`);
  console.log(`  Historical wallets          : ${result.summary.historical_wallets}`);
  console.log(`  No longer holding           : ${result.summary.no_longer_holding}`);
  console.log(`  Historical buyers           : ${result.summary.historical_buyers}`);
  console.log(`  Historical sellers          : ${result.summary.historical_sellers}`);
  console.log(`  Fee recipient matches       : ${result.summary.fee_recipient_matches}`);
  console.log(`  Creator matches             : ${result.summary.creator_matches}`);
  console.log(`  Initial distribution matches: ${result.summary.initial_distribution_matches}`);
  console.log(`  Related wallet matches      : ${result.summary.related_wallet_matches}`);

  const current = result.matches.filter(w=>w.current.is_holder);
  const exited = result.matches.filter(w=>w.position.status==='NO_LONGER_HOLDER');
  const show = (title, arr) => { console.log(`\n╔══════════════════════════════════════════════════════════════╗\n║ ${title.padEnd(59,' ')}║\n╚══════════════════════════════════════════════════════════════╝`); if (!arr.length) { console.log('  None'); return; } for (const w of arr.slice(0,10)) { const pos = positionLabel(w.position.hold_profile_score); const role = w.database.roles.join('/'); const pctNow = w.current.is_holder ? percentageFromRaw(w.current.balance_raw, supply) : null; const amountText = w.current.is_holder ? formatPercentage(pctNow) : 'EXIT'; console.log(`  ${w.display.padEnd(10)} ${role.padEnd(9)} ${amountText.padEnd(8)} ${pos}`); } if(arr.length>10) console.log(`  ... +${arr.length-10} more`); };
  show('👥 CURRENT HOLDERS', current);
  show('🕘 HISTORICAL / NO LONGER HOLDING', exited);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║ 🔗 MATCH SOURCES                                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Holder matches             : ${result.summary.current_holders}`);
  console.log(`  Initial distribution       : ${result.summary.initial_distribution_matches}`);
  console.log(`  Related wallets            : ${result.summary.related_wallet_matches}`);
  console.log(`  Fee recipients             : ${result.summary.fee_recipient_matches}`);
  console.log(`  Creator-related            : ${result.summary.creator_matches}`);

  console.log(`\nPHASE 7 SUMMARY\n  ${result.summary.matched_wallets} known wallets identified\n  ${result.summary.historical_wallets} have observed historical token involvement\n  ${result.summary.current_holders} are current holders\n  ${result.summary.no_longer_holding} are no longer holding\n\n  Database matching : ✓ COMPLETE\n  Historical scan   : ${result.status === 'COMPLETE' ? '✓ COMPLETE' : result.status === 'PARTIAL' ? '⚠ PARTIAL' : '✗ FAILED'}\n  STATUS            : ${result.status === 'COMPLETE' ? '✓ COMPLETE' : result.status === 'PARTIAL' ? '⚠ PARTIAL' : '✗ FAILED'}\n  TIME              : ${result.elapsed_seconds.toFixed(2)}s`);
  console.log('\nWRITING OUTPUT');
  const out = save(result, mint);
  let verified = false;
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    try { JSON.parse(fs.readFileSync(out, 'utf8')); verified = true; } catch {}
  }
  console.log(`  OUTPUT            : ${path.relative(ROOT, out)}`);
  console.log(`  OUTPUT VERIFY     : ${verified ? '✓ OK' : '✗ FAILED'}`);
  console.log(`\nSTATUS              : ${verified && result.status !== 'FAILED' ? (result.status === 'PARTIAL' ? '⚠ PARTIAL' : '✓ COMPLETE') : '✗ FAILED'}`);
  console.log(`TIME                : ${result.elapsed_seconds.toFixed(2)}s`);
  console.log('────────────────────────────────────────────────────────────────');
  if (result.status === 'FAILED' || !verified) process.exitCode = 1;
}
main().catch(e => { console.log(`\nSTATUS     : FAILED ✗\nERROR      : ${e.message}`); process.exitCode = 1; });
