#!/usr/bin/env node
'use strict';
/**
 * Phase 9 Risk Engine v2.0.0
 * Deterministic rule evaluation. No aggregate risk score or final token verdict.
 */
const fs = require('fs');
const path = require('path');
const { attachRunMetadata } = require('./run_metadata');
const { annotateRelationships, loadRelationshipsConfig } = require('./relationship_annotator');
const { loadCexIndex, withoutCexWallets } = require('./cex_registry');

/* ------------------------------------------------------------------
 * guard kredibilitas likuiditas.
 * SPR-05/LTR-01/LTR-04 membandingkan volume SELL teramati dengan SATU
 * snapshot pool DEX. Bila pool jauh lebih kecil dari volume teramati
 * (token CEX-listed: likuiditas riil di CEX; atau pool kering), pool tidak
 * kredibel mewakili likuiditas — evaluasi menjadi INSUFFICIENT_DATA yang
 * jujur (rasio mentah tetap dipublikasikan sebagai diagnostik), bukan
 * trigger dengan rasio absurd. Ini guard metodologi, BUKAN perubahan
 * threshold rule (phase9_rules.json tidak disentuh).
 * ------------------------------------------------------------------ */
function loadEvaluationGuards() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'Config', 'config.json'), 'utf8'));
    return (c && c.evaluation_guards) || {};
  } catch { return {}; }
}
/* Pure: pool kredibel bila base_raw >= threshold * volume teramati.
 * Default threshold 0.01 (pool < 1% dari volume → tidak kredibel). */
function liquidityCredibility(poolBaseRaw, volumeRaw, guards) {
  const raw = Number(guards?.liquidity_credibility_ratio ?? 0.01);
  const threshold = Number.isFinite(raw) && raw > 0 ? raw : 0.01;
  if (!(volumeRaw > 0n) || !(poolBaseRaw > 0n))
    return { credible: null, pool_share_of_volume: null, threshold };
  const share = Number(poolBaseRaw * 1000000n / volumeRaw) / 1000000;
  return { credible: share >= threshold, pool_share_of_volume: share, threshold };
}
const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'Output');
const RULES_FILE = path.join(ROOT, 'Config', 'phase9_rules.json');
const VALID_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STATUSES = new Set(['TRIGGERED','PROVISIONAL','NOT_TRIGGERED','UNKNOWN','INSUFFICIENT_DATA','DISABLED']);
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const asNum = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
function tsOf(e) {
  if (e?.block_time != null || e?.timestamp != null) {
    const n=asNum(e.block_time ?? e.timestamp); return n==null?null:Math.floor(n>2e10?n/1000:n);
  }
  for (const v of [e?.timestamp_utc,e?.timestamp_wib]) {
    if (typeof v==='string') { const t=Date.parse(v); if(Number.isFinite(t)) return Math.floor(t/1000); }
    const n=asNum(v); if(n!=null) return Math.floor(n>2e10?n/1000:n);
  }
  return null;
}
function locate(mint) {
  const dir=path.join(OUT_ROOT,mint);
  if(!fs.existsSync(dir)) throw Error(`OUTPUT_DIR_NOT_FOUND: ${dir}`);
  const files={};
  for(const i of [1,2,3,4,5,6,7,8]) files[`phase${i}`]=readJson(path.join(dir,`phase${i}-result.json`));
  return {dir,files};
}
function phase4ClassificationMap(phase4) {
  const map=new Map();
  for(const x of phase4?.special_accounts||[]) {
    if(x?.owner && x?.classification) map.set(x.owner,String(x.classification).toUpperCase());
  }
  for(const x of phase4?.holders||[]) {
    if(x?.owner && x?.classification) map.set(x.owner,String(x.classification).toUpperCase());
  }
  return map;
}

function findLatestInput() {
  if(!fs.existsSync(OUT_ROOT)) return null;
  const candidates=[];
  for(const entry of fs.readdirSync(OUT_ROOT,{withFileTypes:true})) {
    if(!entry.isDirectory()) continue;
    const dir=path.join(OUT_ROOT,entry.name), file=path.join(dir,'phase8-result.json');
    if(!fs.existsSync(file)) continue;
    const data=readJson(file), mint=String(data?.input?.mint||data?.token?.mint||entry.name).trim();
    if(!VALID_MINT.test(mint)||!Array.isArray(data?.wallets)) continue;
    candidates.push({mint,dir,data,mtime:fs.statSync(file).mtimeMs});
  }
  candidates.sort((a,b)=>b.mtime-a.mtime); return candidates[0]||null;
}
function flatEvents(phase8) {
  const rows=[]; const mint=phase8?.input?.mint||phase8?.token?.mint||null;
  for(const w of phase8?.wallets||[]) for(const e of w?.history?.events||[]) rows.push({wallet:w.wallet,event:e,history:w.history,mint});
  return rows;
}
function eventKey(row) { const e=row?.event||{}; return e.signature ? `${row.wallet}|${e.signature}|${row.mint||''}|${e.event_class||'EVENT'}` : null; }
function uniqueRows(rows) {
  const seen=new Set(), out=[];
  for(const row of rows) { const key=eventKey(row); if(!key||seen.has(key)) continue; seen.add(key); out.push(row); }
  return out;
}
function evRef(row) {
  const e=row?.event||{};
  return {wallet:row.wallet,event_id:e.event_id||null,signature:e.signature||null,event_class:e.event_class||null,
    timestamp_utc:e.timestamp_utc||null,timestamp_wib:e.timestamp_wib||null,
    amount_ui:e.amount_ui??null,counterparty:e.counterparty||null,source:e.source||null,
    transaction_provenance:e.transaction_provenance||{signature:e.signature||null,source:e.source||null,slot:e.slot??null,block_time:e.block_time??null}};
}
function historyCoverage(phase8) {
  const wallets=phase8?.wallets||[];
  if(!wallets.length) return {complete:false,status:'UNKNOWN',reason:'No wallet histories are present.',wallets_total:0,wallets_complete:0,wallets_partial:0,wallets_unknown:0};
  const classify = w => {
    const c=w?.history?.coverage;
    const cs=String(c?.status||'').toUpperCase();
    const legacy=String(w?.history?.status||'').toUpperCase();
    if(cs==='COMPLETE') return 'COMPLETE';
    if(['PARTIAL','SAMPLED','FAILED','UNKNOWN','EMPTY'].includes(cs)) return cs;
    if(w?.history?.complete===true && w?.history?.events_truncated!==true && !['FAILED','RATE_LIMITED'].includes(legacy)) return 'COMPLETE';
    if(['FAILED','RATE_LIMITED'].includes(legacy)) return 'FAILED';
    if(legacy==='FOUND' || w?.history?.complete===false || w?.history?.events_truncated===true) return 'PARTIAL';
    return 'UNKNOWN';
  };
  const counts={COMPLETE:0,PARTIAL:0,SAMPLED:0,FAILED:0,UNKNOWN:0,EMPTY:0};
  for(const w of wallets) counts[classify(w)]++;
  const complete=counts.COMPLETE===wallets.length;
  const incomplete=wallets.length-counts.COMPLETE;
  const status=complete?'COMPLETE':(counts.FAILED===wallets.length?'FAILED':(counts.PARTIAL||counts.SAMPLED?'PARTIAL':'UNKNOWN'));
  return {complete,status,reason:complete?null:`${incomplete}/${wallets.length} wallet histories are not complete within their declared retrieval scope.`,wallets_total:wallets.length,wallets_complete:counts.COMPLETE,wallets_partial:counts.PARTIAL,wallets_sampled:counts.SAMPLED,wallets_failed:counts.FAILED,wallets_unknown:counts.UNKNOWN,wallets_empty:counts.EMPTY};
}
function result(id,category,rule,status,reason,metric=null,evidence=[],extra={}) {
  return {rule_id:id,category,name:rule.name||id,status,reason,metric,
    threshold:rule.threshold??rule.min_count??rule.threshold_pp??null,
    operator:rule.operator||(rule.min_count!=null?'>=':null),window_seconds:rule.window_seconds??null,
    evaluator:rule.evaluator||id,evidence_refs:evidence,data_quality:extra.data_quality||null,
    ...(extra.alternative?{alternative:extra.alternative}:{}),...(extra.notes?{notes:extra.notes}: {})};
}
function missing(id,cat,rule,reason,extra={}) { return result(id,cat,rule,'INSUFFICIENT_DATA',reason,null,[],extra); }
function alternative(rule) { return rule?.evaluation?.alternative||{}; }
function countWindow(rows,windowSeconds) {
  let best={count:0,rows:[]};
  const sorted=[...rows].sort((a,b)=>tsOf(a.event)-tsOf(b.event));
  for(let i=0;i<sorted.length;i++) {
    const start=tsOf(sorted[i].event);
    const group=sorted.filter(r=>tsOf(r.event)>=start && tsOf(r.event)<=start+windowSeconds);
    if(group.length>best.count) best={count:group.length,rows:group};
  }
  return best;
}
function getTransferEndpoints(row) {
  const e=row.event||{}, cp=e.counterparty;
  if(!cp) return null;
  if(e.event_class==='RECEIVE') return {sender:cp,recipient:row.wallet};
  if(e.event_class==='TRANSFER_OUT') return {sender:row.wallet,recipient:cp};
  return null;
}
function transferSellSequences(events,windowSeconds,{requireRelationship=false}={}) {
  const transfers=uniqueRows(events.filter(r=>['RECEIVE','TRANSFER_OUT'].includes(r.event?.event_class)&&tsOf(r.event)!=null))
    .map(row=>({row,...getTransferEndpoints(row),ts:tsOf(row.event)})).filter(t=>t.sender&&t.recipient);
  const sells=uniqueRows(events.filter(r=>r.event?.event_class==='SELL'&&tsOf(r.event)!=null));
  transfers.sort((a,b)=>a.ts-b.ts); sells.sort((a,b)=>tsOf(a.event)-tsOf(b.event));
  const usedSells=new Set(), usedTransfers=new Set(), matches=[];
  for(const t of transfers) {
    const tk=eventKey(t.row); if(usedTransfers.has(tk)) continue;
    const candidates=sells.filter(s=>s.wallet===t.recipient && tsOf(s.event)>=t.ts && tsOf(s.event)-t.ts<=windowSeconds && !usedSells.has(eventKey(s)));
    candidates.sort((a,b)=>tsOf(a.event)-tsOf(b.event));
    const s=candidates[0]; if(!s) continue;
    const rel=t.row.event?.relationship_verified===true && typeof t.row.event?.relationship_id==='string' && t.row.event.relationship_id.trim().length>0;
    const relSell=s.event?.relationship_verified===true && typeof s.event?.relationship_id==='string' && s.event.relationship_id.trim().length>0;
    const sameRel=rel&&relSell&&t.row.event.relationship_id===s.event.relationship_id;
    const match={transfer:t,sell:s,relationship_verified:sameRel,relationship_id:sameRel?t.row.event.relationship_id:null};
    if(!requireRelationship || sameRel) { matches.push(match); usedTransfers.add(tk); usedSells.add(eventKey(s)); }
  }
  return matches;
}
const MISSING_REASONS={
 'SPR-01':'No validated historical wallet balance immediately before the SELL event; current balance is not a substitute.',
 'SPR-03':'No aligned, comprehensive connected-wallet SELL volume and total trading volume for the same period and units.',
 'SPR-04':'No historical balance snapshots with verified attribution of balance reductions specifically to SELL events.',
 'SPR-05':'No aligned SELL volume, mapped pool liquidity, and comparable valuation units.',
 'CTR-01':'No normalized, verified wallet-link graph combined with sufficiently complete trade events.',
 'CTR-02':'No verified funding event with recipient, timestamp, and a qualifying subsequent trade event.',
 'CTR-04':'No connected-group trading volume and total market trading volume measured over the same interval and units.',
 'TCR-01':'No complete or representative market-wide SELL volume by wallet for a common period.',
 'TCR-02':'No complete or representative market-wide BUY volume by wallet for a common period.',
 'TCR-03':'No comparable connected-group and total trading volume for the same period.',
 'TCR-04':'No comparable current and prior-period concentration metrics with matching coverage.',
 'LTR-01':'No aligned verified SELL volume and relevant pool liquidity snapshot for the configured window.',
 'LTR-02':'No comparable liquidity snapshots for the same pool and matching interval.',
 'LTR-03':'No aligned SELL pressure metric and liquidity-decline series for a shared interval.',
 'LTR-04':'No protocol-specific pool state and validated price-impact model inputs.'
};
/* ------------------------------------------------------------------
 * SPR-01 — Large Holder Sell Ratio
 * EVIDENCE CONTRACT :
 *  - Required data: per-wallet chronologically ordered SELL events with a
 *    verified amount_raw, PLUS the balance immediately before each SELL
 *    reconstructed from the SAME wallet's observed event ledger.
 *  - Ledger discipline (identical to the BA engine): the wallet is evaluated
 *    ONLY when history.complete===true AND
 *    BUY+RECEIVE-SELL-TRANSFER_OUT === current balance (exact BigInt).
 *    Wallets that fail this are EXCLUDED from evaluation — never counted as
 *    negative evidence, never assumed safe.
 *  - Counting unit: unique SELL events (deduplicated by event_id).
 *  - Metric: sell_ratio = sell_amount / balance_before_sell.
 *  - Threshold: rule.threshold from Config/phase9_rules.json (SPR-01: 0.2);
 *    fallback rule.thresholds.sell_ratio, then 0.5. Configured and documented,
 *    pending historical calibration — not a hidden magic number.
 *  - LIQUIDITY_POOL wallets are excluded (consistent with SPR-02/CTR-03):
 *    pool token movements are AMM mechanics, not holder exits.
 *  - SELF_TRANSFER nets to zero and does not move the reconstructed balance.
 *  - Any event with an unverifiable amount, or any unhandled event class,
 *    invalidates that wallet's reconstruction (wallet excluded).
 * ------------------------------------------------------------------ */
function rawBigOrNull(x){ const s=String(x??''); return /^\d+$/.test(s)?BigInt(s):null; }
function num(x){ const n=Number(x); return Number.isFinite(n)?n:null; }
/* Shared ledger reconstruction for SPR-01/SPR-04.
 * Returns {ok:false} unless the wallet's observed ledger can be faithfully
 * reconstructed: history.complete===true, every IN/OUT event carries a
 * verifiable amount_raw, no unhandled event classes, and the walk ends
 * exactly at the current balance (same discipline as the BA engine).
 * On success: {ok:true, peak, current, sells:[{event,amount,before}],
 * sellVolume, transferOutVolume}. */
function walkWalletLedger(w){
  const cur=rawBigOrNull(w?.current?.balance_raw);
  const evs=(w?.history?.events||[]).slice().sort((a,b)=>
    (Number(a.block_time)||0)-(Number(b.block_time)||0) ||
    (Number(a.slot)||0)-(Number(b.slot)||0) ||
    String(a.event_id||'').localeCompare(String(b.event_id||'')));
  const seen=new Set(), ordered=[];
  for(const e of evs){ const k=String(e.event_id||`${e.signature}:${e.event_class}`); if(seen.has(k)) continue; seen.add(k); ordered.push(e); }
  if(cur===null) return {ok:false};
  let bal=0n, peak=0n, ok=true, sellVolume=0n, outVolume=0n;
  const sells=[];
  for(const e of ordered){
    const amt=rawBigOrNull(e.amount_raw), cls=e.event_class;
    if(cls==='BUY'||cls==='RECEIVE'){ if(amt===null){ok=false;break;} bal+=amt; }
    else if(cls==='SELL'||cls==='TRANSFER_OUT'){
      if(amt===null){ok=false;break;}
      if(cls==='SELL'){ sells.push({event:e,amount:amt,before:bal}); sellVolume+=amt; }
      else outVolume+=amt;
      bal-=amt;
    }
    else if(cls==='SELF_TRANSFER'){ /* net zero */ }
    else { ok=false; break; }
    if(bal>peak) peak=bal;
  }
  if(!ok||bal!==cur) return {ok:false};
  return {ok:true,peak,current:cur,sells,sellVolume,transferOutVolume:outVolume};
}
function evaluateSpr01({phase8,phase4,rule,mint,cat}) {
  // Threshold source: rule.threshold in Config/phase9_rules.json (SPR-01: 0.2).
  // Falls back to rule.thresholds.sell_ratio, then 0.5. Documented, not hidden.
  const threshold=Number(rule?.threshold ?? rule?.thresholds?.sell_ratio ?? 0.5);
  const classification=phase4ClassificationMap(phase4);
  const tokenMint=mint || phase8?.mint || null;
  let evaluated=0, excluded=0, maxRatio=0;
  const qualifying=[];
  for(const w of (phase8?.wallets||[])) {
    if(!w?.history?.complete) continue;
    if(classification.get(w.wallet)==='LIQUIDITY_POOL') continue;
    const walk=walkWalletLedger(w);
    if(!walk.ok){ excluded++; continue; }
    evaluated++;
    for(const s of walk.sells) {
      if(s.before<=0n) continue;
      // Fraction (not percent): amount/before. Threshold 0.2 = 20%.
      const ratio=Number(s.amount*1000000n/s.before)/1000000;
      if(ratio>maxRatio) maxRatio=ratio;
      if(ratio>=threshold) {
        const r=evRef({wallet:w.wallet,event:s.event});
        qualifying.push({...r,sell_ratio:Math.round(ratio*10000)/10000,
          balance_before_sell_raw:s.before.toString(),
          sell_amount_raw:s.amount.toString()});
      }
    }
  }
  const metric={threshold_sell_ratio:threshold,evaluated_wallets:evaluated,
    excluded_wallets_unreconciled_or_incomplete:excluded,
    qualifying_sell_events:qualifying.length,
    max_observed_sell_ratio:Math.round(maxRatio*10000)/10000,
    counting_unit:'unique_sell_event_with_reconstructed_prior_balance'};
  const cov=historyCoverage(phase8);
  const category=cat||'SELL_PRESSURE_RISK';
  if(qualifying.length)
    return result('SPR-01',category,rule,'TRIGGERED',
      `Found ${qualifying.length} unique SELL event(s) disposing >=${threshold*100}% of the wallet's reconstructed pre-sell balance (threshold ${threshold}).`,
      metric,qualifying.slice(0,100),{data_quality:{ledger_reconciled:true,unique_events:true,liquidity_pool_excluded:true}});
  if(evaluated>0)
    return result('SPR-01',category,rule,'NOT_TRIGGERED',
      `Evaluated ${evaluated} wallet(s) with reconciled ledgers; no SELL reached ${threshold*100}% of pre-sell balance (max observed ${(maxRatio*100).toFixed(2)}%).`,
      metric,[],{data_quality:{ledger_reconciled:true}});
  return result('SPR-01',category,rule,'INSUFFICIENT_DATA',
    `No wallet had a complete, reconcilable event ledger to evaluate. ${cov.reason}`,metric,[],{});
}

/* ------------------------------------------------------------------
 * SPR-04 — Holder Balance Reduction Attributable to Sells
 * EVIDENCE CONTRACT :
 *  - Same ledger discipline as SPR-01 (complete + reconciled + LP excluded).
 *  - Metric: total_sell_volume / peak_reconstructed_balance per wallet.
 *    "period_start_balance" is proxied by the peak balance observed in the
 *    wallet's reconstructed ledger — documented here because the observation
 *    window starts at the wallet's first observed event.
 *  - Answers: "of everything this wallet ever held in the observed window,
 *    what fraction exited through SELLs (realized exit) as opposed to
 *    TRANSFER_OUTs (reorganization)?"
 *  - Threshold: rule.threshold (SPR-04: 0.2). Counting unit: wallet.
 *  - Evidence refs are the underlying SELL events (with signatures), each
 *    annotated with the wallet-level ratio. This preserves evidence lineage
 *    (rule -> event_id -> signature) and lets Phase 10's identity dedup
 *    discount overlap with SPR-01's per-event evidence instead of
 *    double-counting the same sells.
 * ------------------------------------------------------------------ */
function evaluateSpr04({phase8,phase4,rule,cat}) {
  const threshold=Number(rule?.threshold ?? 0.2);
  const classification=phase4ClassificationMap(phase4);
  let evaluated=0, excluded=0, maxRatio=0;
  const qualifyingWallets=[];
  const evidenceRefs=[];
  for(const w of (phase8?.wallets||[])) {
    if(!w?.history?.complete) continue;
    if(classification.get(w.wallet)==='LIQUIDITY_POOL') continue;
    const walk=walkWalletLedger(w);
    if(!walk.ok||walk.peak<=0n){ excluded++; continue; }
    evaluated++;
    const ratio=Number(walk.sellVolume*1000000n/walk.peak)/1000000;
    if(ratio>maxRatio) maxRatio=ratio;
    if(ratio>=threshold){
      const walletRatio=Math.round(ratio*10000)/10000;
      qualifyingWallets.push({wallet:w.wallet,sell_attributed_ratio:walletRatio,
        total_sell_volume_raw:walk.sellVolume.toString(),
        total_transfer_out_volume_raw:walk.transferOutVolume.toString(),
        peak_balance_raw:walk.peak.toString(),
        current_balance_raw:walk.current.toString(),
        sell_events:walk.sells.length});
      // Evidence lineage: the claim is wallet-level, but the evidence is the
      // underlying SELL events (signatures). This lets Phase 10's identity
      // dedup correctly discount overlap with SPR-01's per-event evidence
      // instead of double-counting the same sells.
      for(const s of walk.sells){
        const r=evRef({wallet:w.wallet,event:s.event});
        evidenceRefs.push({...r,sell_attributed_ratio:walletRatio,
          wallet_peak_balance_raw:walk.peak.toString(),
          attribution:'SPR-04_WALLET_AGGREGATE'});
      }
    }
  }
  const metric={threshold_sell_attributed_ratio:threshold,evaluated_wallets:evaluated,
    excluded_wallets_unreconciled_or_incomplete:excluded,
    qualifying_wallets:qualifyingWallets.length,
    qualifying_wallets_detail:qualifyingWallets.slice(0,50),
    max_observed_ratio:Math.round(maxRatio*10000)/10000,
    counting_unit:'wallet_with_reconstructed_ledger',
    metric_definition:'total_sell_volume / peak_reconstructed_balance',
    evidence_unit:'underlying_sell_events_with_wallet_ratio_annotation'};
  const cov=historyCoverage(phase8);
  const category=cat||'SELL_PRESSURE_RISK';
  if(qualifyingWallets.length)
    return result('SPR-04',category,rule,'TRIGGERED',
      `Found ${qualifyingWallets.length} wallet(s) whose SELL-attributed outflow reached >=${threshold*100}% of peak reconstructed balance (threshold ${threshold}).`,
      metric,evidenceRefs.slice(0,100),{data_quality:{ledger_reconciled:true,liquidity_pool_excluded:true}});
  if(evaluated>0)
    return result('SPR-04',category,rule,'NOT_TRIGGERED',
      `Evaluated ${evaluated} wallet(s); no wallet's SELL-attributed outflow reached ${threshold*100}% of peak balance (max ${(maxRatio*100).toFixed(2)}%).`,
      metric,[],{data_quality:{ledger_reconciled:true}});
  return result('SPR-04',category,rule,'INSUFFICIENT_DATA',
    `No wallet had a complete, reconcilable event ledger to evaluate. ${cov.reason}`,metric,[],{});
}

/* Scan-time pool liquidity snapshot lookup .
 * Returns {pool, base_raw} for the significant pool with the largest FOUND
 * base-token balance, or null when no usable snapshot exists. */
function primaryPoolLiquidity(phase4){
  let best=null;
  for(const p of (phase4?.liquidity_mapping?.significant_pools||[])){
    const b=p?.liquidity_snapshot?.base;
    if(b?.status!=='FOUND') continue;
    const raw=rawBigOrNull(b.amount_raw);
    if(raw===null) continue;
    if(!best||raw>best.base_raw) best={pool:p.pool,program:p.program_name||p.dex||null,base_raw:raw,
      quote_raw:rawBigOrNull(p?.liquidity_snapshot?.quote?.amount_raw),
      snapshot_utc:p?.liquidity_snapshot?.snapshot_utc||null};
  }
  return best;
}

/* ------------------------------------------------------------------
 * SPR-05 — Sell Volume Relative to Liquidity
 * LTR-01 — Sell Volume to Liquidity Ratio (windowed)
 * EVIDENCE CONTRACT :
 *  - Required: verified SELL events (observed, bounded sample) + a pool
 *    liquidity snapshot from Phase 4 (scan-time point-in-time, documented as
 *    a liquidity PROXY — not a historical series).
 *  - SPR-05: total observed SELL volume / pool base-token balance.
 *  - LTR-01: max SELL volume inside any rolling window_seconds window /
 *    pool base-token balance (burst-vs-depth).
 *  - Thresholds from rule config (both 0.05). Units: base-token raw units on
 *    both sides — no cross-unit valuation is performed or implied.
 *  - No usable snapshot -> INSUFFICIENT_DATA (never assumed).
 * ------------------------------------------------------------------ */
function evaluateSellVsLiquidity(id,{phase8,phase4,rule,cat,guards}) {
  const threshold=Number(rule?.threshold ?? 0.05);
  const win=id==='LTR-01'?Number(rule?.window_seconds||3600):null;
  const pool=primaryPoolLiquidity(phase4);
  const cov=historyCoverage(phase8);
  const category=cat||(id.startsWith('LTR')?'LIQUIDITY_RELATED_TRADING_RISK':'SELL_PRESSURE_RISK');
  if(!pool||pool.base_raw<=0n)
    return result(id,category,rule,'INSUFFICIENT_DATA',
      'No usable pool liquidity snapshot (Phase 4 liquidity_snapshot.base FOUND) for sell-volume comparison.',{threshold,pool_liquidity_status:'unavailable',counting_unit:win?'rolling_window_sell_volume':'total_observed_sell_volume'},[],{});
  const sells=[];
  for(const w of (phase8?.wallets||[]))
    for(const e of (w.history?.events||[])){
      if(e.event_class!=='SELL') continue;
      const amt=rawBigOrNull(e.amount_raw), ts=tsOf(e);
      if(amt===null||ts==null) continue;
      sells.push({ts,amt,event:e,wallet:w.wallet});
    }
  // Deduplicate by event_id (counting unit).
  const seen=new Set(), uniq=[];
  for(const s of sells){ const k=String(s.event.event_id||`${s.event.signature}:SELL`); if(seen.has(k))continue; seen.add(k); uniq.push(s); }
  let volume=0n, windowDetail=null;
  if(win){
    const sorted=uniq.slice().sort((a,b)=>a.ts-b.ts);
    let best=0n, bestStart=null;
    for(let i=0;i<sorted.length;i++){
      let sum=0n;
      for(let j=i;j<sorted.length&&sorted[j].ts-sorted[i].ts<=win;j++) sum+=sorted[j].amt;
      if(sum>best){ best=sum; bestStart=sorted[i].ts; }
    }
    volume=best;
    windowDetail={window_seconds:win,window_start_ts:bestStart};
  }else{
    volume=uniq.reduce((s,x)=>s+x.amt,0n);
  }
  const ratio=Number(volume*1000000n/pool.base_raw)/1000000;
  const metric={threshold,pool:pool.pool,pool_program:pool.program,
    pool_base_liquidity_raw:pool.base_raw.toString(),
    pool_liquidity_snapshot_utc:pool.snapshot_utc,
    observed_sell_volume_raw:volume.toString(),
    unique_sell_events:uniq.length,
    sell_to_liquidity_ratio:Math.round(ratio*10000)/10000,
    ...(windowDetail||{}),
    counting_unit:win?'max_sell_volume_in_rolling_window':'total_unique_observed_sell_volume',
    scope:'bounded_phase8_sample_vs_scan_time_snapshot'};
  // B1: guard kredibilitas likuiditas .
  const cred=liquidityCredibility(pool.base_raw,volume,guards);
  metric.liquidity_credibility=cred;
  const refs=uniq.slice(0,100).map(s=>evRef({wallet:s.wallet,event:s.event}));
  if(volume>0n&&cred.credible===false)
    return result(id,category,rule,'INSUFFICIENT_DATA',
      `Pool base liquidity hanya ${(cred.pool_share_of_volume*100).toFixed(4)}% dari volume SELL teramati — di bawah ambang kredibilitas ${(cred.threshold*100)}%. Pool tidak dapat mewakili likuiditas (mis. token CEX-listed atau pool kering); rasio mentah ${(ratio*100).toFixed(2)}% dipublikasikan sebagai diagnostik, tidak dievaluasi.`,
      metric,[],{});
  if(ratio>=threshold)
    return result(id,category,rule,'TRIGGERED',
      `Observed SELL volume reached ${(ratio*100).toFixed(2)}% of pool base-token liquidity (threshold ${threshold*100}%).`,
      metric,refs,{data_quality:{unique_events:true,units:'base_token_raw_both_sides'}});
  if(uniq.length>0)
    return result(id,category,rule,'NOT_TRIGGERED',
      `Observed SELL volume was ${(ratio*100).toFixed(2)}% of pool base-token liquidity (threshold ${threshold*100}%).`,
      metric,[],{data_quality:{unique_events:true}});
  return result(id,category,rule,'INSUFFICIENT_DATA',
    `No verifiable SELL events observed to compare against pool liquidity. ${cov.reason}`,metric,[],{});
}

/* ------------------------------------------------------------------
 * TCR-01 / TCR-02 — Top Seller / Buyer Volume Share (diagnostic only)
 * EVIDENCE CONTRACT :
 *  - The rule requires COMPLETE or REPRESENTATIVE market-wide volume.
 *    Phase 8 observes a bounded, top-holder-biased sample — neither complete
 *    nor provably representative. Triggering on it would be misleading.
 *  - Therefore this evaluator publishes the computed diagnostic metric
 *    (top share of OBSERVED volume, clearly labeled as bounded-sample) and
 *    keeps status INSUFFICIENT_DATA with an explicit reason. No fabricated
 *    trigger. A future calibrated threshold + coverage gate can promote this
 *    to a real evaluator without changing the metric.
 * ------------------------------------------------------------------ */
function tcrDiagnostics(id,{phase8,rule,cat}) {
  const cls=id==='TCR-01'?'SELL':'BUY';
  const perWallet=new Map();
  for(const w of (phase8?.wallets||[])) {
    let sum=0n, n=0;
    for(const e of (w.history?.events||[])) {
      if(e.event_class!==cls) continue;
      const amt=rawBigOrNull(e.amount_raw);
      if(amt===null) continue;
      sum+=amt; n++;
    }
    if(n>0) perWallet.set(w.wallet,{volume:sum,events:n});
  }
  const entries=[...perWallet.entries()].sort((a,b)=>a[1].volume<b[1].volume?1:-1);
  const total=entries.reduce((s,[,v])=>s+v.volume,0n);
  const top=entries[0];
  const share=total>0n&&top?Number(top[1].volume*1000000n/total)/10000:null;
  const metric={event_class:cls,wallets_with_volume:entries.length,
    observed_total_volume_raw:total.toString(),
    top_wallet:top?top[0]:null,top_wallet_volume_raw:top?top[1].volume.toString():null,
    top_share_of_observed_volume_pct:share,
    scope:'bounded_phase8_sample_not_market_total',
    threshold_status:'unaudited_no_trigger_evaluated'};
  const cov=historyCoverage(phase8);
  return result(id,cat||'TRADING_CONCENTRATION_RISK',rule,'INSUFFICIENT_DATA',
    `Diagnostic computed (top ${cls} share of observed volume: ${share==null?'n/a':share+'%'}), but observed volume is a bounded top-holder sample — not complete or representative market volume, and no audited threshold exists. ${cov.reason}`,
    metric,[],{});
}

/* Read liquidity_history.jsonl (one JSON object per line, appended by Phase 4).
 * Returns [] when the file is absent — never throws. */
function readLiquidityHistory(outDir){
  try{
    const f=path.join(outDir,'liquidity_history.jsonl');
    if(!fs.existsSync(f)) return [];
    return fs.readFileSync(f,'utf8').split('\n').filter(x=>x.trim())
      .map(x=>{ try{return JSON.parse(x);}catch{return null;} }).filter(Boolean);
  }catch{ return []; }
}

/* ------------------------------------------------------------------
 * LTR-02 — Liquidity Decline
 * EVIDENCE CONTRACT :
 *  - Required: >=2 comparable pool liquidity snapshots for the SAME pool
 *    from liquidity_history.jsonl (appended by Phase 4 on every scan).
 *  - Metric: (old_base - new_base) / old_base per pool, using the two most
 *    recent entries. Evaluated per pool; the maximum decline is reported.
 *  - Threshold: rule.threshold (LTR-02: 0.2). The actual inter-scan interval
 *    is whatever the scan spacing was — reported, not assumed to equal
 *    window_seconds.
 *  - <2 comparable snapshots -> INSUFFICIENT_DATA (never interpolated).
 * ------------------------------------------------------------------ */
function evaluateLtr02({liquidityHistory,rule,cat}){
  const threshold=Number(rule?.threshold ?? 0.2);
  const category=cat||'LIQUIDITY_RELATED_TRADING_RISK';
  const hist=(liquidityHistory||[]).filter(e=>e?.snapshot_utc&&Array.isArray(e.pools));
  const declines=[];
  if(hist.length>=2){
    const prev=hist[hist.length-2], last=hist[hist.length-1];
    const prevMap=new Map((prev.pools||[]).filter(p=>p?.base?.amount_raw!=null).map(p=>[p.pool,p]));
    for(const p of (last.pools||[])){
      const q=prevMap.get(p.pool);
      const oldR=rawBigOrNull(q?.base?.amount_raw), newR=rawBigOrNull(p?.base?.amount_raw);
      if(oldR===null||newR===null||oldR<=0n) continue;
      const decline=Number((oldR-newR)*1000000n/oldR)/1000000;
      declines.push({pool:p.pool,program:p.program||null,
        old_base_raw:oldR.toString(),new_base_raw:newR.toString(),
        decline_ratio:Math.round(decline*10000)/10000,
        interval_start_utc:prev.snapshot_utc,interval_end_utc:last.snapshot_utc});
    }
  }
  declines.sort((a,b)=>b.decline_ratio-a.decline_ratio);
  const best=declines[0]||null;
  const metric={threshold_decline_ratio:threshold,snapshots_available:hist.length,
    comparable_pools:declines.length,
    max_decline:best,
    counting_unit:'pool_with_two_comparable_snapshots',
    note:'Inter-scan interval is whatever the actual scan spacing was.'};
  if(best&&best.decline_ratio>=threshold)
    return result('LTR-02',category,rule,'TRIGGERED',
      `Pool base liquidity declined ${(best.decline_ratio*100).toFixed(2)}% between scans (threshold ${threshold*100}%).`,
      metric,[{pool:best.pool,program:best.program,...best}],{data_quality:{comparable_snapshots:true}});
  if(declines.length)
    return result('LTR-02',category,rule,'NOT_TRIGGERED',
      `Max observed pool liquidity decline was ${((best?.decline_ratio||0)*100).toFixed(2)}% (threshold ${threshold*100}%).`,
      metric,[],{data_quality:{comparable_snapshots:true}});
  return result('LTR-02',category,rule,'INSUFFICIENT_DATA',
    'Fewer than two comparable pool liquidity snapshots available (need >=2 scans with liquidity_history.jsonl).',metric,[],{});
}

/* ------------------------------------------------------------------
 * LTR-03 — Sell Pressure with Liquidity Decline (composite)
 * EVIDENCE CONTRACT: TRIGGERED iff BOTH hold —
 *   (A) sell/liquidity >= 0.05  (SPR-05 logic, total observed sell volume), and
 *   (B) pool liquidity decline >= 0.2 (LTR-02 logic).
 * No independent threshold; both sub-conditions are reported.
 * ------------------------------------------------------------------ */
function evaluateLtr03(ctx){
  const {rule,cat}=ctx;
  const category=cat||'LIQUIDITY_RELATED_TRADING_RISK';
  const spr05=evaluateSellVsLiquidity('SPR-05',{...ctx,rule:{...(ctx.rules?.categories?.SELL_PRESSURE_RISK?.rules?.['SPR-05']||{}),threshold:0.05}});
  const ltr02=evaluateLtr02(ctx);
  const aTrig=spr05.status==='TRIGGERED', bTrig=ltr02.status==='TRIGGERED';
  const metric={condition_a_sell_vs_liquidity:{status:spr05.status,ratio:spr05.metric?.sell_to_liquidity_ratio??null,threshold:0.05},
    condition_b_liquidity_decline:{status:ltr02.status,max_decline:ltr02.metric?.max_decline?.decline_ratio??null,threshold:Number(rule?.threshold??ltr02.metric?.threshold_decline_ratio??0.2)},
    counting_unit:'composite_of_A_and_B'};
  if(aTrig&&bTrig)
    return result('LTR-03',category,rule,'TRIGGERED',
      'Both conditions hold: sell pressure >=5% of pool liquidity AND pool liquidity decline >=20% between scans.',
      metric,[...(spr05.evidence_refs||[]).slice(0,50),...(ltr02.evidence_refs||[]).slice(0,50)],{data_quality:{composite:true}});
  if(spr05.status==='INSUFFICIENT_DATA'||ltr02.status==='INSUFFICIENT_DATA')
    return result('LTR-03',category,rule,'INSUFFICIENT_DATA',
      `Composite cannot be evaluated: A=${spr05.status}, B=${ltr02.status}.`,metric,[],{});
  return result('LTR-03',category,rule,'NOT_TRIGGERED',
    `Composite not met: A=${spr05.status} (sell/liquidity), B=${ltr02.status} (decline).`,metric,[],{});
}

/* ------------------------------------------------------------------
 * CTR-01 — Multi-Wallet Trading Activity (shared funder)
 * EVIDENCE CONTRACT :
 *  - Required: funding-graph.json (Phase 8B) with shared_funders, plus
 *    observed BUY/SELL activity per wallet from Phase 8.
 *  - A shared funder linking >= min_wallets (default 2) ACTIVE wallets
 *    (wallets with observed BUY or SELL) is an investigative lead for
 *    coordinated activity — NOT proof of common ownership (CEX hot wallets
 *    also fund many unrelated wallets; documented in the funding collector).
 *  - Counting unit: shared funder. No funding graph -> INSUFFICIENT_DATA.
 * ------------------------------------------------------------------ */
function evaluateCtr01({phase8,fundingGraph,rule,cat}){
  const minWallets=Math.max(2,Number(rule?.thresholds?.min_wallets ?? 2));
  const category=cat||'COORDINATED_TRADING_RISK';
  if(!fundingGraph)
    return result('CTR-01',category,rule,'INSUFFICIENT_DATA',
      'No funding-graph.json (run Script/collect_funding_graph.js first).',{min_wallets:minWallets,funding_graph:'absent'},[],{});
  const active=new Set((phase8?.wallets||[])
    .filter(w=>((w.history?.counts_observed?.BUY)||0)+((w.history?.counts_observed?.SELL)||0)>0)
    .map(w=>w.wallet));
  const qualifying=(fundingGraph.shared_funders||[])
    .map(s=>({...s,active_wallets:(s.wallets||[]).filter(w=>active.has(w))}))
    .filter(s=>s.active_wallets.length>=minWallets);
  const metric={min_wallets:minWallets,shared_funders_total:(fundingGraph.shared_funders||[]).length,
    qualifying_shared_funders:qualifying.length,
    counting_unit:'shared_funder_linking_active_wallets',
    caveat:'Shared funder (esp. CEX/exchange wallets) does not prove common ownership.'};
  const refs=qualifying.slice(0,50).flatMap(s=>s.active_wallets.map(w=>({wallet:w,funder:s.funder,
    funder_wallet_count:s.wallet_count,event_class:'SHARED_FUNDER_LINK',
    note:'Investigative lead only; not proof of coordination.'})));
  if(qualifying.length)
    return result('CTR-01',category,rule,'TRIGGERED',
      `Found ${qualifying.length} shared funder(s) each linked to >=${minWallets} wallets with observed trading activity. Investigative lead — not proof of coordination.`,
      metric,refs,{data_quality:{heuristic_attribution:true}});
  return result('CTR-01',category,rule,'NOT_TRIGGERED',
    `Funding graph present with ${(fundingGraph.shared_funders||[]).length} shared funder(s); none links >=${minWallets} active wallets.`,
    metric,[],{});
}

/* ------------------------------------------------------------------
 * CTR-02 — Funding-to-Trading Relationship
 * EVIDENCE CONTRACT :
 *  - Required: funding-graph.json with per-wallet funders (block_time), plus
 *    first observed BUY/SELL per wallet from Phase 8.
 *  - Sequence: funder F -> wallet W at Tf, then W's first trade at Tt with
 *    0 <= Tt-Tf <= window_seconds (default 86400). Temporal association only;
 *    funding does not prove the funder controls the trade.
 *  - Counting unit: unique funding->trade sequence (funder, wallet).
 * ------------------------------------------------------------------ */
function evaluateCtr02({phase8,fundingGraph,rule,cat}){
  const win=Number(rule?.window_seconds||86400);
  const category=cat||'COORDINATED_TRADING_RISK';
  if(!fundingGraph)
    return result('CTR-02',category,rule,'INSUFFICIENT_DATA',
      'No funding-graph.json (run Script/collect_funding_graph.js first).',{window_seconds:win,funding_graph:'absent'},[],{});
  const firstTrade=new Map();
  for(const w of (phase8?.wallets||[])){
    let best=null;
    for(const e of (w.history?.events||[])){
      if(e.event_class!=='BUY'&&e.event_class!=='SELL') continue;
      const ts=tsOf(e); if(ts==null) continue;
      if(best==null||ts<best) best=ts;
    }
    if(best!=null) firstTrade.set(w.wallet,best);
  }
  const seen=new Set(), seqs=[];
  for(const [w,rec] of Object.entries(fundingGraph.wallets||{})){
    const tt=firstTrade.get(w); if(tt==null) continue;
    for(const f of (rec?.funders||[])){
      const tf=num(f.block_time); if(tf==null) continue;
      const dt=tt-tf;
      if(dt<0||dt>win) continue;
      const k=`${f.funder}|${w}`;
      if(seen.has(k)) continue; seen.add(k);
      seqs.push({wallet:w,funder:f.funder,funder_asset:f.asset||null,
        funding_signature:f.signature||null,funding_timestamp_utc:f.timestamp_utc||null,
        first_trade_ts:tt,delta_seconds:dt,event_class:'FUNDING_TO_TRADE',
        note:'Temporal association only; funding does not prove control of the trade.'});
    }
  }
  seqs.sort((a,b)=>a.delta_seconds-b.delta_seconds);
  const metric={window_seconds:win,qualifying_sequences:seqs.length,
    wallets_with_funding_data:Object.keys(fundingGraph.wallets||{}).length,
    counting_unit:'unique_funder_wallet_sequence'};
  if(seqs.length)
    return result('CTR-02',category,rule,'TRIGGERED',
      `Found ${seqs.length} funding->first-trade sequence(s) within ${win}s. Temporal association only.`,
      metric,seqs.slice(0,100),{data_quality:{heuristic_attribution:true,chronology_verified:true}});
  return result('CTR-02',category,rule,'NOT_TRIGGERED',
    `Funding graph present; no funding->first-trade sequence within ${win}s.`,metric,[],{});
}

/* ------------------------------------------------------------------
 * Phase 8C sidecar: market-volume.json (market-wide trade volume).
 * TIERED EVALUATION (tiered evaluation):
 *  - tier 'complete'  -> klaim market-wide (seperti sebelumnya).
 *  - tier 'windowed'  -> file PARTIAL tapi jendela memadai
 *    (>= MARKET_WINDOW_MIN_PARSED transaksi ter-parse): 5 rule market
 *    dievaluasi pada WINDOW TERAMATI (transaksi terbaru, newest-first),
 *    dengan scope diungkap eksplisit di metric. Ini setia pada deskripsi
 *    SPR-03 ("for the same interval"): numerator & denominator dihitung
 *    pada interval yang sama — intervalnya adalah window observasi.
 *    Tidak ada klaim market-wide; tidak ada trigger yang dipaksa —
 *    threshold config tetap yang menentukan.
 *  - tier 'none'/'unusable' -> INSUFFICIENT_DATA (data tidak cukup untuk
 *    kesimpulan yang relevan). Missing/partial data tidak dipetakan ke
 *    NOT_TRIGGERED.
 * ------------------------------------------------------------------ */
const MARKET_WINDOW_MIN_PARSED = 500; // adequacy floor, documented uncalibrated
function readMarketVolume(outDir){
  if(!outDir) return null;
  try{
    const f=path.join(outDir,'market-volume.json');
    if(!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f,'utf8'));
  }catch{ return null; }
}
function marketVolumeTier(mv){
  if(!mv) return {tier:'none',reason:'No market-volume.json found (run Script/collect_market_volume.js / menu 15 first).'};
  const comp=mv?.coverage?.completeness;
  const t=mv?.totals||{};
  if(rawBigOrNull(t.trade_volume_raw)===null||rawBigOrNull(t.buy_volume_raw)===null||rawBigOrNull(t.sell_volume_raw)===null)
    return {tier:'none',reason:'market-volume.json totals are missing or malformed.'};
  if(comp==='complete') return {tier:'complete'};
  const parsed=Number(mv?.coverage?.transactions_parsed||0);
  if(comp==='partial'&&parsed>=MARKET_WINDOW_MIN_PARSED) return {tier:'windowed',parsed};
  return {tier:'unusable',reason:`market-volume.json is '${comp||'unknown'}' with only ${parsed} parsed transactions (< ${MARKET_WINDOW_MIN_PARSED} adequacy floor); insufficient for a relevant conclusion.`};
}
function marketWindowScope(mv,tier){
  const c=mv.coverage||{}, w=mv.window||{};
  if(tier==='complete') return {scope:'market_wide_complete_sidecar',window:mv.window||null};
  return {scope:'windowed_recent_signatures',
    window_characterization:{
      tier:'windowed',
      signatures_seen:c.signatures_seen??null,
      transactions_parsed:c.transactions_parsed??null,
      transactions_failed:c.transactions_failed??null,
      first_block_time:w.first_block_time??null,
      last_block_time:w.last_block_time??null,
      recency:'getSignaturesForAddress paginates newest-first: this is the MOST RECENT window, not a random sample',
      note:'NOT market-wide. Conclusions apply to the observed window only.'}};
}

/* Connected-wallet set from Phase 5 (creator/dev analysis):
 * union of creator address, dev address, and related-wallet addresses.
 * Documented definition — "connected" here means on-graph relationship to
 * the creator/dev as observed by Phase 5, not proven coordination. */
function connectedWalletSet(phase5){
  const set=new Set();
  const add=a=>{ if(typeof a==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) set.add(a); };
  add(phase5?.ownership?.creator_address);
  add(phase5?.creator_discovery?.selected?.address);
  add(phase5?.dev_relationship?.address);
  const rw=phase5?.related_wallets?.wallets;
  if(Array.isArray(rw)) for(const w of rw) add(typeof w==='string'?w:(w?.address||w?.wallet));
  return set;
}
function connectedVolumes(phase5,marketVolume){
  // Numerator is read from the market-wide sidecar (same interval & units as
  // the denominator by construction), NOT from the bounded Phase 8 sample.
  const connected=connectedWalletSet(phase5);
  const wmap=marketVolume?.wallets||{};
  let buy=0n, sell=0n;
  const contrib=[];
  for(const w of connected){
    const b=rawBigOrNull(wmap[w]?.buy_raw), s=rawBigOrNull(wmap[w]?.sell_raw);
    if(b!==null&&b>0n) buy+=b;
    if(s!==null&&s>0n) sell+=s;
    if((b!==null&&b>0n)||(s!==null&&s>0n))
      contrib.push({wallet:w,buy_volume_raw:b===null?'0':b.toString(),sell_volume_raw:s===null?'0':s.toString()});
  }
  contrib.sort((a,b)=>{
    const ta=BigInt(a.buy_volume_raw)+BigInt(a.sell_volume_raw);
    const tb=BigInt(b.buy_volume_raw)+BigInt(b.sell_volume_raw);
    return tb<ta?-1:tb>ta?1:0;
  });
  return {connected,buy,sell,contrib};
}

/* ------------------------------------------------------------------
 * Diagnostik stabilitas window .
 * Untuk tier 'windowed', metrik rule dihitung ulang pada dua paruh window
 * (recent = separuh transaksi terbaru, older = separuhnya lagi) agar verdict
 * tidak menjadi sandera satu window: bila metrik didorong satu paruh saja,
 * spread antar-paruh akan besar dan pembaca bisa menilainya.
 * Murni DIAGNOSTIK — tidak mengubah status, threshold, atau rule yang terkunci.
 * market-volume.json lama (kolektor < v1.0.5, tanpa field halves) -> null;
 * pemanggil menampilkan alasan yang jujur, bukan angka palsu.
 * ------------------------------------------------------------------ */
function halvesBlock(mv) {
  const h = mv?.halves;
  if (!h || !h.recent || !h.older) return null;
  return h;
}
function connectedShareHalves(mv, connected, side) {
  const h = halvesBlock(mv); if (!h) return null;
  const wmap = mv.wallets || {};
  const per = {};
  for (const half of ['recent', 'older']) {
    let buy = 0n, sell = 0n;
    for (const w of connected) {
      const wh = wmap[w]?.halves?.[half];
      if (!wh) continue;
      const b = rawBigOrNull(wh.buy_raw), s = rawBigOrNull(wh.sell_raw);
      if (b !== null && b > 0n) buy += b;
      if (s !== null && s > 0n) sell += s;
    }
    const den = rawBigOrNull(h[half].trade_volume_raw);
    const num = side === 'sell' ? sell : buy + sell;
    const ratio = (den !== null && den > 0n) ? Number(num * 1000000n / den) / 1000000 : null;
    per[half] = { connected_share_ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
      connected_volume_raw: num.toString(), volume_total_raw: den === null ? null : den.toString() };
  }
  const r = per.recent.connected_share_ratio, o = per.older.connected_share_ratio;
  return { basis: 'paruh window menurut urutan transaksi (newest-first): recent = separuh terbaru',
    recent: per.recent, older: per.older,
    spread_pp: (r === null || o === null) ? null : Math.round(Math.abs(r - o) * 10000) / 100,
    note: 'Diagnostik stabilitas window; tidak mengubah status/threshold.' };
}
function topShareHalves(mv, cls) {
  const h = halvesBlock(mv); if (!h) return null;
  const wmap = mv.wallets || {};
  const key = cls === 'SELL' ? 'sell_raw' : 'buy_raw';
  const totKey = cls === 'SELL' ? 'sell_volume_raw' : 'buy_volume_raw';
  const per = {};
  for (const half of ['recent', 'older']) {
    let best = null, bestVol = -1n;
    for (const [w, e] of Object.entries(wmap)) {
      const v = rawBigOrNull(e?.halves?.[half]?.[key]);
      if (v !== null && v > bestVol) { bestVol = v; best = w; }
    }
    const den = rawBigOrNull(h[half][totKey]);
    const ratio = (den !== null && den > 0n && bestVol >= 0n) ? Number(bestVol * 1000000n / den) / 1000000 : null;
    per[half] = { top_wallet: best,
      top_share_ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
      top_volume_raw: bestVol < 0n ? null : bestVol.toString(),
      volume_total_raw: den === null ? null : den.toString() };
  }
  const r = per.recent.top_share_ratio, o = per.older.top_share_ratio;
  return { basis: 'paruh window menurut urutan transaksi (newest-first): recent = separuh terbaru',
    recent: per.recent, older: per.older,
    spread_pp: (r === null || o === null) ? null : Math.round(Math.abs(r - o) * 10000) / 100,
    note: 'Diagnostik stabilitas window; tidak mengubah status/threshold.' };
}
const WINDOW_STABILITY_UNAVAILABLE = { available: false,
  reason: 'market-volume.json dibuat oleh kolektor < v1.0.5 (tanpa field halves). Jalankan ulang menu 15 untuk mengaktifkan diagnostik ini.' };

/* ------------------------------------------------------------------
 * SPR-03 — Connected Wallet Sell Volume Share
 * CTR-04 — Connected Group Trading Volume Share
 * TCR-03 — Connected Group Trading Concentration
 * EVIDENCE CONTRACT :
 *  - Tier 'complete': numerator & denominator market-wide (klaim market-wide).
 *  - Tier 'windowed' (partial, >=500 parsed): keduanya dihitung pada WINDOW
 *    TERAMATI yang sama (transaksi terbaru). Scope 'windowed_recent_signatures'
 *    diungkap di metric — bukan klaim market-wide. Threshold config tidak
 *    berubah; tidak ada trigger yang dipaksa.
 *  - Tier 'none'/'unusable' -> INSUFFICIENT_DATA (never NOT_TRIGGERED).
 *  - Connected set kosong (Phase 5 tak ada) -> INSUFFICIENT_DATA.
 *  - Connected volume 0 dalam window -> NOT_TRIGGERED dengan catatan
 *    "no observed activity IN THE WINDOW" (bukan "tidak pernah aktif").
 * ------------------------------------------------------------------ */
function evaluateConnectedShare(id,{phase5,marketVolume,rule,cat}) {
  const spec={'SPR-03':{threshold:0.05,side:'sell',category:'SELL_PRESSURE_RISK'},
              'CTR-04':{threshold:0.1,side:'trade',category:'COORDINATED_TRADING_RISK'},
              'TCR-03':{threshold:0.5,side:'trade',category:'TRADING_CONCENTRATION_RISK'}}[id];
  const threshold=Number(rule?.threshold ?? spec.threshold);
  const category=cat||spec.category;
  const gate=marketVolumeTier(marketVolume);
  const tier=gate.tier;
  const scopeInfo=tier==='complete'||tier==='windowed'?marketWindowScope(marketVolume,tier):{scope:'none'};
  const base={threshold,tier,market_volume_file:marketVolume?'present':'absent',
    completeness:marketVolume?.coverage?.completeness||null,
    numerator_side:spec.side,
    denominator:tier==='complete'?'market_total_trade_volume_buy_plus_sell':'observed_window_total_trade_volume_buy_plus_sell',
    ...scopeInfo};
  if(tier!=='complete'&&tier!=='windowed')
    return result(id,category,rule,'INSUFFICIENT_DATA',
      `${gate.reason} ${MISSING_REASONS[id]||''}`.trim(),base,[],{});
  const {connected,buy,sell,contrib}=connectedVolumes(phase5,marketVolume);
  base.connected_wallets_identified=connected.size;
  if(!connected.size)
    return result(id,category,rule,'INSUFFICIENT_DATA',
      'No connected-wallet set identified from Phase 5 (creator/related/dev addresses absent).',base,[],{});
  const den=rawBigOrNull(marketVolume.totals.trade_volume_raw);
  if(den===null||den<=0n)
    return result(id,category,rule,'INSUFFICIENT_DATA',
      'Trade volume total is zero or malformed in market-volume.json.',base,[],{});
  const num=spec.side==='sell'?sell:buy+sell;
  const ratio=Number(num*1000000n/den)/1000000;
  const scopeNoun=tier==='complete'?'total market trade volume':'observed-window trade volume';
  const metric={...base,
    connected_volume_raw:num.toString(),
    connected_buy_raw:buy.toString(),connected_sell_raw:sell.toString(),
    volume_total_raw:den.toString(),
    connected_share_ratio:Math.round(ratio*10000)/10000,
    counting_unit:'connected_wallet_volume_div_total_trade_volume_same_scope',
    ...(num===0n?{zero_activity_note:'Connected wallets had no observed buy/sell activity IN THE WINDOW (not "never active").'}:{})};
  if (tier === 'windowed') {
    const stab = connectedShareHalves(marketVolume, connected, spec.side);
    metric.window_stability = stab || WINDOW_STABILITY_UNAVAILABLE;
  }
  const refs=contrib.slice(0,50).map(c=>({wallet:c.wallet,
    buy_volume_raw:c.buy_volume_raw,sell_volume_raw:c.sell_volume_raw,
    event_class:'CONNECTED_WALLET_MARKET_VOLUME'}));
  const dq={tier,scope:scopeInfo.scope};
  if(ratio>=threshold)
    return result(id,category,rule,'TRIGGERED',
      `Connected wallets' ${spec.side} volume was ${(ratio*100).toFixed(2)}% of ${scopeNoun} (threshold ${threshold*100}%).`,
      metric,refs,{data_quality:dq});
  return result(id,category,rule,'NOT_TRIGGERED',
    `Connected wallets' ${spec.side} volume was ${(ratio*100).toFixed(2)}% of ${scopeNoun} (threshold ${threshold*100}%).`,
    metric,[],{data_quality:dq});
}

/* ------------------------------------------------------------------
 * TCR-01 / TCR-02 — Top Seller / Buyer Volume Share
 * EVIDENCE CONTRACT :
 *  - Tier 'complete': top wallet's SELL/BUY / market-wide SELL/BUY (klaim
 *    market-wide). Tier 'windowed': metrik yang sama pada window teramati
 *    dengan scope diungkap — threshold config tidak berubah.
 *  - Tier 'none'/'unusable': tetap publikasi diagnostik bounded-sample yang
 *    jujur + INSUFFICIENT_DATA (perilaku diagnostik-only  dipertahankan
 *    sebagai fallback, bukan dihapus).
 * ------------------------------------------------------------------ */
function evaluateTcr0102(id,{phase8,marketVolume,rule,cat}) {
  const cls=id==='TCR-01'?'SELL':'BUY';
  const threshold=Number(rule?.threshold ?? 0.3);
  const category=cat||'TRADING_CONCENTRATION_RISK';
  const gate=marketVolumeTier(marketVolume);
  const tier=gate.tier;
  if(tier!=='complete'&&tier!=='windowed'){
    const d=tcrDiagnostics(id,{phase8,rule,cat});
    d.metric.market_volume_gate=gate.reason;
    d.metric.evaluator_note='Real evaluation needs a COMPLETE market-volume.json, or a PARTIAL one with >=500 parsed transactions (windowed scope); bounded-sample diagnostic published instead.';
    return d;
  }
  const totals=marketVolume.totals||{};
  const den=rawBigOrNull(cls==='SELL'?totals.sell_volume_raw:totals.buy_volume_raw);
  // CEX exclusion: wallet CEX dikecualikan dari ranking top.
  // Kolektor baru sudah memfilter; ini pertahanan untuk market-volume.json lama.
  const topRaw=(cls==='SELL'?marketVolume.top_sellers:marketVolume.top_buyers)||[];
  const {clean:top,excluded:cexExcluded}=withoutCexWallets(loadCexIndex(ROOT),topRaw,e=>e.wallet);
  const t0=top[0];
  const num=t0?rawBigOrNull(t0[cls==='SELL'?'sell_volume_raw':'buy_volume_raw']):null;
  const scopeInfo=marketWindowScope(marketVolume,tier);
  const scopeNoun=tier==='complete'?'market-wide':'observed-window';
  const base={threshold,tier,event_class:cls,
    counting_unit:`top_wallet_volume_div_${scopeNoun}_${cls.toLowerCase()}_volume`,
    ...scopeInfo};
  if(den===null||den<=0n||num===null)
    return result(id,category,rule,'INSUFFICIENT_DATA',
      `${cls} totals or top-wallet entry missing/malformed in market-volume.json.`,base,[],{});
  const share=Number(num*1000000n/den)/1000000;
  const metric={...base,
    top_wallet:t0.wallet,top_wallet_volume_raw:num.toString(),
    volume_total_raw:den.toString(),
    top_share_ratio:Math.round(share*10000)/10000,
    cex_wallets_excluded_from_ranking:cexExcluded.map(x=>({wallet:x.address,cex_label:x.cex_label}))};
  if (tier === 'windowed') {
    const stab = topShareHalves(marketVolume, cls);
    metric.window_stability = stab || WINDOW_STABILITY_UNAVAILABLE;
  }
  const refs=[{wallet:t0.wallet,event_class:`TOP_${cls}_VOLUME`,
    volume_raw:num.toString(),volume_total_raw:den.toString()}];
  const dq={tier,scope:scopeInfo.scope};
  if(share>=threshold)
    return result(id,category,rule,'TRIGGERED',
      `Top ${cls} wallet holds ${(share*100).toFixed(2)}% of ${scopeNoun} ${cls} volume (threshold ${threshold*100}%).`,
      metric,refs,{data_quality:dq});
  return result(id,category,rule,'NOT_TRIGGERED',
    `Top ${cls} wallet holds ${(share*100).toFixed(2)}% of ${scopeNoun} ${cls} volume (threshold ${threshold*100}%).`,
    metric,[],{data_quality:dq});
}

/* ------------------------------------------------------------------
 * TCR-04 — Trading Concentration Increase
 * EVIDENCE CONTRACT :
 *  - Required: observed BUY/SELL events with verifiable amount_raw and
 *    timestamps, from Phase 8 alone (no market-wide data needed).
 *  - Method: split the observed event time range into two halves (H1/H2).
 *    Comparable wallets = complete histories whose first observed event is
 *    within the first 10% of the range (observable for ~the whole window —
 *    this is the "matching coverage" requirement).
 *  - Metric: Herfindahl-Hirschman Index (HHI, 0-100 scale) of per-wallet
 *    BUY+SELL volume in H1 vs H2, over the SAME wallet set.
 *    delta_pp = HHI_H2 - HHI_H1 (percentage points).
 *  - Threshold: rule.threshold_pp (config: 15 pp; fallback 10). Documented
 *    uncalibrated — same standing as other rule thresholds pending
 *    historical calibration.
 *  - <3 comparable wallets or an empty half -> INSUFFICIENT_DATA.
 *  - Small-sample guard: each half needs >= MIN_EVENTS_PER_HALF (10)
 *    unique events. HHI on a near-empty half is mechanically extreme and
 *    would fire on noise; the guard keeps the trigger meaningful.
 * ------------------------------------------------------------------ */
const TCR04_MIN_EVENTS_PER_HALF = 10;
function hhi0100(vols){
  const total=vols.reduce((s,v)=>s+v,0n);
  if(total<=0n) return null;
  let sum=0;
  for(const v of vols){ const pct=Number(v*1000000n/total)/10000; sum+=pct*pct; }
  return sum/100;
}
function evaluateTcr04({phase8,rule,cat}){
  const thresholdPp=Number(rule?.threshold_pp ?? 10);
  const category=cat||'TRADING_CONCENTRATION_RISK';
  const seen=new Set(), evs=[];
  const firstTs=new Map();
  for(const w of (phase8?.wallets||[])){
    for(const e of (w.history?.events||[])){
      const ts=tsOf(e);
      if(ts!=null){ const f=firstTs.get(w.wallet); if(f==null||ts<f) firstTs.set(w.wallet,ts); }
      if(e.event_class!=='BUY'&&e.event_class!=='SELL') continue;
      const amt=rawBigOrNull(e.amount_raw);
      if(amt===null||amt<=0n||ts==null) continue;
      const k=String(e.event_id||`${e.signature}:${e.event_class}`);
      if(seen.has(k)) continue; seen.add(k);
      evs.push({wallet:w.wallet,amt,ts,complete:w?.history?.complete===true});
    }
  }
  const base={threshold_pp:thresholdPp,counting_unit:'hhi_delta_percentage_points_same_wallet_set',
    metric_definition:'HHI(H2)-HHI(H1) over per-wallet BUY+SELL volume, 0-100 scale'};
  if(evs.length<2)
    return result('TCR-04',category,rule,'INSUFFICIENT_DATA',
      'Fewer than 2 verifiable BUY/SELL events observed; cannot form two comparable windows.',{...base,unique_events:evs.length},[],{});
  const minTs=Math.min(...evs.map(e=>e.ts)), maxTs=Math.max(...evs.map(e=>e.ts));
  const range=maxTs-minTs;
  if(range<=0)
    return result('TCR-04',category,rule,'INSUFFICIENT_DATA',
      'All observed events share one timestamp; no two windows can be formed.',{...base},[],{});
  const mid=(minTs+maxTs)/2;
  const cutoff=minTs+0.1*range;
  const compWallets=[...new Set(evs.filter(e=>e.complete&&(firstTs.get(e.wallet)??Infinity)<=cutoff).map(e=>e.wallet))];
  const inH1=new Map(), inH2=new Map();
  for(const w of compWallets){ inH1.set(w,0n); inH2.set(w,0n); }
  let nH1=0,nH2=0;
  for(const e of evs){
    if(!inH1.has(e.wallet)) continue;
    if(e.ts<=mid){ inH1.set(e.wallet,inH1.get(e.wallet)+e.amt); nH1++; }
    else { inH2.set(e.wallet,inH2.get(e.wallet)+e.amt); nH2++; }
  }
  base.comparable_wallets=compWallets.length;
  base.window={h1_start_ts:minTs,h1_end_ts:Math.floor(mid),h2_start_ts:Math.floor(mid)+1,h2_end_ts:maxTs,
    events_h1:nH1,events_h2:nH2};
  if(compWallets.length<3||nH1<TCR04_MIN_EVENTS_PER_HALF||nH2<TCR04_MIN_EVENTS_PER_HALF)
    return result('TCR-04',category,rule,'INSUFFICIENT_DATA',
      `Need >=3 comparable wallets (complete history, observable from window start) with >=${TCR04_MIN_EVENTS_PER_HALF} events in each half; have ${compWallets.length} wallets, H1=${nH1} events, H2=${nH2} events.`,base,[],{});
  const h1=hhi0100([...inH1.values()]), h2=hhi0100([...inH2.values()]);
  const dpp=(h2??0)-(h1??0);
  const metric={...base,
    hhi_h1:h1==null?null:Math.round(h1*100)/100,
    hhi_h2:h2==null?null:Math.round(h2*100)/100,
    delta_pp:Math.round(dpp*100)/100,
    coverage_note:'Same wallet set in both halves; wallets with complete histories observable from window start.'};
  const refs=compWallets.slice(0,50).map(w=>({wallet:w,
    h1_volume_raw:inH1.get(w).toString(),h2_volume_raw:inH2.get(w).toString(),
    event_class:'CONCENTRATION_WINDOW_VOLUME'}));
  if(dpp>=thresholdPp)
    return result('TCR-04',category,rule,'TRIGGERED',
      `Trading concentration (HHI) rose ${dpp.toFixed(2)} pp between halves (H1=${h1?.toFixed(2)}, H2=${h2?.toFixed(2)}; threshold ${thresholdPp} pp).`,
      metric,refs,{data_quality:{matched_coverage:true,same_wallet_set:true}});
  return result('TCR-04',category,rule,'NOT_TRIGGERED',
    `Trading concentration (HHI) changed ${dpp.toFixed(2)} pp between halves (threshold ${thresholdPp} pp).`,
    metric,[],{data_quality:{matched_coverage:true}});
}

/* ------------------------------------------------------------------
 * LTR-04 — Estimated Price Impact
 * EVIDENCE CONTRACT :
 *  - Required: a Phase 4 pool liquidity snapshot (base reserve) for a pool
 *    whose protocol has a VALIDATED price-impact model. Today that is the
 *    constant-product (x*y=k) model, applied ONLY to PumpSwap/Raydium
 *    constant-product pools. Any other protocol -> INSUFFICIENT_DATA
 *    ("No protocol-specific pool state and validated price-impact model
 *    inputs") — the model is not stretched beyond its validated domain.
 *  - Stress size: total unique observed SELL volume (base raw), LP-excluded.
 *  - Model: impact = v / (R + v), the theoretical price move from selling v
 *    into reserves R under x*y=k. This is a MODEL ESTIMATE, not an observed
 *    impact — it excludes fees, routing, concentrated liquidity, and
 *    multi-hop execution. Labeled as such in metric.model.
 *  - Threshold: rule.threshold (LTR-04: 0.05).
 * ------------------------------------------------------------------ */
function evaluateLtr04({phase8,phase4,rule,cat,guards}){
  const threshold=Number(rule?.threshold ?? 0.05);
  const category=cat||'LIQUIDITY_RELATED_TRADING_RISK';
  const pool=primaryPoolLiquidity(phase4);
  const base={threshold,counting_unit:'modeled_price_impact_ratio',
    model:'constant_product_x_times_y_eq_k',model_scope:'theoretical_estimate_not_observed'};
  if(!pool||pool.base_raw<=0n)
    return result('LTR-04',category,rule,'INSUFFICIENT_DATA',
      'No usable pool liquidity snapshot (Phase 4 liquidity_snapshot.base FOUND) for price-impact modeling.',{...base,pool_liquidity_status:'unavailable'},[],{});
  const prog=String(pool.program||'');
  if(!/pumpswap|raydium/i.test(prog))
    return result('LTR-04',category,rule,'INSUFFICIENT_DATA',
      `No validated price-impact model for pool protocol '${prog||'unknown'}'; constant-product model is validated for PumpSwap/Raydium only.`,
      {...base,pool:pool.pool,pool_program:prog||null},[],{});
  const classification=phase4ClassificationMap(phase4);
  const seen=new Set(); let v=0n;
  const refEvents=[];
  for(const w of (phase8?.wallets||[])){
    if(classification.get(w.wallet)==='LIQUIDITY_POOL') continue;
    for(const e of (w.history?.events||[])){
      if(e.event_class!=='SELL') continue;
      const amt=rawBigOrNull(e.amount_raw);
      if(amt===null||amt<=0n) continue;
      const k=String(e.event_id||`${e.signature}:SELL`);
      if(seen.has(k)) continue; seen.add(k);
      v+=amt;
      if(refEvents.length<100) refEvents.push({wallet:w.wallet,event:e});
    }
  }
  if(v<=0n)
    return result('LTR-04',category,rule,'INSUFFICIENT_DATA',
      'No verifiable SELL events observed to stress against pool reserves.',{...base,pool:pool.pool},[],{});
  const R=pool.base_raw;
  // B1: guard kredibilitas likuiditas  — model
  // constant-product tidak bermakna bila reserve jauh lebih kecil dari
  // volume stress (pool kering / likuiditas riil di luar pool ini).
  const cred=liquidityCredibility(R,v,guards);
  const impact=Number(v*1000000n/(R+v))/1000000;
  const metric={...base,
    pool:pool.pool,pool_program:prog,
    pool_base_reserve_raw:R.toString(),
    pool_liquidity_snapshot_utc:pool.snapshot_utc,
    stress_sell_volume_raw:v.toString(),
    modeled_price_impact_ratio:Math.round(impact*10000)/10000,
    modeled_price_impact_formula:'v/(R+v)',
    liquidity_credibility:cred,
    model_caveats:['Theoretical constant-product estimate; excludes fees and routing.',
      'Stress size is total observed (bounded-sample) SELL volume, not a single block.',
      'Concentrated-liquidity and multi-hop effects are not modeled.']};
  const refs=refEvents.map(r=>evRef(r));
  if(cred.credible===false)
    return result('LTR-04',category,rule,'INSUFFICIENT_DATA',
      `Pool reserve hanya ${(cred.pool_share_of_volume*100).toFixed(4)}% dari volume stress — di bawah ambang kredibilitas ${(cred.threshold*100)}%. Model price-impact tidak valid untuk reserve sekecil ini; impact mentah ${(impact*100).toFixed(2)}% dipublikasikan sebagai diagnostik.`,
      metric,[],{});
  if(impact>=threshold)
    return result('LTR-04',category,rule,'TRIGGERED',
      `Modeled price impact of observed SELL volume is ${(impact*100).toFixed(2)}% under constant-product (threshold ${threshold*100}%). Theoretical estimate — not observed impact.`,
      metric,refs,{data_quality:{unique_events:true,model_validated_for_protocol:true}});
  return result('LTR-04',category,rule,'NOT_TRIGGERED',
    `Modeled price impact of observed SELL volume is ${(impact*100).toFixed(2)}% under constant-product (threshold ${threshold*100}%).`,
    metric,[],{data_quality:{model_validated_for_protocol:true}});
}

function evaluateRule(id,cat,rule,ctx) {
  if(rule.enabled!==true || ctx.categoryEnabled===false) return result(id,cat,rule,ctx.rules?.settings?.disabled_rule_status||'DISABLED','Rule or category disabled.');
  const {events,phase8,phase4,phase5,marketVolume}=ctx;
  if(id==='SPR-01') return evaluateSpr01({phase8,phase4,rule,mint:ctx.mint,cat});
  if(id==='SPR-03') return evaluateConnectedShare('SPR-03',{phase5,marketVolume,rule,cat});
  if(id==='SPR-04') return evaluateSpr04({phase8,phase4,rule,cat});
  if(id==='SPR-05'||id==='LTR-01') return evaluateSellVsLiquidity(id,{phase8,phase4,rule,cat,guards:ctx.guards});
  if(id==='LTR-02') return evaluateLtr02({liquidityHistory:ctx.liquidityHistory,phase4,rule,cat});
  if(id==='LTR-03') return evaluateLtr03({phase8,phase4,liquidityHistory:ctx.liquidityHistory,rule,cat,rules:ctx.rules});
  if(id==='LTR-04') return evaluateLtr04({phase8,phase4,rule,cat,guards:ctx.guards});
  if(id==='CTR-01') return evaluateCtr01({phase8,fundingGraph:ctx.fundingGraph,rule,cat});
  if(id==='CTR-02') return evaluateCtr02({phase8,fundingGraph:ctx.fundingGraph,rule,cat});
  if(id==='CTR-04') return evaluateConnectedShare('CTR-04',{phase5,marketVolume,rule,cat});
  if(id==='TCR-01'||id==='TCR-02') return evaluateTcr0102(id,{phase8,marketVolume,rule,cat});
  if(id==='TCR-03') return evaluateConnectedShare('TCR-03',{phase5,marketVolume,rule,cat});
  if(id==='TCR-04') return evaluateTcr04({phase8,rule,cat});
  if(id==='SPR-02') {
    const classification=phase4ClassificationMap(phase4);
    const sells=uniqueRows(events.filter(r=>r.event?.event_class==='SELL'&&tsOf(r.event)!=null && classification.get(r.wallet)!=='LIQUIDITY_POOL'));
    if(!sells.length) {
      const cov=historyCoverage(phase8);
      return cov.complete ? result(id,cat,rule,'NOT_TRIGGERED','No valid uniquely identified SELL events were observed in complete histories.',{max_observed_count:0,window_seconds:rule.window_seconds}) : missing(id,cat,rule,`No valid SELL event was observed and coverage is incomplete. ${cov.reason}`);
    }
    const byWallet=new Map(); for(const row of sells) { const a=byWallet.get(row.wallet)||[]; a.push(row); byWallet.set(row.wallet,a); }
    let best={wallet:null,count:0,rows:[]}; const win=Number(rule.window_seconds||3600), min=Number(rule.min_count||5);
    for(const [wallet,rows] of byWallet) { const x=countWindow(rows,win); if(x.count>best.count) best={wallet,...x}; }
    const alt=alternative(rule), altMin=Number(alt.threshold?.min_unique_sell_events), altWin=Number(alt.threshold?.window_seconds||win);
    const metric={wallet:best.wallet,event_count:best.count,window_seconds:win,unique_transaction_count:best.count};
    const refs=best.rows.map(evRef);
    if(best.count>=min) return result(id,cat,rule,'TRIGGERED',`Wallet has ${best.count} unique SELL transactions in a ${win}-second rolling window (threshold ${min}).`,metric,refs,{data_quality:{unique_signatures:true,window_coverage:historyCoverage(phase8).complete?'complete':'partial_observed_events'}});
    if(alt.enabled===true&&alt.status==='PROVISIONAL'&&Number.isFinite(altMin)&&altMin>0&&best.count>=altMin&&win===altWin)
      return result(id,cat,rule,'PROVISIONAL',`Observed ${best.count} unique SELL transactions: below primary threshold ${min}, but meets enabled alternative threshold ${altMin}.`,{...metric,alternative_threshold:altMin},refs,{alternative:{status:'PROVISIONAL',threshold:altMin},data_quality:{unique_signatures:true,window_coverage:'partial_observed_events'}});
    const cov=historyCoverage(phase8);
    if(!cov.complete) return missing(id,cat,rule,`Observed maximum is ${best.count}/${min} unique SELLs, but full-window absence cannot be established. ${cov.reason}`,{data_quality:{unique_signatures:true,window_coverage:'partial'}});
    return result(id,cat,rule,'NOT_TRIGGERED',`No wallet reached ${min} unique SELL transactions in a ${win}-second window.`,{...metric,max_observed_count:best.count},refs,{data_quality:{unique_signatures:true,window_coverage:'complete'}});
  }
  if(id==='CTR-03'||id==='CTR-05') {
    const win=Number(rule.window_seconds||(id==='CTR-05'?604800:86400));
    // Mirror SPR-02: confirmed LIQUIDITY_POOL accounts are AMM program state,
    // not wallets. Their swap-driven RECEIVE/SELL pairs must not become
    // wallet-level coordinated-trading subjects.
    const classification=phase4ClassificationMap(phase4);
    const matches=transferSellSequences(events,win,{requireRelationship:id==='CTR-05'})
      .filter(m=>classification.get(m.sell.wallet)!=='LIQUIDITY_POOL');
    const cov=historyCoverage(phase8);
    if(id==='CTR-03') {
      if(matches.length) return result(id,cat,rule,'TRIGGERED',`Found ${matches.length} unique one-to-one transfer→recipient SELL temporal association(s) within ${win} seconds. This is temporal association only; wallet relationship and token-flow causality are not established.`,{matched_sequences:matches.length,window_seconds:win,counting_unit:'unique_one_to_one_temporal_association'},matches.slice(0,100).flatMap(m=>[evRef(m.transfer.row),evRef(m.sell)]),{evidence_scope:'temporal_association_unverified_relationship',data_quality:{signature_deduplication:true,chronology_verified:true,recipient_match:true,token_flow_causality:'not_established'}});
      if(!cov.complete) return missing(id,cat,rule,`No qualifying sequence observed, but histories are incomplete. ${cov.reason}`);
      return result(id,cat,rule,'NOT_TRIGGERED','No qualifying one-to-one transfer→recipient SELL temporal association was observed in complete histories.',{matched_sequences:0,window_seconds:win});
    }
    if(matches.length>=Number(rule.min_count||2)) return result(id,cat,rule,'TRIGGERED',`Found ${matches.length} unique sequences where transfer and subsequent recipient SELL share independently verified relationship_id evidence.`,{linked_event_count:matches.length,window_seconds:win,counting_unit:'verified_relationship_sequence'},matches.slice(0,100).flatMap(m=>[evRef(m.transfer.row),evRef(m.sell)]),{evidence_scope:'verified_relationship_sequence',data_quality:{relationship_id_checked_per_sequence:true,chronology_verified:true,one_to_one_pairing:true}});
    if(!cov.complete) return missing(id,cat,rule,`Only ${matches.length}/${Number(rule.min_count||2)} qualifying verified relationship sequences observed; histories are incomplete. ${cov.reason}`);
    return result(id,cat,rule,'NOT_TRIGGERED',`Only ${matches.length} qualifying verified relationship sequences observed; threshold is ${Number(rule.min_count||2)}.`,{linked_event_count:matches.length,window_seconds:win});
  }
  return missing(id,cat,rule,MISSING_REASONS[id]||'Required validated inputs are not present in the available phase artifacts.');
}
function validateRules(rules) {
  if(!rules?.categories||typeof rules.categories!=='object') throw Error('INVALID_RULES_CONFIG: categories missing');
  const ids=[];
  for(const [cat,group] of Object.entries(rules.categories)) for(const [id,rule] of Object.entries(group.rules||{})) {
    ids.push(id);
    if(!rule||typeof rule.enabled!=='boolean'||!rule.name) throw Error(`INVALID_RULE_CONFIG: ${cat}.${id}`);
    const alt=alternative(rule);
    if(alt.enabled===true&&!STATUSES.has(alt.status)) throw Error(`INVALID_ALTERNATIVE_STATUS: ${id}.${alt.status}`);
  }
  const expected=['SPR-01','SPR-02','SPR-03','SPR-04','SPR-05','CTR-01','CTR-02','CTR-03','CTR-04','CTR-05','TCR-01','TCR-02','TCR-03','TCR-04','LTR-01','LTR-02','LTR-03','LTR-04'];
  if(new Set(ids).size!==ids.length||expected.some(id=>!ids.includes(id))) throw Error('INVALID_RULE_CATALOG: expected 18 unique SPR/CTR/TCR/LTR rules');
  return ids.length;
}
function runEvaluation({rules,phase8,phase4=null,phase5=null,mint=null,source='test'}) {
  const events=flatEvents(phase8), results=[];
  // Optional sidecar inputs (graceful when absent — evaluators stay honest):
  //  - funding-graph.json  (Phase 8B collector) -> CTR-01 / CTR-02
  //  - liquidity_history.jsonl (appended by Phase 4 each scan) -> LTR-02 / LTR-03
  //  - market-volume.json (Phase 8C collector, completeness='complete')
  //    -> SPR-03 / CTR-04 / TCR-01 / TCR-02 / TCR-03
  const outDir=mint?path.join(ROOT,'Output',mint):null;
  const fundingGraph=outDir?readJson(path.join(outDir,'funding-graph.json')):null;
  const liquidityHistory=outDir?readLiquidityHistory(outDir):[];
  const marketVolume=outDir?readMarketVolume(outDir):null;
  // CTR-05 data path: anotasi relationship_id + relationship_verified
  // dari funding-graph.json ke event transfer/SELL yang berpasangan. Ini TIDAK
  // mengubah rule apa pun (threshold/window/status terkunci) — hanya mengisi
  // evidence yang selama ini kosong sehingga CTR-05 bisa dievaluasi. Evaluator
  // lain mengabaikan dua field tambahan ini.
  const ctr05Rule=rules?.categories?.COORDINATED_TRADING_RISK?.rules?.['CTR-05']||null;
  const annotatedEvents=annotateRelationships(events,fundingGraph,ctr05Rule,{relationships:loadRelationshipsConfig()});
  for(const [category,group] of Object.entries(rules.categories)) for(const [id,rule] of Object.entries(group.rules||{}))
    results.push(evaluateRule(id,category,rule,{events:annotatedEvents,phase8,phase4,phase5,fundingGraph,liquidityHistory,marketVolume,mint,categoryEnabled:group.enabled!==false,rules,guards:loadEvaluationGuards()}));
  const counts={}; for(const r of results) counts[r.status]=(counts[r.status]||0)+1;
  return {phase:9,phase_name:'RISK_ENGINE',version:'2.0.0',status:'COMPLETE',timestamp:new Date().toISOString(),input:{mint:mint||phase8?.input?.mint||null,source,phase8_result:phase8?'phase8-result.json':null,phase4_result:phase4?'phase4-result.json':null,phase5_result:phase5?'phase5-result.json':null,rule_config:'config/phase9_rules.json'},scope:{purpose:'Evaluate configured risk rules against available upstream evidence; no scoring, prediction, or final classification.',rules_config_version:rules.config_version||null,timezone:`${rules.settings?.timezone||'Asia/Jakarta'} (WIB, UTC+7)`,wallets_in_phase8:(phase8?.wallets||[]).length,wallet_selection:phase8?.wallet_selection||{candidate_wallets:phase8?.config?.candidate_wallets??null,selected_wallets:phase8?.config?.selected_wallets??null,skipped_wallets:phase8?.config?.skipped_wallets??null,max_wallets:phase8?.config?.max_wallets??null,selection_policy:phase8?.config?.selection||null},events_observed:events.length,coverage:historyCoverage(phase8),coverage_note:'NOT_TRIGGERED requires adequate coverage. Missing evidence remains INSUFFICIENT_DATA.'},summary:{rules_total:results.length,by_status:counts,triggered:counts.TRIGGERED||0,provisional:counts.PROVISIONAL||0,not_triggered:counts.NOT_TRIGGERED||0,unknown:counts.UNKNOWN||0,insufficient_data:counts.INSUFFICIENT_DATA||0,disabled:counts.DISABLED||0},categories:Object.entries(rules.categories).map(([category,group])=>({category,enabled:group.enabled!==false,rule_count:results.filter(r=>r.category===category).length,status_counts:Object.fromEntries([...new Set(results.filter(r=>r.category===category).map(r=>r.status))].map(s=>[s,results.filter(r=>r.category===category&&r.status===s).length]))})),rules:results,data_sources:['Phase 8 wallet behavior/timeline artifact','Phase 4 entity classification artifact (used to exclude confirmed LIQUIDITY_POOL from wallet-level SPR-02)','Phase 5 creator/related-wallet artifact (connected-wallet set for SPR-03/CTR-04/TCR-03)','config/phase9_rules.json','Optional sidecars: funding-graph.json (Phase 8B) for CTR-01/CTR-02, liquidity_history.jsonl (Phase 4) for LTR-02/LTR-03, market-volume.json (Phase 8C, completeness=complete only) for SPR-03/CTR-04/TCR-01/TCR-02/TCR-03'],limitations:['No market-wide trading-volume completeness is assumed.','Token transfers are not treated as buys or sells.','Transfer→SELL temporal association does not prove token-flow causality.','No aggregate risk score is calculated.','A missing input is not interpreted as absence of risk.']};
}
function main() {
  const requestedMint=String(process.argv[2]||'').trim();
  if(requestedMint&&!VALID_MINT.test(requestedMint)) throw Error('INVALID_SOLANA_TOKEN_MINT');
  const rules=readJson(RULES_FILE); validateRules(rules);
  let input;
  if(requestedMint) { const located=locate(requestedMint); input={...located,phase8:located.files.phase8,phase4:located.files.phase4,source:'explicit_mint',mint:requestedMint}; }
  else { const latest=findLatestInput(); if(!latest) throw Error('PHASE_INPUT_NOT_FOUND: No valid phase8-result.json found under output/<TOKEN_MINT>/. Run previous phases first.'); const located=locate(latest.mint); input={...located,phase8:latest.data,source:'latest_phase8_result',mint:latest.mint}; }
  if(!input.phase8) throw Error('PHASE8_INPUT_INVALID: phase8-result.json missing or invalid');
  const output=runEvaluation({rules,phase8:input.phase8,phase4:input.files.phase4,phase5:input.files.phase5,mint:input.mint,source:input.source});
  attachRunMetadata(output,9,input.mint); const out=path.join(input.dir,'phase9-result.json'); fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n','utf8');
  const c=output.summary.by_status;
  console.log('\nPHASE 9 — RISK ENGINE v2.0.0'); console.log(`Input          : ${input.source}`); console.log(`Mint           : ${input.mint||input.phase8?.input?.mint}`); console.log(`Rules          : ${output.summary.rules_total}`); console.log(`TRIGGERED      : ${c.TRIGGERED||0}`); console.log(`PROVISIONAL     : ${c.PROVISIONAL||0}`); console.log(`NOT_TRIGGERED  : ${c.NOT_TRIGGERED||0}`); console.log(`INSUFFICIENT   : ${c.INSUFFICIENT_DATA||0}`); console.log(`UNKNOWN        : ${c.UNKNOWN||0}`); console.log(`DISABLED       : ${c.DISABLED||0}`); console.log(`Output         : ${out}`);
}
if(require.main===module) { try { main(); } catch(e) { console.error(`PHASE9_ERROR: ${e.message}`); process.exit(1); } }
module.exports={evaluateRule,runEvaluation,validateRules,flatEvents,historyCoverage,transferSellSequences,tsOf,phase4ClassificationMap,evaluateConnectedShare,evaluateTcr0102,evaluateTcr04,evaluateLtr04,connectedWalletSet,marketVolumeTier,readMarketVolume,hhi0100,MARKET_WINDOW_MIN_PARSED,connectedShareHalves,topShareHalves,WINDOW_STABILITY_UNAVAILABLE,liquidityCredibility,loadEvaluationGuards};
