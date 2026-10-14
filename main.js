#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { generateReportHTML } = require('./Script/generate_html_report');
const ROOT = __dirname;
const SCRIPT_DIR = path.join(ROOT, 'Script');
const OUTPUT_DIR = path.join(ROOT, 'Output');
const PHASES = [
  { n: 1, title: 'phase token discovery', file: 'phase1_token_discovery.js' },
  { n: 2, title: 'phase token authority supply', file: 'phase2_token_authority_supply.js' },
  { n: 3, title: 'phase holder discovery', file: 'phase3_holder_discovery.js' },
  { n: 4, title: 'phase holder concentration', file: 'phase4_holder_concentration.js' },
  { n: 5, title: 'phase creator_dev_analysis', file: 'phase5_creator_dev_analysis.js' },
  { n: 6, title: 'phase fee trading economics', file: 'phase6_fee_trading_economics.js' },
  { n: 7, title: 'phase database wallet matching', file: 'phase7_database_wallet_matching.js' },
  { n: 8, title: 'phase wallet behavior timeline', file: 'phase8_wallet_behavior_timeline.js' },
  { n: 9, title: 'phase risk_engine', file: 'phase9_risk_engine.js' },
  { n: 10, title: 'phase scoring_engine', file: 'phase10_scoring_engine.js' },
  { n: 11, title: 'phase final_report', file: 'phase11_final_report.js' },
  { n: 12, title: 'phase early trader signals', file: 'phase12_early_signals.js' },
  { n: 14, title: 'funding graph collector (CTR-01/02)', file: 'collect_funding_graph.js' },
  { n: 15, title: 'market volume collector (SPR-03/CTR-04/TCR-01/02/03)', file: 'collect_market_volume.js' },
];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, a => resolve(String(a || '').trim())));
const short = s => s.length > 20 ? `${s.slice(0, 8)}...${s.slice(-8)}` : s;
function validMint(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); }
function banner() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║ SOLANA TOKEN INTELLIGENCE — DAFTAR MENU ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  for (const p of PHASES) console.log(`${String(p.n).padStart(2, '0')}. ${p.title}`);
  console.log('\n00. Jalankan seluruh phase (1-12)');
  console.log('13. generate HTML report');
  console.log('14. funding graph collector (opsional, untuk CTR-01/02)');
  console.log('15. market volume collector (opsional, untuk 5 rule market)');
  console.log(' X. Keluar\n');
}
function phaseArgs(n, mint, allMode) {
  if (n === 10) return ['--mint', mint];
  if (n === 11) return allMode ? ['--mint', mint, '--no-menu'] : ['--mint', mint];
  return [mint];
}
let activeChild = null;
let interruptRequested = false;
process.on('SIGINT', () => {
  if (activeChild) {
    interruptRequested = true;
    console.log('\n⚠ Ctrl+C diterima. Menghentikan phase yang sedang berjalan...');
    activeChild.kill('SIGINT');
    const killer = setTimeout(() => { if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM'); }, 5000);
    killer.unref();
  } else {
    console.log('\nGunakan X untuk keluar dari menu.');
  }
});
function runPhase(p, mint, allMode = false, runId = null) {
  return new Promise(resolve => {
    const file = path.join(SCRIPT_DIR, p.file);
    if (!fs.existsSync(file)) { console.error(`\n[${String(p.n).padStart(2,'0')}] FILE NOT FOUND: ${file}`); resolve(false); return; }
    console.log(`\n\n══════════════════ PHASE ${p.n} / ${PHASES.length} ══════════════════`);
    console.log(`${p.title.toUpperCase()}\nTOKEN: ${short(mint)}\n`);
    interruptRequested = false;
    // Selama child phase berjalan, lepaskan input terminal dari readline menu utama.
    // Ini mencegah parent dan child berebut membaca tombol (terutama menu Phase 10).
    rl.pause();
    const child = spawn(process.execPath, [file, ...phaseArgs(p.n, mint, allMode)], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, SCAN_MINT: mint, SCAN_RUN_ID: runId || process.env.SCAN_RUN_ID || crypto.randomUUID() },
    });
    activeChild = child;
    child.once('error', err => { console.error(`Gagal menjalankan Phase ${p.n}: ${err.message}`); activeChild = null; rl.resume(); resolve(false); });
    child.once('close', (code, signal) => {
      activeChild = null;
      // Ambil kembali input terminal setelah phase selesai atau dihentikan.
      rl.resume();
      if (interruptRequested || signal === 'SIGINT' || signal === 'SIGTERM') {
        console.log(`\nPhase ${p.n} dihentikan oleh pengguna.`); resolve(false); return;
      }
      if (code !== 0) { console.error(`\n⚠ Phase ${p.n} selesai dengan kode ${code ?? 'tidak diketahui'}.`); resolve(false); return; }
      console.log(`\n✓ Phase ${p.n} selesai.`); resolve(true);
    });
  });
}
async function getMint() {
  const mint = await ask('Masukkan CA / Token Mint: ');
  if (!mint) { console.log('CA tidak boleh kosong.'); return null; }
  if (!validMint(mint)) { console.log('Format CA Solana tidak valid.'); return null; }
  return mint;
}
async function runAll(mint) {
  const runId = crypto.randomUUID();
  const scanDir = path.join(OUTPUT_DIR, mint);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'scan-context.json'), JSON.stringify({ run_id: runId, mint, started_at: new Date().toISOString(), mode: 'full_pipeline' }, null, 2) + '\n', 'utf8');
  // Pipeline penuh = phase 1-12. Phase 14 (funding graph), 15 (market volume),
  const PIPELINE = PHASES.filter(p => ![14, 15].includes(p.n));
  console.log(`\nMemulai pipeline 1–12 untuk: ${short(mint)}\nRUN ID: ${runId}\n(Phase 14/15 opsional — jalankan manual bila perlu.)\n`);
  const failed = [];
  let phase11Ok = false;
  for (const p of PIPELINE) {
    const ok = await runPhase(p, mint, true, runId);
    if (p.n === 11) phase11Ok = ok;
    if (!ok) {
      failed.push(p.n);
      const choice = await ask(`Phase ${p.n} gagal. [C] lanjutkan phase berikutnya / [S] hentikan? `);
      if (choice.toLowerCase() !== 'c') break;
    }
  }
  console.log('\n══════════════ RINGKASAN PIPELINE ══════════════');
  console.log(failed.length ? `Phase gagal: ${failed.join(', ')}` : 'Seluruh phase selesai tanpa kode error.');
  console.log(`Output: ${path.join('Output', mint)}`);
  if (phase11Ok) {
    try {
      const report = generateReportHTML(mint, scanDir);
      console.log(`HTML report: ${report.out}`);
    } catch (e) {
      console.error(`⚠ HTML report gagal dibuat: ${e.message}`);
    }
  } else {
    console.log('HTML report tidak dibuat karena Phase 11 belum berhasil pada run ini.');
  }
}
async function main() {
  if (!fs.existsSync(path.join(ROOT, 'Config', 'config.json'))) {
    console.error('Config/config.json tidak ditemukan.'); process.exitCode = 1; return;
  }
  if (!fs.existsSync(path.join(ROOT, 'Data', 'database-wallet.json'))) {
    console.error('Data/database-wallet.json tidak ditemukan.'); process.exitCode = 1; return;
  }
  while (true) {
    banner();
    const choice = (await ask('Pilih menu: ')).toUpperCase();
    if (choice === 'X') break;
    if (choice === '13') {
      const mint = await getMint();
      if (mint) {
        try {
          const report = generateReportHTML(mint);
          console.log(`\n✓ HTML report dibuat: ${report.out}`);
          console.log(`SHA-256: ${report.sha256}`);
        } catch (e) { console.error(`\n⚠ Gagal membuat HTML report: ${e.message}`); }
      }
      await ask('\nTekan Enter untuk kembali ke menu...');
      continue;
    }
    if (choice === '00') {
      const mint = await getMint(); if (mint) await runAll(mint);
      await ask('\nTekan Enter untuk kembali ke menu...'); continue;
    }
    const p = PHASES.find(x => String(x.n).padStart(2, '0') === choice || String(x.n) === choice);
    if (!p) { console.log('Pilihan tidak dikenal.'); await ask('Tekan Enter untuk kembali...'); continue; }
    const mint = await getMint();
    if (mint) {
      const scanDir = path.join(OUTPUT_DIR, mint);
      fs.mkdirSync(scanDir, { recursive: true });
      const contextFile = path.join(scanDir, 'scan-context.json');
      let runId = null;
      try { runId = JSON.parse(fs.readFileSync(contextFile, 'utf8'))?.run_id || null; } catch {}
      if (!runId) { runId = crypto.randomUUID(); fs.writeFileSync(contextFile, JSON.stringify({ run_id: runId, mint, started_at: new Date().toISOString(), mode: 'manual_phases' }, null, 2) + '\n', 'utf8'); }
      const ok = await runPhase(p, mint, false, runId);
      if (ok && p.n === 11) {
        try {
          const report = generateReportHTML(mint, scanDir);
          console.log(`✓ HTML report dibuat: ${report.out}`);
        } catch (e) { console.error(`⚠ HTML report gagal dibuat: ${e.message}`); }
      }
    }
    await ask('\nTekan Enter untuk kembali ke menu...');
  }
  rl.close(); console.log('\nKeluar dari Solana Token Intelligence.');
}
main().catch(e => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; rl.close(); });
