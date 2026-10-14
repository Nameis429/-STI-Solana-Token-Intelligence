#!/usr/bin/env node
'use strict';
/**
 * SOLANA TOKEN INTELLIGENCE — SHARED HELIUS RPC THROTTLE 
 *
 * Satu modul untuk dua hal yang diminta dokumentasi Helius "Rate Limits":
 *   1. Jeda preventif antar-request (~10 request/detik): SATU slot global
 *      per proses Node. Semua phase (1-8) dan kedua kolektor (menu 14/15)
 *      yang berjalan dalam proses yang sama berbagi slot ini, sehingga
 *      worker pool / burst loop tidak bisa menembus budget 10/dtk.
 *   2. Retry dengan exponential backoff + jitter saat kena 429/5xx,
 *      mengikuti pola resmi: delay * (0.75 + Math.random() * 0.5),
 *      digandakan tiap percobaan, dibatasi max_delay_ms, dan menghormati
 *      header Retry-After dari server bila ada.
 *
 * Konfigurasi (Config/config.json, section "rpc_throttle"):
 *   {
 *     "min_interval_ms": 110,                          // ~9 req/dtk, aman < 10/dtk
 *     "max_delay_ms": 30000,                           // batas backoff
 *     "retryable_statuses": [408, 429, 500, 502, 503, 504]
 *   }
 * Modul phase/kolektor yang sudah punya interval sendiri (phase8:
 * min_request_interval_ms=180, market_volume delay_ms=300, funding_graph
 * min_request_interval_ms=180) tetap memakai nilainya sebagai override
 * per-panggilan ke takeSlot(); rpc_throttle.min_interval_ms menjadi
 * default global untuk semua yang tidak menentukan sendiri.
 *
 * Catatan: slot bersifat per-proses. Phase yang dijalankan sebagai proses
 * Node terpisah (pipeline 00 memanggil tiap phase berurutan) masing-masing
 * punya slot sendiri — itu aman karena mereka tidak berjalan bersamaan.
 */

const DEFAULTS = {
  min_interval_ms: 110,
  max_delay_ms: 30000,
  retryable_statuses: [408, 429, 500, 502, 503, 504],
};

let settings = {
  min_interval_ms: DEFAULTS.min_interval_ms,
  max_delay_ms: DEFAULTS.max_delay_ms,
  retryable_statuses: new Set(DEFAULTS.retryable_statuses),
};

// Slot global: timestamp (ms) paling awal request berikutnya boleh MULAI.
let nextSlotAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * Baca section rpc_throttle dari config. Idempoten; aman dipanggil
 * berulang kali (tiap helper memanggilnya dengan config masing-masing).
 */
function configure(config) {
  const t = (config && config.rpc_throttle) || {};
  const mi = Number(t.min_interval_ms);
  const md = Number(t.max_delay_ms);
  const rs = Array.isArray(t.retryable_statuses) && t.retryable_statuses.length
    ? t.retryable_statuses.map(Number).filter(n => Number.isFinite(n))
    : DEFAULTS.retryable_statuses;
  settings = {
    min_interval_ms: Number.isFinite(mi) && mi >= 0 ? mi : DEFAULTS.min_interval_ms,
    max_delay_ms: Number.isFinite(md) && md > 0 ? md : DEFAULTS.max_delay_ms,
    retryable_statuses: new Set(rs),
  };
  return settings;
}

/** Kembalikan setting aktif (untuk diagnostik/test). */
function getSettings() {
  return {
    min_interval_ms: settings.min_interval_ms,
    max_delay_ms: settings.max_delay_ms,
    retryable_statuses: [...settings.retryable_statuses],
  };
}

/** Reset ke default + slot nol. Dipakai test agar antar-test terisolasi. */
function resetState() {
  settings = {
    min_interval_ms: DEFAULTS.min_interval_ms,
    max_delay_ms: DEFAULTS.max_delay_ms,
    retryable_statuses: new Set(DEFAULTS.retryable_statuses),
  };
  nextSlotAt = 0;
}

/**
 * Ambil slot request. Menunggu bila slot global belum tiba, lalu
 * memajukan slot sebesar `overrideMs` (atau min_interval_ms dari config).
 * Mengembalikan timestamp slot yang dipakai.
 */
async function takeSlot(overrideMs) {
  const interval = (overrideMs === undefined || overrideMs === null)
    ? settings.min_interval_ms
    : Math.max(0, Number(overrideMs) || 0);
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + interval;
  if (slot > now) await sleep(slot - now);
  return slot;
}

/**
 * Dorong slot global ke timestamp tertentu (dipakai phase8 untuk
 * shared cooldown setelah 429: tidak ada request sampai cooldown usai).
 */
function delayUntil(timestampMs) {
  if (Number.isFinite(timestampMs)) nextSlotAt = Math.max(nextSlotAt, timestampMs);
}

/** True bila status HTTP termasuk daftar retryable (default ikut pola resmi). */
function isRetryableStatus(status) {
  return settings.retryable_statuses.has(Number(status));
}

/**
 * Parse nilai header Retry-After (detik angka atau HTTP-date) -> ms.
 * Mengembalikan 0 bila tidak valid.
 */
function retryAfterMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

/**
 * Backoff eksponensial + jitter pola resmi dokumentasi Helius:
 *   delay = min(max_delay_ms, baseMs * 2^(attempt-1))
 *   hasil = delay * (0.75 + Math.random() * 0.5)
 * Tidak pernah di bawah serverRetryAfterMs (Retry-After dihormati).
 * attempt mulai dari 1.
 */
function backoffMs(attempt, baseMs, serverRetryAfterMs = 0) {
  const base = Math.max(0, Number(baseMs) || 0);
  const exp = Math.min(settings.max_delay_ms, base * 2 ** (Math.max(1, attempt) - 1));
  const jittered = exp * (0.75 + Math.random() * 0.5);
  return Math.max(jittered, Math.max(0, Number(serverRetryAfterMs) || 0));
}

module.exports = {
  configure,
  getSettings,
  resetState,
  takeSlot,
  delayUntil,
  isRetryableStatus,
  retryAfterMs,
  backoffMs,
  DEFAULTS,
};
