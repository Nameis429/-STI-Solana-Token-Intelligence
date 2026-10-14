'use strict';

const COVERAGE_STATUSES = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  SAMPLED: 'SAMPLED',
  EMPTY: 'EMPTY',
  UNKNOWN: 'UNKNOWN',
  FAILED: 'FAILED'
});

const RETRIEVAL_MODES = Object.freeze({
  SNAPSHOT: 'SNAPSHOT',
  PAGINATED_BOUNDED: 'PAGINATED_BOUNDED',
  PAGINATED_UNBOUNDED: 'PAGINATED_UNBOUNDED',
  SAMPLED: 'SAMPLED',
  FAILED: 'FAILED',
  EMPTY: 'EMPTY'
});

const COVERAGE_REASONS = Object.freeze({
  NO_MORE_DATA: 'NO_MORE_DATA',
  PAGE_LIMIT: 'PAGE_LIMIT',
  RECORD_LIMIT: 'RECORD_LIMIT',
  TIME_WINDOW_COMPLETE: 'TIME_WINDOW_COMPLETE',
  SAMPLE_LIMIT: 'SAMPLE_LIMIT',
  RATE_LIMIT: 'RATE_LIMIT',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  TIMEOUT: 'TIMEOUT',
  REQUEST_FAILED: 'REQUEST_FAILED',
  UPSTREAM_PARTIAL: 'UPSTREAM_PARTIAL',
  PROBE_LIMIT: 'PROBE_LIMIT',
  FILTERED_EMPTY: 'FILTERED_EMPTY',
  NO_MATCH: 'NO_MATCH',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  UNKNOWN_REASON: 'UNKNOWN_REASON'
});

function baseCoverage({retrievalMode, status, reason, scope, pagination, records, caps, rateLimit} = {}) {
  return {
    retrieval_mode: retrievalMode || RETRIEVAL_MODES.SNAPSHOT,
    status: status || COVERAGE_STATUSES.UNKNOWN,
    reason: reason || COVERAGE_REASONS.UNKNOWN_REASON,
    scope: scope || 'UNKNOWN_SCOPE',
    pagination: {
      enabled: Boolean(pagination?.enabled),
      pages_requested: Number(pagination?.pages_requested || 0),
      pages_fetched: Number(pagination?.pages_fetched || 0),
      cursor_used: Boolean(pagination?.cursor_used),
      stopped_reason: pagination?.stopped_reason || null,
      has_more_possible: pagination?.has_more_possible ?? null
    },
    records: {
      requested: Number(records?.requested || 0),
      observed: Number(records?.observed || 0),
      retained: Number(records?.retained || 0)
    },
    caps: {
      page_cap: caps?.page_cap ?? null,
      record_cap: caps?.record_cap ?? null,
      wallet_cap: caps?.wallet_cap ?? null,
      event_cap: caps?.event_cap ?? null,
      cap_triggered: Boolean(caps?.cap_triggered)
    },
    rate_limit: {
      encountered: Boolean(rateLimit?.encountered),
      retry_count: Number(rateLimit?.retry_count || 0),
      recovered: rateLimit?.recovered ?? null,
      final_state: rateLimit?.final_state || 'NOT_ENCOUNTERED'
    }
  };
}

function phase3HolderCoverage({pages, recordsObserved, recordsRetained, holderCap, limitReached, hadAnyRecords, rateLimit, pagesFetched} = {}) {
  const pagesN = Number(pagesFetched ?? pages ?? 0);
  const observed = Number(recordsObserved || 0);
  const retained = Number(recordsRetained || 0);
  const cap = Number(holderCap || 0);

  let status;
  let reason;
  let retrievalMode = RETRIEVAL_MODES.PAGINATED_UNBOUNDED;
  let stoppedReason;
  let hasMorePossible;

  if (limitReached) {
    status = COVERAGE_STATUSES.PARTIAL;
    reason = COVERAGE_REASONS.RECORD_LIMIT;
    stoppedReason = 'RECORD_LIMIT';
    hasMorePossible = true;
  } else if (!hadAnyRecords) {
    status = COVERAGE_STATUSES.EMPTY;
    reason = COVERAGE_REASONS.NO_MATCH;
    retrievalMode = RETRIEVAL_MODES.EMPTY;
    stoppedReason = 'NO_MORE_DATA';
    hasMorePossible = false;
  } else {
    status = COVERAGE_STATUSES.COMPLETE;
    reason = COVERAGE_REASONS.NO_MORE_DATA;
    stoppedReason = 'NO_MORE_DATA';
    hasMorePossible = false;
  }

  const rl = rateLimit || {};
  return baseCoverage({
    retrievalMode,
    status,
    reason,
    scope: 'FULL_AVAILABLE_DATA',
    pagination: {
      enabled: true,
      pages_requested: pagesN,
      pages_fetched: pagesN,
      cursor_used: false,
      stopped_reason: stoppedReason,
      has_more_possible: hasMorePossible
    },
    records: {
      requested: observed,
      observed,
      retained
    },
    caps: {
      page_cap: null,
      record_cap: cap || null,
      wallet_cap: cap || null,
      event_cap: null,
      cap_triggered: Boolean(limitReached)
    },
    rateLimit: rl
  });
}



function phase7HistoryCoverage({pagesFetched=0, maxPages=0, transactionsObserved=0, eventsRetained=0, complete=false, rateLimit, failed=false, empty=false}={}) {
  const pages = Number(pagesFetched || 0);
  const pageCap = Number(maxPages || 0);
  const observed = Number(transactionsObserved || 0);
  const retained = Number(eventsRetained || 0);
  const rl = rateLimit || {};
  let status, reason, mode, scope, stoppedReason, hasMorePossible;

  if (failed) {
    status = COVERAGE_STATUSES.FAILED;
    reason = rl?.encountered ? (rl?.retry_exhausted ? COVERAGE_REASONS.RETRY_EXHAUSTED : COVERAGE_REASONS.RATE_LIMIT) : COVERAGE_REASONS.REQUEST_FAILED;
    mode = RETRIEVAL_MODES.FAILED;
    scope = pages > 0 ? 'CONFIGURED_PAGE_WINDOW' : 'UNKNOWN_SCOPE';
    stoppedReason = reason;
    hasMorePossible = null;
  } else if (complete && empty) {
    status = COVERAGE_STATUSES.EMPTY;
    reason = COVERAGE_REASONS.NO_MATCH;
    mode = RETRIEVAL_MODES.EMPTY;
    scope = 'CONFIGURED_PAGE_WINDOW';
    stoppedReason = 'NO_MORE_DATA';
    hasMorePossible = false;
  } else if (complete) {
    status = COVERAGE_STATUSES.COMPLETE;
    reason = COVERAGE_REASONS.NO_MORE_DATA;
    mode = RETRIEVAL_MODES.PAGINATED_BOUNDED;
    scope = 'CONFIGURED_PAGE_WINDOW';
    stoppedReason = 'NO_MORE_DATA';
    hasMorePossible = false;
  } else {
    status = COVERAGE_STATUSES.PARTIAL;
    reason = COVERAGE_REASONS.PAGE_LIMIT;
    mode = RETRIEVAL_MODES.PAGINATED_BOUNDED;
    scope = 'CONFIGURED_PAGE_WINDOW';
    stoppedReason = 'PAGE_LIMIT';
    hasMorePossible = true;
  }

  return baseCoverage({
    retrievalMode: mode, status, reason, scope,
    pagination: { enabled:true, pages_requested:pageCap, pages_fetched:pages, cursor_used:pages > 1, stopped_reason:stoppedReason, has_more_possible:hasMorePossible },
    records: { requested:observed, observed, retained },
    caps: { page_cap:pageCap || null, record_cap:null, wallet_cap:null, event_cap:null, cap_triggered:status === COVERAGE_STATUSES.PARTIAL },
    rateLimit: rl
  });
}

module.exports = {
  COVERAGE_STATUSES,
  RETRIEVAL_MODES,
  COVERAGE_REASONS,
  baseCoverage,
  phase3HolderCoverage,
  phase7HistoryCoverage
};
