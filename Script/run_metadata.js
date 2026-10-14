'use strict';

/** Attach consistent scan provenance to a phase result before it is persisted. */
function attachRunMetadata(result, phase, mint) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const runId = String(process.env.SCAN_RUN_ID || '').trim() || null;
  const generatedAt = new Date().toISOString();
  result.run_id = runId;
  result.generated_at = generatedAt;
  result.provenance = {
    ...(result.provenance && typeof result.provenance === 'object' ? result.provenance : {}),
    run_id: runId,
    phase: Number(phase),
    mint: mint || result.input?.mint || result.token?.mint || null,
    generated_at: generatedAt,
    timestamp_source: 'phase-result-write'
  };
  return result;
}

module.exports = { attachRunMetadata };
