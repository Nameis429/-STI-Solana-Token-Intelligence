#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { attachRunMetadata } = require('./run_metadata');
const { baseCoverage, COVERAGE_STATUSES, RETRIEVAL_MODES, COVERAGE_REASONS } = require('./coverage_contract');
const { loadCexIndex } = require('./cex_registry');
const throttle = require('./rpc_throttle');
const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'Config', 'config.json');
const OUTPUT_ROOT = path.join(ROOT, 'Output');
const LEGACY_DATA = path.join(ROOT, 'Data');
const started = Date.now();

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJYbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEFAULT_BURN_ADDRESSES = ['1nc1nerator11111111111111111111111111111111'];
const PUMPSWAP_POOL_MIN_DATA_SIZE = 245;
const PUMPSWAP_POOL_CURRENT_DATA_SIZE = 301;
const PUMPSWAP_POOL_DISCRIMINATOR = 'f19a6d0411b16dbc';

const short = x => x && x.length > 12 ? `${x.slice(0, 6)}...${x.slice(-6)}` : x || 'UNKNOWN';
const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);

function loadConfig() {
  if (!fs.existsSync(CFG)) throw Error('CONFIG_NOT_FOUND');
  const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  c.helius.api_key = String(c.helius?.api_key || '').trim();
  if (!c.helius.api_key || c.helius.api_key.startsWith('PASTE_')) throw Error('HELIUS_API_KEY_NOT_CONFIGURED');
  return c;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function findPhase3Input() {
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested){const p=path.join(OUTPUT_ROOT,requested,'phase3-result.json');const r=readJson(p);if(r&&(r.input?.mint===requested||r.token?.mint===requested))return {data:r,file:p,mint:requested,source:'phase3-result.json'};return null;}
  if (fs.existsSync(OUTPUT_ROOT)) {
    const dirs = fs.readdirSync(OUTPUT_ROOT, {withFileTypes:true}).filter(x=>x.isDirectory());
    for (const d of dirs) {
      const p = path.join(OUTPUT_ROOT, d.name, 'phase3-result.json');
      if (!fs.existsSync(p)) continue;
      const r = readJson(p); const mint = r?.input?.mint || r?.token?.mint;
      if (r && mint) return {data:r,file:p,mint,source:'phase3-result.json'};
    }
  }
  const p = path.join(LEGACY_DATA,'phase3-result.json');
  if (fs.existsSync(p)) {
    const r=readJson(p); const mint=r?.input?.mint || r?.token?.mint;
    if (r && mint) return {data:r,file:p,mint,source:'data/phase3-result.json'};
  }
  return null;
}
function findPhase2(mint) {
  const p=path.join(OUTPUT_ROOT,mint,'phase2-result.json');
  if(fs.existsSync(p)) return readJson(p);
  const q=path.join(LEGACY_DATA,'phase2-result.json');
  return fs.existsSync(q)?readJson(q):null;
}
function save(result,mint) {
  const dir=path.join(OUTPUT_ROOT,mint); fs.mkdirSync(dir,{recursive:true});
  const out=path.join(dir,'phase4-result.json');
  attachRunMetadata(result,4,mint); fs.writeFileSync(out,JSON.stringify(result,null,2),'utf8');
  // Liquidity history archive : append one
  // JSON line per scan with pool base/quote balances. Never fails the run.
  try{
    const entry={snapshot_utc:new Date().toISOString(),
      pools:(result.liquidity_mapping?.significant_pools||[]).map(p=>({
        pool:p.pool,program:p.program_name||p.dex||null,
        base:p?.liquidity_snapshot?.base?.status==='FOUND'?{amount_raw:p.liquidity_snapshot.base.amount_raw,decimals:p.liquidity_snapshot.base.decimals}:null,
        quote:p?.liquidity_snapshot?.quote?.status==='FOUND'?{amount_raw:p.liquidity_snapshot.quote.amount_raw,decimals:p.liquidity_snapshot.quote.decimals}:null}))};
    fs.appendFileSync(path.join(dir,'liquidity_history.jsonl'),JSON.stringify(entry)+'\n','utf8');
  }catch(e){ result.errors.push({source:'liquidity_history_archive',message:String(e?.message||e).slice(0,120)}); }
  return out;
}
async function requestJson(url, options, label, config, tracker) {
  throttle.configure(config);
  const max=Math.max(1,Number(config.scanner?.max_retries??3));
  const base=Math.max(0,Number(config.scanner?.retry_delay_ms??1000));
  const timeout=Math.max(1000,Number(config.scanner?.request_timeout_ms??15000));
  for(let attempt=1;attempt<=max;attempt++){
    const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),timeout);
    try{
      console.log(`  ${label} : request (${attempt}/${max})`);
      await throttle.takeSlot();
      const res=await fetch(url,{...options,signal:ctl.signal});
      const txt=await res.text(); let body={};
      try{body=txt?JSON.parse(txt):{};}catch{body={raw:txt};}
      if(res.status===401) throw Error('HTTP_401_UNAUTHORIZED');
      if(res.status===403) throw Error('HTTP_403_FORBIDDEN');
      if(throttle.isRetryableStatus(res.status)||res.status>=500){
        if(tracker){ tracker.encountered = tracker.encountered || res.status===429; if(res.status===429) tracker.retry_count = Number(tracker.retry_count||0)+1; }
        if(attempt<max){console.log(`  ↻ RETRY   : HTTP ${res.status}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base,throttle.retryAfterMs(res.headers.get('retry-after')))));continue;}
        throw Error(`HTTP_${res.status}`);
      }
      // Other 4xx responses are endpoint/configuration/query errors, not transient.
      if(!res.ok) throw Error(`HTTP_${res.status}: ${body?.error?.message||body?.message||body?.msg||body?.raw||''}`);
      if(body?.error) throw Error(`RPC_${body.error.code??'UNKNOWN'}: ${body.error.message??'Unknown RPC error'}`);
      if(tracker && tracker.encountered) { tracker.recovered = true; tracker.final_state = 'RECOVERED'; }
      return body;
    }catch(e){
      if(e.message==='HTTP_401_UNAUTHORIZED'||e.message==='HTTP_403_FORBIDDEN') throw e;
      if(attempt>=max) { if(tracker && tracker.encountered){ tracker.recovered=false; tracker.final_state='RETRY_EXHAUSTED'; } throw e; }
      console.log(`  ↻ RETRY   : ${e.name==='AbortError'?'TIMEOUT':e.message}`);
      await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base)));
    }finally{clearTimeout(timer);}
  }
  throw Error('REQUEST_FAILED');
}
async function rpc(rpcUrl, method, params, label, config, result, tracker) {
  const body={jsonrpc:'2.0',id:`phase4-${Date.now()}-${Math.random()}`,method,params};
  const out=await requestJson(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)},label,config,tracker);
  if(result) result.data_sources.push(`Helius RPC ${method}`);
  return out?.result;
}
function rawBigInt(x){try{return BigInt(String(x??'0'));}catch{return 0n;}}
function percent(raw,den){const d=rawBigInt(den);return d>0n?Number(rawBigInt(raw)*1000000n/d)/10000:null;}
function sumRaw(items){return items.reduce((n,x)=>n+rawBigInt(x.amount_raw),0n);}
function unique(a){return [...new Set((a||[]).filter(Boolean))];}
function buildProgramIdsChecked(pump, met, orca){
  return unique([
    pump?.program_id || null,
    met?.attempted ? 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' : null,
    orca?.attempted ? 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' : null
  ]);
}
function normalizeMap(list){
  const m=new Map();
  for(const x of (list||[])){
    if(typeof x==='string'&&valid(x))m.set(x,x);
    else if(x&&valid(x.address))m.set(x.address,x.name||x.address);
  }
  return m;
}
function base64Bytes(v){try{return Buffer.from(String(v||''),'base64');}catch{return Buffer.alloc(0);}}
function readPubkey(data,offset){
  const b=data.subarray(offset,offset+32); if(b.length!==32)return null;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num=0n; for(const byte of b)num=num*256n+BigInt(byte);
  let out=''; while(num>0n){const r=Number(num%58n);out=alphabet[r]+out;num/=58n;}
  for(let i=0;i<b.length&&b[i]===0;i++)out='1'+out; return out||'1';
}
function readU64LE(data,offset){
  if(offset+8>data.length)return null; let n=0n;
  for(let i=7;i>=0;i--)n=(n<<8n)+BigInt(data[offset+i]); return n.toString();
}
const PUMPSWAP_LAYOUT={baseMint:43,quoteMint:75,lpMint:107,poolBaseTokenAccount:139,poolQuoteTokenAccount:171,lpSupply:203,coinCreator:211,isMayhemMode:243,isCashbackCoin:244,virtualQuoteReserves:245};
function readI128LE(data,offset){
  if(offset+16>data.length)return null;
  let n=0n; for(let i=15;i>=0;i--)n=(n<<8n)+BigInt(data[offset+i]);
  const sign=1n<<127n; if(n&sign)n-=1n<<128n; return n.toString();
}
function decodePumpSwapPool(pubkey,account){
  const data=base64Bytes(account?.data?.[0]);
  if(data.length<PUMPSWAP_POOL_MIN_DATA_SIZE)return null;
  const discriminator=data.subarray(0,8).toString('hex');
  if(discriminator!==PUMPSWAP_POOL_DISCRIMINATOR)return null;
  const p={pool:pubkey,base_mint:readPubkey(data,43),quote_mint:readPubkey(data,75),lp_mint:readPubkey(data,107),
    pool_base_token_account:readPubkey(data,139),pool_quote_token_account:readPubkey(data,171),
    lp_supply_raw:readU64LE(data,203),coin_creator:readPubkey(data,211),
    is_mayhem_mode:Boolean(data[243]),is_cashback_coin:Boolean(data[244]),
    account_data_length:data.length,
    virtual_quote_reserves_raw:data.length>=261?readI128LE(data,245):null,
    pool_layout:data.length>=PUMPSWAP_POOL_CURRENT_DATA_SIZE?'MODERN_301_OR_EXTENDED':(data.length===245?'LEGACY_245_OR_SHORT':'EXTENDED'),
    program_name:'PumpSwap',
    program_id:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'};
  return p.base_mint&&p.quote_mint&&p.lp_mint&&p.pool_base_token_account&&p.pool_quote_token_account?p:null;
}
function evaluatePumpSwapPoolAccount(pubkey,account,mint,program_id='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'){
  const data=base64Bytes(account?.data?.[0]);
  const out={owner:pubkey,status:'NOT_FOUND',program_owner:account?.owner||null,data_length:data.length,discriminator:data.subarray(0,8).toString('hex'),pool:null,target_mint_match:false};
  if(!account){out.status='NOT_FOUND';return out;}
  if(out.program_owner!==program_id){out.status='WRONG_PROGRAM_OWNER';return out;}
  if(data.length<PUMPSWAP_POOL_MIN_DATA_SIZE){out.status='WRONG_DATA_LENGTH';return out;}
  if(out.discriminator!==PUMPSWAP_POOL_DISCRIMINATOR){out.status='WRONG_DISCRIMINATOR';return out;}
  const pool=decodePumpSwapPool(pubkey,account);
  if(!pool){out.status='DECODE_FAILED';return out;}
  out.pool=pool; out.base_mint=pool.base_mint; out.quote_mint=pool.quote_mint; out.target_mint_match=pool.base_mint===mint||pool.quote_mint===mint;
  out.status=out.target_mint_match?'CONFIRMED_TARGET_POOL':'VALID_PUMPSWAP_POOL';
  return out;
}

function selectPumpSwapOwnerCandidates(holders,classifications,program_id,max=50){
  const rows=(holders||[]).map(h=>({owner:h.owner,amount_raw:h.amount_raw,amount_ui:h.amount_ui,share_of_total_supply_pct:h.share_of_total_supply_pct,classification:classifications.get(h.owner)?.classification||'UNKNOWN',evidence:classifications.get(h.owner)?.evidence||[]}))
    .filter(x=>x.classification==='PROGRAM_CONTROLLED'||x.classification==='PROGRAM'||x.classification==='LP_CANDIDATE')
    .filter(x=>x.evidence.some(e=>String(e)===`owner_program:${program_id}`))
    .sort((a,b)=>rawBigInt(b.amount_raw)>rawBigInt(a.amount_raw)?1:rawBigInt(b.amount_raw)<rawBigInt(a.amount_raw)?-1:0);
  return rows.slice(0,Math.max(0,Number(max)||0));
}

function extractProgramAccountsV2Page(result){
  const r=result||{};
  if(Array.isArray(r)) return {accounts:r,paginationKey:null,totalResults:null,response_shape:'array',accounts_field_present:true};
  const wrapped=Boolean(r?.value && typeof r.value==='object');
  const value=wrapped ? r.value : r;
  const accountsFieldPresent=Object.prototype.hasOwnProperty.call(value||{},'accounts');
  const accounts=Array.isArray(value?.accounts)?value.accounts:[];
  const paginationKey=value?.paginationKey ?? r?.paginationKey ?? null;
  const totalResults=value?.totalResults ?? r?.totalResults ?? null;
  return {accounts,paginationKey,totalResults,response_shape:wrapped?'context_value':'direct',accounts_field_present:accountsFieldPresent};
}
function pumpSwapCoverage({pageSize,pagesFetched,observed,retained,stoppedReason,hasMorePossible,tracker,totalResults}){
  const status=stoppedReason==='NO_MORE_DATA'
    ? (observed>0?COVERAGE_STATUSES.COMPLETE:COVERAGE_STATUSES.EMPTY)
    : COVERAGE_STATUSES.PARTIAL;
  const reason=stoppedReason==='NO_MORE_DATA'
    ? (observed>0?COVERAGE_REASONS.NO_MORE_DATA:COVERAGE_REASONS.NO_MATCH)
    : (stoppedReason==='RECORD_LIMIT'?COVERAGE_REASONS.RECORD_LIMIT:COVERAGE_REASONS.PAGE_LIMIT);
  return baseCoverage({
    retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,
    status, reason,
    scope:status===COVERAGE_STATUSES.COMPLETE?'FULL_AVAILABLE_DATA':'CONFIGURED_PAGE_WINDOW',
    pagination:{
      enabled:true,
      pages_requested:pagesFetched,
      pages_fetched:pagesFetched,
      cursor_used:pagesFetched>1 || hasMorePossible,
      stopped_reason:stoppedReason,
      has_more_possible:hasMorePossible
    },
    records:{
      requested:pagesFetched*pageSize,
      observed,
      retained
    },
    caps:{page_cap:null,record_cap:null,cap_triggered:stoppedReason==='PAGE_LIMIT'||stoppedReason==='RECORD_LIMIT'},
    rateLimit:tracker
  });
}
async function discoverPumpSwap(mint,rpcUrl,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{};
  if(lm.enable_pumpswap===false)return {attempted:false,pools:[],program_id:null,program_name:'PumpSwap',coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.EMPTY,status:COVERAGE_STATUSES.EMPTY,reason:COVERAGE_REASONS.NOT_AVAILABLE,scope:'UNKNOWN_SCOPE'})};
  const program_id=String(lm.pumpswap_program_id||'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const pageSize=Math.max(1,Math.min(10000,Number(lm.pumpswap_page_size??1000)));
  const pageCap=Math.max(1,Number(lm.pumpswap_page_cap??10));
  const recordCap=Math.max(pageSize,Number(lm.pumpswap_record_cap??10000));
  const map=new Map();
  let pagesFetched=0, observed=0, stoppedReason='NO_MORE_DATA', hasMorePossible=false, totalResults=null, hitCap=false;
  const tracker={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
  const diagnostics={pages_with_accounts:0,empty_pages:0,empty_pages_with_cursor:0,accounts_decode_candidates:0,accounts_decoded:0,by_filter:{},filter_mode:'MEMCMP_ONLY',accepted_pool_data_min:PUMPSWAP_POOL_MIN_DATA_SIZE,accepted_pool_data_current:PUMPSWAP_POOL_CURRENT_DATA_SIZE};
  for(const [name,offset] of [['base',43],['quote',75]]){
    let paginationKey=null;
    let exhausted=false;
    let filterPages=0, filterObserved=0;
    for(let page=1;page<=pageCap;page++){
      const cfg={encoding:'base64',limit:pageSize,filters:[{memcmp:{offset,bytes:mint}}]};
      if(paginationKey)cfg.paginationKey=paginationKey;
      const pageResult=await rpc(rpcUrl,'getProgramAccountsV2',[program_id,cfg],`PumpSwap pools (${name}) page ${page}`,config,result,tracker);
      const pageData=extractProgramAccountsV2Page(pageResult);
      const rows=pageData.accounts;
      pagesFetched++; filterPages++; observed+=rows.length; filterObserved+=rows.length;
      totalResults=pageData.totalResults??totalResults;
      if(rows.length)diagnostics.pages_with_accounts++; else {diagnostics.empty_pages++; if(pageData.paginationKey)diagnostics.empty_pages_with_cursor++;}
      diagnostics.accounts_decode_candidates+=rows.length;
      for(const x of rows){
        const p=decodePumpSwapPool(x.pubkey,x.account);
        if(p){diagnostics.accounts_decoded++; if(p.base_mint===mint||p.quote_mint===mint)map.set(p.pool,p);}
      }
      if(observed>=recordCap){hitCap=true;hasMorePossible=Boolean(pageData.paginationKey);break;}
      const nextKey=pageData.paginationKey;
      if(!nextKey){exhausted=true;break;}
      paginationKey=nextKey;
      hasMorePossible=true;
      if(page===pageCap)break;
    }
    diagnostics.by_filter[name]={pages_fetched:filterPages,observed:filterObserved};
    if(hitCap)break;
    if(!exhausted)hasMorePossible=true;
  }
  if(hitCap)stoppedReason='RECORD_LIMIT';
  else if(hasMorePossible)stoppedReason='PAGE_LIMIT';
  else stoppedReason='NO_MORE_DATA';
  const coverage=pumpSwapCoverage({pageSize,pagesFetched,observed,retained:map.size,stoppedReason,hasMorePossible,tracker,totalResults});
  coverage.caps.page_cap=pageCap;
  coverage.caps.record_cap=recordCap;
  coverage.response_diagnostics=diagnostics;
  coverage.response_diagnostics.total_results=totalResults;
  return {attempted:true,pools:[...map.values()],program_id,program_name:'PumpSwap',coverage};
}

async function probePumpSwapPoolCandidates(candidates,mint,rpcUrl,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{};
  const program_id=String(lm.pumpswap_program_id||'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const enabled=lm.pumpswap_direct_owner_probe_enabled!==false;
  const cap=Math.max(0,Number(lm.pumpswap_direct_owner_probe_max??50));
  const batchSize=Math.min(100,Math.max(1,Number(lm.pumpswap_direct_owner_probe_batch_size??25)));
  const source=Array.isArray(candidates)?candidates:[];
  const targets=enabled?source.slice(0,cap):[];
  const tracker={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
  const coverageBase={retrieval_mode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status:COVERAGE_STATUSES.COMPLETE,reason:COVERAGE_REASONS.NO_MORE_DATA,scope:'FULL_AVAILABLE_DATA'};
  const diagnostics={enabled,program_id,candidates_available:source.length,candidates_selected:targets.length,cap,cap_triggered:source.length>targets.length,accounts_observed:0,accounts_decoded:0,target_mint_matches:0,wrong_program_owner:0,not_found:0,wrong_data_length:0,wrong_discriminator:0,decode_failed:0,by_candidate:[]};
  if(!enabled||!targets.length){
    if(!enabled)coverageBase.status=COVERAGE_STATUSES.UNKNOWN,coverageBase.reason=COVERAGE_REASONS.NOT_AVAILABLE,coverageBase.scope='UNKNOWN_SCOPE';
    else coverageBase.status=COVERAGE_STATUSES.EMPTY,coverageBase.reason=COVERAGE_REASONS.NO_MATCH,coverageBase.scope='FULL_AVAILABLE_DATA';
    return {pools:[],coverage:baseCoverage({...coverageBase,retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,pagination:{enabled:false,pages_requested:0,pages_fetched:0,cursor_used:false,stopped_reason:enabled?'NO_MATCH':'NOT_AVAILABLE',has_more_possible:false},records:{requested:targets.length,observed:0,retained:0},caps:{page_cap:null,record_cap:cap,cap_triggered:false},rateLimit:tracker}),diagnostics};
  }
  const pools=new Map();
  let rpcFailed=0;
  for(let i=0;i<targets.length;i+=batchSize){
    const batch=targets.slice(i,i+batchSize);
    try{
      const rows=await rpc(rpcUrl,'getMultipleAccounts',[batch,{encoding:'base64'}],`PumpSwap direct owner probe ${i+1}-${i+batch.length}`,config,result,tracker);
      const vals=Array.isArray(rows?.value)?rows.value:[];
      diagnostics.accounts_observed+=vals.filter(Boolean).length;
      batch.forEach((owner,idx)=>{
        const account=vals[idx]||null;
        const d=evaluatePumpSwapPoolAccount(owner,account,mint,program_id);
        if(d.status==='NOT_FOUND')diagnostics.not_found++;
        else if(d.status==='WRONG_PROGRAM_OWNER')diagnostics.wrong_program_owner++;
        else if(d.status==='WRONG_DATA_LENGTH')diagnostics.wrong_data_length++;
        else if(d.status==='WRONG_DISCRIMINATOR')diagnostics.wrong_discriminator++;
        else if(d.status==='DECODE_FAILED')diagnostics.decode_failed++;
        if(d.pool)diagnostics.accounts_decoded++;
        diagnostics.by_candidate.push(d);
        if(d.status==='CONFIRMED_TARGET_POOL'){diagnostics.target_mint_matches++;pools.set(d.pool.pool,d.pool);}
      });
    }catch(e){rpcFailed+=batch.length;for(const owner of batch)diagnostics.by_candidate.push({owner,status:'PROBE_FAILED',error:e.message});result.errors.push({source:'pumpswap_direct_owner_probe',message:e.message,batch_start:i,batch_size:batch.length});}
  }
  const capTriggered=source.length>targets.length;
  const status=rpcFailed>0?COVERAGE_STATUSES.PARTIAL:(capTriggered?COVERAGE_STATUSES.PARTIAL:(pools.size?COVERAGE_STATUSES.COMPLETE:(targets.length?COVERAGE_STATUSES.EMPTY:COVERAGE_STATUSES.UNKNOWN)));
  const reason=rpcFailed>0?COVERAGE_REASONS.REQUEST_FAILED:(capTriggered?COVERAGE_REASONS.PROBE_LIMIT:(pools.size?COVERAGE_REASONS.NO_MORE_DATA:COVERAGE_REASONS.NO_MATCH));
  const scope=status===COVERAGE_STATUSES.COMPLETE||status===COVERAGE_STATUSES.EMPTY?'FULL_AVAILABLE_DATA':'CONFIGURED_RECORD_WINDOW';
  const coverage=baseCoverage({retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status,reason,scope,pagination:{enabled:false,pages_requested:1,pages_fetched:1,cursor_used:false,stopped_reason:reason,has_more_possible:false},records:{requested:targets.length,observed:diagnostics.accounts_observed,retained:pools.size},caps:{page_cap:null,record_cap:cap,cap_triggered:capTriggered},rateLimit:tracker});
  coverage.response_diagnostics=diagnostics;
  return {pools:[...pools.values()],coverage,diagnostics};
}

function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function extractArray(body){
  const d=body?.data;
  if(Array.isArray(d))return d;
  if(Array.isArray(d?.data))return d.data;
  if(Array.isArray(body?.pairs))return body.pairs;
  return [];
}
function raydiumNormalize(p,mint){
  if(!p?.id)return null;
  const a=p.mintA?.address||p.mintA, b=p.mintB?.address||p.mintB;
  if(a!==mint&&b!==mint)return null;
  return {dex:'Raydium',pool:p.id,pool_type:p.type||p.poolType||p.programId||'UNKNOWN',
    program_id:p.programId||null,base_mint:a,quote_mint:b,
    lp_mint:p.lpMint?.address||p.lpMint||null,
    base_amount_raw:p.mintAmountA??null,quote_amount_raw:p.mintAmountB??null,
    liquidity_usd:num(p.tvl??p.liquidity),volume_24h_usd:num(p.day?.volume??p.volume24h??p.volume24H),
    raw_source:p};
}
async function discoverRaydium(mint,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{};
  if(lm.enable_raydium===false)return {attempted:false,pools:[],source:null,coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.EMPTY,status:COVERAGE_STATUSES.EMPTY,reason:COVERAGE_REASONS.NOT_AVAILABLE,scope:'UNKNOWN_SCOPE'})};
  const base=String(lm.raydium_api_base_url||'https://api-v3.raydium.io').replace(/\/$/,'');
  const pageSize=Math.max(1,Math.min(1000,Number(lm.raydium_page_size??100)));
  const pageCap=Math.max(1,Number(lm.raydium_page_cap??10));
  const recordCap=Math.max(pageSize,Number(lm.raydium_record_cap??5000));
  const pools=[]; let pagesFetched=0, observed=0, retained=0, stopped='NO_MORE_DATA', hasMore=false;
  const tracker={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
  for(let page=1;page<=pageCap;page++){
    const url=`${base}/pools/info/mint?mint1=${encodeURIComponent(mint)}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${pageSize}&page=${page}`;
    const body=await requestJson(url,{method:'GET',headers:{Accept:'application/json'}},`Raydium pool API page ${page}`,config,tracker);
    if(body?.success===false)throw Error(`RAYDIUM_API:${body.msg||'FAILED'}`);
    result.data_sources.push('Raydium API v3 /pools/info/mint');
    const arr=extractArray(body);
    observed += arr.length;
    const remaining=Math.max(0,recordCap-retained);
    const keep=arr.slice(0,remaining).map(x=>raydiumNormalize(x,mint)).filter(Boolean);
    pools.push(...keep); retained += keep.length; pagesFetched=page;
    if(retained>=recordCap){stopped='RECORD_LIMIT';hasMore=true;break;}
    if(arr.length<pageSize){stopped='NO_MORE_DATA';hasMore=false;break;}
    if(page===pageCap){stopped='PAGE_LIMIT';hasMore=true;break;}
  }
  if(pagesFetched===0){stopped='NO_MORE_DATA';hasMore=false;}
  const status=stopped==='NO_MORE_DATA' ? (observed?COVERAGE_STATUSES.COMPLETE:COVERAGE_STATUSES.EMPTY) : COVERAGE_STATUSES.PARTIAL;
  const reason=stopped==='NO_MORE_DATA' ? (observed?COVERAGE_REASONS.NO_MORE_DATA:COVERAGE_REASONS.NO_MATCH) : (stopped==='RECORD_LIMIT'?COVERAGE_REASONS.RECORD_LIMIT:COVERAGE_REASONS.PAGE_LIMIT);
  return {attempted:true,pools,source:base,coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status,reason,scope:status===COVERAGE_STATUSES.COMPLETE?'FULL_AVAILABLE_DATA':'CONFIGURED_PAGE_WINDOW',pagination:{enabled:true,pages_requested:pagesFetched,pages_fetched:pagesFetched,cursor_used:false,stopped_reason:stopped,has_more_possible:hasMore},records:{requested:observed,observed,retained},caps:{page_cap:pageCap,record_cap:recordCap,cap_triggered:stopped==='PAGE_LIMIT'||stopped==='RECORD_LIMIT'},rateLimit:tracker})};
}
function meteoraNormalize(p,mint){
  if(!p)return null;
  const a=p.mint_x||p.tokenXMint||p.token_x_mint||p.mintX, b=p.mint_y||p.tokenYMint||p.token_y_mint||p.mintY;
  const id=p.address||p.public_key||p.publicKey||p.lb_pair||p.lbPair;
  if(!id|| (a!==mint&&b!==mint))return null;
  return {dex:'Meteora',pool:id,pool_type:'DLMM',program_id:'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',base_mint:a,quote_mint:b,lp_mint:p.lp_mint||p.lpMint||null,base_amount_raw:p.reserve_x??p.reserveX??p.token_x_amount??null,quote_amount_raw:p.reserve_y??p.reserveY??p.token_y_amount??null,liquidity_usd:num(p.liquidity??p.tvl),volume_24h_usd:num(p.trade_volume_24h??p.tradeVolume24h??p.volume24h??p.volume_24h),fees_24h_usd:num(p.fees_24h??p.fees24h??p.fees24H),raw_source:p};
}
async function discoverMeteora(mint,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{};
  if(lm.enable_meteora===false)return {attempted:false,pools:[],source:null,coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.EMPTY,status:COVERAGE_STATUSES.EMPTY,reason:COVERAGE_REASONS.NOT_AVAILABLE,scope:'UNKNOWN_SCOPE'})};
  const base=String(lm.meteora_dlmm_api_base_url||'https://dlmm.datapi.meteora.ag').replace(/\/$/,'');
  const pageSize=Math.max(1,Math.min(1000,Number(lm.meteora_page_size??1000)));
  const pageCap=Math.max(1,Number(lm.meteora_page_cap??10));
  const recordCap=Math.max(pageSize,Number(lm.meteora_record_cap??5000));
  const pools=[]; let pagesFetched=0, observed=0, retained=0, stopped='NO_MORE_DATA', hasMore=false;
  const tracker={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
  for(let page=1;page<=pageCap;page++){
    const url=`${base}/pools?page=${page}&page_size=${pageSize}&query=${encodeURIComponent(mint)}`;
    const body=await requestJson(url,{method:'GET',headers:{Accept:'application/json'}},`Meteora DLMM Data API page ${page}`,config,tracker);
    result.data_sources.push('Meteora DLMM Data API /pools?query=<mint>');
    const arr=Array.isArray(body)?body:extractArray(body);
    observed += arr.length;
    const remaining=Math.max(0,recordCap-retained);
    const keep=arr.slice(0,remaining).map(x=>meteoraNormalize(x,mint)).filter(Boolean);
    pools.push(...keep); retained += keep.length; pagesFetched=page;
    if(retained>=recordCap){stopped='RECORD_LIMIT';hasMore=true;break;}
    if(arr.length<pageSize){stopped='NO_MORE_DATA';hasMore=false;break;}
    if(page===pageCap){stopped='PAGE_LIMIT';hasMore=true;break;}
  }
  const status=stopped==='NO_MORE_DATA' ? (observed?COVERAGE_STATUSES.COMPLETE:COVERAGE_STATUSES.EMPTY) : COVERAGE_STATUSES.PARTIAL;
  const reason=stopped==='NO_MORE_DATA' ? (observed?COVERAGE_REASONS.NO_MORE_DATA:COVERAGE_REASONS.NO_MATCH) : (stopped==='RECORD_LIMIT'?COVERAGE_REASONS.RECORD_LIMIT:COVERAGE_REASONS.PAGE_LIMIT);
  return {attempted:true,pools,source:base,coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status,reason,scope:status===COVERAGE_STATUSES.COMPLETE?'FULL_AVAILABLE_DATA':'CONFIGURED_PAGE_WINDOW',pagination:{enabled:true,pages_requested:pagesFetched,pages_fetched:pagesFetched,cursor_used:false,stopped_reason:stopped,has_more_possible:hasMore},records:{requested:observed,observed,retained},caps:{page_cap:pageCap,record_cap:recordCap,cap_triggered:stopped==='PAGE_LIMIT'||stopped==='RECORD_LIMIT'},rateLimit:tracker})};
}
async function discoverOrca(mint,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{};
  if(lm.enable_orca===false)return {attempted:false,pools:[],source:null,note:'disabled'};
  // Orca has multiple Whirlpool pool states and position-NFT liquidity.
  // We intentionally do not guess account offsets here. This adapter reports
  // UNKNOWN until a verified indexed/RPC decoder is configured.
  return {attempted:true,pools:[],source:null,note:'ORCA_DECODER_NOT_ENABLED_IN_V3; NO_OFFSET_GUESSING'};
}
function significant(pool,thresholds){
  const minL=Number(thresholds.min_liquidity_usd??0), minV=Number(thresholds.min_volume_24h_usd??0);
  const l=pool.liquidity_usd, v=pool.volume_24h_usd;
  if(minL<=0&&minV<=0)return true;
  return (l!=null&&l>=minL)||(v!=null&&v>=minV);
}
/* pool tanpa identitas DEX/program yang dikenal
 * (dex/program_name UNKNOWN) adalah false positive deteksi — jangan masuk
 * significant_pools. Pure — bisa di-unit-test. */
function knownDexPool(p){
  const dex=String(p?.dex||p?.program_name||'').trim().toUpperCase();
  return dex!==''&&dex!=='UNKNOWN'&&dex!=='NONE';
}
async function fetchTokenSupply(mint,rpcUrl,config,result){
  try{const r=await rpc(rpcUrl,'getTokenSupply',[mint,{commitment:'confirmed'}],'LP mint supply',config,result);
    return r?.value?{amount:String(r.value.amount),decimals:Number(r.value.decimals||0),ui_amount:r.value.uiAmount}:null;
  }catch{return null;}
}
function ownerClass(owner,account,knownLockerPrograms,knownLockerAddresses,burns){
  if(burns.has(owner)||knownLockerAddresses.has(owner))return burns.has(owner)?'BURN':'LOCKER';
  const program=account?.owner||null, executable=Boolean(account?.executable);
  if(program&&knownLockerPrograms.has(program))return 'LOCKER_PROGRAM';
  if(executable)return 'PROGRAM';
  if(program&&program!==SYSTEM_PROGRAM&&program!==TOKEN_PROGRAM&&program!==TOKEN_2022_PROGRAM)return 'PROGRAM_CONTROLLED';
  return 'WALLET';
}
async function inspectFungibleLpStatus(pool,rpcUrl,config,result){
  const lm=config.holder_concentration?.liquidity_mapping||{}; const st=lm.lp_status||{};
  if(st.enabled===false||!pool.lp_mint)return {status:'NOT_APPLICABLE',reason:'no_fungible_lp_mint',coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.EMPTY,status:COVERAGE_STATUSES.EMPTY,reason:COVERAGE_REASONS.NOT_AVAILABLE,scope:'UNKNOWN_SCOPE'})};
  const supply=await fetchTokenSupply(pool.lp_mint,rpcUrl,config,result); if(!supply)return {status:'UNKNOWN',reason:'lp_mint_supply_unavailable',coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.FAILED,status:COVERAGE_STATUSES.FAILED,reason:COVERAGE_REASONS.REQUEST_FAILED,scope:'UNKNOWN_SCOPE'})};
  const pageSize=Math.max(1,Math.min(1000,Number(lm.lp_status?.page_size??1000))); const pageCap=Math.max(1,Number(lm.lp_status?.page_cap??10)); const recordCap=Math.max(pageSize,Number(lm.lp_status?.record_cap??5000));
  const accounts=[]; let pagesFetched=0, observed=0, stopped='NO_MORE_DATA', hasMore=false; const tracker={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
  for(let page=1;page<=pageCap;page++){
    const lpRows=await requestJson(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:`phase4-lp-${Date.now()}-${page}`,method:'getTokenAccounts',params:{mint:pool.lp_mint,page,limit:pageSize,displayOptions:{}}})},`LP holders (Helius) page ${page}`,config,tracker);
    result.data_sources.push('Helius getTokenAccounts (LP mint)');
    const rows=Array.isArray(lpRows?.result?.token_accounts)?lpRows.result.token_accounts:Array.isArray(lpRows?.result?.tokenAccounts)?lpRows.result.tokenAccounts:[];
    observed += rows.length; const remaining=Math.max(0,recordCap-accounts.length); accounts.push(...rows.slice(0,remaining)); pagesFetched=page;
    if(accounts.length>=recordCap){stopped='RECORD_LIMIT';hasMore=true;break;} if(rows.length<pageSize){stopped='NO_MORE_DATA';hasMore=false;break;} if(page===pageCap){stopped='PAGE_LIMIT';hasMore=true;break;}
  }
  const coverageStatus=stopped==='NO_MORE_DATA'?(observed?COVERAGE_STATUSES.COMPLETE:COVERAGE_STATUSES.EMPTY):COVERAGE_STATUSES.PARTIAL;
  const coverageReason=stopped==='NO_MORE_DATA'?(observed?COVERAGE_REASONS.NO_MORE_DATA:COVERAGE_REASONS.NO_MATCH):(stopped==='RECORD_LIMIT'?COVERAGE_REASONS.RECORD_LIMIT:COVERAGE_REASONS.PAGE_LIMIT);
  const coverage=baseCoverage({retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status:coverageStatus,reason:coverageReason,scope:coverageStatus===COVERAGE_STATUSES.COMPLETE?'FULL_AVAILABLE_DATA':'CONFIGURED_PAGE_WINDOW',pagination:{enabled:true,pages_requested:pagesFetched,pages_fetched:pagesFetched,cursor_used:false,stopped_reason:stopped,has_more_possible:hasMore},records:{requested:observed,observed,retained:accounts.length},caps:{page_cap:pageCap,record_cap:recordCap,cap_triggered:stopped==='PAGE_LIMIT'||stopped==='RECORD_LIMIT'},rateLimit:tracker});
  const burns=new Set(unique([...(st.known_burn_addresses||[]),...DEFAULT_BURN_ADDRESSES])); const lockerPrograms=normalizeMap(st.known_locker_programs); const lockerAddresses=normalizeMap(st.known_locker_addresses);
  let burn=0n,locked=0n,wallet=0n,program=0n,unknown=0n; const holders=[];
  for(const row of accounts){const owner=row?.owner||row?.account?.data?.parsed?.info?.owner||row?.token_account_owner||null; const amount=rawBigInt(row?.amount??row?.token_amount?.amount??row?.account?.data?.parsed?.info?.tokenAmount?.amount); if(amount<=0n||!owner)continue; const accountInfo=row?.account||{}; const cls=ownerClass(owner,accountInfo,lockerPrograms,lockerAddresses,burns); if(cls==='BURN')burn+=amount; else if(cls==='LOCKER'||cls==='LOCKER_PROGRAM')locked+=amount; else if(cls==='WALLET')wallet+=amount; else if(cls==='PROGRAM')program+=amount; else unknown+=amount; holders.push({token_account:row?.address||row?.pubkey||row?.token_account||null,owner,amount_raw:amount.toString(),classification:cls});}
  const total=rawBigInt(supply.amount), pct=x=>percent(x,total), burnPct=pct(burn)||0,lockedPct=pct(locked)||0,walletPct=pct(wallet)||0; let status='UNKNOWN',note='Insufficient evidence to determine LP lock state.';
  if(total===0n||burnPct>=Number(st.burn_share_threshold_pct??99.99)){status='BURNED';note='LP mint supply is zero or effectively all observed LP supply is held by configured burn address(es).';}
  else if(locked>0n&&wallet===0n&&program===0n&&unknown===0n){status='LOCKED';note='All observed non-burn LP supply is controlled by recognized locker address/program evidence.';}
  else if(locked>0n&&wallet>0n){status='PARTIALLY_LOCKED';note='Recognized locked LP supply and ordinary wallet-held LP supply both exist.';}
  else if(wallet>0n&&locked===0n&&program===0n&&unknown===0n){status='UNLOCKED';note='Observed LP supply is held by ordinary wallet-controlled accounts; no recognized locker evidence.';}
  else if(locked===0n&&(program>0n||unknown>0n)){status='UNKNOWN';note='LP supply is program-controlled or otherwise not attributable to a recognized lock mechanism.';}
  return {status,supply_raw:supply.amount,supply_ui:supply.ui_amount,observed_holder_count:holders.length,burn_amount_raw:burn.toString(),locked_amount_raw:locked.toString(),wallet_amount_raw:wallet.toString(),program_amount_raw:program.toString(),unknown_amount_raw:unknown.toString(),burn_share_pct:burnPct,locked_share_pct:lockedPct,wallet_share_pct:walletPct,note,holders,coverage};
}
function dedupePools(pools){
  const m=new Map();
  for(const p of pools){
    if(!p?.pool)continue;
    const key=p.pool;
    const prev=m.get(key);
    if(!prev)m.set(key,p);
    else m.set(key,{...prev,...p,raw_sources:[...(prev.raw_sources||[prev.raw_source]),p.raw_source].filter(Boolean)});
  }
  return [...m.values()];
}
function makeDistribution(holders,den){
  const sorted=[...holders].sort((a,b)=>{const aa=rawBigInt(a.amount_raw),bb=rawBigInt(b.amount_raw);return bb>aa?1:bb<aa?-1:0;});
  const out={}; for(const n of [1,5,10,20,50,100]){const s=sorted.slice(0,n);out[`top_${n}`]={holder_count:s.length,amount_raw:sumRaw(s).toString(),share_of_total_supply_pct:percent(sumRaw(s),den)};}
  return {sorted,result:out};
}
async function classifyOwners(owners,rpcUrl,config,result,liquidityPools){
  const hc=config.holder_concentration||{}, burn=new Set(unique([...(hc.burn_addresses||[]),...DEFAULT_BURN_ADDRESSES])); const lpPrograms=normalizeMap(hc.known_liquidity_programs);
  // CEX exclusion: wallet CEX dari registry diklasifikasikan
  // SEBELUM probe RPC — aktivitas bursa dikecualikan dari analisis holder.
  // Fail-soft: registry tidak ada -> tidak ada eksklusi.
  const cexIndex=loadCexIndex(ROOT);
  const batchSize=Math.min(100,Math.max(1,Number(hc.owner_probe_batch_size??100))); const max=Math.min(owners.length,Math.max(1,Number(hc.max_owner_probes??5000))); const targets=owners.slice(0,max), cls=new Map(), poolByOwner=new Map();
  for(const p of liquidityPools)poolByOwner.set(p.pool,{classification:'LIQUIDITY_POOL',confidence:'HIGH',evidence:['confirmed_pool_account',`dex:${p.dex||p.program_name}`,`pool:${p.pool}`],pool:p,excluded_from_normal_holder_concentration:true});
  let preclassified=0, cexPreclassified=0; for(const o of targets){if(cexIndex.has(o)){const lbl=cexIndex.labelOf(o); cls.set(o,{classification:'CEX_WALLET',confidence:'HIGH',evidence:[`cex_registry:${lbl}`,'user_provided_registry','exchange_or_market_maker_operational_wallet'],excluded_from_normal_holder_concentration:true});preclassified++;cexPreclassified++;} else if(burn.has(o)){cls.set(o,{classification:'BURN',confidence:'HIGH',evidence:['known_burn_address'],excluded_from_normal_holder_concentration:true});preclassified++;} else if(poolByOwner.has(o)){cls.set(o,poolByOwner.get(o));preclassified++;}}
  result.classification = result.classification || {}; result.classification.cex_registry={wallets_excluded:cexPreclassified,registry_size:cexIndex.size,registry_found:cexIndex.size>0};
  const pending=targets.filter(x=>!cls.has(x)); let rpcAttempted=0,rpcSuccessful=0,rpcFailed=0; const failedOwners=new Set(); result.classification.probed_owners=targets.length; result.classification.batches=Math.ceil(pending.length/batchSize);
  for(let i=0;i<pending.length;i+=batchSize){const batch=pending.slice(i,i+batchSize); rpcAttempted+=batch.length; try{const rows=await rpc(rpcUrl,'getMultipleAccounts',[batch,{encoding:'base64'}],`owner accounts ${i+1}-${i+batch.length}`,config,result); const vals=Array.isArray(rows?.value)?rows.value:[]; batch.forEach((owner,idx)=>{const a=vals[idx]||null;if(!a){cls.set(owner,{classification:'UNKNOWN',confidence:'LOW',evidence:['owner_account_not_found'],excluded_from_normal_holder_concentration:false});return;} rpcSuccessful++; const program=a.owner||null,executable=Boolean(a.executable); if(lpPrograms.has(program))cls.set(owner,{classification:'LP_CANDIDATE',confidence:'MEDIUM',evidence:[`owner_program:${program}`,lpPrograms.get(program),'known_amm_program_but_pool_structure_not_confirmed'],excluded_from_normal_holder_concentration:false}); else if(executable)cls.set(owner,{classification:'PROGRAM',confidence:'HIGH',evidence:['owner_account_executable',...(program?[`owner_program:${program}`]:[])],excluded_from_normal_holder_concentration:false}); else if(program&&program!==SYSTEM_PROGRAM&&program!==TOKEN_PROGRAM&&program!==TOKEN_2022_PROGRAM)cls.set(owner,{classification:'PROGRAM_CONTROLLED',confidence:'MEDIUM',evidence:[`owner_program:${program}`],excluded_from_normal_holder_concentration:false}); else cls.set(owner,{classification:'NORMAL_HOLDER',confidence:'MEDIUM',evidence:['system_owned_or_standard_account'],excluded_from_normal_holder_concentration:false});});}catch(e){rpcFailed+=batch.length;batch.forEach(o=>{failedOwners.add(o);cls.set(o,{classification:'UNKNOWN',confidence:'LOW',evidence:['owner_probe_failed',e.message],excluded_from_normal_holder_concentration:false});});result.errors.push({source:'owner_probe',message:e.message,batch_start:i,batch_size:batch.length});}}
  for(const o of owners)if(!cls.has(o))cls.set(o,{classification:'UNKNOWN',confidence:'LOW',evidence:['probe_limit_reached'],excluded_from_normal_holder_concentration:false});
  const limited=owners.length>targets.length; const status=limited||rpcFailed>0?COVERAGE_STATUSES.PARTIAL:COVERAGE_STATUSES.COMPLETE; const reason=limited?COVERAGE_REASONS.PROBE_LIMIT:(rpcFailed>0?COVERAGE_REASONS.REQUEST_FAILED:COVERAGE_REASONS.NO_MORE_DATA);
  result.classification.coverage=baseCoverage({retrievalMode:RETRIEVAL_MODES.PAGINATED_BOUNDED,status,reason,scope:status===COVERAGE_STATUSES.COMPLETE?'FULL_AVAILABLE_DATA':'CONFIGURED_RECORD_WINDOW',pagination:{enabled:false,pages_requested:0,pages_fetched:0,cursor_used:false,stopped_reason:limited?'PROBE_LIMIT':rpcFailed?'REQUEST_FAILED':'NO_MORE_DATA',has_more_possible:limited},records:{requested:owners.length,observed:targets.length,retained:cls.size},caps:{wallet_cap:max,record_cap:max,cap_triggered:limited},rateLimit:{encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'}});
  result.classification.coverage.probe_accounting={owners_requested:owners.length,owners_selected:targets.length,owners_preclassified:preclassified,owners_rpc_probed:rpcAttempted,owners_rpc_successful:rpcSuccessful,owners_failed:rpcFailed,owners_unclassified:Math.max(0,owners.length-cls.size)};
  return cls;
}
async function main(){
  console.log('\n╔══════════════════════════════════════════════════════╗\n║ PHASE 4 v3 — HOLDER + MULTI-DEX LIQUIDITY MAPPING    ║\n╚══════════════════════════════════════════════════════╝\n');
  let config; try{config=loadConfig();}catch(e){console.log(`STATUS : FAILED ✗\nERROR  : ${e.message}`);process.exitCode=1;return;}
  const input=findPhase3Input(); if(!input){console.log('STATUS : FAILED ✗\nERROR  : PHASE3_INPUT_NOT_FOUND');process.exitCode=1;return;}
  const mint=String(input.mint||'').trim(); if(!valid(mint)){console.log('STATUS : FAILED ✗\nERROR  : INVALID_SOLANA_TOKEN_MINT');process.exitCode=1;return;}
  const phase3=input.data, phase2=findPhase2(mint), supplyRaw=phase2?.token?.supply!=null?String(phase2.token.supply):null;
  const decimals=Number(phase2?.token?.decimals??0);
  const holders=Array.isArray(phase3?.holders)?phase3.holders.filter(h=>h&&h.owner&&rawBigInt(h.amount_raw)>0n):[];
  const datasetComplete=phase3?.discovery?.limit_reached===false;
  const result={
    phase:4,phase_name:'HOLDER_CONCENTRATION',version:'3.0',status:'FAILED',timestamp:new Date().toISOString(),elapsed_seconds:null,
    input:{mint,source:input.source,phase3_file:input.file},token:{mint,decimals,supply_raw:supplyRaw},
    dataset:{status:datasetComplete?'COMPLETE':'PARTIAL_OR_CAPPED',unique_holders_from_phase3:holders.length,max_unique_holders:Number(phase3?.discovery?.max_unique_holders??config.scanner?.holder_max_unique??5000),limit_reached:phase3?.discovery?.limit_reached??null,pages:phase3?.discovery?.pages??null},
    coverage:{discovered_holder_supply_raw:sumRaw(holders).toString(),discovered_holder_supply_pct_of_phase2_supply:supplyRaw?percent(sumRaw(holders),supplyRaw):null,phase3:phase3?.coverage||null,datasets:{},overall:null,note:'Phase 3 holder snapshot compared with Phase 2 supply snapshot.'},
    classification:{mode:'B_LAYERED',rules:['Direct known burn/liquidity evidence','Known liquidity-program evidence','DEX-specific pool discovery','Executable/program-controlled owner evidence','UNKNOWN when evidence is insufficient'],probed_owners:0,batches:0,counts:{},max_owner_probes:Number(config.holder_concentration?.max_owner_probes??5000),owner_probe_batch_size:Number(config.holder_concentration?.owner_probe_batch_size??100)},
    liquidity_mapping:{status:'UNKNOWN',scanners:[],confirmed_pools:[],candidates:[],significant_pools:[],program_ids_checked:[],deduped_pool_count:0,
      lock_status_summary:{BURNED:0,LOCKED:0,PARTIALLY_LOCKED:0,UNLOCKED:0,UNKNOWN:0,NOT_APPLICABLE:0},
      note:'LP candidates are not excluded from adjusted concentration. For concentrated-liquidity venues without a fungible LP mint, lock state may remain UNKNOWN until a verified position decoder is added.'},
    special_accounts:[],holders:[],concentration:{raw:null,adjusted_confirmed_normal:null,notes:['Raw includes every discovered non-zero holder.','Adjusted excludes confirmed LIQUIDITY_POOL, BURN, and CEX_WALLET (wallet CEX dari registry dikecualikan).','LP_CANDIDATE, PROGRAM, PROGRAM_CONTROLLED, UNKNOWN remain included.']},data_sources:[],missing:[],errors:[]
  };
  console.log(`TOKEN\n  Mint       : ${short(mint)}\n  Input      : ${input.source}\n  Dataset    : ${datasetComplete?'COMPLETE':'PARTIAL / CAPPED'}\n  Holders    : ${holders.length}\n  Supply     : ${supplyRaw||'UNKNOWN'}\n\nLIQUIDITY MAPPING\n  Focus      : significant pools + LP status (burn/lock/unlock)`);
  try{
    if(!holders.length)throw Error('NO_HOLDERS_IN_PHASE3_RESULT');
    const hc=config.holder_concentration||{}, lm=hc.liquidity_mapping||{};
    const rpcBase=String(config.helius.rpc_url).trim(), rpcUrl=`${rpcBase}${rpcBase.includes('?')?'&':'?'}api-key=${encodeURIComponent(config.helius.api_key)}`;
    const health=await rpc(rpcUrl,'getHealth',[],'Helius RPC',config,result); if(health!=='ok')throw Error('HELIUS_RPC_HEALTH_NOT_OK');
    console.log('  ✓ API / RPC  : AUTHENTICATED\n  ✓ RPC Health  : OK');
    const scanners=[];
    const pump=await discoverPumpSwap(mint,rpcUrl,config,result); scanners.push({name:'PumpSwap',program_id:pump.program_id,attempted:pump.attempted,pool_count:pump.pools.length,coverage:pump.coverage});
    const ray=await discoverRaydium(mint,config,result); scanners.push({name:'Raydium',attempted:ray.attempted,pool_count:ray.pools.length,coverage:ray.coverage});
    const met=await discoverMeteora(mint,config,result); scanners.push({name:'Meteora DLMM',program_id:'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',attempted:met.attempted,pool_count:met.pools.length,coverage:met.coverage});
    const orca=await discoverOrca(mint,config,result); scanners.push({name:'Orca Whirlpools',program_id:'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',attempted:orca.attempted,pool_count:orca.pools.length,note:orca.note,coverage:baseCoverage({retrievalMode:RETRIEVAL_MODES.EMPTY,status:COVERAGE_STATUSES.UNKNOWN,reason:COVERAGE_REASONS.NOT_AVAILABLE,scope:'UNKNOWN_SCOPE'})});
    result.liquidity_mapping.scanners=scanners;
    result.liquidity_mapping.program_ids_checked=buildProgramIdsChecked(pump,met,orca);
    let pools=dedupePools([...pump.pools,...ray.pools,...met.pools]);
    const maxPools=Math.max(1,Number(lm.significance?.max_pools_per_dex??20));
    const thresholds=lm.significance||{};
    pools=pools.filter(p=>significant(p,thresholds));
    const unknownDexA=pools.length; pools=pools.filter(knownDexPool); result.unknown_dex_pools_filtered=(result.unknown_dex_pools_filtered||0)+(unknownDexA-pools.length);
    const byDex={};
    for(const p of pools){byDex[p.dex||p.program_name||'UNKNOWN']??=[]; if(byDex[p.dex||p.program_name||'UNKNOWN'].length<maxPools)byDex[p.dex||p.program_name||'UNKNOWN'].push(p);}
    pools=Object.values(byDex).flat();
    const owners=holders.map(h=>h.owner);
    let classifications=await classifyOwners(owners,rpcUrl,config,result,pump.pools.map(p=>({...p,dex:'PumpSwap'})));
    const directCap=Math.max(0,Number(config.holder_concentration?.liquidity_mapping?.pumpswap_direct_owner_probe_max??50));
    const candidateRows=selectPumpSwapOwnerCandidates(holders,classifications,pump.program_id,directCap);
    const directProbe=await probePumpSwapPoolCandidates(candidateRows.map(x=>x.owner),mint,rpcUrl,config,result);
    if(directProbe.pools.length){
      pump.pools=dedupePools([...pump.pools,...directProbe.pools]);
      const scanner=scanners.find(x=>x.name==='PumpSwap');
      if(scanner){scanner.pool_count=pump.pools.length;}
      scanner.coverage.direct_owner_probe=directProbe.coverage;
      scanner.response_diagnostics={...(scanner.coverage?.response_diagnostics||{}),direct_owner_probe:directProbe.diagnostics};
    } else if(scanners.find(x=>x.name==='PumpSwap')){
      scanners.find(x=>x.name==='PumpSwap').coverage.direct_owner_probe=directProbe.coverage;
      scanners.find(x=>x.name==='PumpSwap').coverage.response_diagnostics={...(scanners.find(x=>x.name==='PumpSwap').coverage.response_diagnostics||{}),direct_owner_probe:directProbe.diagnostics};
    }
    pools=dedupePools([...pump.pools,...ray.pools,...met.pools]);
    pools=pools.filter(p=>significant(p,thresholds));
    const unknownDexB=pools.length; pools=pools.filter(knownDexPool); result.unknown_dex_pools_filtered=(result.unknown_dex_pools_filtered||0)+(unknownDexB-pools.length);
    const byDexAfterProbe={};
    for(const p of pools){byDexAfterProbe[p.dex||p.program_name||'UNKNOWN']??=[]; if(byDexAfterProbe[p.dex||p.program_name||'UNKNOWN'].length<maxPools)byDexAfterProbe[p.dex||p.program_name||'UNKNOWN'].push(p);}
    pools=Object.values(byDexAfterProbe).flat();
    const pumpPoolOwners=new Map(pump.pools.map(p=>[p.pool,{classification:'LIQUIDITY_POOL',confidence:'HIGH',evidence:['confirmed_pool_account',`dex:${p.dex||p.program_name}`,`pool:${p.pool}`],pool:p,excluded_from_normal_holder_concentration:true}]));
    for(const [owner,info] of pumpPoolOwners)if(classifications.has(owner))classifications.set(owner,info);
    result.coverage.datasets.phase3_holders=phase3?.coverage?.status || (datasetComplete?'COMPLETE':'PARTIAL'); result.coverage.datasets.pumpswap_discovery=scanners.find(x=>x.name==='PumpSwap')?.coverage?.status||'UNKNOWN'; result.coverage.datasets.raydium_discovery=ray.coverage?.status||'UNKNOWN'; result.coverage.datasets.meteora_discovery=met.coverage?.status||'UNKNOWN'; result.coverage.datasets.orca_discovery=orca.attempted?'UNKNOWN':'EMPTY'; result.coverage.datasets.owner_probe='UNKNOWN';
    const annotated=holders.map(h=>{const c=classifications.get(h.owner)||{classification:'UNKNOWN',confidence:'LOW',evidence:[],excluded_from_normal_holder_concentration:false};return {...h,classification:c.classification,classification_confidence:c.confidence,classification_evidence:c.evidence,excluded_from_normal_holder_concentration:c.excluded_from_normal_holder_concentration,share_of_total_supply_pct:supplyRaw?percent(h.amount_raw,supplyRaw):null};});
    result.holders=annotated;
    const counts={};for(const h of annotated)counts[h.classification]=(counts[h.classification]||0)+1;result.classification.counts=counts;
    result.liquidity_mapping.confirmed_pools=pump.pools.map(p=>({...p,confidence:'HIGH',evidence:['pool_account_owned_by_supported_amm_program','target_mint_match','pool_structure_decoded_on_chain']}));
    const candidates=annotated.filter(h=>h.classification==='LP_CANDIDATE');
    result.liquidity_mapping.candidates=candidates.map(h=>({owner:h.owner,amount_raw:h.amount_raw,amount_ui:h.amount_ui,share_of_total_supply_pct:h.share_of_total_supply_pct,confidence:h.classification_confidence,evidence:h.classification_evidence}));
    /* Scan-time pool liquidity snapshot (for SPR-05/LTR-01:
     * sell volume vs pool liquidity). Fail-soft by design: any RPC/parse
     * problem yields null balances with a reason — never throws, never blocks
     * the pool loop. This is a point-in-time snapshot, NOT a historical
     * series; consumers must document it as a liquidity proxy. */
    async function snapshotPoolTokenBalances(pool){
      const snap={snapshot_utc:new Date().toISOString(),base:null,quote:null};
      for(const [key,account] of [['base',pool.pool_base_token_account],['quote',pool.pool_quote_token_account]]){
        if(!account){ snap[key]={status:'NOT_AVAILABLE',reason:'account_address_missing'}; continue; }
        try{
          const res=await rpc(rpcUrl,'getTokenAccountBalance',[account],`pool ${key} token balance`,config,result);
          const v=res?.value;
          if(v&&/^\d+$/.test(String(v.amount??''))){
            snap[key]={status:'FOUND',amount_raw:String(v.amount),decimals:Number(v.decimals??0),amount_ui:(v.uiAmount??null)};
          }else{
            snap[key]={status:'NOT_FOUND',reason:'empty_or_unparseable_response'};
          }
        }catch(e){
          snap[key]={status:'FAILED',reason:String(e?.message||e).slice(0,120)};
        }
      }
      return snap;
    }
    for(const p of pools){
      const item={...p,significance:'SIGNIFICANT'};
      try{
        item.liquidity_snapshot=await snapshotPoolTokenBalances(p);
      }catch(snapErr){
        item.liquidity_snapshot={snapshot_utc:new Date().toISOString(),base:{status:'FAILED',reason:'snapshot_threw'},quote:{status:'FAILED',reason:'snapshot_threw'}};
        result.errors.push({source:`liquidity_snapshot:${p.pool}`,message:String(snapErr?.message||snapErr).slice(0,120)});
      }
      if(p.lp_mint){
        try{
          item.lp_status=await inspectFungibleLpStatus(p,rpcUrl,config,result);
        }catch(lpErr){
          item.lp_status={status:'UNKNOWN',reason:'lp_status_probe_failed',error:lpErr.message};
          result.errors.push({source:`lp_status:${p.dex||'UNKNOWN'}:${p.pool}`,message:lpErr.message});
          console.log(`  ⚠ LP status UNKNOWN : ${lpErr.message}`);
        }
      } else item.lp_status={status:'NOT_APPLICABLE',reason:'concentrated_or_position_based_pool; no fungible LP mint exposed by discovery adapter'};
      result.liquidity_mapping.significant_pools.push(item);
      result.liquidity_mapping.lock_status_summary[item.lp_status.status]=(result.liquidity_mapping.lock_status_summary[item.lp_status.status]||0)+1;
    }
    result.liquidity_mapping.deduped_pool_count=pools.length;
    result.coverage.datasets.owner_probe=result.classification.coverage.status;
    const lpCovs=result.liquidity_mapping.significant_pools.map(x=>x.lp_status?.coverage?.status).filter(Boolean); result.coverage.datasets.lp_holder_probe=lpCovs.includes('PARTIAL')?'PARTIAL':lpCovs.includes('FAILED')?'FAILED':lpCovs.length?'COMPLETE':'EMPTY';
    result.liquidity_mapping.status=(result.liquidity_mapping.significant_pools.length||result.liquidity_mapping.confirmed_pools.length)?'FOUND':(candidates.length?'CANDIDATES_FOUND':'NOT_FOUND');
    result.liquidity_mapping.candidates=result.liquidity_mapping.candidates;
    const special=annotated.filter(h=>['LIQUIDITY_POOL','LP_CANDIDATE','BURN','PROGRAM','PROGRAM_CONTROLLED'].includes(h.classification));
    result.special_accounts=special.map(h=>({owner:h.owner,classification:h.classification,confidence:h.classification_confidence,amount_raw:h.amount_raw,amount_ui:h.amount_ui,share_of_total_supply_pct:h.share_of_total_supply_pct,evidence:h.classification_evidence}));
    const distributionDenominator=supplyRaw||sumRaw(annotated);
    const raw=makeDistribution(annotated,distributionDenominator); result.concentration.raw=raw.result;
    const adjustedHolders=annotated.filter(h=>!h.excluded_from_normal_holder_concentration);
    const adjusted=makeDistribution(adjustedHolders,distributionDenominator); result.concentration.adjusted_confirmed_normal=adjusted.result;
    // 6H: preserve explicit classification cohorts without changing the locked raw/adjusted metrics.
    // Confirmed LIQUIDITY_POOL/BURN are excluded from the legacy adjusted view;
    // CEX_WALLET juga excluded.
    const cohortNames=['NORMAL_HOLDER','LIQUIDITY_POOL','LP_CANDIDATE','BURN','PROGRAM','PROGRAM_CONTROLLED','UNKNOWN','CEX_WALLET'];
    result.concentration.classification_cohorts={};
    for(const cls of cohortNames){
      const rows=annotated.filter(h=>h.classification===cls);
      const d=makeDistribution(rows,distributionDenominator);
      result.concentration.classification_cohorts[cls]={
        holder_count:rows.length,
        amount_raw:sumRaw(rows).toString(),
        share_of_total_supply_pct:percent(sumRaw(rows),distributionDenominator),
        included_in_adjusted_confirmed_normal:rows.some(h=>!h.excluded_from_normal_holder_concentration),
        distribution:d.result
      };
    }
    result.concentration.adjusted_confirmed_normal_metadata={
      excluded_classifications:cohortNames.filter(cls=>result.concentration.classification_cohorts[cls].holder_count>0 && !result.concentration.classification_cohorts[cls].included_in_adjusted_confirmed_normal),
      unresolved_included_classifications:cohortNames.filter(cls=>['LP_CANDIDATE','PROGRAM','PROGRAM_CONTROLLED','UNKNOWN'].includes(cls) && result.concentration.classification_cohorts[cls].included_in_adjusted_confirmed_normal),
      denominator_supply_raw:String(distributionDenominator),
      interpretation:'Adjusted view excludes only explicitly confirmed non-holder classifications; unresolved/program-controlled classes remain included and must not be described as pure normal-holder concentration.'
    };
    result.coverage.discovered_holder_supply_raw=sumRaw(annotated).toString();
    if(supplyRaw)result.coverage.discovered_holder_supply_pct_of_phase2_supply=percent(sumRaw(annotated),supplyRaw);
    const ds=Object.values(result.coverage.datasets); result.coverage.overall=ds.includes('FAILED')?'PARTIAL':ds.includes('PARTIAL')?'PARTIAL':ds.includes('UNKNOWN')?'PARTIAL':ds.every(x=>x==='EMPTY'||x==='COMPLETE')?'COMPLETE':'PARTIAL'; result.status=result.coverage.overall==='COMPLETE'&&datasetComplete?'COMPLETE':'PARTIAL';
    console.log('\nSUMMARY');
    console.log(`  PumpSwap Pools          : ${pump.pools.length}`);
    console.log(`  Raydium Pools           : ${ray.pools.length}`);
    console.log(`  Meteora DLMM Pools      : ${met.pools.length}`);
    console.log(`  Orca Pools              : ${orca.pools.length}${orca.note?' (decoder not enabled)':''}`);
    console.log(`  Significant Pools       : ${result.liquidity_mapping.significant_pools.length}`);
    console.log(`  LP BURNED               : ${result.liquidity_mapping.lock_status_summary.BURNED}`);
    console.log(`  LP LOCKED               : ${result.liquidity_mapping.lock_status_summary.LOCKED}`);
    console.log(`  LP PARTIALLY LOCKED     : ${result.liquidity_mapping.lock_status_summary.PARTIALLY_LOCKED}`);
    console.log(`  LP UNLOCKED             : ${result.liquidity_mapping.lock_status_summary.UNLOCKED}`);
    console.log(`  LP UNKNOWN              : ${result.liquidity_mapping.lock_status_summary.UNKNOWN}`);
    console.log(`  LIQUIDITY_POOL holders  : ${counts.LIQUIDITY_POOL||0}`);
    console.log(`  LP_CANDIDATE            : ${counts.LP_CANDIDATE||0}`);
    console.log(`  UNKNOWN holders         : ${counts.UNKNOWN||0}`);
    console.log(`  Top 10 Raw              : ${result.concentration.raw.top_10.share_of_total_supply_pct}%`);
    console.log(`  Top 10 Adjusted         : ${result.concentration.adjusted_confirmed_normal.top_10.share_of_total_supply_pct}%`);
  }catch(e){
    result.status='FAILED';result.errors.push({source:'phase4',message:e.message});console.log(`\n  ✗ ${e.message}`);
  }
  result.elapsed_seconds=Number(((Date.now()-started)/1000).toFixed(2));
  const out=save(result,mint);
  console.log(`──────────────────────────────────────────────────────\nSTATUS     : ${result.status==='COMPLETE'?'COMPLETE ✓':result.status==='PARTIAL'?'PARTIAL ⚠':'FAILED ✗'}\nTIME       : ${result.elapsed_seconds.toFixed(2)}s\nOUTPUT     : ${path.relative(ROOT,out)}\n──────────────────────────────────────────────────────`);
  if(result.status==='FAILED')process.exitCode=1;
}
if(require.main===module){main().catch(e=>{console.log(`\nSTATUS : FAILED ✗\nERROR  : ${e.message}`);process.exitCode=1;});}

module.exports={buildProgramIdsChecked,extractProgramAccountsV2Page,pumpSwapCoverage,decodePumpSwapPool,evaluatePumpSwapPoolAccount,selectPumpSwapOwnerCandidates,knownDexPool};
