'use strict';
const { baseCoverage, COVERAGE_STATUSES, RETRIEVAL_MODES, COVERAGE_REASONS } = require('./coverage_contract');

function paginatedCoverage({ pagesRequested, pagesFetched, pageSize, recordsObserved, recordsRetained, paginationToken, cursorUsed, stoppedByCap, scope=null, rateLimit, failed=false } = {}) {
  const observed = Number(recordsObserved || 0), retained = Number(recordsRetained ?? observed);
  const pagesReq = Number(pagesRequested || 0), pagesDone = Number(pagesFetched || 0);
  let status, reason, stoppedReason, hasMorePossible;
  if (failed) {
    status = observed > 0 ? COVERAGE_STATUSES.PARTIAL : COVERAGE_STATUSES.FAILED;
    reason = observed > 0 ? COVERAGE_REASONS.REQUEST_FAILED : COVERAGE_REASONS.REQUEST_FAILED;
    stoppedReason = 'REQUEST_FAILED'; hasMorePossible = true;
  } else if (stoppedByCap) {
    status = COVERAGE_STATUSES.PARTIAL; reason = COVERAGE_REASONS.PAGE_LIMIT;
    stoppedReason = 'PAGE_LIMIT'; hasMorePossible = true;
  } else if (!observed) {
    status = COVERAGE_STATUSES.EMPTY; reason = COVERAGE_REASONS.NO_MATCH;
    stoppedReason = 'NO_MORE_DATA'; hasMorePossible = false;
  } else {
    status = COVERAGE_STATUSES.COMPLETE; reason = COVERAGE_REASONS.NO_MORE_DATA;
    stoppedReason = 'NO_MORE_DATA'; hasMorePossible = false;
  }
  return baseCoverage({
    retrievalMode: stoppedByCap ? RETRIEVAL_MODES.PAGINATED_BOUNDED : RETRIEVAL_MODES.PAGINATED_UNBOUNDED,
    status, reason, scope: scope || (stoppedByCap ? 'CONFIGURED_PAGE_WINDOW' : 'FULL_AVAILABLE_DATA'),
    pagination: { enabled: true, pages_requested: pagesReq, pages_fetched: pagesDone, cursor_used: Boolean(cursorUsed ?? paginationToken), stopped_reason: stoppedReason, has_more_possible: hasMorePossible },
    records: { requested: pagesDone * Number(pageSize || 0), observed, retained },
    caps: { page_cap: stoppedByCap ? pagesReq : null, record_cap: null, wallet_cap: null, event_cap: null, cap_triggered: Boolean(stoppedByCap) },
    rateLimit
  });
}

function emptyOrFailedCoverage({ attempted=true, observed=0, failed=false, rateLimit, reason } = {}) {
  if (!attempted) return baseCoverage({ retrievalMode: RETRIEVAL_MODES.EMPTY, status: COVERAGE_STATUSES.UNKNOWN, reason: COVERAGE_REASONS.NOT_AVAILABLE, scope:'UNKNOWN_SCOPE' });
  return baseCoverage({ retrievalMode: failed ? RETRIEVAL_MODES.FAILED : RETRIEVAL_MODES.EMPTY, status: failed ? COVERAGE_STATUSES.FAILED : COVERAGE_STATUSES.EMPTY, reason: failed ? (reason || COVERAGE_REASONS.REQUEST_FAILED) : COVERAGE_REASONS.NO_MATCH, scope:'FULL_AVAILABLE_DATA', records:{requested:0,observed,retained:observed}, rateLimit });
}

function overallCoverage(datasets) {
  const vals = Object.values(datasets || {}).filter(Boolean);
  if (!vals.length) return null;
  if (vals.some(x => x.status === COVERAGE_STATUSES.FAILED)) return 'PARTIAL';
  if (vals.some(x => x.status === COVERAGE_STATUSES.PARTIAL || x.status === COVERAGE_STATUSES.UNKNOWN || x.status === COVERAGE_STATUSES.SAMPLED)) return 'PARTIAL';
  return 'COMPLETE';
}

module.exports = { paginatedCoverage, emptyOrFailedCoverage, overallCoverage };
