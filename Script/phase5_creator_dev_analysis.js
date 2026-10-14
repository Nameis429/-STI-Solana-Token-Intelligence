#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { attachRunMetadata } = require('./run_metadata');
const { paginatedCoverage, emptyOrFailedCoverage, overallCoverage } = require('./phase5_coverage');
const throttle = require('./rpc_throttle');
const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'Config', 'config.json');
const OUTPUT_ROOT = path.join(ROOT, 'Output');
const LEGACY_DATA = path.join(ROOT, 'Data');
const started = Date.now();

const short = x => x && x.length > 12 ? `${x.slice(0, 6)}...${x.slice(-6)}` : x || 'UNKNOWN';
const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const rawBigInt = x => { try { return BigInt(String(x ?? '0')); } catch { return 0n; } };
const unique = a => [...new Set((a || []).filter(Boolean))];
const pct = (raw, den) => { const d=rawBigInt(den); return d>0n ? Number(rawBigInt(raw)*1000000n/d)/10000 : null; };
const normalizeTs = v => { const n=Number(v); return Number.isFinite(n) ? (n>20000000000?Math.floor(n/1000):Math.floor(n)) : null; };
const iso = v => { const n=normalizeTs(v); return n ? new Date(n*1000).toISOString() : null; };

function readJson(file){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;} }
function loadConfig(){
  if(!fs.existsSync(CFG)) throw Error('CONFIG_NOT_FOUND');
  const c=JSON.parse(fs.readFileSync(CFG,'utf8'));
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if(!c.helius.api_key) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}
function locateInput(){
  const dirs=fs.existsSync(OUTPUT_ROOT)?fs.readdirSync(OUTPUT_ROOT,{withFileTypes:true}).filter(x=>x.isDirectory()):[];
  const candidates=[];
  for(const d of dirs){
    const dir=path.join(OUTPUT_ROOT,d.name);
    const p4=path.join(dir,'phase4-result.json');
    const p3=path.join(dir,'phase3-result.json');
    const p2=path.join(dir,'phase2-result.json');
    const p1=path.join(dir,'phase1-result.json');
    const f=[p4,p3,p2,p1].find(fs.existsSync);
    if(f){const x=readJson(f); const mint=x?.input?.mint||x?.token?.mint||d.name; if(valid(mint)) candidates.push({mint,file:f,source:path.basename(f)});}
  }
  for(const n of ['phase4-result.json','phase3-result.json','phase2-result.json','phase1-result.json']){
    const f=path.join(LEGACY_DATA,n); if(fs.existsSync(f)){const x=readJson(f);const mint=x?.input?.mint||x?.token?.mint;if(valid(mint)&&!candidates.some(c=>c.mint===mint))candidates.push({mint,file:f,source:`data/${n}`});}
  }
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested) for(let i=candidates.length-1;i>=0;i--) if(candidates[i].mint!==requested) candidates.splice(i,1);
  if(!candidates.length)return null;
  const rank={'phase4-result.json':4,'phase3-result.json':3,'phase2-result.json':2,'phase1-result.json':1};
  candidates.sort((a,b)=>(rank[b.source]||0)-(rank[a.source]||0));
  const x=candidates[0], dir=path.join(OUTPUT_ROOT,x.mint);
  return {mint:x.mint,source:x.source,
    phase1:readJson(path.join(dir,'phase1-result.json'))||null,
    phase2:readJson(path.join(dir,'phase2-result.json'))||null,
    phase3:readJson(path.join(dir,'phase3-result.json'))||null,
    phase4:readJson(path.join(dir,'phase4-result.json'))||null};
}
function save(r,mint){attachRunMetadata(r,5,mint);const dir=path.join(OUTPUT_ROOT,mint);fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'phase5-result.json');fs.writeFileSync(f,JSON.stringify(r,null,2));return f;}

async function requestJson(url,options,label,config,meta={}){
  throttle.configure(config);
  const max=Math.max(1,Number(config.scanner?.max_retries??3));
  const base=Math.max(0,Number(config.scanner?.retry_delay_ms??1000));
  const timeout=Math.max(1000,Number(config.scanner?.request_timeout_ms??15000));
  for(let attempt=1;attempt<=max;attempt++){
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),timeout);
    try{
      console.log(`  ${label} : request (${attempt}/${max})`);
      await throttle.takeSlot();
      const res=await fetch(url,{...options,signal:ctl.signal}); const txt=await res.text(); let body={};
      try{body=txt?JSON.parse(txt):{};}catch{body={raw:txt};}
      if(res.status===401)throw Error('HTTP_401_UNAUTHORIZED');
      if(res.status===403)throw Error('HTTP_403_FORBIDDEN');
      if(throttle.isRetryableStatus(res.status)||res.status>=500){if(res.status===429){const retryAfter=Number(res.headers.get('retry-after'));if(Number.isFinite(retryAfter)&&retryAfter>=0){meta.retry_after_ms=retryAfter*1000;}} if(meta){meta.encountered=meta.encountered||res.status===429;meta.retry_count=(meta.retry_count||0)+(attempt<max?1:0);meta.recovered=false;} if(attempt<max){console.log(`  ↻ RETRY   : HTTP ${res.status}`);const ra=Number(meta?.retry_after_ms||0);await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base,ra)));continue;}throw Error(`HTTP_${res.status}`);}
      if(!res.ok)throw Error(`HTTP_${res.status}: ${body?.error?.message||body?.message||body?.msg||body?.raw||''}`);
      if(body?.error)throw Error(`RPC_${body.error.code??'UNKNOWN'}: ${body.error.message??'Unknown RPC error'}`);
      if(meta?.encountered) meta.recovered=true; if(meta?.encountered) meta.final_state='RECOVERED'; return body;
    }catch(e){
      if(e.message==='HTTP_401_UNAUTHORIZED'||e.message==='HTTP_403_FORBIDDEN')throw e;
      if(attempt>=max){if(meta?.encountered){meta.recovered=false;meta.final_state='RETRY_EXHAUSTED';}throw e;}
      console.log(`  ↻ RETRY   : ${e.name==='AbortError'?'TIMEOUT':e.message}`);
      await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base)));
    }finally{clearTimeout(timer);}
  }
  throw Error('REQUEST_FAILED');
}
async function rpc(rpcUrl,method,params,label,config,result){
  const body={jsonrpc:'2.0',id:`phase5-${Date.now()}-${Math.random()}`,method,params};
  const meta={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED',retry_after_ms:0}; const out=await requestJson(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)},label,config,meta); if(result?.rate_limit){result.rate_limit.encountered=result.rate_limit.encountered||meta.encountered;result.rate_limit.retry_count+=meta.retry_count||0;if(meta.encountered)result.rate_limit.recovered=meta.recovered; if(meta.final_state!=='NOT_ENCOUNTERED')result.rate_limit.final_state=meta.final_state;}
  if(result)result.data_sources.push(`Helius RPC ${method}`);
  return out?.result;
}

function holderMap(p3){const m=new Map();for(const h of (p3?.holders||[]))if(valid(h?.owner))m.set(h.owner,h);return m;}
function classificationMap(p4){const m=new Map();for(const h of (p4?.holders||[]))if(valid(h?.owner))m.set(h.owner,h);return m;}
function phase4Pools(p4,mint){
  const out=[]; const lists=[...(p4?.liquidity_mapping?.confirmed_pools||[]),...(p4?.liquidity_mapping?.significant_pools||[])];
  for(const p of lists){const base=p.base_mint||p.mint_x||p.mintX, quote=p.quote_mint||p.mint_y||p.mintY;const ta=base===mint?(p.pool_base_token_account||p.base_token_account):quote===mint?(p.pool_quote_token_account||p.quote_token_account):null;if(ta)out.push({dex:p.dex||p.program_name||'UNKNOWN',pool:p.pool||p.address||null,token_account:ta,confidence:p.confidence||'UNKNOWN'});}
  return out;
}
function creatorCandidates(p4){
  // coin_creator dari pool AMM generik
  // (PumpSwap/Raydium/dll) adalah PEMBUAT POOL, bukan deployer token — tidak
  // boleh diklaim sebagai creator dengan confidence tinggi (kasus BONK:
  // POOL_COIN_CREATOR acak → Phase 12 AVOID palsu). Cap di LOW + prioritas
  // terakhir; hanya launchpad bonding-curve yang relevan yang boleh
  // menaikkan ini (belum ada di discovery saat ini).
  const out=[];
  for(const p of (p4?.liquidity_mapping?.confirmed_pools||[])){
    if(!valid(p?.coin_creator)) continue;
    out.push({address:p.coin_creator,role:'POOL_COIN_CREATOR',confidence:'LOW',
      evidence:'Phase 4 AMM pool coin_creator (pool creator, BUKAN token deployer — atribusi lemah)'});
  }
  return out;
}
function feePayer(tx){const p=tx?.feePayer||tx?.fee_payer||tx?.transaction?.message?.accountKeys?.find(k=>k?.signer)?.pubkey||tx?.transaction?.message?.accountKeys?.find(k=>k?.signer)?.address;return valid(p)?p:null;}
function parseGtf(r){return Array.isArray(r)?r:(Array.isArray(r?.data)?r.data:[]);}

async function getMintHistory(mint,rpcUrl,config,out,maxPages){
  const all=[]; let paginationToken=null;
  const pages=Math.max(1,Number(maxPages??config.creator_dev?.initial_distribution_max_pages??5));
  let pages_fetched=0, stopped_by_page_cap=false, stopped_by_short_page=false, cursor_used=false;
  try {
    for(let p=1;p<=pages;p++){
      const params={transactionDetails:'full',sortOrder:'asc',limit:100,filters:{status:'succeeded'},maxSupportedTransactionVersion:1};
      if(paginationToken) { params.paginationToken=paginationToken; cursor_used=true; }
      const rr=await rpc(rpcUrl,'getTransactionsForAddress',[mint,params],`Mint history (initial distribution) p${p}`,config,out);
      const rows=parseGtf(rr); pages_fetched=p; all.push(...rows);
      paginationToken=rr?.paginationToken||rr?.pagination_token||null;
      if(rows.length<100){stopped_by_short_page=true;break;}
      if(!paginationToken)break;
      if(p===pages) stopped_by_page_cap=true;
    }
  } catch(e) {
    Object.defineProperty(all,'meta',{value:{requested_pages:pages,pages_fetched,raw_transactions:all.length,unique_transactions:all.length,stopped_by_page_cap:false,stopped_by_short_page:false,has_more_possible:true,failed:true,error:e.message},enumerable:false});
    throw e;
  }
  const seen=new Set(), deduped=[];
  for(const tx of all){const key=tx?.signature||`${tx?.slot||''}:${tx?.blockTime||tx?.block_time||''}`;if(seen.has(key))continue;seen.add(key);deduped.push(tx);}
  Object.defineProperty(deduped,'meta',{value:{requested_pages:pages,pages_fetched,raw_transactions:all.length,unique_transactions:deduped.length,stopped_by_page_cap,stopped_by_short_page,has_more_possible:Boolean(stopped_by_page_cap),cursor_used},enumerable:false});
  return deduped;
}
function positiveDeltas(tx,mint){
  const pre=new Map(); for(const b of (tx?.meta?.preTokenBalances||[]))if(b?.mint===mint)pre.set(Number(b.accountIndex),rawBigInt(b.uiTokenAmount?.amount));
  const out=[]; for(const b of (tx?.meta?.postTokenBalances||[])){if(b?.mint!==mint||!valid(b?.owner))continue;const before=pre.get(Number(b.accountIndex))||0n, after=rawBigInt(b.uiTokenAmount?.amount), d=after-before;if(d>0n)out.push({address:b.owner,amount_raw:d.toString(),decimals:Number(b.uiTokenAmount?.decimals??0),signature:tx.signature||null,slot:tx.slot||null,block_time:normalizeTs(tx.blockTime||tx.block_time),timestamp:iso(tx.blockTime||tx.block_time),fee_payer:feePayer(tx)});}return out;
}

async function getTransfers(address,mint,rpcUrl,config,out,label,maxPages){
  const all=[]; let paginationToken=null; const pages=Math.max(1,Number(maxPages??config.creator_dev?.creator_transfer_max_pages??10));
  let pages_fetched=0, stopped_by_page_cap=false, stopped_by_short_page=false, cursor_used=false;
  for(let p=1;p<=pages;p++){
    const params={mint,direction:'out',limit:100}; if(paginationToken) { params.paginationToken=paginationToken; cursor_used=true; }
    try {
      const r=await rpc(rpcUrl,'getTransfersByAddress',[address,params],`${label||`Outbound token transfers ${short(address)}`} p${p}`,config,out);
      const rows=Array.isArray(r?.data)?r.data:(Array.isArray(r)?r:[]); pages_fetched=p; all.push(...rows);
      paginationToken=r?.paginationToken||r?.pagination_token||null;
      if(rows.length<100){stopped_by_short_page=true;break;}
      if(!paginationToken)break;
      if(p===pages) stopped_by_page_cap=true;
    } catch(e) {
      e.coverage={pages_requested:pages,pages_fetched,records_observed:all.length,stopped_by_page_cap:false,stopped_by_short_page:false,has_more_possible:true,cursor_used,failed:true,error:e.message}; throw e;
    }
  }
  const seen=new Set(), deduped=[]; for(const t of all){const key=t?.signature?`${t.signature}:${t.transactionIdx??''}:${t.instructionIdx??''}:${t.innerInstructionIdx??''}`:JSON.stringify(t);if(seen.has(key))continue;seen.add(key);deduped.push(t);}
  Object.defineProperty(deduped,'meta',{value:{requested_pages:pages,pages_fetched,raw_transfers:all.length,unique_transfers:deduped.length,stopped_by_page_cap,stopped_by_short_page,has_more_possible:Boolean(stopped_by_page_cap),cursor_used},enumerable:false});
  return deduped;
}
async function getEnhanced(address,apiBase,key,config,out,maxPages,label){
  const all=[];let before=null;const pages=Math.max(1,Number(maxPages||1));let pages_fetched=0,stopped_by_page_cap=false,stopped_by_short_page=false,cursor_used=false;
  for(let p=1;p<=pages;p++){
    let url=`${apiBase}/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(key)}&limit=100`;if(before) { url+=`&before-signature=${encodeURIComponent(before)}`; cursor_used=true; }
    try {
      const meta={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'}; const body=await requestJson(url,{method:'GET',headers:{Accept:'application/json'}},label||`Enhanced history ${short(address)} p${p}`,config,meta); if(out?.rate_limit){out.rate_limit.encountered=out.rate_limit.encountered||meta.encountered;out.rate_limit.retry_count+=meta.retry_count||0;if(meta.encountered)out.rate_limit.recovered=meta.recovered;if(meta.final_state!=='NOT_ENCOUNTERED')out.rate_limit.final_state=meta.final_state;}const arr=Array.isArray(body)?body:[];pages_fetched=p;all.push(...arr);
      if(arr.length<100){stopped_by_short_page=true;break;} before=arr[arr.length-1]?.signature;if(!before)break; if(p===pages)stopped_by_page_cap=true;
    } catch(e){e.coverage={pages_requested:pages,pages_fetched,records_observed:all.length,stopped_by_page_cap:false,stopped_by_short_page:false,has_more_possible:true,cursor_used,failed:true,error:e.message};throw e;}
  }
  Object.defineProperty(all,'meta',{value:{requested_pages:pages,pages_fetched,raw_transactions:all.length,unique_transactions:all.length,stopped_by_page_cap,stopped_by_short_page,has_more_possible:Boolean(stopped_by_page_cap),cursor_used},enumerable:false});
  return all;
}
function swapSellSignatures(address,mint,txs){
  const set=new Set(); for(const tx of txs||[]){const type=String(tx?.type||'').toUpperCase(), desc=String(tx?.description||'').toLowerCase(), tt=Array.isArray(tx?.tokenTransfers)?tx.tokenTransfers:[];const tokenIn=tt.some(x=>x?.mint===mint&&(x?.fromUserAccount===address||x?.from_user_account===address));if(type==='SWAP'&&tokenIn)set.add(tx.signature);else if(type==='SWAP'&&desc.includes('sell')&&tokenIn)set.add(tx.signature);}return set;
}
function classifyTransfers(address,mint,transfers,pools,sells){
  const poolAccounts=new Set(pools.map(x=>x.token_account).filter(Boolean));return transfers.map(t=>{const to=t.toUserAccount||t.to_user_account||t.toTokenAccount||t.to_token_account||null;const sig=t.signature||null;const pool=Boolean(to&&poolAccounts.has(to));const sell=Boolean(sig&&sells.has(sig));return {signature:sig,slot:t.slot||null,block_time:normalizeTs(t.blockTime||t.block_time),timestamp:iso(t.blockTime||t.block_time),type:t.type||'transfer',from:t.fromUserAccount||t.from_user_account||address,to,amount_raw:String(t.amount??t.amount_raw??'0'),amount_ui:t.uiAmount??t.ui_amount??null,counterparty:to,event_class:sell?'SELL':(pool?'SELL_CANDIDATE':'TRANSFER_OUT'),pool_match:pool};});
}
function sumAmount(events){return events.reduce((n,e)=>n+rawBigInt(e.amount_raw),0n);}
function eventSummary(events,supply){const sells=events.filter(e=>e.event_class==='SELL'),cand=events.filter(e=>e.event_class==='SELL_CANDIDATE'),outs=events.filter(e=>e.event_class!=='SELL'&&e.event_class!=='SELL_CANDIDATE');return {sell_count:sells.length,sell_amount_raw:sumAmount(sells).toString(),sell_pct_supply:pct(sumAmount(sells),supply),sell_candidate_count:cand.length,sell_candidate_amount_raw:sumAmount(cand).toString(),transfer_out_count:outs.length,transfer_out_amount_raw:sumAmount(outs).toString(),last_sell:sells[0]||null,last_sell_candidate:cand[0]||null,last_transfer_out:events[0]||null};}

function buildDistribution(acq,creator,supply){
  const creatorAcq=acq.filter(x=>x.address===creator); const initial=creatorAcq.reduce((n,x)=>n+rawBigInt(x.amount_raw),0n);
  const firstByWallet=new Map(); for(const x of acq){if(!firstByWallet.has(x.address))firstByWallet.set(x.address,x);} 
  const walletList=[...firstByWallet.values()].sort((a,b)=>rawBigInt(b.amount_raw)>rawBigInt(a.amount_raw)?1:-1);
  return {creator_initial_allocation_raw:initial.toString(),creator_initial_allocation_pct_supply:pct(initial,supply),first_acquisition_wallet_count:firstByWallet.size,first_acquisitions:walletList};
}

async function main(){
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ PHASE 5 v2 — CREATOR / DEV INTELLIGENCE             ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  let config;try{config=loadConfig();}catch(e){console.log(`STATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1;return;}
  const input=locateInput();if(!input){console.log('STATUS     : FAILED ✗\nERROR      : PHASE_INPUT_NOT_FOUND');process.exitCode=1;return;}
  const mint=input.mint,p2=input.phase2||{},p3=input.phase3||{},p4=input.phase4||{};const supply=String(p2?.token?.supply??input.phase1?.token?.supply??'0');const decimals=Number(p2?.token?.decimals??6);const holders=holderMap(p3), classes=classificationMap(p4), pools=phase4Pools(p4,mint);
  const r={phase:5,phase_name:'CREATOR_DEV_ANALYSIS',version:'2.1',status:'FAILED',timestamp:new Date().toISOString(),elapsed_seconds:null,input:{mint,source:input.source},helius:{network:config.helius.network,rpc_health:'UNKNOWN'},rate_limit:{encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'},scope:{purpose:'Creator/dev evidence and bounded relationship mapping; no final scoring or behavioral verdicts.',max_score_component:10,configuration:{
      max_direct_recipients:Number(config.creator_dev?.max_direct_recipients??10),
      creator_history_max_pages:Number(config.creator_dev?.creator_history_max_pages??2),
      creator_transfer_max_pages:Number(config.creator_dev?.creator_transfer_max_pages??10),
      related_wallet_enabled:config.creator_dev?.related_wallet_enabled!==false,
      related_wallet_max:Number(config.creator_dev?.related_wallet_max??10),
      related_wallet_history_max_pages:Number(config.creator_dev?.related_wallet_history_max_pages??1),
      related_transfer_max_pages:Number(config.creator_dev?.related_transfer_max_pages??5),
      initial_distribution_enabled:config.creator_dev?.initial_distribution_enabled!==false,
      initial_distribution_max_pages:Number(config.creator_dev?.initial_distribution_max_pages??2),
      max_initial_distribution_clusters:Number(config.creator_dev?.max_initial_distribution_clusters??30),
      max_wallets_per_cluster:Number(config.creator_dev?.max_wallets_per_cluster??100),
      funding_enabled:config.creator_dev?.funding_enabled===true,
      funding_max_depth:Number(config.creator_dev?.funding_max_depth??0),
      funding_max_wallets:Number(config.creator_dev?.funding_max_wallets??0)
    },principles:['Creator/dev identity is evidence-based and may remain UNKNOWN.','Creator is not automatically developer.','Bundler candidate is not proof of common ownership.','Outbound transfer is not automatically a sell.','Historical and current states are separated.','Phase 5 uses Phase 3/4 holder intelligence before adding new RPC work.','Related-wallet analysis is bounded to direct creator recipients; no recursive wallet hunting.','Initial distribution coverage is explicitly reported; reaching the configured page cap is PARTIAL, not COMPLETE.','Recipient totals are calculated from all discovered recipients; display caps only limit detailed per-wallet output.']},
    creator_discovery:{status:'UNKNOWN',candidates:[],selected:null,transaction_sample_count:0,enhanced_transactions_fetched:0,initial_acquisitions:[],errors:[]},
    ownership:{creator_address:null,initial_balance_raw:null,initial_balance_ui:null,initial_percentage_supply:null,initial_allocation_slot:null,current_balance_raw:null,current_balance_ui:null,current_percentage_supply:null,transferred_from_creator_raw:null,distribution_percentage_of_initial:null,holder_found:false,evidence:[],confidence:'UNKNOWN'},
    creator_events:{sell:{status:'UNKNOWN',sell_count:0,sell_amount_raw:'0',sell_amount_ui:0,sell_pct_supply:null,last_sell:null},transfers:{outbound_count:0,outbound_amount_raw:'0',destinations:[],last_transfer:null},burn_count:0,lp_interaction_count:0},
    creator_distribution:{status:'UNKNOWN',recipients:[],recipient_count:0,total_transferred_raw:'0',total_transferred_pct_supply:null,unaccounted_initial_raw:null,unaccounted_initial_pct_supply:null,evidence:[]},
    related_wallets:{status:'NOT_PERFORMED',analysis_cap:0,analyzed_count:0, wallets:[],note:'Direct creator recipients only; each recipient is checked against Phase 3/4 and bounded token transfer history.'},
    initial_distribution:{status:'UNKNOWN',mint_history_transactions:0,pagination:null,coverage_status:'UNKNOWN',unique_acquisition_events:0,first_distribution_time:null,first_distribution_slot:null,unique_wallets:0,clusters:[],bundler_candidates:[],note:'Same-slot/time clustering is distribution evidence only; it is not proof of bundling or common ownership.'},
    funding_relationships:{status:'NOT_PERFORMED',candidates:[],note:'No recursive funding graph in Phase 5 v2.'},
    dev_relationship:{status:'UNKNOWN',address:null,evidence:[],confidence:'UNKNOWN',note:'Creator, pool coin_creator, fee payer, recipients and distribution clusters are not automatically classified as developer.'},
    timeline:{mint_transaction_time:null,first_creator_acquisition:null,last_creator_sell:null,last_creator_transfer:null,current_creator_balance_raw:null,current_creator_percentage_supply:null,related_wallet_sell_count:0,status:'UNKNOWN'},
    data_sources:[],missing:[],errors:[],
    coverage:{initial_distribution:null,creator_transfers:null,creator_enhanced_history:null,related_wallets:null,overall:null}};

  console.log(`TOKEN\n  Mint       : ${short(mint)}\n  Network    : ${config.helius.network}\n  Input      : ${input.source}\n\nCONFIG\n  Creator recipients : ${config.creator_dev?.max_direct_recipients ?? 10}\n  Creator history    : ${config.creator_dev?.creator_history_max_pages ?? 2} pages
  Creator transfers : ${config.creator_dev?.creator_transfer_max_pages ?? 10} pages\n  Related wallets    : ${config.creator_dev?.related_wallet_max ?? 10}\n  Related history    : ${config.creator_dev?.related_wallet_history_max_pages ?? 1} pages\n  Distribution       : ${config.creator_dev?.initial_distribution_max_pages ?? 5} pages\n  Funding recursion  : ${config.creator_dev?.funding_enabled ? 'ON' : 'OFF'}\n\nHELIUS CONNECTION`);
  const rpcBase=String(config.helius.rpc_url).trim(),rpcUrl=`${rpcBase}${rpcBase.includes('?')?'&':'?'}api-key=${encodeURIComponent(config.helius.api_key)}`,apiBase=String(config.helius.api_base_url||'https://api.helius.xyz').replace(/\/$/,'');
  try{
    const health=await rpc(rpcUrl,'getHealth',[],'Helius RPC',config,r);if(health!=='ok')throw Error('HELIUS_RPC_HEALTH_NOT_OK');r.helius.rpc_health='OK';console.log('  ✓ API / RPC  : AUTHENTICATED\n  ✓ RPC Health  : OK\n\nCREATOR DISCOVERY');

    // Correct DAS JSON-RPC shape: params is an object, not an array.
    try{
      const asset=await rpc(rpcUrl,'getAsset',{id:mint,displayOptions:{showFungible:true}},'DAS getAsset (creator)',config,r);
      for(const c of (Array.isArray(asset?.content?.metadata?.creators)?asset.content.metadata.creators:[]))if(valid(c?.address))r.creator_discovery.candidates.push({address:c.address,role:'METADATA_CREATOR',confidence:c.verified?'HIGH':'MEDIUM',evidence:'Helius DAS asset metadata creator entry',verified:Boolean(c.verified)});
      const auth=Array.isArray(asset?.authorities)?asset.authorities:[];for(const a of auth)if(valid(a?.address))r.creator_discovery.candidates.push({address:a.address,role:'DAS_AUTHORITY',confidence:'MEDIUM',evidence:'Helius DAS asset authority entry',scopes:a.scopes||null});
    }catch(e){r.creator_discovery.errors.push({method:'getAsset',message:e.message});}

    for(const c of creatorCandidates(p4))r.creator_discovery.candidates.push(c);
    let txs=[];try{txs=config.creator_dev?.initial_distribution_enabled===false ? [] : await getMintHistory(mint,rpcUrl,config,r,Number(config.creator_dev?.initial_distribution_max_pages??5));r.creator_discovery.transaction_sample_count=txs.length;}catch(e){r.creator_discovery.errors.push({method:'getTransactionsForAddress',message:e.message});r.coverage.initial_distribution=emptyOrFailedCoverage({failed:true,observed:e.coverage?.records_observed||0,rateLimit:r.rate_limit});}
    const acq=txs.flatMap(tx=>positiveDeltas(tx,mint));
    r.creator_discovery.initial_acquisitions=acq;
    r.initial_distribution.pagination=txs.meta||null;
    r.coverage.initial_distribution=txs.meta ? paginatedCoverage({pagesRequested:txs.meta.requested_pages,pagesFetched:txs.meta.pages_fetched,pageSize:100,recordsObserved:txs.meta.raw_transactions??txs.length,recordsRetained:txs.length,paginationToken:txs.meta.cursor_used,stoppedByCap:Boolean(txs.meta.stopped_by_page_cap),rateLimit:r.rate_limit}) : emptyOrFailedCoverage({attempted:false});
    const by=new Map();const rank={HIGH:3,MEDIUM:2,LOW:1,UNKNOWN:0};
    for(const c of r.creator_discovery.candidates){if(!valid(c.address))continue;const prev=by.get(c.address);if(!prev||(rank[c.confidence]||0)>(rank[prev.confidence]||0))by.set(c.address,{...c});else prev.evidence=`${prev.evidence}; ${c.evidence}`;}
    r.creator_discovery.candidates=[...by.values()];
    const roleOrder=['METADATA_CREATOR','DAS_AUTHORITY','POOL_COIN_CREATOR'];let selected=null;for(const role of roleOrder){selected=r.creator_discovery.candidates.find(c=>c.role===role);if(selected)break;}
    if(!selected){const first=txs[0];const payer=first&&feePayer(first);if(valid(payer))selected={address:payer,role:'MINT_TRANSACTION_FEE_PAYER',confidence:'MEDIUM',evidence:'Earliest successful mint-address transaction fee payer'};}
    if(selected){r.creator_discovery.selected=selected;r.creator_discovery.status='FOUND';console.log(`  Creator cand : ${short(selected.address)} (${selected.role})\n  Confidence   : ${selected.confidence}`);}else console.log('  Creator      : UNKNOWN');

    const creator=selected?.address||null;
    const distribution=buildDistribution(acq,creator,supply);
    r.initial_distribution.mint_history_transactions=txs.length;r.initial_distribution.unique_wallets=new Set(acq.map(x=>x.address)).size;
    r.initial_distribution.unique_acquisition_events=acq.length;
    r.initial_distribution.coverage_status=r.coverage.initial_distribution.status;
    if(acq.length){const times=acq.map(x=>x.block_time).filter(Number.isFinite);r.initial_distribution.first_distribution_time=iso(Math.min(...times));r.initial_distribution.first_distribution_slot=Math.min(...acq.map(x=>Number(x.slot)||Number.MAX_SAFE_INTEGER));}
    const groups=new Map();
    const clusterWindow=Math.max(1,Number(config.creator_dev?.initial_distribution_time_window_seconds??60));
    for(const a of acq){
      const key=Number.isFinite(Number(a.slot))?`slot:${a.slot}`:(Number.isFinite(a.block_time)?`time:${Math.floor(a.block_time/clusterWindow)*clusterWindow}`:'unknown');
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(a);
    }
    const clusters=[...groups.entries()]
      .filter(([,g])=>new Set(g.map(x=>x.address)).size>=2)
      .sort((a,b)=>Number(b[1][0]?.slot||0)-Number(a[1][0]?.slot||0))
      .slice(0,Math.max(0,Number(config.creator_dev?.max_initial_distribution_clusters??30)))
      .map(([key,g])=>({cluster_key:key,slot:g[0].slot,timestamp:g[0].timestamp,wallet_count:new Set(g.map(x=>x.address)).size,wallets:unique(g.map(x=>x.address)).slice(0,Math.max(0,Number(config.creator_dev?.max_wallets_per_cluster??100))),total_amount_raw:sumAmount(g).toString(),creator_involved:Boolean(creator&&g.some(x=>x.address===creator)),evidence:key.startsWith('slot:')?'Multiple positive target-token balance deltas in the same slot':'Multiple positive target-token balance deltas in the same time window',confidence:'LOW'}));
    r.initial_distribution.clusters=clusters;
    r.initial_distribution.bundler_candidates=clusters.filter(c=>c.wallet_count>=3).map(c=>({...c,evidence:`${c.evidence}; candidate only`,confidence:'LOW'}));
    r.initial_distribution.status=acq.length?'ANALYZED':'UNKNOWN';

    let related=[];
    if(creator){
      const creatorAcq=acq.filter(x=>x.address===creator).sort((a,b)=>Number(a.slot||0)-Number(b.slot||0)||Number(a.block_time||0)-Number(b.block_time||0));const firstCreatorSlot=creatorAcq.length?Number(creatorAcq[0].slot||0):null;const initialCreatorEvents=creatorAcq.filter(x=>firstCreatorSlot!==null?Number(x.slot||0)===firstCreatorSlot:Number(x.block_time||0)===Number(creatorAcq[0]?.block_time||0));const initRaw=initialCreatorEvents.reduce((n,x)=>n+rawBigInt(x.amount_raw),0n);const h=holders.get(creator);
      r.ownership.creator_address=creator;r.ownership.initial_balance_raw=initRaw.toString();r.ownership.initial_balance_ui=Number(initRaw)/(10**decimals);r.ownership.initial_percentage_supply=pct(initRaw,supply);r.ownership.initial_allocation_slot=firstCreatorSlot;r.ownership.current_balance_raw=h?String(h.amount_raw):null;r.ownership.current_balance_ui=h?.amount_ui??null;r.ownership.current_percentage_supply=h?pct(h.amount_raw,supply):null;r.ownership.holder_found=Boolean(h);r.ownership.evidence.push('Phase 3 holder snapshot','Bounded mint-history positive balance deltas');r.ownership.confidence=h?'HIGH':'MEDIUM';
      console.log('\nCREATOR OWNERSHIP');console.log(`  Initial     : ${r.ownership.initial_balance_ui==null?'UNKNOWN':r.ownership.initial_balance_ui}`);console.log(`  Initial %   : ${r.ownership.initial_percentage_supply==null?'UNKNOWN':r.ownership.initial_percentage_supply.toFixed(4)+'%'}`);console.log(`  Current     : ${r.ownership.current_balance_ui==null?'UNKNOWN':r.ownership.current_balance_ui}`);console.log(`  Current %   : ${r.ownership.current_percentage_supply==null?'UNKNOWN':r.ownership.current_percentage_supply.toFixed(4)+'%'}`);

      console.log('\nCREATOR EVENTS');
      let transfers=[]; try { transfers=await getTransfers(creator,mint,rpcUrl,config,r,`Creator transfers ${short(creator)}`,Number(config.creator_dev?.creator_transfer_max_pages??10)); r.coverage.creator_transfers=paginatedCoverage({pagesRequested:transfers.meta?.requested_pages,pagesFetched:transfers.meta?.pages_fetched,pageSize:100,recordsObserved:transfers.meta?.raw_transfers??transfers.length,recordsRetained:transfers.length,stoppedByCap:Boolean(transfers.meta?.stopped_by_page_cap),rateLimit:r.rate_limit}); } catch(e) { r.errors.push({source:'creator_transfers',message:e.message}); r.coverage.creator_transfers=emptyOrFailedCoverage({failed:true,observed:e.coverage?.records_observed||0,rateLimit:r.rate_limit}); }
      let enhanced=[];try{enhanced=await getEnhanced(creator,apiBase,config.helius.api_key,config,r,Number(config.creator_dev?.creator_history_max_pages??2),`Creator history ${short(creator)}`);r.creator_discovery.enhanced_transactions_fetched=enhanced.length;r.coverage.creator_enhanced_history=paginatedCoverage({pagesRequested:enhanced.meta?.requested_pages,pagesFetched:enhanced.meta?.pages_fetched,pageSize:100,recordsObserved:enhanced.length,recordsRetained:enhanced.length,stoppedByCap:Boolean(enhanced.meta?.stopped_by_page_cap),rateLimit:r.rate_limit});}catch(e){r.errors.push({source:'creator_enhanced_history',message:e.message});r.coverage.creator_enhanced_history=emptyOrFailedCoverage({failed:true,observed:e.coverage?.records_observed||0,rateLimit:r.rate_limit});}
      const sells=swapSellSignatures(creator,mint,enhanced),events=classifyTransfers(creator,mint,transfers,pools,sells),sum=eventSummary(events,supply);r.creator_events.sell={status:sum.sell_count?'FOUND':'NO_SELL_OBSERVED_WITHIN_COVERAGE',sell_count:sum.sell_count,sell_amount_raw:sum.sell_amount_raw,sell_amount_ui:Number(sum.sell_amount_raw)/(10**decimals),sell_pct_supply:sum.sell_pct_supply,last_sell:sum.last_sell};r.creator_events.transfers={outbound_count:transfers.length,outbound_amount_raw:sumAmount(transfers.map(t=>({amount_raw:String(t.amount??0)}))).toString(),destinations:unique(events.map(e=>e.to)),last_transfer:events[0]||null};
      r.timeline.first_creator_acquisition=creatorAcq[0]||null;r.timeline.last_creator_sell=sum.last_sell;r.timeline.last_creator_transfer=events[0]||null;r.timeline.current_creator_balance_raw=r.ownership.current_balance_raw;r.timeline.current_creator_percentage_supply=r.ownership.current_percentage_supply;
      console.log(`  Outbound    : ${transfers.length}\n  SELL        : ${sum.sell_count}\n  SELL cand.  : ${sum.sell_candidate_count}\n  Last SELL   : ${sum.last_sell?.timestamp||'NONE'}`);

      const recipientMap=new Map();for(const e of events){if(!e.to||e.to===creator)continue;if(!recipientMap.has(e.to))recipientMap.set(e.to,{address:e.to,received_raw:0n,transfer_count:0,last_transfer:e});const x=recipientMap.get(e.to);x.received_raw+=rawBigInt(e.amount_raw);x.transfer_count++;if(!x.last_transfer||Number(e.block_time||0)>Number(x.last_transfer.block_time||0))x.last_transfer=e;}
      const cap=Math.max(1,Number(config.creator_dev?.max_direct_recipients??10));
      const allRecipients=[...recipientMap.values()].sort((a,b)=>b.received_raw>a.received_raw?-1:1);
      const recipients=allRecipients.slice(0,cap);
      const allTransferred=allRecipients.reduce((n,x)=>n+x.received_raw,0n);
      r.creator_distribution.status=recipientMap.size ? 'FOUND' : (r.coverage.creator_transfers?.status==='FAILED' ? 'UNKNOWN' : 'NOT_FOUND_WITHIN_COVERAGE');
      r.creator_distribution.recipient_count=recipientMap.size;
      r.creator_distribution.discovered_recipient_count=recipientMap.size;
      r.creator_distribution.returned_recipient_count=recipients.length;
      r.creator_distribution.recipient_limit=cap;
      r.creator_distribution.recipient_limit_reached=recipientMap.size>cap;
      r.creator_distribution.recipients=recipients.map(x=>({address:x.address,received_raw:x.received_raw.toString(),received_ui:Number(x.received_raw)/(10**decimals),received_pct_supply:pct(x.received_raw,supply),transfer_count:x.transfer_count,last_transfer:x.last_transfer}));
      r.creator_distribution.total_transferred_raw=allTransferred.toString();
      r.creator_distribution.total_transferred_pct_supply=pct(allTransferred,supply);
      r.creator_distribution.unaccounted_initial_raw=(initRaw-allTransferred).toString();
      r.creator_distribution.unaccounted_initial_pct_supply=pct(r.creator_distribution.unaccounted_initial_raw,supply);
      r.creator_distribution.distribution_percentage_of_initial=initRaw>0n?pct(allTransferred,initRaw):null;
      r.creator_distribution.evidence.push('Helius creator outbound token transfers; totals use all discovered recipients, not only the displayed recipient cap');
       r.creator_distribution.evidence_status=r.creator_distribution.status==='FOUND'?'VERIFIED':
         (r.creator_distribution.status==='NOT_FOUND_WITHIN_COVERAGE'?'PARTIAL':
           (r.creator_distribution.status==='UNKNOWN'?'UNKNOWN':'INSUFFICIENT_DATA'));

      console.log('\nCREATOR DISTRIBUTION');console.log(`  Recipients  : ${recipientMap.size}`);console.log(`  Total out   : ${Number(sumAmount(events))/(10**decimals)}`);console.log(`  Top checked : ${recipients.length}`);
      console.log('\nRELATED WALLETS');
      const relatedPages=Math.max(1,Number(config.creator_dev?.related_wallet_history_max_pages??1));
      const relatedWalletEnabled=config.creator_dev?.related_wallet_enabled!==false;
      for(const rec of (relatedWalletEnabled ? recipients.slice(0,Math.max(0,Number(config.creator_dev?.related_wallet_max??10))) : [])){
        const h2=holders.get(rec.address), c2=classes.get(rec.address);let ev=[], transferOutCount=null,sellCount=null,lastSell=null,tr=[],eh=[];try{tr=await getTransfers(rec.address,mint,rpcUrl,config,r,`Related transfers ${short(rec.address)}`,Number(config.creator_dev?.related_transfer_max_pages??5));try{eh=await getEnhanced(rec.address,apiBase,config.helius.api_key,config,r,relatedPages,`Related history ${short(rec.address)}`);}catch(e){ev.push(`enhanced_history:${e.message}`);}const se=swapSellSignatures(rec.address,mint,eh), ee=classifyTransfers(rec.address,mint,tr,pools,se);const ss=eventSummary(ee,supply);transferOutCount=tr.length;sellCount=ss.sell_count;lastSell=ss.last_sell;if(ss.sell_count)r.timeline.related_wallet_sell_count+=ss.sell_count;}catch(e){ev.push(`transfer_history:${e.message}`);}
        related.push({address:rec.address,received_raw:rec.received_raw.toString(),received_ui:Number(rec.received_raw)/(10**decimals),received_pct_supply:pct(rec.received_raw,supply),current_balance_raw:h2?String(h2.amount_raw):null,current_balance_ui:h2?.amount_ui??null,current_percentage_supply:h2?pct(h2.amount_raw,supply):null,phase3_holder_found:Boolean(h2),phase4_classification:c2?.classification||null,phase4_confidence:c2?.classification_confidence||null,transfer_out_count:transferOutCount,sell_count:sellCount,last_sell:lastSell,evidence:ev,coverage:{transfers:tr.meta?paginatedCoverage({pagesRequested:tr.meta.requested_pages,pagesFetched:tr.meta.pages_fetched,pageSize:100,recordsObserved:tr.meta.raw_transfers,recordsRetained:tr.length,stoppedByCap:Boolean(tr.meta.stopped_by_page_cap)}):null,enhanced_history:eh.meta?paginatedCoverage({pagesRequested:eh.meta.requested_pages,pagesFetched:eh.meta.pages_fetched,pageSize:100,recordsObserved:eh.length,recordsRetained:eh.length,stoppedByCap:Boolean(eh.meta.stopped_by_page_cap)}):null}});
      }
      r.related_wallets={status:recipients.length?'ANALYZED':'NO_RECIPIENTS',analysis_cap:cap,analyzed_count:related.length,wallets:related,note:'Direct creator recipients only; bounded to configured recipient/history caps. No recursive wallet hunting.'};
      r.creator_distribution.recipients=recipients.map((x,i)=>({...r.creator_distribution.recipients[i],current_balance_raw:related[i]?.current_balance_raw??null,current_balance_ui:related[i]?.current_balance_ui??null,current_percentage_supply:related[i]?.current_percentage_supply??null,phase3_holder_found:related[i]?.phase3_holder_found??false,phase4_classification:related[i]?.phase4_classification??null,related_sell_count:related[i]?.sell_count??null}));
    }else{
      r.missing.push('creator_identity','creator_initial_allocation','creator_distribution');
    }

    r.initial_distribution.note='Initial distribution is derived from bounded positive token balance deltas in mint-address transaction history. Same-slot clusters are candidates only and do not prove bundling.';
    r.data_sources.push('Phase 3 holder snapshot','Phase 4 holder classification','Phase 4 liquidity mapping / pool creator evidence');
    if(r.creator_discovery.errors.length)r.data_sources.push('Helius DAS getAsset attempted');
    r.timeline.status=creator?'COMPLETE_BOUNDED':'UNKNOWN';
    r.coverage.related_wallets=related.length ? (related.some(x=>x.coverage?.transfers?.status==='PARTIAL'||x.coverage?.enhanced_history?.status==='PARTIAL'||x.coverage?.transfers?.status==='FAILED'||x.coverage?.enhanced_history?.status==='FAILED')?'PARTIAL':'COMPLETE') : 'EMPTY';
    r.coverage.overall=overallCoverage(Object.fromEntries(Object.entries(r.coverage).filter(([k])=>k!=='overall').map(([k,v])=>[k,typeof v==='string'?{status:v}:v])));
    r.status=r.coverage.overall==='COMPLETE'?'COMPLETE':r.coverage.overall==='PARTIAL'?'PARTIAL':'COMPLETE';
  }catch(e){r.status='FAILED';r.errors.push({source:'phase5',message:e.message});console.log(`\n  ✗ ${e.message}`);}
  r.elapsed_seconds=Number(((Date.now()-started)/1000).toFixed(2));const out=save(r,mint);
  console.log('\n──────────────────────────────────────────────────────');console.log(`STATUS     : ${r.status==='COMPLETE'?'COMPLETE ✓':r.status==='PARTIAL'?'PARTIAL ⚠':'FAILED ✗'}`);console.log(`TIME       : ${r.elapsed_seconds.toFixed(2)}s`);console.log(`OUTPUT     : ${path.relative(ROOT,out)}`);console.log('──────────────────────────────────────────────────────');if(r.status==='FAILED')process.exitCode=1;
}
if(require.main===module) main().catch(e=>{console.log(`\nSTATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1;});
// Export untuk unit test (A1): atribusi creator tidak boleh mengklaim
// POOL_COIN_CREATOR dengan confidence tinggi.
module.exports = { creatorCandidates };
