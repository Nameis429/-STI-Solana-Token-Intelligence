#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { attachRunMetadata } = require('./run_metadata');
const ROOT = path.resolve(__dirname, '..');
const CFG_FILE = path.join(ROOT, 'Config', 'config.json');
const OUT_ROOT = path.join(ROOT, 'Output');
const started = Date.now();
// Shared request pacing/cooldown across all wallet workers.
// Pacing memakai slot global Script/rpc_throttle.js  agar satu
// budget ~10 req/dtk berlaku konsisten dengan phase lain; cooldown 429
// tetap dikelola di sini.
const throttle = require('./rpc_throttle');
let globalCooldownUntil = 0;
let requestCount = 0;
async function waitForRequestSlot(config) {
  throttle.configure(config);
  const pc = config.phase8 || {};
  const interval = Math.max(0, Number(pc.min_request_interval_ms ?? 180));
  await throttle.takeSlot(interval);
  const now = Date.now();
  if (globalCooldownUntil > now) {
    throttle.delayUntil(globalCooldownUntil);
    await sleep(globalCooldownUntil - now);
  }
  requestCount++;
}
function retryAfterMs(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.min(120000, n * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, Math.min(120000, t - Date.now())) : 0;
}
const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const short = x => valid(x) ? `${x.slice(0,5)}…${x.slice(-4)}` : 'UNKNOWN';
const normalizeTs = v => { const n = Number(v); return Number.isFinite(n) ? (n > 20000000000 ? Math.floor(n / 1000) : Math.floor(n)) : null; };
const iso = ts => ts == null ? null : new Date(ts * 1000).toISOString();
const wib = ts => ts == null ? null : new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).format(new Date(ts * 1000)).replace(' ', 'T');
const rawBigInt = x => { try { return BigInt(String(x ?? '0')); } catch { return 0n; } };
function loadConfig() {
  if (!fs.existsSync(CFG_FILE)) throw Error('CONFIG_NOT_FOUND');
  const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  c.helius = c.helius || {};
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if (!c.helius.api_key || c.helius.api_key.startsWith('PASTE_')) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}
function locateInput() {
  if (!fs.existsSync(OUT_ROOT)) return null;
  const dirs = fs.readdirSync(OUT_ROOT, { withFileTypes:true }).filter(x => x.isDirectory());
  const found = [];
  for (const d of dirs) {
    const dir = path.join(OUT_ROOT, d.name);
    const p7 = readJson(path.join(dir, 'phase7-result.json'));
    if (!p7) continue;
    const mint = p7?.input?.mint || d.name;
    if (!valid(mint)) continue;
    found.push({ dir, mint, phase7:p7, phase1:readJson(path.join(dir,'phase1-result.json')), phase2:readJson(path.join(dir,'phase2-result.json')), phase3:readJson(path.join(dir,'phase3-result.json')), phase4:readJson(path.join(dir,'phase4-result.json')), phase5:readJson(path.join(dir,'phase5-result.json')), phase6:readJson(path.join(dir,'phase6-result.json')) });
  }
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested) for(let i=found.length-1;i>=0;i--) if(found[i].mint!==requested) found.splice(i,1);
  found.sort((a,b) => String(b.phase7.timestamp || '').localeCompare(String(a.phase7.timestamp || '')));
  return found[0] || null;
}
function getDecimals(input) {
  const candidates = [input.phase2?.token?.decimals, input.phase2?.token_info?.decimals, input.phase1?.token?.decimals, input.phase1?.metadata?.decimals, input.phase7?.token?.decimals];
  for (const x of candidates) if (Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 255) return Number(x);
  return null;
}
function toUi(raw, decimals) {
  if (raw == null || decimals == null) return null;
  try { const b=BigInt(String(raw)); const neg=b<0n; const s=(neg?-b:b).toString().padStart(decimals+1,'0'); const out=decimals ? `${s.slice(0,-decimals)}.${s.slice(-decimals)}` : s; return Number(`${neg?'-':''}${out}`); } catch { return null; }
}
// Convert a UI token amount to integer base units without floating-point multiplication.
function decimalUiToRaw(value, decimals) {
  if (value == null || decimals == null || !Number.isInteger(Number(decimals)) || Number(decimals) < 0) return null;
  let text = String(value).trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const places = Number(decimals);
  let sign = '';
  if (text[0] === '-' || text[0] === '+') { if (text[0] === '-') sign = '-'; text = text.slice(1); }
  let exponent = 0;
  const eIndex = text.toLowerCase().indexOf('e');
  if (eIndex >= 0) { exponent = Number(text.slice(eIndex + 1)); text = text.slice(0, eIndex); }
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const dot = text.indexOf('.');
  const fractionLength = dot >= 0 ? text.length - dot - 1 : 0;
  let digits = text.replace('.', '').replace(/^0+(?=\d)/, '');
  let scale = fractionLength - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  const shift = places - scale;
  if (shift >= 0) return `${sign}${(digits || '0')}${'0'.repeat(shift)}`.replace(/^-?0+(?=\d)/, sign === '-' ? '-' : '');
  const cut = -shift;
  if (cut >= digits.length) return null;
  const discarded = digits.slice(digits.length - cut);
  if (/[1-9]/.test(discarded)) return null; // Do not silently round sub-unit precision.
  const whole = digits.slice(0, digits.length - cut).replace(/^0+(?=\d)/, '') || '0';
  return `${sign}${whole}`;
}
function extractTransferAmounts(transfer, fallbackDecimals) {
  const rawCandidates = [
    transfer?.rawTokenAmount?.tokenAmount,
    transfer?.raw_token_amount?.token_amount,
    transfer?.token_amount_raw,
    transfer?.rawTokenAmount?.amount,
    transfer?.raw_token_amount?.amount
  ];
  let raw = rawCandidates.find(v => v != null && /^-?\d+$/.test(String(v).trim()));
  const exDec = transfer?.rawTokenAmount?.decimals ?? transfer?.raw_token_amount?.decimals ?? null;
  const decimals = exDec != null && Number.isInteger(Number(exDec)) && Number(exDec) >= 0
    ? Number(exDec) : fallbackDecimals;
  const uiCandidates = [
    transfer?.tokenAmount?.uiAmount,
    transfer?.tokenAmount?.ui_amount,
    transfer?.uiAmount,
    transfer?.ui_amount,
    transfer?.tokenAmount,
    transfer?.token_amount,
    transfer?.amount
  ];
  const uiValue = uiCandidates.find(v => v != null && (typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '' && Number.isFinite(Number(v)));
  const ui = uiValue == null ? null : Number(uiValue);
  let rawSource = raw != null ? 'HELIUS_RAW_TOKEN_AMOUNT' : null;
  if (raw == null && uiValue != null && decimals != null) {
    raw = decimalUiToRaw(uiValue, decimals);
    if (raw != null) rawSource = 'DERIVED_FROM_UI_AMOUNT_AND_DECIMALS';
  }
  return {
    raw: raw == null ? null : String(raw),
    ui: ui,
    decimals: Number.isInteger(Number(decimals)) && decimals != null ? Number(decimals) : null,
    rawSource,
    decimalsSource: exDec != null ? 'HELIUS_RAW_TOKEN_AMOUNT' : (fallbackDecimals != null ? 'PHASE2_TOKEN_DECIMALS' : null)
  };
}
function addCandidate(map, address, source, priority='LOW', context={}) {
  if (!valid(address)) return;
  const rank={HIGH:3,MEDIUM:2,LOW:1};
  const prev=map.get(address);
  if (!prev) map.set(address,{wallet:address,priority,sources:[source],source_context:[context]});
  else { if (!prev.sources.includes(source)) prev.sources.push(source); prev.source_context.push(context); if ((rank[priority]||0)>(rank[prev.priority]||0)) prev.priority=priority; }
}
function collectCandidates(input, cfg) {
  const map=new Map(); const p7=input.phase7; const high=new Set();
  for (const m of (p7.matches || [])) {
    const roles=m.database?.roles || [];
    const hasSpecial=roles.some(r=>['EARLY','WHALE','DEV','RUG/KOL'].includes(r));
    const appearances=m.appearances || [];
    const specialAppearance=appearances.some(a=>/CREATOR|FEE_RECIPIENT|INITIAL_DISTRIBUTION|RELATED_WALLET/.test(a.source||''));
    const active=Number(m.history?.buy_count||0)>0 || Number(m.history?.sell_count||0)>0 || m.current?.is_holder || m.position?.status==='NO_LONGER_HOLDER';
    const pri=(hasSpecial||specialAppearance||m.current?.is_holder)?'HIGH':active?'MEDIUM':'LOW';
    addCandidate(map,m.wallet,'PHASE7_DATABASE_MATCH',pri,{display:m.display||null,roles,phase7_position:m.position?.status||null,is_holder:!!m.current?.is_holder});
    if (pri==='HIGH') high.add(m.wallet);
  }
  const topN=Math.max(0,Number(cfg.top_holder_count ?? 30));
  for (const h of (input.phase3?.holders || []).slice(0,topN)) addCandidate(map,h.owner,'PHASE3_TOP_HOLDER', 'MEDIUM',{rank:h.rank??null,balance_raw:String(h.amount_raw??'0'),balance_ui:h.amount_ui??null});
  const creator=input.phase5?.creator_discovery?.selected?.address;
  addCandidate(map,creator,'PHASE5_CREATOR','HIGH');
  for (const x of (input.phase5?.creator_discovery?.candidates||[])) addCandidate(map,x.address,'PHASE5_CREATOR_CANDIDATE','HIGH',{role:x.role||null,confidence:x.confidence||null});
  for (const x of (input.phase5?.creator_distribution?.recipients||[])) addCandidate(map,x.address,'PHASE5_CREATOR_RECIPIENT','HIGH',{received_raw:String(x.received_raw??'0'),received_pct_supply:x.received_pct_supply??null});
  for (const x of (input.phase5?.related_wallets?.wallets||[])) addCandidate(map,x.address,'PHASE5_RELATED_WALLET','HIGH',{relation:'DIRECT_CREATOR_RECIPIENT'});
  for (const cl of (input.phase5?.initial_distribution?.clusters||[])) for (const a of (cl.wallets||[])) addCandidate(map,a,'PHASE5_INITIAL_DISTRIBUTION','MEDIUM',{cluster_key:cl.cluster_key||null});
  for (const c of (input.phase6?.fee_components||[])) for (const a of (c?.destination?.addresses||[])) addCandidate(map,a,'PHASE6_FEE_RECIPIENT','HIGH',{component:c.name||null,verification:c.verification||null});
  for (const d of (input.phase6?.fee_destinations?.components||[])) for (const a of (d?.addresses||d?.destination?.addresses||[])) addCandidate(map,a,'PHASE6_FEE_RECIPIENT','HIGH',{component:d.name||d.component||null});
  for (const x of (input.phase6?.downstream_usage?.flows||[])) addCandidate(map,x.address,'PHASE6_DOWNSTREAM_RECIPIENT','MEDIUM',{ownership_status:x.ownership_status||'UNKNOWN'});
  const rank={HIGH:0,MEDIUM:1,LOW:2};
  return [...map.values()].sort((a,b)=>(rank[a.priority]-rank[b.priority]) || a.wallet.localeCompare(b.wallet));
}
async function requestHistory(address, mint, config, maxPages, decimals, maxEvents) {
  const apiBase=String(config.helius.api_base_url||'https://api.helius.xyz').replace(/\/$/,'');
  const key=config.helius.api_key; const pc=config.phase8||{};
  const timeout=Math.max(1000,Number(pc.request_timeout_ms??12000));
  const retryMax=Math.max(0,Number(pc.retry_5xx_attempts??2));
  let before=null,pages=0,transactions=0,complete=false;
  const all=[]; let rateLimited=false;
  for(let page=1;page<=maxPages;page++) {
    let url=`${apiBase}/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(key)}&limit=100`;
    if(before) url+=`&before-signature=${encodeURIComponent(before)}`;
    let rows=null;
    for(let attempt=0;attempt<=retryMax;attempt++) {
      const ctl=new AbortController(); let timer;
      try {
        await waitForRequestSlot(config);
        timer=setTimeout(()=>ctl.abort(),timeout);
        const res=await fetch(url,{method:'GET',headers:{Accept:'application/json'},signal:ctl.signal});
        const txt=await res.text(); let body; try{body=txt?JSON.parse(txt):[];}catch{body={raw:txt};}
        if(res.status===429){
          rateLimited=true;
          const delay=Math.max(retryAfterMs(res.headers.get('retry-after')), Number(pc.retry_429_pass_delay_ms ?? 5000));
          globalCooldownUntil=Math.max(globalCooldownUntil, Date.now()+Math.min(120000,delay));
          throttle.delayUntil(globalCooldownUntil);
          const e=Error('HTTP_429'); e.status=429; e.retryAfterMs=delay; throw e;
        }
        if([400,401,403,404,410].includes(res.status)) throw Error(`HTTP_${res.status}`);
        if(res.status>=500){if(attempt<retryMax){await sleep(Math.min(15000,1000*2**attempt)+Math.floor(Math.random()*500));continue;} throw Error(`HTTP_${res.status}`);}
        if(!res.ok) throw Error(`HTTP_${res.status}`);
        if(body?.error) throw Error(`API_ERROR_${body.error.code??'UNKNOWN'}: ${body.error.message||''}`);
        rows=Array.isArray(body)?body:[]; break;
      } catch(e) {
        if(e.message==='HTTP_429'||/^HTTP_(400|401|403|404|410)$/.test(e.message)) throw e;
        if(attempt>=retryMax) throw e;
        await sleep(Math.min(15000,1000*2**attempt)+Math.floor(Math.random()*500));
      } finally {clearTimeout(timer);}
    }
    if(!rows) rows=[];
    pages=page; transactions+=rows.length;
    for(const tx of rows) {
      const ts=normalizeTs(tx.timestamp??tx.blockTime??tx.block_time);
      for(const t of (Array.isArray(tx.tokenTransfers)?tx.tokenTransfers:[])) {
        if(t?.mint!==mint) continue;
        const from=t.fromUserAccount||t.from_user_account||null, to=t.toUserAccount||t.to_user_account||null;
        const outgoing=from===address,incoming=to===address; if(!outgoing&&!incoming) continue;
        const amounts=extractTransferAmounts(t,decimals);
        const raw=amounts.raw;
        const ui=amounts.ui;
        const dec=amounts.decimals;
        const type=String(tx.type||'').trim().toUpperCase();
        // Classify only what the observed transaction fields support. A SWAP is
        // BUY/SELL; non-swap token movements remain RECEIVE/TRANSFER_OUT.
        let eventClass='UNKNOWN';
        let classificationBasis='DIRECTION_UNCLEAR';
        if(outgoing && incoming) {
          eventClass='SELF_TRANSFER';
          classificationBasis='SAME_WALLET_AS_SOURCE_AND_DESTINATION';
        } else if(type==='SWAP' && incoming) {
          eventClass='BUY';
          classificationBasis='HELIUS_TYPE_SWAP_AND_TOKEN_RECEIVED';
        } else if(type==='SWAP' && outgoing) {
          eventClass='SELL';
          classificationBasis='HELIUS_TYPE_SWAP_AND_TOKEN_SENT';
        } else if(incoming) {
          eventClass='RECEIVE';
          classificationBasis='TOKEN_TRANSFER_TO_WALLET_NOT_CLASSIFIED_AS_SWAP';
        } else if(outgoing) {
          eventClass='TRANSFER_OUT';
          classificationBasis='TOKEN_TRANSFER_FROM_WALLET_NOT_CLASSIFIED_AS_SWAP';
        }
        const event={signature:tx.signature||null,slot:tx.slot??null,timestamp_utc:iso(ts),timestamp_wib:wib(ts),block_time:ts,event_class:eventClass,classification_basis:classificationBasis,amount_raw:raw==null?null:String(raw),amount_ui:ui==null?toUi(raw,dec):ui,decimals:dec,amount_raw_source:amounts.rawSource,decimals_source:amounts.decimalsSource,counterparty:outgoing&&incoming?address:(incoming?from:to),direction:outgoing&&incoming?'SELF':(incoming?'IN':'OUT'),tx_type:tx.type||null,description:tx.description||null,source:'HELIUS_ENHANCED_TRANSACTION'};
        // Stable source identifier for downstream evidence lineage. The ordinal is
        // scoped to this transaction's token-transfer observations and therefore
        // disambiguates multiple token events sharing one signature.
        event.event_id = `${event.signature || 'NO_SIGNATURE'}:${event.event_class}:${all.length}`;
        event.transaction_provenance = {signature:event.signature,source:event.source,slot:event.slot,block_time:event.block_time};
        all.push(event);
      }
    }
    if(rows.length<100){complete=true;break;}
    before=rows[rows.length-1]?.signature;
    if(!before){complete=true;break;}
  }
  all.sort((a,b)=>(a.block_time??0)-(b.block_time??0));
  const counts={BUY:0,SELL:0,RECEIVE:0,TRANSFER_OUT:0,SELF_TRANSFER:0,UNKNOWN:0};
  const totals={BUY:0n,SELL:0n,RECEIVE:0n,TRANSFER_OUT:0n,SELF_TRANSFER:0n};
  for(const e of all){counts[e.event_class]=(counts[e.event_class]||0)+1;if(e.amount_raw!=null&&totals[e.event_class]!=null)totals[e.event_class]+=rawBigInt(e.amount_raw);}
  const pick=(cls,first=true)=>{const a=all.filter(e=>e.event_class===cls);return a.length?(first?a[0]:a[a.length-1]):null;};
  const firstAcq=all.find(e=>['BUY','RECEIVE'].includes(e.event_class))||null;
  const lastSell=pick('SELL',false), lastTransfer=pick('TRANSFER_OUT',false), lastBuy=pick('BUY',false), lastReceive=pick('RECEIVE',false);
  const lastActivity=all[all.length-1]||null;
  const maxEvent=cls=>all.filter(e=>e.event_class===cls).reduce((best,e)=>!best||rawBigInt(e.amount_raw)>rawBigInt(best.amount_raw)?e:best,null);
  let span=null; if(firstAcq?.block_time&&lastActivity?.block_time&&lastActivity.block_time>=firstAcq.block_time) span=lastActivity.block_time-firstAcq.block_time;
  const stored=all.length>maxEvents?all.slice(-maxEvents):all;
  const eventsTruncated=all.length>stored.length;
  const retrievalStatus=complete ? (eventsTruncated?'PARTIAL':'COMPLETE') : 'PARTIAL';
  const stoppedReason=complete ? (eventsTruncated?'EVENT_RETENTION_CAP':'NO_MORE_DATA') : 'PAGE_LIMIT';
  const coverage={retrieval_mode:'PAGINATED_BOUNDED',status:retrievalStatus,reason:stoppedReason,scope:'CONFIGURED_PAGE_WINDOW',pagination:{enabled:true,pages_requested:pages,pages_fetched:pages,cursor_used:pages>1,stopped_reason:stoppedReason,has_more_possible:!complete},records_requested:pages*100,records_observed:all.length,records_retained:stored.length,cap_triggered:!complete||eventsTruncated,rate_limit:{encountered:false,retry_count:0,recovered:false,final_state:'NOT_ENCOUNTERED'}};
  const coverageLegacy=!complete?'PARTIAL_PAGE_CAP':(eventsTruncated?'PARTIAL_EVENT_RETENTION_CAP':'COMPLETE_WITHIN_CONFIGURED_PAGES');
  const observedCoverageStart=all.length?all[0].block_time:null;
  const observedCoverageEnd=all.length?all[all.length-1].block_time:null;
  return {status:'FOUND',coverage:coverage,coverage_legacy:coverageLegacy,complete, pages,transactions,events_detected:all.length,events:stored,events_truncated:eventsTruncated,counts_observed:counts,amount_totals_raw_observed:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v.toString()])),first_buy:pick('BUY',true),last_buy:lastBuy,first_sell:pick('SELL',true),last_sell:lastSell,first_receive:pick('RECEIVE',true),last_receive:lastReceive,first_transfer_out:pick('TRANSFER_OUT',true),last_transfer_out:lastTransfer,last_activity:lastActivity,activity_summary:{buy_count:counts.BUY,sell_count:counts.SELL,receive_count:counts.RECEIVE,transfer_out_count:counts.TRANSFER_OUT,self_transfer_count:counts.SELF_TRANSFER,unknown_count:counts.UNKNOWN},first_observed_acquisition:firstAcq,largest_buy:maxEvent('BUY'),largest_sell:maxEvent('SELL'),observed_activity_span_seconds:span,observed_activity_span_basis:span==null?null:'FIRST_OBSERVED_ACQUISITION_TO_LAST_OBSERVED_TOKEN_ACTIVITY',observed_coverage_start:observedCoverageStart,observed_coverage_end:observedCoverageEnd,observed_coverage_start_iso:iso(observedCoverageStart),observed_coverage_end_iso:iso(observedCoverageEnd),rate_limited:false};
}
function summarizePosition(candidate, history, currentHolder) {
  let status='UNKNOWN';
  if(currentHolder) status=history.first_observed_acquisition?'CURRENT_HOLDER':'CURRENT_HOLDER_NO_OBSERVED_ACQUISITION';
  else if(history.counts_observed.SELL>0||history.counts_observed.TRANSFER_OUT>0) status='NO_CURRENT_HOLDING_WITH_OBSERVED_OUTFLOW';
  else if(history.counts_observed.BUY>0||history.counts_observed.RECEIVE>0) status='HISTORICAL_ACTIVITY';
  else status='NO_TOKEN_ACTIVITY_OBSERVED';
  return {status,current_holder:!!currentHolder,observed_buy_count:history.counts_observed.BUY,observed_sell_count:history.counts_observed.SELL,observed_receive_count:history.counts_observed.RECEIVE,observed_transfer_out_count:history.counts_observed.TRANSFER_OUT,observed_activity_span_seconds:history.observed_activity_span_seconds,observed_activity_span_basis:history.observed_activity_span_basis,note:'Observed history is bounded by configured page limits; counts and timelines are not lifetime totals. TRANSFER_OUT is not classified as SELL. Outflow plus no current holding does not establish that all tokens were sold.'};
}
async function main(){
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🔎 SOLANA TOKEN ANALYZER — PHASE 8 V3.1             ║');
  console.log('║           WALLET BEHAVIOR & TIMELINE                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  let config; try{config=loadConfig();}catch(e){console.error(`STATUS : FAILED ✗\nERROR  : ${e.message}`);process.exitCode=1;return;}
  const input=locateInput(); if(!input){console.error('STATUS : FAILED ✗\nERROR  : PHASE7_RESULT_NOT_FOUND');process.exitCode=1;return;}
  const cfg=config.phase8||{}; const mint=input.mint; const decimals=getDecimals(input);
  const candidates=collectCandidates(input,cfg); const maxWallets=Math.max(1,Number(cfg.max_wallets??100));
  const selected=candidates.slice(0,maxWallets); const skipped=candidates.slice(maxWallets);
  const maxPagesByPriority={HIGH:Math.max(1,Number(cfg.high_priority_max_pages??10)),MEDIUM:Math.max(1,Number(cfg.medium_priority_max_pages??5)),LOW:Math.max(1,Number(cfg.low_priority_max_pages??3))};
  const maxEvents=Math.max(1,Number(cfg.max_events_per_wallet??500)); const concurrency=Math.max(1,Math.min(8,Number(cfg.concurrency??3)));
  const result={phase:8,phase_name:'WALLET_BEHAVIOR_TIMELINE',version:'3.1',status:'RUNNING',timestamp:new Date().toISOString(),input:{mint,phase7_result:'phase7-result.json',token_decimals:decimals},config:{selection:'PRIORITY_BASED_SELECTED_WALLETS',candidate_wallets:candidates.length,selected_wallets:selected.length,skipped_wallets:skipped.length,max_wallets:maxWallets,max_pages_by_priority:maxPagesByPriority,concurrency,max_events_per_wallet:maxEvents,timezone:'Asia/Jakarta (WIB, UTC+7)',retry_429:'DEFERRED_SINGLE_RETRY_PASS_WITH_SHARED_COOLDOWN', min_request_interval_ms:Math.max(0,Number(cfg.min_request_interval_ms??180))},summary:{wallets_selected:selected.length,wallets_scanned:0,wallets_with_activity:0,wallets_without_activity:0,rate_limited_initial:0,retry_attempted:0,retry_recovered:0,retry_still_rate_limited:0,failed:0,partial_histories:0,complete_histories:0},wallets:[],skipped_wallets:skipped.map(x=>({wallet:x.wallet,priority:x.priority,sources:x.sources,reason:'MAX_WALLETS_CAP'})),rate_limited_wallets:[],errors:[],data_sources:['Phase 7 database wallet matching artifact','Phase 3 holder discovery artifact','Phase 5 creator/dev artifact','Phase 6 fee economics artifact','Helius Enhanced Transactions API']};
  console.log(`Mint             : ${mint}\nCandidates       : ${candidates.length}\nSelected         : ${selected.length}\nConcurrency      : ${concurrency}\nPriority pages   : HIGH ${maxPagesByPriority.HIGH} / MEDIUM ${maxPagesByPriority.MEDIUM} / LOW ${maxPagesByPriority.LOW}\nTimezone         : WIB (UTC+7)\n`);
  const byAddress=new Map();
  for(const m of (input.phase7.matches||[])) byAddress.set(m.wallet,m);
  for(const h of (input.phase3?.holders||[])) if(!byAddress.has(h.owner)) byAddress.set(h.owner,{wallet:h.owner,display:short(h.owner),database:{matched:false,name:null,roles:[]},current:{is_holder:rawBigInt(h.amount_raw)>0n,balance_raw:String(h.amount_raw??'0'),balance_ui:h.amount_ui??null,supply_percentage:h.supply_percentage??null,holder_rank:h.rank??null},appearances:[]});
  const outputs=new Map(); let cursor=0,done=0,active=0,rateWallets=[];
  async function processCandidate(c,retry=false){
    const base=byAddress.get(c.wallet)||{wallet:c.wallet,display:short(c.wallet),database:{matched:false,name:null,roles:[]},current:{is_holder:false,balance_raw:'0',balance_ui:0},appearances:[]};
    const pages=maxPagesByPriority[c.priority]||maxPagesByPriority.LOW;
    try {
      const history=await requestHistory(c.wallet,mint,config,pages,decimals,maxEvents);
      outputs.set(c.wallet,{wallet:c.wallet,display:base.display||short(c.wallet),database:base.database||{matched:false,name:null,roles:[]},sources:c.sources,source_context:c.source_context,priority:c.priority,current:base.current||{},history,position:summarizePosition(c,history,!!base.current?.is_holder)});
      if(retry){result.summary.retry_recovered++;}
      return {ok:true};
    } catch(e){
      if(e.message==='HTTP_429'){
        if(!retry){rateWallets.push(c);result.summary.rate_limited_initial++;}
        else result.summary.retry_still_rate_limited++;
        outputs.set(c.wallet,{wallet:c.wallet,display:base.display||short(c.wallet),database:base.database||{matched:false,name:null,roles:[]},sources:c.sources,source_context:c.source_context,priority:c.priority,current:base.current||{},history:{status:'RATE_LIMITED',coverage:{retrieval_mode:'FAILED',status:'FAILED',reason:'RATE_LIMIT',scope:'UNKNOWN_SCOPE',rate_limit:{encountered:true,retry_count:1,recovered:false,final_state:'RETRY_EXHAUSTED'}},coverage_legacy:'UNKNOWN',pages:0,transactions:0,events:[],counts_observed:{BUY:null,SELL:null,RECEIVE:null,TRANSFER_OUT:null,SELF_TRANSFER:null,UNKNOWN:null},error:'HTTP_429',recovery:retry?{attempted:true,status:'STILL_RATE_LIMITED'}:{attempted:false},note:'No behavioral conclusion is made when history retrieval is rate-limited.'},position:{status:'UNKNOWN',note:'History unavailable due to HTTP 429.'}});
      } else {
        result.summary.failed++;
        outputs.set(c.wallet,{wallet:c.wallet,display:base.display||short(c.wallet),database:base.database||{matched:false,name:null,roles:[]},sources:c.sources,source_context:c.source_context,priority:c.priority,current:base.current||{},history:{status:'FAILED',coverage:{retrieval_mode:'FAILED',status:'FAILED',reason:'REQUEST_FAILED',scope:'UNKNOWN_SCOPE',rate_limit:{encountered:false,retry_count:0,recovered:false,final_state:'NOT_ENCOUNTERED'}},coverage_legacy:'UNKNOWN',pages:0,transactions:0,events:[],counts_observed:{BUY:null,SELL:null,RECEIVE:null,TRANSFER_OUT:null,SELF_TRANSFER:null,UNKNOWN:null},error:e.message},position:{status:'UNKNOWN',note:'History retrieval failed; no behavioral conclusion is made.'}});
        result.errors.push({wallet:c.wallet,error:e.message});
      }
      return {ok:false,error:e.message};
    }
  }
  async function worker(){while(true){const i=cursor++;if(i>=selected.length)return;const c=selected[i];active++;const t=Date.now();await processCandidate(c,false);active--;done++;const w=outputs.get(c.wallet);console.log(`  [${String(done).padStart(3)}/${selected.length}] ${String(w?.display||short(c.wallet)).padEnd(12)} ${String(w?.history?.status||'UNKNOWN').padEnd(14)} ${c.priority.padEnd(6)} ${Date.now()-t}ms`);if(done%10===0||done===selected.length)console.log(`      Progress ${done}/${selected.length} | Active ${active} | 429 ${result.summary.rate_limited_initial} | Failed ${result.summary.failed}`);}}
  await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},()=>worker()));
  if(rateWallets.length){const delay=Math.max(0,Number(cfg.retry_429_pass_delay_ms??4000));console.log(`\n429 recovery pass: ${rateWallets.length} wallet(s), waiting ${delay}ms...`);await sleep(delay);for(let i=0;i<rateWallets.length;i++){const c=rateWallets[i];result.summary.retry_attempted++;const out=await processCandidate(c,true);const w=outputs.get(c.wallet);if(out.ok&&w?.history){w.history.recovery={attempted:true,status:'FOUND'};}else if(w?.history?.error==='HTTP_429'){w.history.recovery={attempted:true,status:'STILL_RATE_LIMITED'};}console.log(`  [Retry ${i+1}/${rateWallets.length}] ${short(c.wallet)} ${out.ok?'RECOVERED':out.error}`);}}
  result.wallets=[...outputs.values()].sort((a,b)=>({HIGH:0,MEDIUM:1,LOW:2}[a.priority]-({HIGH:0,MEDIUM:1,LOW:2}[b.priority]))||a.wallet.localeCompare(b.wallet));
  for(const w of result.wallets){const h=w.history||{};if(h.status==='FOUND'){result.summary.wallets_scanned++;if((h.events_detected||0)>0)result.summary.wallets_with_activity++;else result.summary.wallets_without_activity++;if(h.complete)result.summary.complete_histories++;else result.summary.partial_histories++;}else if(h.status==='RATE_LIMITED')result.rate_limited_wallets.push(w.wallet);}
  result.status=(result.summary.failed||result.summary.retry_still_rate_limited||result.summary.partial_histories)?'PARTIAL':'COMPLETE';
  result.evaluation_time_utc=new Date().toISOString();
  result.evaluation_time_wib=wib(Math.floor(Date.parse(result.evaluation_time_utc)/1000));
  result.wallet_selection={candidate_wallets:candidates.length,selected_wallets:selected.length,skipped_wallets:skipped.length,max_wallets:maxWallets,selection_policy:'PRIORITY_BASED_SELECTED_WALLETS'};
  result.elapsed_seconds=Number(((Date.now()-started)/1000).toFixed(2));
  result.request_metrics={requests_started:requestCount,global_cooldown_until:globalCooldownUntil?new Date(globalCooldownUntil).toISOString():null};
  attachRunMetadata(result,8,input.mint); const file=path.join(input.dir,'phase8-result.json');fs.writeFileSync(file,JSON.stringify(result,null,2),'utf8');
  console.log(`\n════════ PHASE 8 SUMMARY ════════\nStatus                 : ${result.status}\nSelected               : ${selected.length}\nScanned                : ${result.summary.wallets_scanned}\nWith activity          : ${result.summary.wallets_with_activity}\n429 initial            : ${result.summary.rate_limited_initial}\nRetry recovered        : ${result.summary.retry_recovered}\nStill rate-limited     : ${result.summary.retry_still_rate_limited}\nFailed                 : ${result.summary.failed}\nElapsed                : ${result.elapsed_seconds}s\nOutput                 : ${file}\n`);
}
main().catch(e=>{console.error(`FATAL: ${e.stack||e.message}`);process.exitCode=1;});
