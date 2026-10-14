#!/usr/bin/env node
const fs=require('fs'),path=require('path'),readline=require('readline');
const { attachRunMetadata } = require('./run_metadata');
const throttle = require('./rpc_throttle');
const ROOT=path.resolve(__dirname,'..'), CFG=path.join(ROOT,'Config','config.json'), OUTPUT_ROOT=path.join(ROOT,'Output'), LEGACY_OUT=path.join(ROOT,'Data','phase1-result.json');
const started=Date.now();
const short=x=>x&&x.length>12?`${x.slice(0,6)}...${x.slice(-6)}`:x||'UNKNOWN';
const valid=x=>typeof x==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
function loadConfig(){if(!fs.existsSync(CFG))throw Error('CONFIG_NOT_FOUND');const c=JSON.parse(fs.readFileSync(CFG,'utf8'));c.helius.api_key = String(c.helius?.api_key || '').trim();if(!c.helius.api_key || c.helius.api_key.startsWith('PASTE_'))throw Error('HELIUS_API_KEY_NOT_CONFIGURED');return c}
function ask(){return new Promise(resolve=>{const rl=readline.createInterface({input:process.stdin,output:process.stdout});rl.question('Enter Token CA / Mint Address: ',a=>{rl.close();resolve(String(a||'').trim())})})}
function save(r,mint){attachRunMetadata(r,1,mint);const dir=path.join(OUTPUT_ROOT,mint);fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,'phase1-result.json');fs.writeFileSync(out,JSON.stringify(r,null,2),'utf8');return out}
async function req(url,opt,label,c){throttle.configure(c);const max=Number(c.scanner?.max_retries??3),base=Number(c.scanner?.retry_delay_ms??1000),timeout=Number(c.scanner?.request_timeout_ms??15000);for(let a=1;a<=max;a++){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),timeout);try{console.log(`  ${label} : request (${a}/${max})`);await throttle.takeSlot();const res=await fetch(url,{...opt,signal:ctl.signal}),txt=await res.text();let body;try{body=txt?JSON.parse(txt):{}}catch{body={raw:txt}}if(res.status===401)throw Error('HTTP_401_UNAUTHORIZED');if(res.status===403)throw Error('HTTP_403_FORBIDDEN');if(throttle.isRetryableStatus(res.status)||res.status>=500){if(a<max){console.log(`  ↻ RETRY   : HTTP ${res.status}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(a,base,throttle.retryAfterMs(res.headers.get('retry-after')))));continue}throw Error(`HTTP_${res.status}`)}if(!res.ok)throw Error(`HTTP_${res.status}: ${body?.error?.message||body?.message||body?.raw||''}`);if(body?.error)throw Error(`RPC_${body.error.code??'UNKNOWN'}: ${body.error.message??'Unknown RPC error'}`);return body}catch(e){if(e.message==='HTTP_401_UNAUTHORIZED'||e.message==='HTTP_403_FORBIDDEN')throw e;if(a>=max)throw e;console.log(`  ↻ RETRY   : ${e.name==='AbortError'?'TIMEOUT':e.message}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(a,base)))}finally{clearTimeout(tm)}}throw Error('REQUEST_FAILED')}
async function main(){
console.log('\n╔══════════════════════════════════════════════════════╗\n║ PHASE 1 — TOKEN DISCOVERY                            ║\n╚══════════════════════════════════════════════════════╝\n');
let config;try{config=loadConfig()}catch(e){console.log(`STATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1;return}
const arg=String(process.argv[2]||'').trim();const mint=arg||await ask();if(!mint){console.log('\nSTATUS     : FAILED ✗\nERROR      : TOKEN_MINT_REQUIRED');process.exitCode=1;return}if(!valid(mint)){console.log('\nSTATUS     : FAILED ✗\nERROR      : INVALID_SOLANA_TOKEN_MINT');process.exitCode=1;return}
const r={phase:1,phase_name:'TOKEN_DISCOVERY',status:'FAILED',timestamp:new Date().toISOString(),elapsed_seconds:null,input:{mint},helius:{network:config.helius.network,rpc_health:'UNKNOWN'},token:{mint,name:null,symbol:null,decimals:null,supply:null,logo_uri:null,token_program:null},data_sources:[],missing:[],errors:[]};
console.log(`TOKEN\n  Mint       : ${short(mint)}\n  Network    : ${config.helius.network}\n\nHELIUS CONNECTION`);
try{
const base=String(config.helius.rpc_url).trim();const rpcUrl=`${base}${base.includes('?')?'&':'?'}api-key=${encodeURIComponent(config.helius.api_key)}`;
const health=await req(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'phase1-health',method:'getHealth',params:[]})},'Helius RPC',config);if(health?.result!=='ok')throw Error('HELIUS_RPC_HEALTH_NOT_OK');r.helius.rpc_health='OK';r.data_sources.push('Helius RPC getHealth');console.log('  ✓ API / RPC  : AUTHENTICATED\n  ✓ RPC Health  : OK\n\nTOKEN DISCOVERY');
const acct=await req(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'phase1-account',method:'getAccountInfo',params:[mint,{encoding:'jsonParsed'}]})},'getAccountInfo',config);r.data_sources.push('Helius RPC getAccountInfo');const v=acct?.result?.value;if(!v)throw Error('TOKEN_ACCOUNT_NOT_FOUND');r.token.token_program=v.owner||null;const info=v?.data?.parsed?.info||null;if(info){r.token.supply=info.supply??null;r.token.decimals=info.decimals??null}console.log(`  ✓ Mint account : FOUND\n  Program       : ${r.token.token_program||'UNKNOWN'}\n\nTOKEN METADATA`);
 try{
 const m=await req(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'phase1-asset',method:'getAsset',params:{id:mint,displayOptions:{showFungible:true}}})},'Helius DAS getAsset',config);
 r.data_sources.push('Helius DAS getAsset');
 const x=m?.result;if(!x)throw Error('DAS_ASSET_NOT_FOUND');
 const md=x?.content?.metadata,ti=x?.token_info;
 if(md){r.token.name=md.name??r.token.name;r.token.symbol=md.symbol??r.token.symbol}
 if(ti){if(ti.decimals!=null)r.token.decimals=ti.decimals;if(ti.supply!=null)r.token.supply=ti.supply;r.token.token_standard=ti.token_standard??null}
 r.token.interface=x?.interface??null;r.token.logo_uri=x?.content?.links?.image??null;
 console.log(`  ✓ DAS Asset    : FOUND`);
 console.log(`  Name           : ${r.token.name||'UNKNOWN'}`);
 console.log(`  Symbol         : ${r.token.symbol||'UNKNOWN'}`);
 }catch(e){r.missing.push('token_metadata');r.errors.push({source:'Helius DAS getAsset',message:e.message});console.log(`  ⚠ Metadata     : ${e.message}`)}
r.status=(r.token.token_program&&r.token.decimals!==null&&r.token.supply!==null)?(r.missing.length?'PARTIAL':'COMPLETE'):'FAILED';
}catch(e){r.status='FAILED';r.errors.push({source:'phase1',message:e.message});if(e.message==='HTTP_401_UNAUTHORIZED')console.log('\nAUTHENTICATION\n  ✗ Helius rejected the API key (401).\n  Check config/config.json.');else if(e.message==='HTTP_403_FORBIDDEN')console.log('\nAUTHORIZATION\n  ✗ Helius denied access (403).');else console.log(`\n  ✗ ${e.message}`)}
r.elapsed_seconds=Number(((Date.now()-started)/1000).toFixed(2));const out=save(r,mint);console.log(`\nRESULT\n  Name       : ${r.token.name||'UNKNOWN'}\n  Symbol     : ${r.token.symbol||'UNKNOWN'}\n  Decimals   : ${r.token.decimals??'UNKNOWN'}\n  Supply     : ${r.token.supply??'UNKNOWN'}\n  Program    : ${r.token.token_program||'UNKNOWN'}\n${r.missing.length?`  Missing     : ${r.missing.join(', ')}\n`:''}\n──────────────────────────────────────────────────────\nSTATUS     : ${r.status==='COMPLETE'?'COMPLETE ✓':r.status==='PARTIAL'?'PARTIAL ⚠':'FAILED ✗'}\nTIME       : ${r.elapsed_seconds.toFixed(2)}s\nOUTPUT     : ${path.relative(ROOT,out)}\n──────────────────────────────────────────────────────`);if(r.status==='FAILED')process.exitCode=1}
main().catch(e=>{console.log(`\nSTATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1});
