#!/usr/bin/env node
'use strict';
/* Helper: pasang Helius API key ke Config/config.json (dijalankan di perangkat sendiri).
 * Key hanya disimpan lokal di file config — jangan bagikan file ini. */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CFG = path.join(__dirname, '..', 'Config', 'config.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Tempel Helius API key (trial) lalu Enter: ', ans => {
  const key = String(ans || '').trim();
  rl.close();
  if (!key || key.length < 10) { console.error('Key kosong/terlalu pendek — dibatalkan.'); process.exit(1); }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch (e) { console.error('Gagal baca', CFG); process.exit(1); }
  cfg.helius = cfg.helius || {};
  cfg.helius.api_key = key;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('OK — key tersimpan di Config/config.json (lokal, jangan dibagikan).');
});
