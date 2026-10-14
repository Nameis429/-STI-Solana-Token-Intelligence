'use strict';
/* Registry wallet CEX .
 * Daftar alamat milik CEX/market-maker yang DIKECUALIKAN dari analisis
 * holder dan metrik top buyer/seller — aktivitas mereka adalah operasional
 * bursa, bukan sinyal holder ritel.
 *
 * Format file (Data/cex_registry.json):
 *   { "_meta": {...},
 *     "<Label>": { "addresses": ["..."], "confidence": "...", "source": "..." } }
 * Policy: HANYA alamat yang eksplisit terdaftar yang ditandai; tidak ada
 * inferensi dari bentuk transaksi. File tidak ada -> tidak ada eksklusi
 * (fail-soft, diungkap di output). Semua fungsi pure kecuali loader.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_REL = 'Data/cex_registry.json';

function loadCexRegistry(root, relPath) {
  try {
    const p = path.join(root || path.resolve(__dirname, '..'), relPath || DEFAULT_REL);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

/* Bangun index: address -> label. Duplikat antar label: label pertama menang. */
function buildCexIndex(registry) {
  const map = new Map();
  if (registry && typeof registry === 'object') {
    for (const [label, entry] of Object.entries(registry)) {
      if (label === '_meta' || !entry || !Array.isArray(entry.addresses)) continue;
      for (const a of entry.addresses) {
        const addr = String(a || '').trim();
        if (!addr || map.has(addr)) continue;
        map.set(addr, String(label));
      }
    }
  }
  return {
    size: map.size,
    has(addr) { return map.has(String(addr || '').trim()); },
    labelOf(addr) { return map.get(String(addr || '').trim()) || null; },
  };
}

function loadCexIndex(root, relPath) {
  return buildCexIndex(loadCexRegistry(root, relPath));
}

/* Pisahkan entries menjadi clean vs excluded (dengan label CEX).
 * addrOf: entry -> address string. */
function withoutCexWallets(cexIndex, entries, addrOf) {
  const clean = [], excluded = [];
  const get = typeof addrOf === 'function' ? addrOf : (e) => e;
  for (const e of (entries || [])) {
    const addr = String(get(e) || '').trim();
    const label = cexIndex ? cexIndex.labelOf(addr) : null;
    if (label) excluded.push({ address: addr, cex_label: label });
    else clean.push(e);
  }
  return { clean, excluded };
}

module.exports = { loadCexRegistry, buildCexIndex, loadCexIndex, withoutCexWallets, DEFAULT_REL };
