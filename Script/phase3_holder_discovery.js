#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const { attachRunMetadata } = require('./run_metadata');
const { phase3HolderCoverage } = require('./coverage_contract');
const throttle = require('./rpc_throttle');
const ROOT=path.resolve(__dirname,'..'),CFG=path.join(ROOT,'Config','config.json'),OUTPUT_ROOT=path.join(ROOT,'Output'),LEGACY_DATA=path.join(ROOT,'Data');
const started=Date.now();
const TOKEN_PROGRAM_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const short=x=>x&&x.length>12?`${x.slice(0,6)}...${x.slice(-6)}`:x||'UNKNOWN';
const valid=x=>typeof x==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
function loadConfig(){if(!fs.existsSync(CFG))throw Error('CONFIG_NOT_FOUND');const c=JSON.parse(fs.readFileSync(CFG,'utf8'));c.helius.api_key = String(c.helius?.api_key || '').trim();if(!c.helius.api_key || c.helius.api_key.startsWith('PASTE_'))throw Error('HELIUS_API_KEY_NOT_CONFIGURED');return c}
function reqJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function findLatestInput(){
  // Always bind pipeline execution to the explicitly requested mint.
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested){
    for(const name of ['phase2-result.json','phase1-result.json']){
      const file=path.join(OUTPUT_ROOT,requested,name);
      if(fs.existsSync(file)){const data=reqJson(file);if(data)return {data,file,mint:requested,source:name};}
    }
    return null;
  }
  // Standalone fallback: legacy discovery only when no mint was supplied.
  if(fs.existsSync(OUTPUT_ROOT)){
    const dirs=fs.readdirSync(OUTPUT_ROOT,{withFileTypes:true}).filter(x=>x.isDirectory());
    for(const d of dirs){
      const p2=path.join(OUTPUT_ROOT,d.name,'phase2-result.json');
      const p1=path.join(OUTPUT_ROOT,d.name,'phase1-result.json');
      if(fs.existsSync(p2)){const r=reqJson(p2);if(r?.status==='COMPLETE'||r?.token?.mint||r?.input?.mint)return {data:r,file:p2,mint:r?.input?.mint||r?.token?.mint,source:'phase2-result.json'};}
      if(fs.existsSync(p1)){const r=reqJson(p1);if(r?.status==='COMPLETE'||r?.token?.mint||r?.input?.mint)return {data:r,file:p1,mint:r?.input?.mint||r?.token?.mint,source:'phase1-result.json'};}
    }
  }
  // Backward compatibility for the package/data layout used before token-specific output folders.
  const p2=path.join(LEGACY_DATA,'phase2-result.json');
  const p1=path.join(LEGACY_DATA,'phase1-result.json');
  if(fs.existsSync(p2)){const r=reqJson(p2);if(r)return {data:r,file:p2,mint:r?.input?.mint||r?.token?.mint,source:'data/phase2-result.json'};}
  if(fs.existsSync(p1)){const r=reqJson(p1);if(r)return {data:r,file:p1,mint:r?.input?.mint||r?.token?.mint,source:'data/phase1-result.json'};}
  return null;
}
function save(r,mint){attachRunMetadata(r,3,mint);const dir=path.join(OUTPUT_ROOT,mint);fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,'phase3-result.json');fs.writeFileSync(out,JSON.stringify(r,null,2),'utf8');return out}
async function req(url,opt,label,c,metrics){throttle.configure(c);const max=Number(c.scanner?.max_retries??3),base=Number(c.scanner?.retry_delay_ms??1000),timeout=Number(c.scanner?.request_timeout_ms??15000);for(let a=1;a<=max;a++){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),timeout);try{console.log(`  ${label} : request (${a}/${max})`);await throttle.takeSlot();const res=await fetch(url,{...opt,signal:ctl.signal}),txt=await res.text();let body;try{body=txt?JSON.parse(txt):{}}catch{body={raw:txt}}if(res.status===401)throw Error('HTTP_401_UNAUTHORIZED');if(res.status===403)throw Error('HTTP_403_FORBIDDEN');if(throttle.isRetryableStatus(res.status)||res.status>=500){if(res.status===429&&metrics){metrics.encountered=true;metrics.retry_count++;}if(a<max){console.log(`  ↻ RETRY   : HTTP ${res.status}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(a,base,throttle.retryAfterMs(res.headers.get('retry-after')))));continue}if(res.status===429&&metrics){metrics.final_state='RETRY_EXHAUSTED';metrics.recovered=false;}throw Error(`HTTP_${res.status}`)}if(metrics&&metrics.encountered){metrics.recovered=true;metrics.final_state='RECOVERED';}
if(!res.ok)throw Error(`HTTP_${res.status}: ${body?.error?.message||body?.message||body?.raw||''}`);if(body?.error)throw Error(`RPC_${body.error.code??'UNKNOWN'}: ${body.error.message??'Unknown RPC error'}`);return body}catch(e){if(e.message==='HTTP_401_UNAUTHORIZED'||e.message==='HTTP_403_FORBIDDEN')throw e;if(a>=max){if(metrics&&metrics.encountered){metrics.final_state='RETRY_EXHAUSTED';metrics.recovered=false;}throw e;}console.log(`  ↻ RETRY   : ${e.name==='AbortError'?'TIMEOUT':e.message}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(a,base)))}finally{clearTimeout(tm)}}throw Error('REQUEST_FAILED')}
function toRawAmount(a){if(a==null)return null;return typeof a==='string'?a:String(a)}
function toUiAmount(raw,decimals){if(raw==null||decimals==null)return null;try{return Number(raw)/(10**Number(decimals))}catch{return null}}
async function main(){
 console.log('\n╔══════════════════════════════════════════════════════╗\n║ PHASE 3 — HOLDER DISCOVERY                           ║\n╚══════════════════════════════════════════════════════╝\n');
 let config;try{config=loadConfig()}catch(e){console.log(`STATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1;return}
 const input=findLatestInput();let mint=String(input?.mint||'').trim();
 if(!mint){console.log('\nSTATUS     : FAILED ✗\nERROR      : PHASE_INPUT_NOT_FOUND\nDETAIL     : No phase1/phase2 result with a token mint was found.');process.exitCode=1;return}
 if(!valid(mint)){console.log('\nSTATUS     : FAILED ✗\nERROR      : INVALID_SOLANA_TOKEN_MINT');process.exitCode=1;return}
 const p2=input?.source?.includes('phase2')?input.data:null;
 // Keep decimals null when unknown: defaulting to 0 would silently treat raw
 // base units as UI amounts (e.g. amount_ui == amount_raw), which is wrong.
 const decRaw=p2?.token?.decimals??input?.data?.token?.decimals;
 const decimals=decRaw==null?null:Number(decRaw);
 const program=p2?.token?.program??input?.data?.token?.token_program??null;
 const r={phase:3,phase_name:'HOLDER_DISCOVERY',status:'FAILED',timestamp:new Date().toISOString(),elapsed_seconds:null,input:{mint,source:input.source},helius:{network:config.helius.network,rpc_health:'UNKNOWN'},discovery:{method:'getTokenAccounts',pages:0,token_accounts_found:0,non_zero_token_accounts:0,unique_holders:0,duplicates_aggregated:0,max_unique_holders:Number(config.scanner?.holder_max_unique??1000),limit_reached:false},
  coverage: null,holders:[],token_accounts:[],data_sources:[],missing:[],errors:[]};
 console.log(`TOKEN\n  Mint       : ${short(mint)}\n  Network    : ${config.helius.network}\n  Input      : ${input.source}\n\nHELIUS CONNECTION`);
 let recordsObserved=0,recordsRetained=0,hadAnyRecords=false;
 const rateLimit={encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'};
 try{
  const maxUniqueHolders=Math.max(1,Number(config.scanner?.holder_max_unique??1000));
  const base=String(config.helius.rpc_url).trim();const rpcUrl=`${base}${base.includes('?')?'&':'?'}api-key=${encodeURIComponent(config.helius.api_key)}`;
  const health=await req(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'phase3-health',method:'getHealth',params:[]})},'Helius RPC',config);
  if(health?.result!=='ok')throw Error('HELIUS_RPC_HEALTH_NOT_OK');r.helius.rpc_health='OK';r.data_sources.push('Helius RPC getHealth');console.log('  ✓ API / RPC  : AUTHENTICATED\n  ✓ RPC Health  : OK\n\nHOLDER DISCOVERY');
  const owners=new Map();let page=1;const limit=Math.min(1000,Math.max(1,Number(config.scanner?.holder_page_limit??1000)));
  while(true){
   const body={jsonrpc:'2.0',id:`phase3-holders-${page}`,method:'getTokenAccounts',params:{mint,page,limit,displayOptions:{}}};
   const resp=await req(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)},`getTokenAccounts page ${page}`,config,rateLimit);
   r.data_sources.push(`Helius RPC getTokenAccounts page ${page}`);
   const accounts=Array.isArray(resp?.result?.token_accounts)?resp.result.token_accounts:[];
   recordsObserved+=accounts.length;
   hadAnyRecords=hadAnyRecords||accounts.length>0;
   if(!accounts.length){console.log(`  ✓ Page ${page}  : 0 accounts — discovery complete`);break;}
   r.discovery.pages=page;r.discovery.token_accounts_found+=accounts.length;
   for(const a of accounts){
    const raw=toRawAmount(a.amount??a.tokenAmount?.amount??a.token_amount?.amount);const amountNum=raw==null?0:Number(raw);const nonZero=Number.isFinite(amountNum)?amountNum>0:raw!=='0';if(!nonZero)continue;
    r.discovery.non_zero_token_accounts++;
    const owner=a.owner||a.ownerAddress||null;if(!owner)continue;
    // Stop collecting once the configured unique-holder cap is reached.
    // We still finish the current account loop only until the cap is reached,
    // then stop pagination immediately to protect memory/API usage.
    const rec={address:a.address||a.token_account||null,mint:a.mint||mint,owner,amount_raw:raw,amount_ui:a.uiAmount??a.tokenAmount?.uiAmount??toUiAmount(raw,decimals),decimals:a.decimals??a.tokenAmount?.decimals??decimals,frozen:Boolean(a.frozen??a.isFrozen??false)};
    let h=owners.get(owner);
    if(!h){
      if(owners.size>=maxUniqueHolders){
        r.discovery.limit_reached=true;
        break;
      }
      h={owner,amount_raw:'0',amount_ui:0,token_account_count:0,frozen_account_count:0,token_accounts:[]};
      owners.set(owner,h);
    }
    r.token_accounts.push(rec);
    recordsRetained++;
    try{h.amount_raw=String(BigInt(h.amount_raw)+BigInt(raw||'0'))}catch{h.amount_raw=String(Number(h.amount_raw)+Number(raw||0))}
    h.amount_ui=toUiAmount(h.amount_raw,decimals);h.token_account_count++;if(rec.frozen)h.frozen_account_count++;if(rec.address)h.token_accounts.push(rec.address);
   }
   console.log(`  ✓ Page ${page}  : ${accounts.length} accounts | unique holders: ${owners.size}${r.discovery.limit_reached?' | MAX HOLDER LIMIT REACHED':''}`);
   if(r.discovery.limit_reached)break;
   if(accounts.length<limit)break;page++;
  }
  r.discovery.unique_holders=owners.size;
  r.coverage=phase3HolderCoverage({pages:page,recordsObserved,recordsRetained,holderCap:maxUniqueHolders,limitReached:r.discovery.limit_reached,hadAnyRecords,rateLimit,pagesFetched:r.discovery.pages});
  r.holders=Array.from(owners.values()).sort((a,b)=>{try{return BigInt(b.amount_raw)>BigInt(a.amount_raw)?1:BigInt(b.amount_raw)<BigInt(a.amount_raw)?-1:0}catch{return b.amount_ui-a.amount_ui}});
  r.discovery.unique_holders=r.holders.length;r.discovery.duplicates_aggregated=r.discovery.non_zero_token_accounts-r.discovery.unique_holders;
  r.status=r.coverage.status==='PARTIAL'?'PARTIAL':r.coverage.status==='FAILED'?'FAILED':'COMPLETE';
  console.log(`\nSUMMARY\n  Coverage       : ${r.coverage.status} (${r.coverage.reason})\n  Token Accounts : ${r.discovery.token_accounts_found}\n  Non-zero       : ${r.discovery.non_zero_token_accounts}\n  Unique Holders : ${r.discovery.unique_holders}\n  Aggregated     : ${r.discovery.duplicates_aggregated}\n  Holder Limit   : ${maxUniqueHolders}${r.discovery.limit_reached?' (REACHED)':' (not reached)'}`);
 }catch(e){
  r.coverage=phase3HolderCoverage({pages:r.discovery.pages,recordsObserved,recordsRetained,holderCap:Number(config.scanner?.holder_max_unique??1000),limitReached:false,hadAnyRecords,rateLimit,pagesFetched:r.discovery.pages});
  const partialRetrieval=recordsObserved>0 || r.discovery.pages>0;
  r.coverage.status=partialRetrieval?'PARTIAL':'FAILED';
  r.coverage.reason=e.message.includes('TIMEOUT')?'TIMEOUT':(rateLimit.retry_count && rateLimit.recovered===false?'RETRY_EXHAUSTED':'REQUEST_FAILED');
  r.coverage.retrieval_mode=partialRetrieval?'PAGINATED_UNBOUNDED':'FAILED';
  r.coverage.pagination.stopped_reason=r.coverage.reason;
  r.coverage.pagination.has_more_possible=partialRetrieval?true:null;
  if(rateLimit.encountered&&rateLimit.recovered===false)rateLimit.final_state='RETRY_EXHAUSTED';
  r.status=partialRetrieval?'PARTIAL':'FAILED';r.errors.push({source:'phase3',message:e.message});if(e.message==='HTTP_401_UNAUTHORIZED')console.log('\nAUTHENTICATION\n  ✗ Helius rejected the API key (401).');else if(e.message==='HTTP_403_FORBIDDEN')console.log('\nAUTHORIZATION\n  ✗ Helius denied access (403).');else console.log(`\n  ✗ ${e.message}`)}
 r.elapsed_seconds=Number(((Date.now()-started)/1000).toFixed(2));const out=save(r,mint);
 console.log(`──────────────────────────────────────────────────────\nSTATUS     : ${r.status==='COMPLETE'?'COMPLETE ✓':r.status==='PARTIAL'?'PARTIAL ⚠':'FAILED ✗'}\nTIME       : ${r.elapsed_seconds.toFixed(2)}s\nOUTPUT     : ${path.relative(ROOT,out)}\n──────────────────────────────────────────────────────`);if(r.status==='FAILED')process.exitCode=1;
}
main().catch(e=>{console.log(`\nSTATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1});
