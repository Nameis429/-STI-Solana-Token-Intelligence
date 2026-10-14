#!/usr/bin/env node
/**
 * SOLANA TOKEN INTELLIGENCE — PHASE 6
 * FEE / TRADING ECONOMICS INTELLIGENCE
 *
 * Scope:
 *  - consume Phase 4 liquidity mapping + Phase 5 creator evidence
 *  - identify fee model/config for supported venues
 *  - verify fee destinations from on-chain program state/transactions
 *  - trace targeted downstream fee movement
 *  - compare documented claims with observed evidence
 *  - produce fee_economics_score (-10..+10) and fee_confidence
 *
 * Important:
 *  - documentation is CLAIM, not proof
 *  - unknown remains UNKNOWN
 *  - no claim of "dev fee" without evidence
 *  - network transaction fees are not AMM trading fees
 *
 * Current first-class adapter:
 *  - PumpSwap canonical/non-canonical AMM
 *
 * Other Phase 4 venues are preserved as UNSUPPORTED/UNKNOWN rather than guessed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { attachRunMetadata } = require('./run_metadata');
const throttle = require('./rpc_throttle');
const ROOT = path.resolve(__dirname, '..');
const CFG = fs.existsSync(path.join(ROOT, 'Config', 'config.json')) ? path.join(ROOT, 'Config', 'config.json') : path.join(ROOT, 'config.json');
const OUTPUT_ROOT = path.join(ROOT, 'Output');
const LEGACY_DATA = path.join(ROOT, 'Data');
const started = Date.now();

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from('95089ccaa0fcb0d9','hex');
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from('f19a6d0411b16dbc','hex');
const PUMPSWAP_GLOBAL = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

// Pump/PumpSwap official common fee-recipient set. This is a fallback
// discovery layer when GlobalConfig cannot be decoded; the scanner still
// requires transaction-level evidence before calling a recipient observed.
const OFFICIAL_PUMP_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'
];

const short = x => x && x.length > 12 ? `${x.slice(0, 6)}...${x.slice(-6)}` : x || 'UNKNOWN';
const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const rawBigInt = x => { try { return BigInt(String(x ?? '0')); } catch { return 0n; } };
const pct = (raw, den) => { const d=rawBigInt(den); return d>0n ? Number(rawBigInt(raw)*1000000n/d)/10000 : null; };
const normalizeTs = v => { const n=Number(v); return Number.isFinite(n) ? (n>20000000000?Math.floor(n/1000):Math.floor(n)) : null; };
const iso = v => { const n=normalizeTs(v); return n ? new Date(n*1000).toISOString() : null; };
const unique = a => [...new Set((a||[]).filter(Boolean))];

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
    const files=['phase5-result.json','phase4-result.json','phase3-result.json','phase2-result.json','phase1-result.json'];
    const f=files.map(n=>path.join(dir,n)).find(fs.existsSync);
    if(f){
      const x=readJson(f);
      const mint=x?.input?.mint||x?.token?.mint||d.name;
      if(valid(mint)) candidates.push({mint,file:f,source:path.basename(f)});
    }
  }
  for(const n of ['phase5-result.json','phase4-result.json','phase3-result.json','phase2-result.json','phase1-result.json']){
    const f=path.join(LEGACY_DATA,n);
    if(fs.existsSync(f)){
      const x=readJson(f); const mint=x?.input?.mint||x?.token?.mint;
      if(valid(mint)&&!candidates.some(c=>c.mint===mint)) candidates.push({mint,file:f,source:`data/${n}`});
    }
  }
  const requested=String(process.argv[2]||process.env.SCAN_MINT||'').trim();
  if(requested) for(let i=candidates.length-1;i>=0;i--) if(candidates[i].mint!==requested) candidates.splice(i,1);
  if(!candidates.length)return null;
  const rank={'phase5-result.json':5,'phase4-result.json':4,'phase3-result.json':3,'phase2-result.json':2,'phase1-result.json':1};
  candidates.sort((a,b)=>(rank[b.source]||0)-(rank[a.source]||0));
  const x=candidates[0], dir=path.join(OUTPUT_ROOT,x.mint);
  return {
    mint:x.mint, source:x.source,
    phase1:readJson(path.join(dir,'phase1-result.json')),
    phase2:readJson(path.join(dir,'phase2-result.json')),
    phase3:readJson(path.join(dir,'phase3-result.json')),
    phase4:readJson(path.join(dir,'phase4-result.json')),
    phase5:readJson(path.join(dir,'phase5-result.json'))
  };
}

function save(r,mint){
  const dir=path.join(OUTPUT_ROOT,mint); fs.mkdirSync(dir,{recursive:true});
  attachRunMetadata(r,6,mint); const f=path.join(dir,'phase6-result.json'); fs.writeFileSync(f,JSON.stringify(r,null,2)); return f;
}

async function requestJson(url,options,label,config,result){
  throttle.configure(config);
  const max=Math.max(1,Number(config.scanner?.max_retries??3));
  const base=Math.max(0,Number(config.scanner?.retry_delay_ms??1000));
  const timeout=Math.max(1000,Number(config.scanner?.request_timeout_ms??20000));
  for(let attempt=1;attempt<=max;attempt++){
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),timeout);
    try{
      console.log(`  ${label} : request (${attempt}/${max})`);
      await throttle.takeSlot();
      const res=await fetch(url,{...options,signal:ctl.signal});
      const txt=await res.text(); let body={}; try{body=txt?JSON.parse(txt):{};}catch{body={raw:txt};}
      if(res.status===401)throw Error('HTTP_401_UNAUTHORIZED');
      if(res.status===403)throw Error('HTTP_403_FORBIDDEN');
      if(res.status===400)throw Error(`HTTP_400: ${body?.error?.message||body?.message||body?.raw||''}`);
      if(res.status===404)throw Error(`HTTP_404: ${body?.error?.message||body?.message||body?.raw||''}`);
      if(res.status===410)throw Error(`HTTP_410: ${body?.error?.message||body?.message||body?.raw||''}`);
      if(throttle.isRetryableStatus(res.status)||res.status>=500){
        if(result?.retrieval_metrics){
          if(res.status===429){ result.retrieval_metrics.rate_limit.encountered=true; result.retrieval_metrics.rate_limit.retry_count++; }
        }
        if(attempt<max){console.log(`  ↻ RETRY   : HTTP ${res.status}`);await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base,throttle.retryAfterMs(res.headers.get('retry-after')))));continue;}
        throw Error(`HTTP_${res.status}`);
      }
      if(!res.ok)throw Error(`HTTP_${res.status}: ${body?.error?.message||body?.message||body?.raw||''}`);
      if(body?.error)throw Error(`RPC_${body.error.code??'UNKNOWN'}: ${body.error.message??'Unknown RPC error'}`);
      return body;
    }catch(e){
      if(e.message==='HTTP_401_UNAUTHORIZED'||e.message==='HTTP_403_FORBIDDEN')throw e;
      if(attempt>=max)throw e;
      console.log(`  ↻ RETRY   : ${e.name==='AbortError'?'TIMEOUT':e.message}`);
      await new Promise(r=>setTimeout(r,throttle.backoffMs(attempt,base)));
    }finally{clearTimeout(timer);}
  }
  throw Error('REQUEST_FAILED');
}

async function rpc(rpcUrl,method,params,label,config,result){
  const body={jsonrpc:'2.0',id:`phase6-${Date.now()}-${Math.random()}`,method,params};
  const out=await requestJson(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)},label,config,result);
  if(result)result.data_sources.push(`Helius RPC ${method}`);
  return out?.result;
}

// getAccountInfo returns account state under result.value. Keep this normalization
// local to getAccountInfo consumers so the shared rpc() return contract remains
// unchanged for methods such as getTokenAccountBalance/getSignaturesForAddress.
function normalizeGetAccountInfoResult(rpcResult){
  return rpcResult?.value ?? null;
}

/* ------------------------- Base58 / PDA ------------------------- */

const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP=new Map([...ALPHABET].map((c,i)=>[c,i]));

function b58decode(s){
  if(!valid(s)) throw Error(`INVALID_PUBKEY:${s}`);
  let n=0n;
  for(const c of s){ const v=ALPHABET_MAP.get(c); if(v===undefined)throw Error('INVALID_BASE58'); n=n*58n+BigInt(v); }
  let hex=n.toString(16); if(hex.length%2)hex='0'+hex;
  const bytes=[]; for(let i=0;i<hex.length;i+=2)bytes.push(parseInt(hex.slice(i,i+2),16));
  let zeros=0; for(const c of s){if(c==='1')zeros++;else break;}
  return Uint8Array.from([...new Array(zeros).fill(0),...bytes]);
}
function b58encode(bytes){
  let n=0n; for(const b of bytes)n=n*256n+BigInt(b);
  let out=''; while(n>0n){const r=Number(n%58n);out=ALPHABET[r]+out;n/=58n;}
  for(const b of bytes){if(b===0)out='1'+out;else break;}
  return out||'1';
}
const concatBytes=(...arrs)=>{const a=[];for(const x of arrs)a.push(...x);return Uint8Array.from(a);};
const sha256=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest();

const P=(1n<<255n)-19n;
const mod=(x)=>{x%=P;return x<0n?x+P:x;};
function powMod(a,e){let r=1n; a=mod(a);while(e>0n){if(e&1n)r=mod(r*a);a=mod(a*a);e>>=1n;}return r;}
const SQRT_EXP=(P+3n)>>3n;
const D=mod(-121665n*powMod(121666n,P-2n));
function ed25519OnCurve(comp){
  if(comp.length!==32)return true;
  const yBytes=Uint8Array.from(comp); const sign=(yBytes[31]>>7)&1; yBytes[31]&=127;
  let y=0n; for(let i=31;i>=0;i--)y=y*256n+BigInt(yBytes[i]);
  if(y>=P)return false;
  const y2=mod(y*y), u=mod(y2-1n), v=mod(D*y2+1n);
  const x2=mod(u*powMod(v,P-2n));
  let x=powMod(x2,SQRT_EXP);
  if(mod(x*x-x2)!==0n)x=mod(x*powMod(2n,(P-1n)>>2n));
  if(mod(x*x-x2)!==0n)return false;
  if(Number(x&1n)!==sign)x=mod(P-x);
  return mod(x*x-x2)===0n;
}
function findProgramAddress(seeds,programId){
  const pid=b58decode(programId);
  for(let bump=255;bump>=0;bump--){
    const data=concatBytes(...seeds,new Uint8Array([bump]),pid,Buffer.from('ProgramDerivedAddress'));
    const h=sha256(data);
    if(!ed25519OnCurve(h))return {address:b58encode(h),bump};
  }
  throw Error('PDA_NOT_FOUND');
}
function u64le(bytes,off){let n=0n;for(let i=7;i>=0;i--)n=n*256n+BigInt(bytes[off+i]);return n;}
function u16le(bytes,off){return bytes[off]|(bytes[off+1]<<8);}
function pubkey(bytes,off){return b58encode(bytes.slice(off,off+32));}
function readAccountBytes(account){
  const d=account?.data;
  if(!Array.isArray(d)||typeof d[0]!=='string')return null;
  return Buffer.from(d[0],'base64');
}
function parsePumpSwapGlobal(account){
  const b=readAccountBytes(account);
  if(!b) return {status:'PARSE_FAILED',reason:'NO_BASE64_ACCOUNT_DATA'};
  // Anchor account discriminator + supported layouts.
  // GlobalConfig discriminator is defined by the official PumpSwap IDL.
  if(b.length < 313) return {status:'PARSE_FAILED',reason:'GLOBAL_CONFIG_TOO_SHORT',data_length:b.length};
  const discriminator=b.subarray(0,8);
  if(!discriminator.equals(PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR)){
    return {status:'PARSE_FAILED',reason:'GLOBAL_CONFIG_WRONG_DISCRIMINATOR',data_length:b.length,discriminator:discriminator.toString('hex')};
  }
  if(account?.owner && account.owner!==PUMPSWAP){
    return {status:'PARSE_FAILED',reason:'GLOBAL_CONFIG_WRONG_OWNER',data_length:b.length,account_owner:account.owner};
  }
  const out={
    status:'PARSED',
    account_owner:account.owner||PUMPSWAP,
    data_length:b.length,
    discriminator:discriminator.toString('hex'),
    layout:b.length>=321?'V2_WITH_CREATOR_FEE':'LEGACY_NO_CREATOR_FEE',
    admin:pubkey(b,8),
    lp_fee_basis_points:u64le(b,40).toString(),
    protocol_fee_basis_points:u64le(b,48).toString(),
    disable_flags:b[56],
    protocol_fee_recipients:[]
  };
  let off=57;
  for(let i=0;i<8;i++){
    const addr=pubkey(b,off); off+=32;
    out.protocol_fee_recipients.push(addr);
  }
  out.coin_creator_fee_basis_points=b.length>=321?u64le(b,313).toString():null;
  out.coin_creator_fee_basis_points_source=b.length>=321?'ONCHAIN_GLOBAL_CONFIG':'FIELD_ABSENT_UNKNOWN';
  return out;
}


function u128le(bytes,off){
  let n=0n;
  for(let i=15;i>=0;i--)n=n*256n+BigInt(bytes[off+i]);
  return n;
}
function parsePumpSwapPool(account){
  const b=readAccountBytes(account);
  if(!b||b.length<261)return null;
  if(account?.owner && account.owner!==PUMPSWAP)return {status:'PARSE_FAILED',reason:'POOL_WRONG_OWNER',data_length:b.length,account_owner:account.owner};
  if(b.length<8 || !b.subarray(0,8).equals(PUMPSWAP_POOL_DISCRIMINATOR))return {status:'PARSE_FAILED',reason:'POOL_WRONG_DISCRIMINATOR',data_length:b.length,discriminator:b.subarray(0,8).toString('hex')};
  let off=8;
  const out={
    status:'PARSED',
    discriminator:b.subarray(0,8).toString('hex'),
    data_length:b.length,
    pool_bump:b[off], index:u16le(b,off+1),
    creator:pubkey(b,off+3),
    base_mint:pubkey(b,off+35),
    quote_mint:pubkey(b,off+67),
    lp_mint:pubkey(b,off+99),
    pool_base_token_account:pubkey(b,off+131),
    pool_quote_token_account:pubkey(b,off+163),
    lp_supply_raw:u64le(b,off+195).toString(),
    coin_creator:pubkey(b,off+203),
    is_mayhem_mode:Boolean(b[off+235]),
    is_cashback_coin:Boolean(b[off+236]),
    is_holder_reward:b.length>=262?Boolean(b[off+253]):false,
    virtual_quote_reserves_raw:b.length>=269?u128le(b,off+237).toString():(b.length>=261?u128le(b,off+237).toString():'0')
  };
  return out;
}
function parsePumpFeeConfig(account){
  const b=readAccountBytes(account);
  if(!b||b.length<69)return null;
  let off=8;
  const out={data_length:b.length,bump:b[off],admin:pubkey(b,off+1)};
  off+=33;
  out.flat_fees={
    lp_fee_bps:u64le(b,off).toString(),
    protocol_fee_bps:u64le(b,off+8).toString(),
    creator_fee_bps:u64le(b,off+16).toString()
  };
  off+=24;
  const count=b.readUInt32LE(off); off+=4;
  out.fee_tiers=[];
  for(let i=0;i<count;i++){
    if(off+40>b.length)break;
    out.fee_tiers.push({
      market_cap_lamports_threshold:u128le(b,off).toString(),
      lp_fee_bps:u64le(b,off+16).toString(),
      protocol_fee_bps:u64le(b,off+24).toString(),
      creator_fee_bps:u64le(b,off+32).toString()
    });
    off+=40;
  }
  out.truncated_tiers=out.fee_tiers.length!==count;
  return out;
}
function selectFeeTier(feeConfig,marketCapLamports){
  if(!feeConfig)return null;
  const tiers=[...(feeConfig.fee_tiers||[])].sort((a,b)=>rawBigInt(a.market_cap_lamports_threshold)<rawBigInt(b.market_cap_lamports_threshold)?-1:1);
  let selected=null;
  for(const t of tiers) if(rawBigInt(marketCapLamports)>=rawBigInt(t.market_cap_lamports_threshold))selected=t;
  return selected;
}
/* ------------------------- ATA / fee addresses ------------------------- */

function associatedTokenAddress(owner,mint){
  return findProgramAddress([
    b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)
  ],ASSOCIATED_TOKEN_PROGRAM).address;
}
function pumpSwapCreatorVaultAuthority(creator){
  return findProgramAddress([Buffer.from('creator_vault'),b58decode(creator)],PUMPSWAP).address;
}
function pumpSharingConfig(mint){
  return findProgramAddress([Buffer.from('sharing-config'),b58decode(mint)],PUMP_FEES_PROGRAM).address;
}
function pumpCreatorVault(creatorOrSharingConfig){
  return findProgramAddress([Buffer.from('creator-vault'),b58decode(creatorOrSharingConfig)],PUMP_PROGRAM).address;
}
function pumpFeeConfig(){
  return findProgramAddress([Buffer.from('fee_config'),b58decode(PUMP_PROGRAM)],PUMP_FEES_PROGRAM).address;
}

/* ------------------------- Phase 4/5 inputs ------------------------- */

function getPools(p4,mint){
  const seen=new Set(), out=[];
  const candidates=[
    ...(p4?.liquidity_mapping?.confirmed_pools||[]),
    ...(p4?.liquidity_mapping?.significant_pools||[])
  ];
  for(const p of candidates){
    if(!p||!valid(p.pool))continue;
    const programId=p.program_id||null;
    const dex=p.program_name||p.dex||'UNKNOWN';
    const key=`${dex}|${programId||'UNKNOWN'}|${p.pool}`;
    if(seen.has(key))continue;
    seen.add(key);
    const quote=p.quote_mint||null;
    const row={
      pool:p.pool, dex, program_id:programId,
      base_mint:p.base_mint||null, quote_mint:quote, lp_mint:p.lp_mint||null,
      pool_base_token_account:p.pool_base_token_account||null,
      pool_quote_token_account:p.pool_quote_token_account||null,
      coin_creator:p.coin_creator||null,
      is_mayhem_mode:p.is_mayhem_mode??null,
      is_cashback_coin:p.is_cashback_coin??null,
      lp_status:p.lp_status?.status||p.lp_status||null
    };
    if(row.base_mint===mint||row.quote_mint===mint)out.push(row);
  }
  return out;
}

/* ------------------------- Fee claims / model ------------------------- */

function pumpSwapClaim(pool,global){
  const creatorBps=global?.coin_creator_fee_basis_points==null?null:Number(global.coin_creator_fee_basis_points);
  const lpBps=Number(global?.lp_fee_basis_points??0);
  const protocolBps=Number(global?.protocol_fee_basis_points??0);
  const total=(creatorBps??0)+lpBps+protocolBps;
  return {
    venue:'PumpSwap',
    pool_type:(pool.pool && pool.base_mint && pool.quote_mint && pool.coin_creator)?'CANONICAL_OR_CREATOR_CONFIGURED':'POSSIBLY_NON_CANONICAL',
    source:'official PumpSwap program docs / current on-chain GlobalConfig',
    components:[
      {name:'LP_FEE',bps:lpBps,pct:lpBps/100,destination_type:'POOL_LIQUIDITY'},
      {name:'PROTOCOL_FEE',bps:protocolBps,pct:protocolBps/100,destination_type:'PROTOCOL_FEE_RECIPIENT'},
      {name:'COIN_CREATOR_FEE',bps:creatorBps,pct:creatorBps==null?null:creatorBps/100,destination_type:creatorBps==null?'UNKNOWN':(creatorBps>0?'CREATOR_VAULT':'NOT_ACTIVE')}
    ],
    total_bps:total,total_pct:total/100,
    note:'GlobalConfig gives the current AMM base fee components. Canonical PumpSwap fees may vary by market-cap schedule; the transaction/program state is treated as authoritative for verification.'
  };
}


async function getTokenAccountBalance(address,rpcUrl,config,result,label){
  const r=await rpc(rpcUrl,'getTokenAccountBalance',[address,{commitment:'confirmed'}],label||`Token balance ${short(address)}`,config,result);
  return r?.value||null;
}

/* ------------------------- Transaction helpers ------------------------- */

function txAccountKeys(tx){
  const msg=tx?.transaction?.message||tx?.message||{};
  const keys=msg.accountKeys||[];
  const out=keys.map(k=>typeof k==='string'?k:(k?.pubkey||k?.address)).filter(valid);
  const loaded=tx?.meta?.loadedAddresses||{};
  return [...out,...(loaded.writable||[]).filter(valid),...(loaded.readonly||[]).filter(valid)];
}
function txLamportDeltas(tx){
  const meta=tx?.meta||{};
  const pre=meta.preBalances||[], post=meta.postBalances||[];
  const keys=txAccountKeys(tx); const out=[];
  for(let i=0;i<Math.min(keys.length,pre.length,post.length);i++){
    const d=BigInt(post[i]||0)-BigInt(pre[i]||0);
    if(d!==0n)out.push({address:keys[i],delta_lamports:d.toString(),delta_sol:Number(d)/1e9});
  }
  return out;
}
function txTokenDeltas(tx){
  const meta=tx?.meta||{}, pre=new Map(), post=new Map();
  for(const x of (meta.preTokenBalances||[]))pre.set(`${x.accountIndex}:${x.mint}`,{owner:x.owner||null,amount:rawBigInt(x.uiTokenAmount?.amount)});
  for(const x of (meta.postTokenBalances||[]))post.set(`${x.accountIndex}:${x.mint}`,{owner:x.owner||null,amount:rawBigInt(x.uiTokenAmount?.amount)});
  const keys=new Set([...pre.keys(),...post.keys()]), out=[];
  for(const k of keys){
    const a=pre.get(k)||{amount:0n,owner:null}, b=post.get(k)||{amount:0n,owner:a.owner};
    const [idx,mint]=k.split(':'); const d=b.amount-a.amount;
    if(d!==0n)out.push({account_index:Number(idx),address:txAccountKeys(tx)[Number(idx)]||null,mint,owner:b.owner,delta_raw:d.toString(),decimals:Number((meta.postTokenBalances||[]).find(x=>x.accountIndex===Number(idx)&&x.mint===mint)?.uiTokenAmount?.decimals??0)});
  }
  return out;
}
function txHasProgram(tx,programId){
  const meta=tx?.meta||{}, keys=txAccountKeys(tx);
  const all=[...(tx?.transaction?.message?.instructions||[]),...(meta.innerInstructions||[]).flatMap(x=>x.instructions||[])];
  for(const ix of all){
    const p=ix?.programId||ix?.program_id;
    if(p===programId)return true;
    if(ix?.program==='spl-associated-token-account'&&programId===ASSOCIATED_TOKEN_PROGRAM)return true;
  }
  return keys.includes(programId);
}
function classifyDownstream(tx,address){
  const desc=String(tx?.description||'').toLowerCase();
  const type=String(tx?.type||'').toUpperCase();
  const logs=(tx?.meta?.logMessages||[]).join(' ').toLowerCase();
  const text=`${type} ${desc} ${logs}`;
  if(text.includes('buyback')||text.includes('buy back'))return 'BUYBACK';
  if(text.includes('burn')||text.includes('spl token burn'))return 'BURN';
  if(txInstructions(tx).some(ix=>String(ix?.parsed?.type||'').toLowerCase()==='burn'))return 'BURN';
  if(text.includes('swap')||text.includes('buy')||text.includes('sell'))return 'SWAP';
  const lam=txLamportDeltas(tx);
  if(lam.some(x=>x.address===address&&rawBigInt(x.delta_lamports)<0n))return 'OUTFLOW';
  if(lam.some(x=>x.address===address&&rawBigInt(x.delta_lamports)>0n))return 'INFLOW';
  return 'OTHER';
}

async function getSignatures(address,rpcUrl,config,result,limit){
  return await rpc(rpcUrl,'getSignaturesForAddress',[address,{limit:Math.max(1,Math.min(1000,Number(limit||20)))}],`Signatures ${short(address)}`,config,result);
}
async function getTransaction(sig,rpcUrl,config,result){
  return await rpc(rpcUrl,'getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:1}],`Transaction ${short(sig)}`,config,result);
}
async function fetchTransactionRows(address,rpcUrl,config,result,signatureRows){
  const txs=[];
  for(const s of signatureRows||[]){
    try{
      const tx=await getTransaction(s.signature,rpcUrl,config,result);
      if(tx)txs.push({signature:s.signature,slot:s.slot,block_time:s.blockTime||null,tx});
    }catch(e){result.errors.push(`TX_${s.signature}:${e.message}`);}
  }
  return txs;
}

function randomInt(max){
  if(max<=1)return 0;
  return crypto.randomInt(0,max);
}

function selectTimeDistributedSignatures(signatures,count,mode='HYBRID'){
  const rows=(signatures||[]).filter(x=>x?.signature).slice();
  if(!rows.length||count<=0)return [];
  const n=Math.min(count,rows.length);
  const chosen=new Map();
  const add=x=>{if(x?.signature&&!chosen.has(x.signature))chosen.set(x.signature,x);};
  const shuffled=rows.slice().sort(()=>Math.random()-0.5);

  // Always preserve a small latest slice so current fee routing remains visible.
  const latestN=Math.min(Math.max(1,Math.floor(n*0.25)),n);
  for(let i=0;i<latestN;i++)add(rows[i]);

  if(mode==='RANDOM'){
    for(const x of shuffled){if(chosen.size>=n)break;add(x);}
    return [...chosen.values()].slice(0,n);
  }

  // Divide the available signature history into time/order buckets. This is
  // deliberately bounded: the scanner samples across the available window,
  // rather than scanning the token's entire history.
  const remaining=n-chosen.size;
  const bucketCount=Math.min(4,Math.max(1,remaining));
  for(let b=0;b<bucketCount;b++){
    if(chosen.size>=n)break;
    const lo=Math.floor(b*rows.length/bucketCount);
    const hi=Math.max(lo+1,Math.floor((b+1)*rows.length/bucketCount));
    const bucket=rows.slice(lo,hi).filter(x=>!chosen.has(x.signature));
    if(bucket.length)add(bucket[randomInt(bucket.length)]);
  }
  for(const x of shuffled){if(chosen.size>=n)break;add(x);}
  return [...chosen.values()].slice(0,n);
}

function buildPhase6SampleCoverage(sample){
  const target=Number(sample?.target_count||0);
  const historyPool=Number(sample?.history_pool_size||0);
  const available=Number(sample?.available_count ?? sample?.available_signatures ?? 0);
  const selected=Number(sample?.selected_count||0);
  const txFailures=Number(sample?.transaction_failures||0);
  const requestFailed=Boolean(sample?.request_failed);
  const rateLimit=sample?.rate_limit||{};
  const base={
    retrieval_mode:'SAMPLED',
    status:(requestFailed || txFailures>0) ? 'PARTIAL' : 'SAMPLED',
    reason: requestFailed ? 'REQUEST_FAILED' : (txFailures>0 ? 'REQUEST_FAILED' : 'SAMPLE_LIMIT'),
    scope:'SAMPLE_WINDOW',
    pagination:{
      enabled:false,
      pages_requested:1,
      pages_fetched:requestFailed?0:1,
      cursor_used:false,
      stopped_reason:requestFailed?'REQUEST_FAILED':'SAMPLE_LIMIT',
      has_more_possible:true
    },
    records:{
      requested:historyPool,
      observed:available,
      retained:selected
    },
    caps:{
      page_cap:null,
      record_cap:historyPool||null,
      wallet_cap:null,
      event_cap:null,
      cap_triggered:true
    },
    rate_limit:{
      encountered:Boolean(rateLimit.encountered),
      retry_count:Number(rateLimit.retry_count||0),
      recovered:rateLimit.recovered ?? null,
      final_state:rateLimit.final_state || 'NOT_ENCOUNTERED'
    }
  };
  return base;
}

function aggregatePhase6Coverage(datasetCoverages, base={}){
  const coverages=(datasetCoverages||[]).filter(Boolean);
  const statuses=coverages.map(c=>String(c.status||'UNKNOWN').toUpperCase());
  let status='UNKNOWN';
  let reason='NOT_AVAILABLE';

  if(statuses.length===0){
    // No retrieval coverage exists. This is not evidence of an empty scope.
    // Keep the sampling mode/scope explicit while avoiding a false EMPTY claim.
    status='UNKNOWN';
    reason='NOT_AVAILABLE';
  }else if(statuses.some(x=>x==='FAILED')){
    status=statuses.every(x=>x==='FAILED')?'FAILED':'PARTIAL';
    reason=status==='FAILED'?'REQUEST_FAILED':'UPSTREAM_PARTIAL';
  }else if(statuses.some(x=>x==='PARTIAL')){
    status='PARTIAL';
    reason='UPSTREAM_PARTIAL';
  }else if(statuses.some(x=>x==='SAMPLED')){
    // Sampling remains SAMPLED even when the sampled result contains zero records.
    status='SAMPLED';
    reason='SAMPLE_LIMIT';
  }else if(statuses.every(x=>x==='EMPTY')){
    // EMPTY is valid only when an explicit retrieval scope was completed and empty.
    status='EMPTY';
    reason='NO_MATCH';
  }else if(statuses.every(x=>x==='COMPLETE')){
    status='COMPLETE';
    reason='NO_MORE_DATA';
  }

  return {
    ...base,
    status,
    reason,
    retrieval_mode:status==='FAILED'?'FAILED':(status==='SAMPLED'?'SAMPLED':(status==='EMPTY'?'EMPTY':(base.retrieval_mode||'SAMPLED'))),
    scope:base.scope||'SAMPLE_WINDOW'
  };
}

function resolveFeeFlowVerificationStatus(components){
  const comps=Array.isArray(components)?components:[];
  if(!comps.length)return 'UNKNOWN';
  const statuses=comps.map(c=>String(c?.verification||'UNKNOWN').toUpperCase());
  const verified=statuses.filter(x=>x==='VERIFIED').length;
  const incomplete=statuses.some(x=>['PARTIAL','OBSERVED','UNKNOWN','CLAIM_ONLY','INSUFFICIENT_DATA','CONFLICT'].includes(x));
  if(verified===statuses.length)return 'VERIFIED';
  if(verified>0 || incomplete)return 'PARTIAL';
  return 'UNKNOWN';
}

function protocolStateIdentity(entry){
  return [entry?.program||'',entry?.name||'',entry?.program_id||'',entry?.address||'',entry?.status||''].join('|');
}

function dedupeProtocolStateEntries(entries){
  const seen=new Set(),out=[];
  for(const entry of (entries||[])){
    const key=protocolStateIdentity(entry);
    if(seen.has(key))continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/* PH6-20/32 (finalized): protocol_state.status must be finalized on
 * EVERY exit path — never left at its initial 'UNKNOWN'.
 *  - FOUND/PARTIAL/FAILED: GlobalConfig discovery outcomes (as before).
 *  - NOT_APPLICABLE: no supported-protocol pool exists, so there is no
 *    protocol state to discover. Previously misreported as UNKNOWN.
 *  - NOT_DETERMINED: upstream failure (e.g. RPC health check) prevented
 *    discovery from running at all. Previously also misreported as UNKNOWN.
 *  UNKNOWN is now reserved for "discovery attempted but indeterminate". */
function finalizeProtocolState(result,upstreamFailed=false){
  if(upstreamFailed){
    result.protocol_state.status='NOT_DETERMINED';
    result.protocol_state.note='Protocol state discovery did not run: upstream RPC/health failure.';
  }else{
    const states=result.protocol_state.global_configs||[];
    const hasParsedGlobal=states.some(x=>x.status==='FOUND' && x.state?.status==='PARSED');
    const hasGlobalFailure=states.some(x=>x.status==='PARSE_FAILED');
    result.protocol_state.status=hasParsedGlobal ? (hasGlobalFailure?'PARTIAL':'FOUND')
      : hasGlobalFailure ? 'FAILED'
      : states.length>0 ? 'UNKNOWN'
      : 'NOT_APPLICABLE';
    if(result.protocol_state.status==='NOT_APPLICABLE')
      result.protocol_state.note='No supported-protocol (PumpSwap) pool found; no protocol global config to discover.';
  }
  result.protocol_state.programs=dedupeProtocolStateEntries(result.protocol_state.programs);
  result.protocol_state.global_configs=dedupeProtocolStateEntries(result.protocol_state.global_configs);
  return result.protocol_state.status;
}

async function getSampledTransactionsForAddress(address,rpcUrl,config,result,count,options={}){
  const target=Math.max(1,Number(count||20));
  const historyPool=Math.min(1000,Math.max(target,Number(options.history_pool_size||target*5)));
  let sigs=null, requestFailed=false;
  try{ sigs=await getSignatures(address,rpcUrl,config,result,historyPool); }
  catch(e){ requestFailed=true; result.errors.push(`SIGNATURES_${address}:${e.message}`); }
  const available=Array.isArray(sigs)?sigs.filter(x=>x?.signature):[];
  const selected=selectTimeDistributedSignatures(available,target,options.mode||'HYBRID');
  const beforeErrors=result.errors.length;
  const rows=await fetchTransactionRows(address,rpcUrl,config,result,selected);
  const transactionFailures=Math.max(0,result.errors.length-beforeErrors);
  const rateLimit=result.retrieval_metrics?.rate_limit||{};
  const sample={mode:options.mode||'HYBRID',target_count:target,history_pool_size:historyPool,available_count:available.length,selected_count:selected.length,transaction_failures:transactionFailures,request_failed:requestFailed,rate_limit:rateLimit};
  return {rows,available_signatures:available.length,selected_signatures:selected.map(x=>x.signature),sampling:sample,coverage:buildPhase6SampleCoverage(sample)};
}

function instructionAccountAddresses(ix, tx){
  const keys=txAccountKeys(tx);
  const raw=Array.isArray(ix?.accounts)?ix.accounts:[];
  return raw.map(a=>{
    if(typeof a==='string') return a;
    if(Number.isInteger(a)) return keys[a]||null;
    return a?.pubkey||a?.address||null;
  }).filter(valid);
}

function extractInstructionProgramId(ix){
  return ix?.programId||ix?.program_id||null;
}

const PUMPSWAP_TRADE_DISCRIMINATORS=new Set([
  'J4mKiQqJzCZ', // buy
  '9gVynCQsA1A', // sell
  'AXqYfkfqYht', // buy_exact_sol_in
  'ZZXax5UyFEN'  // buy_exact_quote_in
]);

function decodeBase58(value){
  if(typeof value!=='string'||!value)return null;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const map=new Map([...alphabet].map((c,i)=>[c,i]));
  let n=0n;
  for(const ch of value){
    const v=map.get(ch); if(v===undefined)return null;
    n=n*58n+BigInt(v);
  }
  const bytes=[];
  while(n>0n){bytes.push(Number(n&255n));n>>=8n;}
  bytes.reverse();
  let pad=0; for(const ch of value){if(ch==='1')pad++;else break;}
  return Buffer.concat([Buffer.alloc(pad),Buffer.from(bytes)]);
}

function instructionDiscriminator(ix){
  const data=ix?.data;
  if(Buffer.isBuffer(data))return data.subarray(0,8).toString('hex');
  if(Array.isArray(data))return Buffer.from(data).subarray(0,8).toString('hex');
  if(typeof data==='string'){
    const b=decodeBase58(data);
    if(b&&b.length>=8)return b.subarray(0,8).toString('hex');
  }
  return null;
}

function isPumpSwapTradeInstruction(ix,tx,pool){
  if(extractInstructionProgramId(ix)!==PUMPSWAP)return false;
  const accounts=instructionAccountAddresses(ix,tx);
  if(pool?.pool && !accounts.includes(pool.pool))return false;
  const parsedType=String(ix?.parsed?.type||'').toLowerCase();
  if(parsedType==='buy'||parsedType==='sell')return true;
  const disc=instructionDiscriminator(ix);
  return disc ? [...PUMPSWAP_TRADE_DISCRIMINATORS].some(encoded=>{
    const b=decodeBase58(encoded);
    return b&&b.subarray(0,8).toString('hex')===disc;
  }) : false;
}

function recipientAppearsInPumpSwapTradeInstruction(tx,pool,recipientAddresses){
  const wanted=new Set((recipientAddresses||[]).filter(valid));
  if(!wanted.size)return false;
  return txInstructions(tx).some(ix=>{
    if(!isPumpSwapTradeInstruction(ix,tx,pool))return false;
    const accounts=instructionAccountAddresses(ix,tx);
    return accounts.some(a=>wanted.has(a));
  });
}

function evaluateFeeAttributionEvidence(tx,pool,recipients,positiveMatches){
  const programSeen=txMentionsProgram(tx,PUMPSWAP);
  const tradeInstruction=txInstructions(tx).some(ix=>isPumpSwapTradeInstruction(ix,tx,pool));
  const recipientInTrade=recipientAppearsInPumpSwapTradeInstruction(tx,pool,recipients);
  const positiveBalance=Array.isArray(positiveMatches)&&positiveMatches.length>0;
  return {
    program_seen:programSeen,
    trade_instruction_seen:tradeInstruction,
    recipient_in_trade_instruction:recipientInTrade,
    positive_balance_delta:positiveBalance,
    verified:programSeen&&tradeInstruction&&recipientInTrade&&positiveBalance,
    reason:!positiveBalance?'NO_POSITIVE_DESTINATION_DELTA':
      !programSeen?'PUMPSWAP_PROGRAM_NOT_SEEN':
      !tradeInstruction?'PUMPSWAP_TRADE_INSTRUCTION_NOT_CONFIRMED':
      !recipientInTrade?'RECIPIENT_NOT_PRESENT_IN_TRADE_INSTRUCTION':'PUMPSWAP_TRADE_AND_RECIPIENT_MATCH_CONFIRMED'
  };
}

function detectPumpSwapFeeRecipientCandidates(tx){
  const found=new Set();
  for(const ix of txInstructions(tx)){
    const pid=extractInstructionProgramId(ix);
    if(pid!==PUMPSWAP) continue;
    const accounts=instructionAccountAddresses(ix,tx);
    // PumpSwap buy/sell places one of the common fee recipients near the end
    // of the account list. We deliberately use the official recipient set as
    // a candidate filter, then require positive balance evidence below.
    for(const a of accounts) if(OFFICIAL_PUMP_FEE_RECIPIENTS.includes(a)) found.add(a);
  }
  return [...found];
}

function feeTransferIdentity(x){
  return [
    x?.signature||'',
    x?.asset||'',
    x?.recipient||'',
    x?.owner||'',
    x?.delta_lamports??'',
    x?.delta_raw??'',
    x?.decimals??''
  ].join('|');
}

function dedupeFeeTransfers(transfers){
  const seen=new Set();
  const out=[];
  for(const transfer of (transfers||[])){
    const key=feeTransferIdentity(transfer);
    if(seen.has(key))continue;
    seen.add(key);
    out.push(transfer);
  }
  return out;
}

function buildObservedRecipientMap(tx,pool,globalRecipients){
  const candidates=unique([...(globalRecipients||[]),...OFFICIAL_PUMP_FEE_RECIPIENTS,...detectPumpSwapFeeRecipientCandidates(tx)]);
  const lam=txLamportDeltas(tx);
  const tok=txTokenDeltas(tx);
  const rows=[];
  for(const addr of candidates){
    const lamRows=lam.filter(x=>x.address===addr&&rawBigInt(x.delta_lamports)>0n);
    const ata=pool.quote_mint||WSOL;
    let ataAddr=null; try{ataAddr=associatedTokenAddress(addr,ata);}catch{}
    const tokRows=tok.filter(x=>x.mint===ata&&(x.address===ataAddr||x.owner===addr)&&rawBigInt(x.delta_raw)>0n);
    if(lamRows.length||tokRows.length){
      rows.push({
        address:addr,
        native_receipts:lamRows.map(x=>({delta_lamports:x.delta_lamports,delta_sol:x.delta_sol})),
        token_receipts:tokRows.map(x=>({address:x.address,owner:x.owner,mint:x.mint,delta_raw:x.delta_raw,decimals:x.decimals})),
        evidence:'POSITIVE_BALANCE_DELTA_IN_POOL_TRANSACTION'
      });
    }
  }
  return rows;
}

function classifyRecipient(address, pool, globalState, creatorAddress){
  if(!address)return 'UNKNOWN';
  if(new Set(globalState?.protocol_fee_recipients||[]).has(address))return 'PROTOCOL_FEE_RECIPIENT';
  if(address===creatorAddress)return 'COIN_CREATOR';
  if(address===pool.pool)return 'POOL';
  if(address===pool.pool_quote_token_account||address===pool.pool_base_token_account)return 'POOL_TOKEN_ACCOUNT';
  return 'UNKNOWN';
}

function accountIndexAddressMap(tx){
  const keys=txAccountKeys(tx); const m=new Map(); keys.forEach((k,i)=>m.set(i,k)); return m;
}

function txInstructions(tx){
  const msg=tx?.transaction?.message||tx?.message||{};
  const outer=msg.instructions||[];
  const inner=(tx?.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]);
  return [...outer,...inner];
}

function txMentionsProgram(tx, programId){
  return txInstructions(tx).some(ix=>ix?.programId===programId || ix?.program===programId) || txAccountKeys(tx).includes(programId);
}

function extractTokenTransfersToAddresses(tx, addresses, mint){
  const wanted=new Set(addresses||[]);
  return txTokenDeltas(tx).filter(d=>d.mint===mint && (wanted.has(d.address)||wanted.has(d.owner)) && rawBigInt(d.delta_raw)>0n);
}

function extractLamportTransfersToAddresses(tx, addresses){
  const wanted=new Set(addresses||[]);
  return txLamportDeltas(tx).filter(d=>wanted.has(d.address)&&rawBigInt(d.delta_lamports)>0n);
}

function inferTradeEvent(tx, pool){
  const instructions=txInstructions(tx);
  const logs=(tx?.meta?.logMessages||[]).join(' ').toLowerCase();
  const desc=String(tx?.description||'').toLowerCase();
  const text=`${logs} ${desc}`;
  if(text.includes('buyevent')||text.includes('buy_event')||text.includes('instruction: buy')||text.includes(' buy '))return 'BUY';
  if(text.includes('sellevent')||text.includes('sell_event')||text.includes('instruction: sell')||text.includes(' sell '))return 'SELL';
  if(instructions.some(ix=>String(ix?.parsed?.type||'').toLowerCase()==='transfer'))return 'TRANSFER_OR_OTHER';
  return null;
}

function summarizeDestinationFlow(flowRows){
  const out={
    positive_transfers:0,
    negative_transfers:0,
    swaps:0,
    burn_like:0,
    holder_reward_like:0,
    evidence:[]
  };
  for(const row of flowRows){
    if(rawBigInt(row.delta_lamports||row.delta_raw||0)>0n)out.positive_transfers++;
    if(rawBigInt(row.delta_lamports||row.delta_raw||0)<0n)out.negative_transfers++;
    if(row.kind==='SWAP')out.swaps++;
    if(row.kind==='BURN')out.burn_like++;
    if(row.kind==='HOLDER_REWARD')out.holder_reward_like++;
  }
  return out;
}


/* ------------------------- Token claims / reality ------------------------- */

const CLAIM_TYPES = {
  BUYBACK_BURN:'BUYBACK_BURN',
  HOLDER_REWARDS:'HOLDER_REWARDS',
  STAKING:'STAKING',
  TREASURY:'TREASURY',
  LIQUIDITY:'LIQUIDITY',
  PROTOCOL_UTILITY:'PROTOCOL_UTILITY',
  FEE_UTILITY:'FEE_UTILITY',
  NO_CREATOR_FEE:'NO_CREATOR_FEE',
  NO_TAX:'NO_TAX',
  CHARITY:'CHARITY'
};

function textifyMetadata(value, out=[], path='metadata', depth=0){
  if(depth>5 || value==null)return out;
  if(typeof value==='string'){
    const t=value.trim();
    if(t && (t.length>=8 || /^https?:\/\//i.test(t))) out.push({path,text:t});
    return out;
  }
  if(Array.isArray(value)){ value.slice(0,100).forEach((v,i)=>textifyMetadata(v,out,`${path}[${i}]`,depth+1)); return out; }
  if(typeof value==='object'){
    for(const [k,v] of Object.entries(value)) textifyMetadata(v,out,`${path}.${k}`,depth+1);
  }
  return out;
}

function normalizeClaimText(s){
  return String(s||'').replace(/\s+/g,' ').trim();
}

function detectTokenClaims(textRows){
  const rows=[];
  const seen=new Set();
  const add=(type,text,sourcePath)=>{
    const clean=normalizeClaimText(text);
    if(!clean)return;
    const key=`${type}|${clean.toLowerCase()}`;
    if(seen.has(key))return;
    seen.add(key); rows.push({type,claim_text:clean,source_path:sourcePath||'metadata'});
  };
  for(const row of textRows||[]){
    const t=normalizeClaimText(row.text);
    if(!t)continue;
    const low=t.toLowerCase();
    // Require explicit claim-like context; isolated words such as "protocol" or
    // "utility" are intentionally ignored to avoid noisy false positives.
    if(/\b(buyback|buy[- ]?back|buy and burn|buy & burn|burn tokens|token burn)\b/i.test(t)) add(CLAIM_TYPES.BUYBACK_BURN,t,row.path);
    if(/\b(holder (rewards?|revenue|share)|rewards? (to|for) holders|holders? (earn|receive|share))\b/i.test(t)) add(CLAIM_TYPES.HOLDER_REWARDS,t,row.path);
    if(/\b(staking|stake (the|your)? token|staking rewards?)\b/i.test(t)) add(CLAIM_TYPES.STAKING,t,row.path);
    if(/\b(treasury|treasury wallet|treasury fund|treasury funds)\b/i.test(t)) add(CLAIM_TYPES.TREASURY,t,row.path);
    if(/\b(liquidity|liquidity pool|liquidity provision|lp rewards?)\b/i.test(t)) add(CLAIM_TYPES.LIQUIDITY,t,row.path);
    if(/\b(protocol utility|protocol use|used by the protocol|protocol revenue|protocol fees? fund)\b/i.test(t)) add(CLAIM_TYPES.PROTOCOL_UTILITY,t,row.path);
    if(/\b(fee (utility|revenue|reinvestment|distribution)|fees? (are|is) (used|returned|distributed|shared))\b/i.test(t)) add(CLAIM_TYPES.FEE_UTILITY,t,row.path);
    if(/\b(no|zero|without|does not have|doesn't have)\s+(creator|dev|developer)\s+fee\b/i.test(t)) add(CLAIM_TYPES.NO_CREATOR_FEE,t,row.path);
    if(/\b(no|zero|without|does not have|doesn't have)\s+(buy|sell|trading)\s+tax\b|\b(no|zero)\s+tax\b/i.test(t)) add(CLAIM_TYPES.NO_TAX,t,row.path);
    if(/\b(charity|donat(?:e|ion)|donations? to)\b/i.test(t)) add(CLAIM_TYPES.CHARITY,t,row.path);
  }
  return rows;
}

async function fetchDASAsset(mint,apiBase,config,result){
  const url=`${config.helius.rpc_url}?api-key=${encodeURIComponent(config.helius.api_key)}`;
  const body=await rpc(url,'getAsset',{id:mint,displayOptions:{showFungible:true}},'DAS getAsset',config,null);
  return body;
}

async function fetchExternalMetadata(uri,config){
  if(!/^https?:\/\//i.test(String(uri||''))) throw Error('INVALID_METADATA_URI');
  return await requestJson(String(uri),{method:'GET',headers:{Accept:'application/json,text/plain;q=0.9,*/*;q=0.8'}},'Metadata URI',config);
}

function extractTokenIdentityAndRows(input,p2,das){
  const rows=[];
  const sources=[];
  const identity={name:null,symbol:null,uri:null};
  const addSource = (name)=>{if(name&&!sources.includes(name))sources.push(name);}
  const p2meta=p2?.token_2022?.extensions?.tokenMetadata;
  if(p2meta){
    addSource('ONCHAIN_TOKEN_METADATA');
    identity.name ||= p2meta.name||null; identity.symbol ||= p2meta.symbol||null; identity.uri ||= p2meta.uri||null;
    textifyMetadata(p2meta,rows,'phase2.token_2022.extensions.tokenMetadata');
  }
  const p1meta=input?.phase1?.token?.metadata||input?.phase1?.asset?.content?.metadata||input?.phase1?.metadata||null;
  if(p1meta){ addSource('PHASE1_METADATA'); textifyMetadata(p1meta,rows,'phase1.metadata'); identity.name ||= p1meta.name||null; identity.symbol ||= p1meta.symbol||null; identity.uri ||= p1meta.uri||null; }
  if(das){
    addSource('HELIUS_DAS_GET_ASSET');
    const content=das.content||{};
    const md=content.metadata||content?.json_uri_metadata||{};
    textifyMetadata(md,rows,'das.content.metadata');
    textifyMetadata(content,rows,'das.content');
    identity.name ||= md.name||das.name||null; identity.symbol ||= md.symbol||das.symbol||null;
    identity.uri ||= content.json_uri||das?.content?.json_uri||das?.json_uri||null;
  }
  return {identity,sources,rows};
}


const EVIDENCE_STATUS = Object.freeze({
  VERIFIED:'VERIFIED',
  OBSERVED:'OBSERVED',
  CLAIM_ONLY:'CLAIM_ONLY',
  UNKNOWN:'UNKNOWN',
  PARTIAL:'PARTIAL',
  INSUFFICIENT_DATA:'INSUFFICIENT_DATA',
  CONFLICT:'CONFLICT'
});

function economicEvidenceStatus(component){
  const d=component?.downstream_use||{};
  if(d.verified_protocol_utility===true || d.verified_holder_benefit===true ||
     d.verified_buyback_or_burn===true || d.verified_creator_extraction===true){
    return EVIDENCE_STATUS.VERIFIED;
  }
  if(component?.verification==='PARTIAL') return EVIDENCE_STATUS.PARTIAL;
  if(component?.verification==='VERIFIED' || d.status==='OBSERVED') return EVIDENCE_STATUS.OBSERVED;
  if(component?.claim_status==='CLAIM_ONLY') return EVIDENCE_STATUS.CLAIM_ONLY;
  if(component?.claim_status==='OFFICIAL_RECIPIENT_SET_ONLY') return EVIDENCE_STATUS.UNKNOWN;
  return EVIDENCE_STATUS.INSUFFICIENT_DATA;
}

function attachEvidenceSemantics(component){
  const status=economicEvidenceStatus(component);
  const d=component?.downstream_use||{};
  return {
    ...component,
    routing_verification: component?.verification||EVIDENCE_STATUS.UNKNOWN,
    economic_evidence_status: status,
    economic_scoring_eligible: status===EVIDENCE_STATUS.VERIFIED,
    evidence_basis: status===EVIDENCE_STATUS.VERIFIED
      ? 'Verified downstream economic function evidence.'
      : status===EVIDENCE_STATUS.OBSERVED
        ? 'Technical fee/routing activity observed; economic function remains unverified.'
        : status===EVIDENCE_STATUS.PARTIAL
          ? 'Some fee evidence exists, but coverage or verification is incomplete.'
          : status===EVIDENCE_STATUS.CLAIM_ONLY
            ? 'Economic function appears only in an external/project claim.'
            : 'No sufficient evidence to verify economic function.',
    downstream_use:{
      ...d,
      evidence_status: status===EVIDENCE_STATUS.VERIFIED
        ? EVIDENCE_STATUS.VERIFIED
        : (d.status||EVIDENCE_STATUS.UNKNOWN)
    }
  };
}


function buildClaimReality(claims,state){
  const flows=state.downstream_usage?.flows||[];
  const allActivities=flows.flatMap(f=>f.activities||[]);
  const protocolComponents=(state.fee_components||[]).filter(c=>c.name==='PROTOCOL_FEE'&&c.verification==='VERIFIED');
  const creatorComponents=(state.fee_components||[]).filter(c=>c.name==='COIN_CREATOR_FEE');
  const verifiedCreatorExtraction=creatorComponents.some(c=>c.downstream_use?.verified_creator_extraction);
  const verifiedHolderBenefit=allActivities.some(a=>a.kind==='HOLDER_REWARD') || (state.fee_components||[]).some(c=>c.downstream_use?.verified_holder_benefit);
  const verifiedBuybackBurn=allActivities.some(a=>a.kind==='BUYBACK'||a.kind==='BURN') || (state.fee_components||[]).some(c=>c.downstream_use?.verified_buyback_or_burn);
  const confirmedLiquidity=Boolean(state.venue_mapping?.pools?.length);
  const protocolUtility=Boolean((state.fee_components||[]).some(c=>c.downstream_use?.verified_protocol_utility));
  const routingVerified=protocolComponents.length>0;
  const out=[];
  for(const c of claims||[]){
    let status='UNKNOWN',note='Insufficient dedicated on-chain evidence.';
    if(c.type===CLAIM_TYPES.BUYBACK_BURN){ status=verifiedBuybackBurn?'VERIFIED':'CLAIM_ONLY'; note=verifiedBuybackBurn?'Observed downstream buyback/burn evidence.':'No verified buyback/burn downstream action was observed in the inspected evidence.'; }
    else if(c.type===CLAIM_TYPES.HOLDER_REWARDS){ status=verifiedHolderBenefit?'VERIFIED':'CLAIM_ONLY'; note=verifiedHolderBenefit?'Observed holder-reward-like evidence.':'No verified holder-reward downstream action was observed in the inspected evidence.'; }
    else if(c.type===CLAIM_TYPES.NO_CREATOR_FEE){
      const active=creatorComponents.some(x=>x.verification==='VERIFIED'&&Number(x.bps||0)>0);
      const observed=creatorComponents.some(x=>(x.observed_fee_transfers||[]).length>0);
      if(active||observed||verifiedCreatorExtraction){status='CONFLICT';note='Verified/configured creator-fee evidence conflicts with a no-creator-fee claim.';}
      else if(creatorComponents.some(x=>x.verification==='VERIFIED')){status='VERIFIED';note='Creator fee component was verified as inactive.';}
      else status='UNKNOWN';
    }
    else if(c.type===CLAIM_TYPES.LIQUIDITY){ status=confirmedLiquidity?'PARTIAL':'UNKNOWN'; note=confirmedLiquidity?'A confirmed pool exists; this does not establish project-owned liquidity or LP fee ownership.':'No confirmed Phase 4 pool available.'; }
    else if(c.type===CLAIM_TYPES.FEE_UTILITY){ status=routingVerified?'PARTIAL':'CLAIM_ONLY'; note=routingVerified?'Fee routing is verified, but ultimate economic use is not verified.':'No verified fee routing evidence.'; }
    else if(c.type===CLAIM_TYPES.PROTOCOL_UTILITY){ status=protocolUtility?'VERIFIED':(routingVerified?'PARTIAL':'CLAIM_ONLY'); note=protocolUtility?'Downstream protocol utility was verified.':routingVerified?'Protocol fee routing is verified, but recipient ownership/product utility is unknown.':'No verified protocol-utility evidence.'; }
    else if(c.type===CLAIM_TYPES.STAKING||c.type===CLAIM_TYPES.TREASURY||c.type===CLAIM_TYPES.CHARITY){ status='CLAIM_ONLY'; note=`No dedicated on-chain verifier for ${c.type.toLowerCase()} is active in Phase 6.`; }
    else if(c.type===CLAIM_TYPES.NO_TAX){ status='UNKNOWN'; note='Trading-fee routing is not equivalent to token transfer-tax verification; no independent token-tax verifier is claimed here.'; }
    out.push({...c,status,verification_note:note});
  }
  return out;
}

function assessFeeEconomics(state,claimReality){
  const comps=state.fee_components||[];
  const activities=(state.downstream_usage?.flows||[]).flatMap(f=>f.activities||[]);
  const verifiedProtocolUtility=comps.some(c=>c.downstream_use?.verified_protocol_utility===true && c.economic_evidence_status==='VERIFIED');
  const verifiedHolderBenefit=comps.some(c=>c.downstream_use?.verified_holder_benefit===true && c.economic_evidence_status==='VERIFIED') || activities.some(a=>a.kind==='HOLDER_REWARD');
  const verifiedBuybackBurn=comps.some(c=>c.downstream_use?.verified_buyback_or_burn===true && c.economic_evidence_status==='VERIFIED') || activities.some(a=>a.kind==='BUYBACK'||a.kind==='BURN');
  const verifiedCreatorExtraction=comps.some(c=>c.downstream_use?.verified_creator_extraction===true && c.economic_evidence_status==='VERIFIED');
  const routingVerified=comps.some(c=>c.name==='PROTOCOL_FEE'&&c.routing_verification==='VERIFIED');
  let classification='FEE_ROUTING_ONLY_PURPOSE_UNKNOWN';
  if(verifiedCreatorExtraction && (verifiedProtocolUtility||verifiedHolderBenefit||verifiedBuybackBurn)) classification='MIXED_PROJECT_AND_CREATOR_USE';
  else if(verifiedCreatorExtraction) classification='CREATOR_EXTRACTION_VERIFIED';
  else if(verifiedProtocolUtility||verifiedHolderBenefit||verifiedBuybackBurn) classification='PROJECT_UTILITY_VERIFIED';
  const score=state.fee_economics?.score??0;
  const verifiedEvidence=unique(comps.flatMap(c=>
    (c.economic_evidence_status==='VERIFIED' ? (c.observed_fee_transfers||[]) : [])
      .filter(x=>x?.attribution_evidence?.verified && x?.signature)
      .map(x=>x.signature)
  ));
  let confidence='LOW';
  const evidenceCount=[routingVerified,verifiedCreatorExtraction,verifiedProtocolUtility,verifiedHolderBenefit,verifiedBuybackBurn].filter(Boolean).length;
  if(evidenceCount>=2)confidence='HIGH'; else if(evidenceCount===1 && (verifiedCreatorExtraction||verifiedProtocolUtility||verifiedHolderBenefit||verifiedBuybackBurn))confidence='MEDIUM';
  const economicStatuses=unique(comps.map(c=>c.economic_evidence_status).filter(Boolean));
  const projectUtilityStatus=verifiedProtocolUtility ? EVIDENCE_STATUS.VERIFIED :
    (comps.some(c=>c.economic_evidence_status===EVIDENCE_STATUS.OBSERVED) ? EVIDENCE_STATUS.OBSERVED :
      (comps.some(c=>c.economic_evidence_status===EVIDENCE_STATUS.PARTIAL) ? EVIDENCE_STATUS.PARTIAL :
        (comps.some(c=>c.claim_status==='CLAIM_ONLY') ? EVIDENCE_STATUS.CLAIM_ONLY : EVIDENCE_STATUS.INSUFFICIENT_DATA)));
  return {
    classification,score,confidence,
    routing_verified:routingVerified,
    project_utility_verified:verifiedProtocolUtility,
    project_utility_evidence_status:projectUtilityStatus,
    holder_benefit_verified:verifiedHolderBenefit,
    buyback_burn_verified:verifiedBuybackBurn,
    creator_extraction_verified:verifiedCreatorExtraction,
    economic_evidence_statuses:economicStatuses,
    claim_status_counts:(claimReality||[]).reduce((a,c)=>(a[c.status]=(a[c.status]||0)+1,a),{}),
    provenance:{
      source_phase:6,
      source_field:'fee_economics.score',
      eligibility_field:'project_utility_verified',
      eligibility_status:verifiedProtocolUtility?'ELIGIBLE':'NOT_AVAILABLE',
      component_evidence:(comps||[]).map(c=>{
        // Defensive: upstream dedupe should already hold, but a repeated
        // signature must never inflate provenance twice (6O finding #5).
        const verifiedSigs=unique((c.observed_fee_transfers||[]).filter(x=>x?.attribution_evidence?.verified&&x?.signature).map(x=>x.signature));
        return {
          name:c.name,
          verification:c.verification||EVIDENCE_STATUS.UNKNOWN,
          economic_evidence_status:c.economic_evidence_status||EVIDENCE_STATUS.UNKNOWN,
          verified_transfer_count:verifiedSigs.length,
          evidence_signatures:verifiedSigs
        };
      }),
      verified_evidence_signature_count:verifiedEvidence.length,
      verified_evidence_signatures:verifiedEvidence
    }
  };
}

/* ------------------------- Evidence / scoring ------------------------- */

function scoreFeeEconomics(state){
  // Evidence-strength only. Routing alone is neutral: a protocol recipient is
  // not automatically protocol-owned, and downstream outflow is not proof of
  // creator extraction or protocol utility.
  const comps=state.fee_components||[];
  if(!comps.length)return {score:0,confidence:'LOW',reason:'NO_VERIFIED_FEE_COMPONENTS'};
  let score=0, verified=0, partial=0, positive=0, negative=0;
  for(const c of comps){
    if(c.economic_evidence_status==='VERIFIED'){
      verified++;
      if(c.name==='PROTOCOL_FEE' && c.downstream_use?.verified_holder_benefit){score+=4;positive++;}
      if(c.name==='PROTOCOL_FEE' && c.downstream_use?.verified_protocol_utility){score+=3;positive++;}
      if(c.name==='COIN_CREATOR_FEE'){
        if(c.downstream_use?.verified_holder_benefit){score+=3;positive++;}
        else if(c.downstream_use?.verified_buyback_or_burn){score+=3;positive++;}
        else if(c.downstream_use?.verified_creator_extraction){score-=4;negative++;}
      }
      // LP routing itself is not scored as protocol utility because LPs may be
      // unrelated third parties. Ownership/provider identity must be evidenced.
    }else if(c.verification==='PARTIAL'||c.claim_status==='CLAIM_ONLY')partial++;
  }
  score=Math.max(-10,Math.min(10,score));
  const confidence=verified>=2?'HIGH':verified===1?(positive||negative?'MEDIUM':'LOW'):(partial?'LOW':'UNKNOWN');
  let reason='FEE_ROUTING_VERIFIED_BUT_ECONOMIC_USE_UNKNOWN';
  if(positive)reason='VERIFIED_ECONOMIC_UTILITY_EVIDENCE';
  else if(negative)reason='VERIFIED_CREATOR_OR_EXTRACTION_EVIDENCE';
  else if(!verified)reason=partial?'PARTIAL_FEE_EVIDENCE':'NO_ONCHAIN_VERIFICATION';
  return {score,confidence,reason,verified_components:verified,partial_components:partial};
}

/* ------------------------- Main ------------------------- */

async function main(){
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ PHASE 6 — FEE / TRADING ECONOMICS INTELLIGENCE      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  let config; try{config=loadConfig();}catch(e){console.log(`STATUS     : FAILED ✗\nERROR      : ${e.message}`);process.exitCode=1;return;}
  const input=locateInput(); if(!input){console.log('STATUS     : FAILED ✗\nERROR      : PHASE_INPUT_NOT_FOUND');process.exitCode=1;return;}

  const mint=input.mint, p2=input.phase2||{}, p4=input.phase4||{}, p5=input.phase5||{};
  const decimals=Number(p2?.token?.decimals??6);
  const supply=String(p2?.token?.supply??p4?.token?.supply_raw??'0');
  const rpcUrl=`${config.helius.rpc_url}?api-key=${encodeURIComponent(config.helius.api_key)}`;
  const apiBase=String(config.helius.api_base_url||'https://api.helius.xyz').replace(/\/$/,'');
  const feeCfg=config.fee_economics||{};
  const maxPools=Math.max(1,Number(feeCfg.max_pools_to_analyze??5));
  const txSample=Math.max(1,Number(feeCfg.transaction_sample_size??20));
  const downstreamTx=Math.max(1,Number(feeCfg.downstream_transaction_sample_size??10));
  const poolHistoryMultiplier=Math.max(1,Number(feeCfg.pool_history_multiplier??5));
  const downstreamHistoryMultiplier=Math.max(1,Number(feeCfg.downstream_history_multiplier??8));
  const samplingMode=String(feeCfg.sampling_mode||'HYBRID').toUpperCase();

  const pools=getPools(p4,mint).slice(0,maxPools);
  // GlobalConfig is venue/program state, not pool-specific state. Cache only
  // successful parsed state for this scan run; failures remain retryable.
  const globalConfigCache=new Map();
  let globalConfigCacheHits=0;
  let globalConfigCacheMisses=0;

  const result={
    phase:6,phase_name:'FEE_TRADING_ECONOMICS',version:'5.3',status:'FAILED',analysis_status:'UNKNOWN',
    timestamp:new Date().toISOString(),elapsed_seconds:null,
    input:{mint,source:input.source,phase4_available:Boolean(input.phase4),phase5_available:Boolean(input.phase5)},
    token:{mint,decimals,supply_raw:supply},
    scope:{
      purpose:'Identify trading fee generation, destination, handling protocol, downstream use, and compare documented claims with on-chain evidence.',
      max_score_component:10,
      rules:[
        'Documentation is CLAIM, not proof.',
        'On-chain account state and transaction evidence are authoritative where available.',
        'UNKNOWN is preserved when evidence is insufficient.',
        'Network transaction fees are excluded from protocol trading-fee economics.',
        'Creator/recipient identity is not assumed from labels alone.',
        'Fee economics score is separate from verification confidence.'
      ],
      configuration:{
        max_pools_to_analyze:maxPools,
        transaction_sample_size:txSample,
        downstream_transaction_sample_size:downstreamTx,
        sampling_mode:samplingMode,
        pool_history_multiplier:poolHistoryMultiplier,
        downstream_history_multiplier:downstreamHistoryMultiplier,
        trace_protocol_recipients:feeCfg.trace_protocol_recipients!==false,
        trace_creator_fee:feeCfg.trace_creator_fee!==false
      }
    },
    venue_mapping:{status:pools.length?'FOUND':'UNKNOWN',pools:[],unsupported_venues:[],deduplication:{input_count:0,unique_count:pools.length},note:'Phase 4 is the discovery source. Pools are deduplicated by venue/program/pool. Unsupported concentrated-liquidity fee models are not guessed.'},
    protocol_state:{status:'UNKNOWN',programs:[],global_configs:[],fee_config_accounts:[]},
    fee_model:{status:'UNKNOWN',venues:[],claims:[]},
    fee_components:[],
    fee_destinations:{status:'UNKNOWN',components:[]},
    fee_flow_verification:{status:'UNKNOWN',component_results:[]},
    claim_vs_reality:{status:'UNKNOWN',claims:[]},
    token_claims:{status:'UNKNOWN',mint,token_identity:{name:null,symbol:null,uri:null},sources:[],raw_claim_text:[],detected_claims:[],verification_notes:[],summary:{claims_found:0,verified:0,partially_verified:0,not_verified:0,contradicted:0,unknown:0}},
    downstream_usage:{status:'UNKNOWN',flows:[]},
    sampling:{mode:samplingMode,pool_history_multiplier:poolHistoryMultiplier,downstream_history_multiplier:downstreamHistoryMultiplier,pool_samples:[],downstream_samples:[]},
    coverage:{status:'SAMPLED',retrieval_mode:'SAMPLED',reason:'SAMPLE_LIMIT',scope:'SAMPLE_WINDOW',datasets:{pool_transactions:[],downstream_transactions:[]},rate_limit:{encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'}},
    retrieval_metrics:{rate_limit:{encountered:false,retry_count:0,recovered:null,final_state:'NOT_ENCOUNTERED'}},
    fee_economics:{score:0,confidence:'UNKNOWN',reason:'NOT_ANALYZED',max_score:10,min_score:-10},
    fee_economic_assessment:{classification:'UNKNOWN',confidence:'UNKNOWN',routing_verified:false,project_utility_verified:false,holder_benefit_verified:false,buyback_burn_verified:false,creator_extraction_verified:false,claim_status_counts:{}},
    data_sources:[],missing:[],errors:[]
  };

  console.log(`TOKEN\n  Mint       : ${short(mint)}\n  Network    : ${config.helius.network}\n  Input      : ${input.source}\n\nCONFIG\n  Pools      : ${maxPools}\n  Tx samples : ${txSample}\n  Downstream : ${downstreamTx}\n\nHELIUS CONNECTION`);

  try{
    const health=await rpc(rpcUrl,'getHealth',[],`Helius RPC`,config,result);
    result.helius={network:config.helius.network,rpc_health:health||'UNKNOWN'};
    console.log(`  ✓ API / RPC  : AUTHENTICATED\n  ✓ RPC Health  : ${health||'UNKNOWN'}`);
  }catch(e){
    result.errors.push(`HELIUS:${e.message}`);
    result.helius={network:config.helius.network,rpc_health:'FAILED'};
    console.log(`  ✗ RPC         : ${e.message}`);
    result.status='FAILED'; result.elapsed_seconds=(Date.now()-started)/1000;
    finalizeProtocolState(result,true);
    save(result,mint); process.exitCode=1; return;
  }

  try{
    /* Token/project claims are collected independently from fee routing.
       DAS uses the documented Helius REST asset endpoint; this avoids the
       invalid RPC getAsset parameter shape that caused noisy -32602 errors. */
    if((config.fee_economics?.claim_analysis_enabled)!==false){
      try{
        const das=await fetchDASAsset(mint,apiBase,config,result);
        const collected=extractTokenIdentityAndRows(input,p2,das);
        result.token_claims.token_identity=collected.identity;
        result.token_claims.sources.push(...collected.sources);
        const uri=collected.identity.uri;
        if(uri){
          try{
            const ext=await fetchExternalMetadata(uri,config);
            result.token_claims.sources.push('EXTERNAL_METADATA_URI');
            textifyMetadata(ext,collected.rows,'external_metadata_uri');
          }catch(e){ result.token_claims.verification_notes.push(`METADATA_URI_FAILED:${e.message}`); }
        }
        const detected=detectTokenClaims(collected.rows);
        result.token_claims.raw_claim_text=detected.map(x=>x.claim_text);
        result.token_claims.detected_claims=detected;
        result.token_claims.status=detected.length?'CLAIMS_FOUND':'NO_EXPLICIT_CLAIMS_FOUND';
      }catch(e){
        result.token_claims.status='PARTIAL';
        result.token_claims.verification_notes.push(`DAS_GET_ASSET_FAILED:${e.message}`);
      }
    }

    if(!pools.length){
      result.missing.push('NO_CONFIRMED_PHASE4_POOL');
      result.venue_mapping.status='UNKNOWN';
    }

    for(const pool of pools){
      const venue={...pool,status:'UNKNOWN',fee_model_status:'UNKNOWN',verification:'UNKNOWN',evidence:[]};
      console.log(`\nVENUE\n  ${pool.dex} : ${short(pool.pool)}`);

      if(pool.program_id===PUMPSWAP||pool.dex==='PumpSwap'){
        venue.status='SUPPORTED';
        venue.fee_model_status='UNKNOWN';
        result.protocol_state.programs.push({name:'PumpSwap',program_id:PUMPSWAP});
        const poolRpcResult=await rpc(rpcUrl,'getAccountInfo',[pool.pool,{encoding:'base64'}],`PumpSwap Pool state`,config,result);
        const poolAccount=normalizeGetAccountInfoResult(poolRpcResult);
        const poolState=parsePumpSwapPool(poolAccount);
        if(poolState){ venue.pool_state=poolState; venue.is_holder_reward=Boolean(poolState.is_holder_reward); }
        let globalRecord=globalConfigCache.get(`${PUMPSWAP}|${PUMPSWAP_GLOBAL}`);
        if(globalRecord){
          globalConfigCacheHits++;
        }else{
          globalConfigCacheMisses++;
          const globalRpcResult=await rpc(rpcUrl,'getAccountInfo',[PUMPSWAP_GLOBAL,{encoding:'base64'}],`PumpSwap GlobalConfig`,config,result);
          const global=normalizeGetAccountInfoResult(globalRpcResult);
          const parsed=parsePumpSwapGlobal(global);
          globalRecord=(!parsed || parsed.status==='PARSE_FAILED')
            ? {program:'PumpSwap',address:PUMPSWAP_GLOBAL,status:'PARSE_FAILED',reason:parsed?.reason||'UNKNOWN',data_length:parsed?.data_length||null}
            : {program:'PumpSwap',address:PUMPSWAP_GLOBAL,status:'FOUND',state:parsed};
          // Cache only successful parsed state. A failed request/parse must be
          // allowed to retry on a later pool within the same run.
          if(globalRecord.status==='FOUND')globalConfigCache.set(`${PUMPSWAP}|${PUMPSWAP_GLOBAL}`,globalRecord);
        }
        if(globalRecord.status==='PARSE_FAILED'){
          result.errors.push(`PUMPSWAP_GLOBAL_CONFIG_PARSE_FAILED:${globalRecord.reason||'UNKNOWN'}`);
          venue.verification='PARTIAL';
          venue.fee_model_status='PARSE_FAILED';
          result.protocol_state.global_configs.push(globalRecord);
        }else{
          result.protocol_state.global_configs.push(globalRecord);
          const parsed=globalRecord.state;
          venue.fee_model_status='ONCHAIN_CONFIG_PARSED';
          const claim=pumpSwapClaim(pool,parsed);
          result.fee_model.venues.push(claim);
          result.fee_model.status='FOUND';
          venue.verification='VERIFIED';
          venue.evidence.push('PumpSwap GlobalConfig read on-chain');

          for(const c of claim.components){
            const comp={
              ...c,
              venue:'PumpSwap',pool:pool.pool,
              verification:'PARTIAL',
              claim_status:'CLAIM_AND_ONCHAIN_CONFIG',
              destination:null,
              observed_fee_transfers:[],
              downstream_use:{status:'UNKNOWN',verified_holder_benefit:false,verified_buyback_or_burn:false,verified_creator_extraction:false,evidence:[]}
            };
            if(c.name==='PROTOCOL_FEE'){
              comp.destination={type:'PROTOCOL_FEE_RECIPIENTS',addresses:parsed.protocol_fee_recipients,source:'PumpSwap GlobalConfig',quote_mint:pool.quote_mint||WSOL,quote_token_accounts:parsed.protocol_fee_recipients.map(a=>{try{return associatedTokenAddress(a,pool.quote_mint||WSOL)}catch{return null;}}).filter(Boolean)};
              comp.verification='VERIFIED';
              comp.claim_status='ONCHAIN_CONFIG_VERIFIED';
            }else if(c.name==='COIN_CREATOR_FEE'){
              if(c.bps==null){
                comp.destination={type:'UNKNOWN',reason:'coin_creator_fee_basis_points_field_absent'};
                comp.verification='UNKNOWN';
                comp.claim_status='ONCHAIN_FIELD_ABSENT';
              }else if(Number(c.bps)>0){
                let vault=null, ata=null;
                try{
                  vault=pumpSwapCreatorVaultAuthority(poolState?.coin_creator||pool.coin_creator);
                  ata=associatedTokenAddress(vault,pool.quote_mint||WSOL);
                  comp.destination={type:'CREATOR_VAULT_AUTHORITY',authority:vault,quote_mint:pool.quote_mint||WSOL,quote_token_account:ata,source:'PDA derivation from PumpSwap program docs'};
                  comp.verification='VERIFIED';
                  comp.claim_status='ONCHAIN_CONFIG_VERIFIED';
                }catch(e){comp.destination={type:'CREATOR_VAULT',authority:'UNKNOWN',source:'PDA_DERIVATION_FAILED'};result.errors.push(`CREATOR_VAULT:${e.message}`);}
              }else{
                comp.destination={type:'NOT_ACTIVE',reason:'coin_creator_fee_basis_points_is_zero'};
                comp.verification='VERIFIED';
                comp.claim_status='ONCHAIN_CONFIG_VERIFIED';
              }
            }else if(c.name==='LP_FEE'){
              comp.destination={type:'POOL_LIQUIDITY',pool:pool.pool,base_account:pool.pool_base_token_account,quote_account:pool.pool_quote_token_account};
              comp.verification='PARTIAL';
              comp.claim_status='ONCHAIN_CONFIG_VERIFIED';
              comp.note='LP fee is accounted to the pool by program design; direct per-trade attribution is not inferred from pool balance alone.';
            }
            result.fee_components.push(comp);
          }
        }
      // If GlobalConfig is unavailable, retain the official recipient set as
      // candidate evidence and let transaction tracing determine the actual
      // recipient used by this pool. This prevents GlobalConfig parsing from
      // becoming a single point of failure for the core question: where does
      // trading fee money actually go?
      if(pool.program_id===PUMPSWAP || pool.dex==='PumpSwap'){
        result.protocol_state.fee_config_accounts.push({
          program:'PumpFees',
          address:(()=>{try{return pumpFeeConfig();}catch{return null;}})(),
          status:'CANDIDATE_DERIVED'
        });
        const existing=result.fee_components.some(c=>c.pool===pool.pool&&c.name==='PROTOCOL_FEE');
        if(!existing){
          result.fee_components.push({
            name:'PROTOCOL_FEE',venue:'PumpSwap',pool:pool.pool,bps:null,pct:null,
            destination:{type:'OFFICIAL_FEE_RECIPIENT_SET',addresses:OFFICIAL_PUMP_FEE_RECIPIENTS,source:'Official PumpSwap fee-recipient documentation',verification:'CANDIDATE'},
            verification:'UNKNOWN',claim_status:'OFFICIAL_RECIPIENT_SET_ONLY',observed_fee_transfers:[],
            downstream_use:{status:'UNKNOWN',verified_holder_benefit:false,verified_buyback_or_burn:false,verified_creator_extraction:false,evidence:[]},
            note:'Actual recipient is determined from transaction account routing and positive balance deltas.'
          });
        }
      }
      }else{
        venue.status='UNSUPPORTED';
        venue.fee_model_status='UNKNOWN';
        venue.verification='UNKNOWN';
        venue.evidence.push('No verified Phase 6 adapter for this venue');
        result.venue_mapping.unsupported_venues.push({dex:pool.dex,program_id:pool.program_id,pool:pool.pool});
      }
      result.venue_mapping.pools.push(venue);
    }

    /* Targeted transaction verification. GlobalConfig is one evidence layer;
       transaction-level balances/events are a second independent layer. */
    for(const pool of pools){
      if(pool.program_id!==PUMPSWAP&&pool.dex!=='PumpSwap')continue;
      console.log(`\nFEE FLOW\n  Pool transactions : request`);
      const sampled=await getSampledTransactionsForAddress(pool.pool,rpcUrl,config,result,txSample,{mode:samplingMode,history_pool_size:txSample*poolHistoryMultiplier});
      const recent=sampled.rows;
      result.sampling.pool_samples.push({pool:pool.pool,available_signatures:sampled.available_signatures,selected_count:recent.length,mode:samplingMode,selected_signatures:sampled.selected_signatures,coverage:sampled.coverage});
      result.coverage.datasets.pool_transactions.push({pool:pool.pool,coverage:sampled.coverage});
      const globalState=result.protocol_state.global_configs.find(x=>x.program==='PumpSwap'&&x.status==='FOUND')?.state||null;
      const protocolRecipients=new Set([...(globalState?.protocol_fee_recipients||[]),...OFFICIAL_PUMP_FEE_RECIPIENTS]);
      const protocolAtas=new Set(result.fee_components.filter(x=>x.name==='PROTOCOL_FEE'&&x.pool===pool.pool).flatMap(x=>x.destination?.quote_token_accounts||[]));
      const creatorComps=result.fee_components.filter(x=>x.name==='COIN_CREATOR_FEE'&&x.pool===pool.pool);
      const protocolComps=result.fee_components.filter(x=>x.name==='PROTOCOL_FEE'&&x.pool===pool.pool);
      const poolEvidence=[];
      for(const row of recent){
        const tx=row.tx;
        const lamD=txLamportDeltas(tx);
        const tokD=txTokenDeltas(tx);
        const tradeType=inferTradeEvent(tx,pool);
        const protocolAddresses=[...protocolRecipients,...protocolAtas];
        const matchedProtocolLam=extractLamportTransfersToAddresses(tx,[...protocolRecipients]);
        const matchedProtocolTok=extractTokenTransfersToAddresses(tx,[...protocolAtas],pool.quote_mint||WSOL);
        const protocolMatches=[...matchedProtocolLam.map(m=>({asset:'SOL',recipient:m.address,delta_lamports:m.delta_lamports,delta_sol:m.delta_sol})),...matchedProtocolTok.map(m=>({asset:m.mint,recipient:m.address,owner:m.owner,delta_raw:m.delta_raw,decimals:m.decimals}))];
        const observedRecipients=buildObservedRecipientMap(tx,pool,[...(globalState?.protocol_fee_recipients||[])]);
        const protocolPositiveMatches=[...protocolMatches];
        const protocolEvidence=evaluateFeeAttributionEvidence(
          tx,pool,
          [...protocolRecipients,...protocolAtas],
          protocolPositiveMatches
        );
        for(const obs of observedRecipients){
          for(const nr of obs.native_receipts) protocolMatches.push({asset:'SOL',recipient:obs.address,delta_lamports:nr.delta_lamports,delta_sol:nr.delta_sol,source:'OFFICIAL_RECIPIENT_TX_TRACE'});
          for(const tr of obs.token_receipts) protocolMatches.push({asset:tr.mint,recipient:tr.address,owner:tr.owner,delta_raw:tr.delta_raw,decimals:tr.decimals,source:'OFFICIAL_RECIPIENT_TX_TRACE'});
        }
        const dedupedProtocolMatches=dedupeFeeTransfers(protocolMatches);
        for(const c of protocolComps){
          for(const m of dedupedProtocolMatches){
            c.observed_fee_transfers.push({signature:row.signature,slot:row.slot,timestamp:iso(row.block_time),trade_type:tradeType,...m,attribution_evidence:protocolEvidence});
          }
          c.observed_fee_transfers=dedupeFeeTransfers(c.observed_fee_transfers);
        }
        for(const c of creatorComps){
          const auth=c.destination?.authority, ata=c.destination?.quote_token_account;
          const creatorAddresses=[auth,ata].filter(valid);
          const matchesLam=auth?extractLamportTransfersToAddresses(tx,[auth]):[];
          const matchesTok=ata?extractTokenTransfersToAddresses(tx,[ata,auth],pool.quote_mint||WSOL):[];
          const creatorMatches=[...matchesLam.map(m=>({asset:'SOL',recipient:m.address,delta_lamports:m.delta_lamports,delta_sol:m.delta_sol})),...matchesTok.map(m=>({asset:m.mint,recipient:m.address,owner:m.owner,delta_raw:m.delta_raw,decimals:m.decimals}))];
          const creatorEvidence=evaluateFeeAttributionEvidence(tx,pool,creatorAddresses,creatorMatches);
          for(const m of matchesLam)c.observed_fee_transfers.push({signature:row.signature,slot:row.slot,timestamp:iso(row.block_time),trade_type:tradeType,asset:'SOL',recipient:m.address,delta_lamports:m.delta_lamports,delta_sol:m.delta_sol,attribution_evidence:creatorEvidence});
          for(const m of matchesTok)c.observed_fee_transfers.push({signature:row.signature,slot:row.slot,timestamp:iso(row.block_time),trade_type:tradeType,asset:m.mint,recipient:m.address,owner:m.owner,delta_raw:m.delta_raw,decimals:m.decimals,attribution_evidence:creatorEvidence});
          c.observed_fee_transfers=dedupeFeeTransfers(c.observed_fee_transfers);
        }
        if(dedupedProtocolMatches.length||creatorComps.some(c=>c.observed_fee_transfers.some(x=>x.signature===row.signature))){
          poolEvidence.push({signature:row.signature,slot:row.slot,timestamp:iso(row.block_time),trade_type:tradeType,program_seen:txMentionsProgram(tx,PUMPSWAP),protocol_fee_matches:dedupedProtocolMatches.length,token_delta_count:tokD.length,lamport_delta_count:lamD.length,protocol_attribution:protocolEvidence});
        }
      }
      for(const c of result.fee_components.filter(x=>x.pool===pool.pool)){
        if(c.name==='PROTOCOL_FEE'){
          const verifiedTransfer=(c.observed_fee_transfers||[]).some(x=>x.attribution_evidence?.verified);
          c.verification=verifiedTransfer?'VERIFIED':(c.observed_fee_transfers.length?'OBSERVED':'UNKNOWN');
          c.observation_note=verifiedTransfer?'PumpSwap trade instruction explicitly included the matched protocol fee destination and the same transaction showed a positive destination balance delta. This verifies routing only; it does not prove recipient ownership or downstream economic purpose.':c.observed_fee_transfers.length?'Positive destination balance evidence was observed, but PumpSwap trade-instruction attribution was not independently confirmed; therefore routing is not marked VERIFIED.':'No sampled pool transaction showed a positive balance delta to configured protocol fee destinations; absence is not proof of no fee generation.';
        }
        if(c.name==='COIN_CREATOR_FEE'&&Number(c.bps)>0){
          const verifiedTransfer=(c.observed_fee_transfers||[]).some(x=>x.attribution_evidence?.verified);
          c.verification=verifiedTransfer?'VERIFIED':(c.observed_fee_transfers.length?'OBSERVED':'UNKNOWN');
          c.observation_note=verifiedTransfer?'PumpSwap trade instruction explicitly included the matched creator-vault destination and the same transaction showed a positive destination balance delta. This verifies routing only; it does not prove creator ownership or downstream economic purpose.':c.observed_fee_transfers.length?'Positive creator-vault balance evidence was observed, but PumpSwap trade-instruction attribution was not independently confirmed; therefore routing is not marked VERIFIED.':'No sampled pool transaction showed a positive balance delta to the derived creator-vault destination.';
        }
        if(c.name==='LP_FEE'){
          c.verification=c.claim_status==='ONCHAIN_CONFIG_VERIFIED'?'PARTIAL':'UNKNOWN';
          c.observation_note='LP fee is retained in pool economics; direct fee attribution is not inferred from a single pool balance delta.';
        }
      }
      // Materialize actual protocol destinations discovered from transaction evidence.
      for(const c of result.fee_components.filter(x=>x.pool===pool.pool&&x.name==='PROTOCOL_FEE')){
        const observed=unique((c.observed_fee_transfers||[]).map(x=>x.recipient).filter(valid));
        if(observed.length){
          const verifiedTransfers=(c.observed_fee_transfers||[]).filter(x=>x.attribution_evidence?.verified);
          const verifiedAddresses=unique(verifiedTransfers.map(x=>x.recipient).filter(valid));
          c.destination={
            type:'OBSERVED_PROTOCOL_FEE_RECIPIENT',
            addresses:observed,
            source:'ONCHAIN_TRANSACTION_BALANCE_DELTAS + OFFICIAL_RECIPIENT_SET',
            verification:verifiedAddresses.length?'VERIFIED':'OBSERVED'
          };
          c.verification=verifiedAddresses.length?'VERIFIED':'OBSERVED';
          c.destination_evidence=observed.map(address=>({address,observed_count:(c.observed_fee_transfers||[]).filter(x=>x.recipient===address).length,verified_count:verifiedTransfers.filter(x=>x.recipient===address).length}));
        }
      }
      result.fee_flow_verification.component_results.push({pool:pool.pool,transactions_sampled:recent.length,evidence:poolEvidence});
    }
    /* Canonical fee destinations for downstream phases. Keep this as a
       derived index of fee_components so Phase 7/8 consume the same evidence
       source instead of a separately maintained/empty field. */
    const destinationComponents=result.fee_components.filter(c=>c.destination && c.destination.type!=='UNKNOWN');
    result.fee_destinations={
      status: destinationComponents.length ? 'FOUND' : 'UNKNOWN',
      components: destinationComponents.map(c=>({
        name:c.name, venue:c.venue, pool:c.pool, destination:c.destination,
        verification:c.verification, claim_status:c.claim_status,
        evidence_status:c.economic_evidence_status||null
      }))
    };

    /* Targeted downstream trace: protocol recipients + creator destination. */
    const destinations=unique(result.fee_components.flatMap(c=>{
      const a=[];
      if(c.name==='PROTOCOL_FEE')a.push(...(c.destination?.addresses||[]),...(c.destination?.quote_token_accounts||[]));
      if(c.name==='COIN_CREATOR_FEE'&&c.destination?.authority){
        a.push(c.destination.authority);
        if(c.destination.quote_token_account)a.push(c.destination.quote_token_account);
      }
      return a;
    }));

    if(destinations.length){
      console.log(`\nDOWNSTREAM FEE FLOW`);
      const destinationRank=destinations.map(addr=>{
        const transfers=result.fee_components.flatMap(c=>(c.observed_fee_transfers||[]).filter(x=>x.recipient===addr));
        let lamports=0n, quoteRaw=0n;
        for(const t of transfers){
          if(t.asset==='SOL'||t.asset===WSOL)lamports+=rawBigInt(t.delta_lamports||t.delta_raw||0);
          else quoteRaw+=rawBigInt(t.delta_raw||0);
        }
        return {address:addr,observed_fee_transfers:transfers.length,observed_lamports_raw:lamports.toString(),observed_quote_raw:quoteRaw.toString()};
      }).sort((a,b)=>rawBigInt(b.observed_lamports_raw)>rawBigInt(a.observed_lamports_raw)?1:rawBigInt(b.observed_lamports_raw)<rawBigInt(a.observed_lamports_raw)?-1:b.observed_fee_transfers-a.observed_fee_transfers);
      const maxDest=Math.max(1,Number(feeCfg.max_fee_destinations_to_trace??12));
      for(const rank of destinationRank.slice(0,maxDest)){
        const addr=rank.address;
        try{
          const sampled=await getSampledTransactionsForAddress(addr,rpcUrl,config,result,downstreamTx,{mode:samplingMode,history_pool_size:downstreamTx*downstreamHistoryMultiplier});
          const rows=sampled.rows;
          result.sampling.downstream_samples.push({address:addr,available_signatures:sampled.available_signatures,selected_count:rows.length,mode:samplingMode,selected_signatures:sampled.selected_signatures,priority_observed_fee_transfers:rank.observed_fee_transfers,priority_observed_lamports_raw:rank.observed_lamports_raw,coverage:sampled.coverage});
          result.coverage.datasets.downstream_transactions.push({address:addr,coverage:sampled.coverage});
          const flow={address:addr,transactions_sampled:rows.length,activities:[],evidence:[],identity_class:'UNKNOWN',ownership_status:'UNKNOWN',priority:{observed_fee_transfers:rank.observed_fee_transfers,observed_lamports_raw:rank.observed_lamports_raw}};
          const owningComponents=result.fee_components.filter(c=>(c.destination?.addresses||[]).includes(addr)||c.destination?.quote_token_account===addr||c.destination?.authority===addr);
          flow.component_names=unique(owningComponents.map(c=>c.name));
          if(flow.component_names.includes('PROTOCOL_FEE'))flow.identity_class='PROTOCOL_FEE_RECIPIENT_CONFIGURED';
          if(flow.component_names.includes('COIN_CREATOR_FEE'))flow.identity_class='CREATOR_VAULT_DESTINATION';
          flow.ownership_status='UNKNOWN';
          flow.ownership_note='Being a configured protocol fee recipient does not prove protocol/creator ownership. A third party may provide liquidity or otherwise control an address; downstream outflow is not attributed without direct ownership evidence.';
          for(const row of rows){
            const tx=row.tx, kind=classifyDownstream(tx,addr);
            const outgoing=txLamportDeltas(tx).find(x=>x.address===addr&&rawBigInt(x.delta_lamports)<0n);
            const tokenOut=txTokenDeltas(tx).filter(x=>(x.address===addr||x.owner===addr)&&rawBigInt(x.delta_raw)<0n).slice(0,5);
            flow.activities.push({signature:row.signature,slot:row.slot,timestamp:iso(row.block_time),kind,outgoing_lamports:outgoing?.delta_lamports||'0',outgoing_tokens:tokenOut,flow_out_observed:Boolean(outgoing||tokenOut.length),ownership_attribution:'UNKNOWN',description:tx?.description||null,type:tx?.type||null});
          }
          flow.summary=summarizeDestinationFlow(flow.activities);
          result.downstream_usage.flows.push(flow);
        }catch(e){result.errors.push(`DOWNSTREAM_${addr}:${e.message}`);}
      }
      result.downstream_usage.status=result.downstream_usage.flows.length?'OBSERVED_ACTIVITY':'UNKNOWN';
    }
    /* Claim vs reality, deliberately conservative. */
    const claims=[];
    for(const v of result.fee_model.venues){
      claims.push({
        venue:v.venue,
        claim:{
          creator_fee:'Creator receives a portion of trading fees where applicable.',
          protocol_fee:'Protocol receives protocol fee.',
          lp_fee:'A portion of fees returns to pool liquidity.'
        },
        source_urls:[
          'https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_CREATOR_FEE_README.md',
          'https://github.com/pump-fun/pump-public-docs/blob/main/docs/BREAKING_FEE_RECIPIENT.md',
          'https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md'
        ],
        reality_status:'PARTIAL',
        note:'The current program state verifies fee configuration and destination classes. Downstream economic use is only marked verified when observed on-chain.'
      });
    }
    result.claim_vs_reality.claims=claims;
    result.claim_vs_reality.status=claims.length?'PARTIAL':'UNKNOWN';

    /* Component score. */
    const scored=result.fee_components.map(c=>{
      const down=result.downstream_usage.flows.find(f=>
        c.name==='PROTOCOL_FEE'
          ? (c.destination?.addresses||[]).includes(f.address)
          : c.name==='COIN_CREATOR_FEE' && (f.address===c.destination?.authority || f.address===c.destination?.quote_token_account)
      );
      const x={...c};
      if(down){
        x.downstream_use={
          ...c.downstream_use,
          status:'OBSERVED',
          evidence:down.activities.slice(0,downstreamTx),
          verified_creator_extraction:false,
          verified_protocol_utility:false,
          verified_buyback_or_burn:down.activities.some(a=>a.kind==='SWAP'&&(String(a.description||'').toLowerCase().includes('buyback')||String(a.description||'').toLowerCase().includes('burn'))),
          verified_holder_benefit:false
        };
      }
      return x;
    });
    result.fee_components=scored.map(attachEvidenceSemantics);
    result.fee_economics=scoreFeeEconomics(result);

    /* Compare token/project claims against the evidence gathered above. */
    const claimReality=buildClaimReality(result.token_claims.detected_claims,result);
    result.token_claims.detected_claims=claimReality;
    result.token_claims.summary={
      claims_found:claimReality.length,
      verified:claimReality.filter(x=>x.status==='VERIFIED').length,
      partially_verified:claimReality.filter(x=>x.status==='PARTIAL').length,
      not_verified:claimReality.filter(x=>x.status==='CLAIM_ONLY').length,
      contradicted:claimReality.filter(x=>x.status==='CONFLICT').length,
      unknown:claimReality.filter(x=>x.status==='UNKNOWN').length
    };
    result.claim_vs_reality={
      status:claimReality.length?'ANALYZED':'NO_EXPLICIT_CLAIMS_FOUND',
      claims:claimReality,
      rule:'CLAIM_ONLY is not CONFLICT; conflict requires positive conflicting on-chain evidence.'
    };
    result.fee_economic_assessment=assessFeeEconomics(result,claimReality);
    result.fee_flow_verification.status=resolveFeeFlowVerificationStatus(result.fee_components);
    result.fee_flow_verification.component_summaries=result.fee_components.map(c=>({
      name:c.name,venue:c.venue,pool:c.pool,verification:c.verification,
      observed_transfer_count:c.observed_fee_transfers?.length||0,
      destination:c.destination
    }));

    finalizeProtocolState(result);
    result.protocol_state.cache={
      global_config_key:`${PUMPSWAP}|${PUMPSWAP_GLOBAL}`,
      global_config_cache_hits:globalConfigCacheHits,
      global_config_cache_misses:globalConfigCacheMisses,
      scope:'SINGLE_SCAN_RUN'
    };

    result.missing=unique(result.missing);
    const verified=result.fee_components.filter(c=>c.verification==='VERIFIED').length;
    const partial=result.fee_components.filter(c=>c.verification==='PARTIAL').length;
    result.analysis_status=verified?'PARTIAL_VERIFIED':(partial?'PARTIAL':'UNKNOWN');
    // Single source of truth: classification may only assert project utility when
    // project_utility_verified is true.
    if(result.fee_economic_assessment.classification==='PROJECT_UTILITY_VERIFIED' &&
       result.fee_economic_assessment.project_utility_verified!==true){
      result.errors.push({source:'phase6_evidence_semantics',message:'PROJECT_UTILITY_CLASSIFICATION_CONTRADICTS_VERIFICATION'});
      result.fee_economic_assessment.classification='FEE_ROUTING_ONLY_PURPOSE_UNKNOWN';
    }
    const allSampleCoverage=[...result.coverage.datasets.pool_transactions.map(x=>x.coverage),...result.coverage.datasets.downstream_transactions.map(x=>x.coverage)];
    result.coverage=aggregatePhase6Coverage(allSampleCoverage,{
      ...result.coverage,
      rate_limit:result.retrieval_metrics.rate_limit,
      retrieval_mode:'SAMPLED',
      scope:'SAMPLE_WINDOW'
    });
    // Phase 6 status follows its actual coverage semantics. An unavailable
    // retrieval scope is UNKNOWN, not EMPTY; sampled zero-record scopes remain SAMPLED.
    result.status=result.coverage.status;
  }catch(e){
    result.errors.push(`PHASE6:${e.stack||e.message}`);
    result.status='PARTIAL';
  }

  result.elapsed_seconds=(Date.now()-started)/1000;
  const out=save(result,mint);

  console.log('\n──────────────────────────────────────────────────────');
  console.log('TOKEN CLAIMS / ON-CHAIN REALITY');
  console.log(`  Claims found          : ${result.token_claims.summary.claims_found}`);
  console.log(`  Verified              : ${result.token_claims.summary.verified}`);
  console.log(`  Partially verified    : ${result.token_claims.summary.partially_verified}`);
  console.log(`  Not verified          : ${result.token_claims.summary.not_verified}`);
  console.log(`  Contradicted          : ${result.token_claims.summary.contradicted}`);
  console.log(`  Unknown               : ${result.token_claims.summary.unknown}`);
  if(result.token_claims.detected_claims.length){
    for(const c of result.token_claims.detected_claims.slice(0,12)) console.log(`    - ${c.type}: ${c.status}`);
  }
  console.log('\nFEE ECONOMIC ASSESSMENT');
  console.log(`  Fee Routing           : ${result.fee_economic_assessment.routing_verified?'VERIFIED':'UNKNOWN'}`);
  console.log(`  Recipient Ownership   : UNKNOWN`);
  console.log(`  Project Utility       : ${result.fee_economic_assessment.project_utility_verified?'VERIFIED':'NOT VERIFIED'}`);
  console.log(`  Buyback / Burn        : ${result.fee_economic_assessment.buyback_burn_verified?'VERIFIED':'NOT VERIFIED'}`);
  console.log(`  Holder Benefit        : ${result.fee_economic_assessment.holder_benefit_verified?'VERIFIED':'NOT VERIFIED'}`);
  console.log(`  Creator Extraction    : ${result.fee_economic_assessment.creator_extraction_verified?'VERIFIED':'NOT VERIFIED'}`);
  console.log(`  Economic Conclusion   : ${result.fee_economic_assessment.classification}`);
  console.log(`  Assessment Confidence : ${result.fee_economic_assessment.confidence}`);
  console.log('\nFEE ECONOMICS');
  const protocolDests=unique(result.fee_components.filter(x=>x.name==='PROTOCOL_FEE').flatMap(x=>x.destination?.addresses||[]));
  console.log(`  Primary usage        : ${protocolDests.length?'PROTOCOL_FEE / ROUTED_TO_RECIPIENT':'UNKNOWN'}`);
  console.log(`  Protocol recipients  : ${protocolDests.length?protocolDests.map(short).join(', '):'UNKNOWN'}`);
  console.log(`  Creator fee          : ${result.fee_components.some(x=>x.name==='COIN_CREATOR_FEE'&&Number(x.bps)>0)?'CONFIGURED/OBSERVED':'UNKNOWN_OR_NOT_ACTIVE'}`);
  console.log(`  LP / liquidity       : ${result.fee_components.some(x=>x.name==='LP_FEE')?'POOL_LIQUIDITY':'UNKNOWN'}`);
  console.log(`  Downstream usage     : ${result.downstream_usage.flows.length?'OBSERVED — see result JSON':'UNKNOWN'}`);
  console.log(`  Economic interpretation: ${result.fee_economics.reason}`);
  console.log('\nSUMMARY');
  console.log(`  Pools analyzed        : ${result.venue_mapping.pools.length}`);
  console.log(`  Fee components        : ${result.fee_components.length}`);
  console.log(`  Verified components   : ${result.fee_components.filter(x=>x.verification==='VERIFIED').length}`);
  console.log(`  Protocol destinations : ${unique(result.fee_components.filter(x=>x.name==='PROTOCOL_FEE').flatMap(x=>x.destination?.addresses||[])).length}`);
  console.log(`  Downstream flows      : ${result.downstream_usage.flows.length}`);
  console.log(`  Fee Economics         : ${result.fee_economics.score}`);
  console.log(`  Fee Confidence        : ${result.fee_economics.confidence}`);
  console.log(`  Analysis Status       : ${result.analysis_status}`);
  console.log(`STATUS     : ${result.status==='SAMPLED'?'SAMPLED ⚠':(result.status==='COMPLETE'?'COMPLETE ✓':'PARTIAL ⚠')}`);
  console.log(`TIME       : ${result.elapsed_seconds.toFixed(2)}s`);
  console.log(`OUTPUT     : ${out}`);
  console.log('──────────────────────────────────────────────────────');
  if(result.status==='PARTIAL')process.exitCode=1;
}

if(require.main===module){
  main().catch(e=>{console.error(`STATUS     : FAILED ✗\nERROR      : ${e.stack||e.message}`);process.exitCode=1;});
}

module.exports={normalizeGetAccountInfoResult,parsePumpSwapGlobal,parsePumpSwapPool,pumpSwapClaim,evaluateFeeAttributionEvidence,isPumpSwapTradeInstruction,feeTransferIdentity,dedupeFeeTransfers,buildPhase6SampleCoverage,aggregatePhase6Coverage,resolveFeeFlowVerificationStatus,protocolStateIdentity,dedupeProtocolStateEntries,finalizeProtocolState};
