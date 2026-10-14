'use strict';
/*
 * relationship_annotator.js
 *
 * Masalah: CTR-05 ("Repeated Linked Trading Events") membutuhkan
 * `relationship_id` + `relationship_verified` yang SAMA pada event transfer
 * dan SELL berikutnya — tetapi tidak ada kolektor yang mengisi evidence itu,
 * sehingga rule ini tidak pernah bisa fire pada data live.
 *
 * Modul ini MENGISI evidence tersebut dari funding-graph.json (Phase 8B):
 * dua wallet yang berbagi funder yang sama mendapat relationship terverifikasi
 * `funder:<F>`. Atribusi funder bersifat heuristik (lihat limitations kolektor)
 * — anotasi ini adalah "kandidat hubungan", dan rule tetap yang memutuskan.
 *
 * Yang TIDAK diubah: rule CTR-05 itu sendiri (threshold, window, status,
 * evidence contract). Modul ini hanya memasok evidence yang selama ini kosong.
 * Fungsi murni: tidak pernah memutasi input.
 */

const fs = require('fs');
const path = require('path');

const FALLBACK_WINDOW_SECONDS = 604800; // sama dengan default rule CTR-05

// Mirror dari tsOf di phase9_risk_engine.js (duplikasi disengaja agar tidak
// ada circular dependency antara kedua modul).
function tsOfEvent(e) {
  const asNum = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (e?.block_time != null || e?.timestamp != null) {
    const n = asNum(e.block_time ?? e.timestamp);
    return n == null ? null : Math.floor(n > 2e10 ? n / 1000 : n);
  }
  for (const v of [e?.timestamp_utc, e?.timestamp_wib]) {
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
    const n = asNum(v);
    if (n != null) return Math.floor(n > 2e10 ? n / 1000 : n);
  }
  return null;
}

function hasRelationship(e) {
  return e?.relationship_verified === true &&
    typeof e?.relationship_id === 'string' &&
    e.relationship_id.trim().length > 0;
}

// Lenient: {} bila config tidak ada. Tidak pernah throw.
function loadRelationshipsConfig() {
  try {
    const p = path.join(__dirname, '..', 'Config', 'config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (c && c.relationships) || {};
  } catch { return {}; }
}

// wallet -> Set(funder)
function walletFunderMap(fundingGraph) {
  const map = new Map();
  const recs = (fundingGraph && fundingGraph.wallets) || {};
  for (const [w, rec] of Object.entries(recs)) {
    const s = new Set();
    for (const f of (rec?.funders || [])) {
      if (f?.funder) s.add(String(f.funder));
    }
    if (s.size) map.set(String(w), s);
  }
  return map;
}

// Relationship id deterministik untuk pasangan (s, r): funder bersama yang
// terkecil secara leksikografis, atau null bila tidak berbagi funder.
function relationshipIdFor(s, r, funderMap) {
  const fs = funderMap.get(String(s));
  const fr = funderMap.get(String(r));
  if (!fs || !fr) return null;
  const shared = [...fs].filter(f => fr.has(f)).sort();
  if (!shared.length) return null;
  return `funder:${shared[0]}`;
}

/*
 * Menganotasi event transfer (RECEIVE/TRANSFER_OUT) dan SELL pasangannya dengan
 * relationship_id yang sama, bila pengirim & penerima berbagi funder terverifikasi
 * (dari funding-graph.json) dan SELL terjadi dalam window rule CTR-05.
 * Greedy berdasarkan waktu (transfer lebih dulu, SELL pertama yang tersedia) —
 * cerminan logika transferSellSequences agar keduanya sepakat.
 */
function annotateRelationships(events, fundingGraph, rule, config = {}) {
  const rows = Array.isArray(events) ? events : [];
  const relCfg = (config && config.relationships) || loadRelationshipsConfig();
  if (relCfg.enabled === false) return rows;
  if (!fundingGraph) return rows;
  const windowSeconds = Number(rule?.window_seconds) || FALLBACK_WINDOW_SECONDS;
  const funderMap = walletFunderMap(fundingGraph);
  if (!funderMap.size) return rows;

  const transfers = [];
  const sellsByWallet = new Map();
  for (const row of rows) {
    const e = row?.event || {};
    const cls = String(e.event_class || '').toUpperCase();
    const ts = tsOfEvent(e);
    if (ts == null) continue;
    if (cls === 'RECEIVE' || cls === 'TRANSFER_OUT') {
      const cp = e.counterparty;
      if (!cp) continue;
      const sender = cls === 'RECEIVE' ? String(cp) : String(row.wallet);
      const recipient = cls === 'RECEIVE' ? String(row.wallet) : String(cp);
      const id = relationshipIdFor(sender, recipient, funderMap);
      if (id) transfers.push({ row, recipient, ts, id });
    } else if (cls === 'SELL') {
      const w = String(row.wallet);
      if (!sellsByWallet.has(w)) sellsByWallet.set(w, []);
      sellsByWallet.get(w).push({ row, ts });
    }
  }
  transfers.sort((a, b) => a.ts - b.ts);
  for (const arr of sellsByWallet.values()) arr.sort((a, b) => a.ts - b.ts);

  const usedSells = new Set();
  const annotated = new Map(); // row -> relationship_id
  for (const t of transfers) {
    if (hasRelationship(t.row.event) || annotated.has(t.row)) continue;
    const cands = (sellsByWallet.get(t.recipient) || [])
      .filter(s => s.ts >= t.ts && s.ts - t.ts <= windowSeconds &&
        !usedSells.has(s.row) && !hasRelationship(s.row.event) && !annotated.has(s.row));
    if (!cands.length) continue;
    const s = cands[0];
    annotated.set(t.row, t.id);
    annotated.set(s.row, t.id);
    usedSells.add(s.row);
  }
  if (!annotated.size) return rows;
  return rows.map(row => {
    const id = annotated.get(row);
    if (!id) return row;
    return { ...row, event: { ...row.event, relationship_id: id, relationship_verified: true } };
  });
}

module.exports = { annotateRelationships, relationshipIdFor, walletFunderMap, loadRelationshipsConfig, tsOfEvent, FALLBACK_WINDOW_SECONDS };
