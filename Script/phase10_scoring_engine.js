#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { attachRunMetadata } = require('./run_metadata');
const { buildWalletBehaviorAdjustment } = require('./behavior_adjustment_engine');

const VERSION = '1.2.1';
const PHASES = [1,2,3,4,5,6,7,8,9];
const RISK_SEVERITY = {
  SELL_PRESSURE_RISK: 75,
  COORDINATED_TRADING_RISK: 70,
  TRADING_CONCENTRATION_RISK: 65,
  LIQUIDITY_RELATED_TRADING_RISK: 60,
  DEFAULT: 50
};
const LABELS = [
  { min: 0, max: 20, label: 'Sangat lemah' },
  { min: 21, max: 40, label: 'Lemah' },
  { min: 41, max: 60, label: 'Sedang' },
  { min: 61, max: 80, label: 'Kuat' },
  { min: 81, max: 100, label: 'Sangat kuat' }
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function clamp(n, min=0, max=100) { return Math.max(min, Math.min(max, n)); }
function round(n, digits=2) { const p = 10 ** digits; return Math.round((n + Number.EPSILON) * p) / p; }
function labelFor(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'Tidak dinilai';
  return LABELS.find(x => score >= x.min && score <= x.max)?.label || 'Tidak dinilai';
}
function riskLabelFor(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'Tidak dinilai';
  if (score <= 20) return 'Rendah';
  if (score <= 40) return 'Terbatas';
  if (score <= 60) return 'Sedang';
  if (score <= 80) return 'Tinggi';
  return 'Sangat tinggi';
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function getWallets(rule) {
  const found = [];
  if (rule?.metric?.wallet) found.push(rule.metric.wallet);
  if (Array.isArray(rule?.metric?.wallets)) found.push(...rule.metric.wallets);
  for (const ref of (Array.isArray(rule?.evidence_refs) ? rule.evidence_refs : [])) {
    if (ref?.wallet) found.push(ref.wallet);
    if (ref?.seller) found.push(ref.seller);
    if (ref?.recipient) found.push(ref.recipient);
    if (Array.isArray(ref?.wallets)) found.push(...ref.wallets);
  }
  return uniq(found);
}
function getSignatures(rule) {
  const refs = Array.isArray(rule?.evidence_refs) ? rule.evidence_refs : [];
  return uniq(refs.map(x => x?.signature || x?.tx_signature || x?.transaction_signature));
}

// Canonical identity for evidence. A transaction signature is preferred; when it
// is unavailable, fall back to a stable event fingerprint. This preserves the
// fact that the same event may satisfy multiple rules without treating it as
// multiple independent events during aggregation.
function evidenceIdentity(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const sig = ref.signature || ref.tx_signature || ref.transaction_signature;
  if (sig) return `sig:${sig}`;
  const wallet = ref.wallet || ref.seller || ref.recipient || '';
  const ts = ref.timestamp_utc || ref.timestamp_wib || ref.timestamp || '';
  const cls = ref.event_class || ref.type || '';
  const cp = ref.counterparty || '';
  const amount = ref.amount_ui ?? ref.amount ?? '';
  if (!wallet && !ts && !cls && !cp && amount === '') return null;
  return `fp:${wallet}|${ts}|${cls}|${cp}|${amount}`;
}
function uniqueEvidenceIdentities(refs) {
  return uniq(refs.map(evidenceIdentity));
}
function evidenceNoveltyRatio(currentRefs, priorIds) {
  const ids = uniqueEvidenceIdentities(currentRefs);
  if (!ids.length) return 0;
  if (!priorIds?.size) return 1;
  const novel = ids.filter(id => !priorIds.has(id)).length;
  return novel / ids.length;
}

/**
 * Transparent v1 scoring rubric. Evidence score describes support quality;
 * risk score describes category severity adjusted by evidence strength.
 * Insufficient/unknown/disabled results are deliberately not scored.
 */
function scoreRule(rule) {
  const status = String(rule?.status || 'UNKNOWN').toUpperCase();
  const refs = Array.isArray(rule?.evidence_refs) ? rule.evidence_refs : [];
  const signatures = getSignatures(rule);
  const evidenceIds = uniqueEvidenceIdentities(refs);
  const hasMetric = rule?.metric !== null && rule?.metric !== undefined;
  const hasThreshold = rule?.threshold !== null && rule?.threshold !== undefined;
  const hasQuality = rule?.data_quality !== null && rule?.data_quality !== undefined;
  const scoreEligible = ['TRIGGERED', 'PROVISIONAL'].includes(status);
  let evidenceScore = null;
  let riskScore = null;
  const components = {
    status_support: scoreEligible ? 25 : 0,
    evidence_references: evidenceIds.length > 0 ? 20 : 0,
    unique_transaction_ids: signatures.length > 0 ? 20 : 0,
    metric_available: hasMetric ? 15 : 0,
    threshold_available: hasThreshold ? 10 : 0,
    data_quality_metadata: hasQuality ? 10 : 0
  };
  if (scoreEligible) {
    evidenceScore = clamp(Object.values(components).reduce((a,b)=>a+b,0));
    const severity = RISK_SEVERITY[rule.category] ?? RISK_SEVERITY.DEFAULT;
    riskScore = round(severity * evidenceScore / 100);
  } else if (status === 'NOT_TRIGGERED') {
    // A verified non-trigger is not a positive risk signal; evidence strength is N/A.
    riskScore = 0;
  }
  return {
    rule_id: rule.rule_id || null,
    category: rule.category || 'UNCLASSIFIED',
    name: rule.name || rule.rule_id || 'Unnamed rule',
    status,
    reason: rule.reason || null,
    metric: rule.metric ?? null,
    threshold: rule.threshold ?? null,
    operator: rule.operator ?? null,
    window_seconds: rule.window_seconds ?? null,
    evaluator: rule.evaluator ?? null,
    evidence_refs: refs,
    evidence_identities: evidenceIds,
    evidence_scope: rule?.evidence_scope || null,
    data_quality: rule.data_quality ?? null,
    wallets: getWallets(rule),
    evidence_strength: {
      score: evidenceScore,
      label: labelFor(evidenceScore),
      components,
      rubric_version: 'evidence-rubric-v1'
    },
    risk: {
      score: riskScore,
      label: riskLabelFor(riskScore),
      category_severity_baseline: scoreEligible ? (RISK_SEVERITY[rule.category] ?? RISK_SEVERITY.DEFAULT) : null,
      method: scoreEligible ? 'category_severity_baseline × evidence_strength / 100' : (status === 'NOT_TRIGGERED' ? 'validated non-trigger = 0 risk signal' : 'not scored: evidence/status insufficient')
    },
    scoring_status: scoreEligible ? 'SCORED' : (status === 'NOT_TRIGGERED' ? 'EVALUATED_NO_TRIGGER' : 'NOT_SCORED'),
    source_phase: 9
  };
}

function groupEvidence(scoredRules) {
  const map = new Map();
  for (const item of scoredRules) {
    const wallets = item.wallets.length ? item.wallets : ['__UNASSIGNED__'];
    for (const wallet of wallets) {
      const key = `${item.category}::${wallet}`;
      if (!map.has(key)) map.set(key, { group_id: key, category: item.category, wallet: wallet === '__UNASSIGNED__' ? null : wallet, member_rule_ids: [], evidence_scores: [], risk_scores: [], source_refs: [], evidence_identities: [], grouping_reason: 'Kategori sama dan wallet teridentifikasi sama; kontribusi rule dibatasi berdasarkan evidence baru agar event yang sama tidak dihitung sebagai kejadian independen.' });
      const g = map.get(key);
      const priorIds = new Set(g.evidence_identities);
      const novelty = evidenceNoveltyRatio(item.evidence_refs, priorIds);
      g.member_rule_ids.push(item.rule_id);
      if (item.evidence_strength.score !== null) g.evidence_scores.push({score:item.evidence_strength.score, novelty});
      if (item.risk.score !== null && item.risk.score > 0) g.risk_scores.push({score:item.risk.score, novelty});
      g.source_refs.push(...item.evidence_refs.map(r => r.signature || r.tx_signature || r.transaction_signature).filter(Boolean));
      g.evidence_identities.push(...item.evidence_identities);
    }
  }
  return [...map.values()].map(g => {
    const ev = aggregateCapped(g.evidence_scores.map(x=>x.score), 0.20, g.evidence_scores.map(x=>x.novelty));
    const risk = aggregateCapped(g.risk_scores.map(x=>x.score), 0.20, g.risk_scores.map(x=>x.novelty));
    return { ...g, member_rule_ids: uniq(g.member_rule_ids), source_refs: uniq(g.source_refs), evidence_identities: uniq(g.evidence_identities),
      evidence_strength: { score: ev, label: labelFor(ev), aggregation: 'maximum + 20% of each additional rule scaled by its novel-evidence ratio; capped at 100' },
      risk: { score: risk, label: riskLabelFor(risk), aggregation: 'maximum + 20% of each additional positive risk score scaled by its novel-evidence ratio; capped at 100' } };
  });
}
function aggregateCapped(values, addFactor=0.20, noveltyRatios=null) {
  const pairs = values.map((value, i) => ({value, novelty: noveltyRatios?.[i] ?? 1})).filter(x=>Number.isFinite(x.value)).sort((a,b)=>b.value-a.value);
  if (!pairs.length) return null;
  return round(clamp(pairs[0].value + pairs.slice(1).reduce((s,x)=>s + x.value*addFactor*clamp(x.novelty,0,1),0)));
}
function aggregateWalletEvidence(groups, observations=[]) {
  // Wallet-level aggregation is deliberately evidence-aware across categories.
  // A group may contain an event already counted by a higher-priority group;
  // only its novel evidence earns the additional-rule contribution. The event
  // remains visible in every member rule/group, so overlap is information, not
  // deletion. Source observations without evidence identities are not silently
  // treated as duplicates.
  const items = [
    ...groups.map(g => ({ kind:'group', id:g.group_id, score:g.evidence_strength.score, identities:g.evidence_identities || [] })),
    ...observations.map(o => ({ kind:'observation', id:o.finding_id, score:o.evidence_strength.score, identities:o.evidence_identities || [] }))
  ].filter(x => Number.isFinite(x.score));
  items.sort((a,b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const seen = new Set();
  const contributions = [];
  for (const item of items) {
    const ids = uniq(item.identities);
    let novelty = 1;
    if (ids.length) {
      const novel = ids.filter(id => !seen.has(id)).length;
      novelty = novel / ids.length;
      ids.forEach(id => seen.add(id));
    }
    contributions.push({ ...item, novelty });
  }
  if (!contributions.length) return { score:null, label:'Tidak dinilai', contributions:[] };
  const score = round(clamp(contributions[0].score + contributions.slice(1).reduce((sum,x) => sum + x.score * 0.20 * clamp(x.novelty,0,1),0)));
  return { score, label:labelFor(score), contributions };
}

function aggregateWalletRisk(groups) {
  const items = groups
    .filter(g => Number.isFinite(g.risk.score))
    .map(g => ({ id:g.group_id, score:g.risk.score, identities:g.evidence_identities || [] }))
    .sort((a,b) => b.score-a.score || String(a.id).localeCompare(String(b.id)));
  if (!items.length) return { score:null, label:'Tidak dinilai', contributions:[] };
  const seen = new Set();
  const contributions = items.map((item, index) => {
    const ids = uniq(item.identities);
    let novelty = 1;
    if (ids.length) {
      const novel = ids.filter(id => !seen.has(id)).length;
      novelty = novel / ids.length;
      ids.forEach(id => seen.add(id));
    }
    return { ...item, novelty, role:index===0?'base':'additional' };
  });
  const score = round(clamp(contributions[0].score + contributions.slice(1).reduce((sum,x) => sum + x.score * 0.20 * clamp(x.novelty,0,1),0)));
  return { score, label:riskLabelFor(score), contributions };
}

function makeWalletScores(phase8, groups, scoredRules, phaseObservations=[]) {
  const wallets = new Map();
  for (const w of (phase8?.wallets || [])) {
    if (w?.wallet) wallets.set(w.wallet, { wallet: w.wallet, display: w.display || null, database: w.database || null, current: w.current || null, history_status: w.history?.status || w.history?.history_status || null, source_context: w.source_context || null });
  }
  for (const r of scoredRules) for (const wallet of r.wallets) {
    if (!wallets.has(wallet)) wallets.set(wallet, { wallet, display: null, database: null, current: null, history_status: null, source_context: null });
  }
  return [...wallets.values()].map(w => {
    const ownGroups = groups.filter(g => g.wallet === w.wallet);
    const ownObservations = phaseObservations.filter(o=>o.source_phase===8 && o.subject===w.wallet);
    const ev = aggregateWalletEvidence(ownGroups, ownObservations);
    const risk = aggregateWalletRisk(ownGroups);
    const findings = scoredRules.filter(r=>r.wallets.includes(w.wallet));
    return { ...w, evidence_strength: { score: ev.score, label: labelFor(ev.score), aggregation: 'maximum + 20% of each additional group scaled by novel-evidence ratio across this wallet; capped at 100' }, risk: { score: risk.score, label: riskLabelFor(risk.score), aggregation: 'maximum + 20% of each additional risk group scaled by novel-evidence ratio across this wallet; capped at 100' },
      coverage: { history_status: w.history_status || 'UNKNOWN', note: 'Coverage dilaporkan terpisah dan tidak otomatis mengurangi skor.' },
      evidence_group_ids: ownGroups.map(g=>g.group_id), source_observation_ids: ownObservations.map(o=>o.finding_id), related_rule_ids: uniq(findings.map(r=>r.rule_id)),
      evidence_aggregation_detail: ev.contributions,
      risk_aggregation_detail: risk.contributions,
      scoring_status: ev.score === null && risk.score === null ? 'NO_SCORABLE_EVIDENCE' : 'SCORED' };
  }).sort((a,b)=>(b.risk.score ?? -1)-(a.risk.score ?? -1) || (b.evidence_strength.score ?? -1)-(a.evidence_strength.score ?? -1));
}
function countStatuses(rules) {
  const out = {};
  for (const r of rules) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}
function average(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? round(nums.reduce((a,b)=>a+b,0)/nums.length) : null;
}
function coverageSummary(p8, p9) {
  const wallets = p8?.wallets || [];
  const classify = w => {
    const cs=String(w?.history?.coverage?.status||'').toUpperCase();
    if(cs) return cs;
    if(w?.history?.complete===true && w?.history?.events_truncated!==true) return 'COMPLETE';
    if(w?.history?.complete===false || /PARTIAL|INCOMPLETE|RATE_LIMIT|FAILED/i.test(String(w?.history?.status || w?.history?.history_status || ''))) return 'PARTIAL';
    return 'UNKNOWN';
  };
  const counts={COMPLETE:0,PARTIAL:0,SAMPLED:0,FAILED:0,UNKNOWN:0,EMPTY:0};
  for(const w of wallets){const c=classify(w);counts[c]=(counts[c]||0)+1;}
  return {
    phase8_wallets: wallets.length,
    wallet_selection: p8?.wallet_selection || {candidate_wallets:p8?.config?.candidate_wallets??null,selected_wallets:p8?.config?.selected_wallets??null,skipped_wallets:p8?.config?.skipped_wallets??null,max_wallets:p8?.config?.max_wallets??null,selection_policy:p8?.config?.selection||null},
    phase8_evaluation_time_utc: p8?.evaluation_time_utc || p8?.generated_at || null,
    history_complete_wallets: counts.COMPLETE,
    history_partial_or_failed_wallets: counts.PARTIAL+counts.FAILED,
    history_sampled_wallets: counts.SAMPLED,
    history_status_unknown_wallets: counts.UNKNOWN,
    history_empty_wallets: counts.EMPTY,
    phase8_coverage_status: counts.COMPLETE===wallets.length&&wallets.length>0?'COMPLETE':(counts.PARTIAL||counts.SAMPLED?'PARTIAL':'UNKNOWN'),
    phase9_coverage: p9?.scope?.coverage ?? null,
    note: 'Coverage merupakan indikator terpisah; data tidak lengkap tidak diberi skor nol dan tidak otomatis menjadi negative finding.'
  };
}


function sourceEvidenceScore({phase, phaseData, data, sourceCount=0, complete=null}) {
  let score = 40; // phase result is present and parsed
  const successful = String(phaseData?.status || '').toUpperCase();
  if (['COMPLETE','SUCCESS','PARTIAL'].includes(successful)) score += 20;
  const hasData = data !== null && data !== undefined && !(Array.isArray(data) && data.length === 0) && !(typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
  if (hasData) score += 20;
  if (sourceCount > 0) score += 20;
  if (complete === false) score -= 10;
  return clamp(score);
}
function makeSourceObservation({phase, phaseData, findingId, title, subject=null, data, sourceCount=0, complete=null, note=null}) {
  const score = sourceEvidenceScore({phase, phaseData, data, sourceCount, complete});
  return {
    finding_id: findingId,
    source_phase: phase,
    finding_type: 'SOURCE_OBSERVATION',
    title,
    subject,
    status: phaseData?.status || 'UNKNOWN',
    evidence_strength: { score, label: labelFor(score), basis: 'Kelengkapan dan keterlacakan record sumber; bukan validasi independen atas kebenaran data.' },
    risk: { score: null, label: 'Tidak dinilai', status: 'NOT_APPLICABLE', reason: 'Observasi sumber belum dipetakan ke rule risiko yang tervalidasi.' },
    data,
    source_reference_count: sourceCount,
    note
  };
}
function buildPhaseObservations(phaseFiles) {
  const out = [];
  const p1=phaseFiles[1], p2=phaseFiles[2], p3=phaseFiles[3], p4=phaseFiles[4], p5=phaseFiles[5], p6=phaseFiles[6], p7=phaseFiles[7], p8=phaseFiles[8];
  const add=(args)=>{ if(args.phaseData) out.push(makeSourceObservation(args)); };
  add({phase:1,phaseData:p1,findingId:'P1-TOKEN-IDENTITY',title:'Identitas token',data:p1?.token || null,sourceCount:p1?.data_sources?.length||0,note:'Metadata token dari Phase 1.'});
  add({phase:2,phaseData:p2,findingId:'P2-AUTHORITY-SUPPLY',title:'Authority dan supply token',data:{authority:p2?.authority||null,supply:p2?.token?.supply??null,token_2022:p2?.token_2022||null},sourceCount:p2?.data_sources?.length||0,note:'Fakta authority dan supply; tidak otomatis diberi Risk Score.'});
  add({phase:3,phaseData:p3,findingId:'P3-HOLDER-DISCOVERY',title:'Dataset holder',data:{discovery:p3?.discovery||null,holders_count:p3?.holders?.length||0,token_accounts_count:p3?.token_accounts?.length||0},sourceCount:p3?.data_sources?.length||0,note:'Cakupan holder yang berhasil ditemukan.'});
  add({phase:4,phaseData:p4,findingId:'P4-HOLDER-CONCENTRATION',title:'Konsentrasi holder dan liquidity mapping',data:{coverage:p4?.coverage||null,concentration:p4?.concentration||null,special_accounts_count:p4?.special_accounts?.length||0,liquidity_mapping:p4?.liquidity_mapping||null},sourceCount:p4?.data_sources?.length||0,note:'Metrik konsentrasi dan pemetaan akun khusus dari Phase 4.'});
  add({phase:5,phaseData:p5,findingId:'P5-CREATOR-ANALYSIS',title:'Creator, distribusi, dan relasi wallet',data:{ownership:p5?.ownership||null,creator_events:p5?.creator_events||null,creator_distribution:p5?.creator_distribution||null,initial_distribution:p5?.initial_distribution||null,funding_relationships:p5?.funding_relationships||null,dev_relationship:p5?.dev_relationship||null},sourceCount:p5?.data_sources?.length||0,note:'Temuan creator dan distribusi; interpretasi risiko tidak ditambahkan tanpa rule.'});
  add({phase:6,phaseData:p6,findingId:'P6-FEE-ECONOMICS',title:'Fee dan trading economics',data:{fee_economics:p6?.fee_economics||null,fee_economic_assessment:p6?.fee_economic_assessment||null,claim_vs_reality:p6?.claim_vs_reality||null,downstream_usage:p6?.downstream_usage||null},sourceCount:p6?.data_sources?.length||0,note:'Ringkasan economics dan verifikasi klaim dari Phase 6.'});
  add({phase:7,phaseData:p7,findingId:'P7-WALLET-MATCHING',title:'Database wallet matching',data:{summary:p7?.summary||null,history_scan:p7?.history_scan||null,matches_count:p7?.matches?.length||0},sourceCount:p7?.data_sources?.length||0,note:'Kecocokan database dan cakupan history scan.'});
  add({phase:8,phaseData:p8,findingId:'P8-WALLET-BEHAVIOR',title:'Ringkasan aktivitas wallet',data:{summary:p8?.summary||null,wallets_scanned:p8?.wallets?.length||0,request_metrics:p8?.request_metrics||null},sourceCount:p8?.data_sources?.length||0,note:'Ringkasan timeline dan aktivitas wallet dari Phase 8.'});
  for (const w of (p8?.wallets||[])) {
    const hist=w?.history||{};
    const data={history_status:hist.status||null,history_complete:hist.complete===true,coverage:hist.coverage||null,events_observed:Array.isArray(hist.events)?hist.events.length:0,activity_summary:hist.activity_summary||null,position:w?.position||null};
    add({phase:8,phaseData:p8,findingId:`P8-WALLET-${w.wallet}`,title:'Evidence aktivitas wallet',subject:w.wallet,data,sourceCount:(hist.events?.length||0)>0?1:0,complete:hist.complete===true,note:'Skor menunjukkan kelengkapan record wallet, bukan penilaian risiko wallet.'});
  }
  return out;
}

function buildResult({dir, phaseFiles, mint}) {
  const p7 = phaseFiles[7] || {};
  const p8 = phaseFiles[8] || {};
  const p2 = phaseFiles[2] || {};
  const p9 = phaseFiles[9] || {};
  const sourceRules = Array.isArray(p9.rules) ? p9.rules : [];
  const scoredRules = sourceRules.map(scoreRule);
  const phaseObservations = buildPhaseObservations(phaseFiles);
  const groups = groupEvidence(scoredRules);
  const walletScores = makeWalletScores(p8, groups, scoredRules, phaseObservations);
  const walletIntelligence = buildWalletBehaviorAdjustment({ phase7: p7, phase8: p8, phase2: p2 });
  const scored = scoredRules.filter(r=>r.scoring_status==='SCORED');
  const scoredWallets = walletScores.filter(w=>w.scoring_status==='SCORED');
  const riskRules = scoredRules.filter(r=>r.risk.score !== null);
  const categoryMap = new Map();
  for (const r of scoredRules) {
    if (!categoryMap.has(r.category)) categoryMap.set(r.category, []);
    categoryMap.get(r.category).push(r);
  }
  const categories = [...categoryMap.entries()].map(([category, rs])=>({
    category, rules_total: rs.length, status_counts: countStatuses(rs),
    evidence_strength_average: average(rs.map(r=>r.evidence_strength.score)),
    risk_score_average: average(rs.map(r=>r.risk.score)),
    scored_findings: rs.filter(r=>r.scoring_status==='SCORED').length
  }));
  const inputSources = PHASES.map(n=>({phase:n, file: phaseFiles[n]?`phase${n}-result.json`:null, available:!!phaseFiles[n], status:phaseFiles[n]?.status || 'MISSING'}));
  return {
    phase: 10, phase_name: 'SCORING_ENGINE', version: VERSION, status: 'COMPLETE',
    generated_at: new Date().toISOString(),
    input: { mint, source_directory: path.basename(dir), phases_expected: PHASES, phases_available: PHASES.filter(n=>!!phaseFiles[n]) },
    scoring_method: {
      version: 'phase10-scoring-v1.2', score_range: [0,100],
      evidence_strength_rubric: { status_support:25, evidence_references:20, unique_transaction_ids:20, metric_available:15, threshold_available:10, data_quality_metadata:10 },
      risk_severity_baselines: RISK_SEVERITY,
      aggregation: { group_key:'category + wallet', additional_member_factor:0.20, cap:100, method:'maximum score + 20% of each additional score scaled by novel-evidence ratio; capped at 100', evidence_identity:'signature preferred; deterministic event fingerprint fallback', wallet_cross_category_method:'maximum wallet-group score + 20% of each additional group scaled by that group\'s novel-evidence ratio against higher-priority groups; capped at 100' },
      labels: LABELS,
      limitations: ['Risk baselines are initial configurable defaults, not empirically calibrated probabilities.', 'Phase 1–8 source observations are scored for record completeness only; they are not independently mapped to Risk Score.', 'NOT_TRIGGERED only maps to risk score 0 when Phase 9 explicitly reports that status; it is not interpreted as evidence of safety.']
    },
    summary: {
      mint, rules_total: scoredRules.length, rule_status_counts: countStatuses(scoredRules),
      findings_scored: scored.length, findings_not_scored: scoredRules.length-scored.length,
      source_observations_total: phaseObservations.length,
      source_observations_average_evidence_strength: average(phaseObservations.map(x=>x.evidence_strength.score)),
      wallets_total: walletScores.length, wallets_with_scores: scoredWallets.length,
      wallets_with_evidence_strength_score: walletScores.filter(w=>w.evidence_strength.score!==null).length,
      wallets_with_risk_score: walletScores.filter(w=>w.risk.score!==null).length,
      overall_evidence_strength_average: average(scored.map(r=>r.evidence_strength.score)),
      overall_risk_score_average: average(riskRules.map(r=>r.risk.score)),
      wallet_evidence_strength_average: average(scoredWallets.map(w=>w.evidence_strength.score)),
      wallet_risk_score_average: average(scoredWallets.map(w=>w.risk.score)),
      coverage: coverageSummary(p8,p9),
      wallet_intelligence: { wallets_total: walletIntelligence.summary.wallets_total, ba_available: walletIntelligence.summary.ba_available, ba_partial: walletIntelligence.summary.ba_partial, ba_insufficient: walletIntelligence.summary.ba_insufficient }
    },
    evidence_groups: groups,
    evidence_scores: scoredRules,
    phase_observations: phaseObservations,
    wallet_scores: walletScores,
    wallet_intelligence: walletIntelligence,
    category_scores: categories,
    limitations: [
      'Skor adalah ukuran rule-based dan bukan probabilitas manipulasi atau kesimpulan final tentang wallet.',
      'Coverage data ditampilkan terpisah dari skor.',
      'Keterkaitan transaksi antar-rule hanya dikelompokkan berdasarkan kategori dan wallet yang teridentifikasi; hubungan kausal tidak diasumsikan.',
      'Skor risiko menggunakan baseline kategori awal dan perlu kalibrasi berdasarkan evaluasi historis.'
    ],
    audit_trail: { input_files: inputSources, phase9_rule_ids: sourceRules.map(r=>r.rule_id), scored_rule_ids: scored.map(r=>r.rule_id), generated_by: `phase10_scoring_engine ${VERSION}` }
  };
}

function findOutputDir(root, explicitMint) {
  if (explicitMint) {
    const p = path.join(root, 'Output', explicitMint);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    throw new Error(`Folder output untuk mint ${explicitMint} tidak ditemukan: ${p}`);
  }
  const output = path.join(root, 'Output');
  if (!fs.existsSync(output)) throw new Error(`Folder output tidak ditemukan: ${output}`);
  const dirs = fs.readdirSync(output).map(n=>path.join(output,n)).filter(p=>fs.statSync(p).isDirectory());
  const withP9 = dirs.filter(d=>fs.existsSync(path.join(d,'phase9-result.json')));
  if (withP9.length === 1) return withP9[0];
  if (!withP9.length) throw new Error('Tidak ditemukan folder output yang memiliki phase9-result.json.');
  throw new Error('Terdapat beberapa hasil Phase 9. Jalankan dengan --mint <MINT> agar target jelas.');
}
function printSummary(result) {
  const s = result.summary;
  const line = '─'.repeat(66);
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                 PHASE 10 — SCORING ENGINE                       ║');
  console.log('║             Evidence Strength & Risk Assessment                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Token       : ${s.mint || 'UNKNOWN'}`);
  console.log(`Rule dinilai: ${s.rules_total} | Evidence scored: ${s.findings_scored} | Tidak dinilai: ${s.findings_not_scored}`);
  console.log(`Wallet      : ${s.wallets_total} | Evidence Score: ${s.wallets_with_evidence_strength_score} | Risk Score: ${s.wallets_with_risk_score}`);
  console.log(`Observasi Phase 1–8: ${s.source_observations_total}`);
  console.log(line);
  console.log('RINGKASAN SKOR');
  console.log(`Evidence Strength (rata-rata temuan): ${s.overall_evidence_strength_average ?? 'N/A'}/100`);
  console.log(`Risk Score (rata-rata temuan)       : ${s.overall_risk_score_average ?? 'N/A'}/100`);
  console.log(`Evidence Strength (rata-rata wallet): ${s.wallet_evidence_strength_average ?? 'N/A'}/100`);
  console.log(`Evidence Strength (observasi Phase 1–8): ${s.source_observations_average_evidence_strength ?? 'N/A'}/100`);
  console.log(`Risk Score (rata-rata wallet)       : ${s.wallet_risk_score_average ?? 'N/A'}/100`);
  console.log(line);
  console.log('STATUS RULE');
  for (const [k,v] of Object.entries(s.rule_status_counts)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(line);
  console.log('DATA COVERAGE');
  const c=s.coverage;
  console.log(`  Wallet Phase 8       : ${c.phase8_wallets}`);
  console.log(`  Riwayat lengkap      : ${c.history_complete_wallets}`);
  console.log(`  Parsial/gagal        : ${c.history_partial_or_failed_wallets}`);
  console.log(`  Status tidak diketahui: ${c.history_status_unknown_wallets}`);
  console.log('  Coverage tidak digunakan sebagai pengurang skor otomatis.');
  console.log(line);
  console.log('TEMUAN DENGAN SKOR');
  const top = result.evidence_scores.filter(x=>x.scoring_status==='SCORED').sort((a,b)=>(b.risk.score??0)-(a.risk.score??0)).slice(0,8);
  if (!top.length) console.log('  Tidak ada temuan yang memenuhi syarat scoring.');
  for (const r of top) console.log(`  ${r.rule_id} | Evidence ${r.evidence_strength.score}/100 | Risk ${r.risk.score}/100 | ${r.name}`);
  console.log(line);
  console.log(`File hasil tunggal: ${path.join('Output', s.mint || '<mint>', 'phase10-result.json')}`);
  console.log('');
}
function printDetails(result, choice) {
  if (choice==='1') {
    console.log('\nDAFTAR EVIDENCE');
    for (const r of result.evidence_scores) console.log(`${r.rule_id} | ${r.status.padEnd(18)} | E:${r.evidence_strength.score ?? 'N/A'} | R:${r.risk.score ?? 'N/A'} | ${r.name}`);
  } else if (choice==='2') {
    console.log('\nSKOR WALLET (maksimal 30)');
    for (const w of result.wallet_scores.slice(0,30)) console.log(`${w.wallet} | E:${w.evidence_strength.score ?? 'N/A'} | R:${w.risk.score ?? 'N/A'} | ${w.scoring_status}`);
  } else if (choice==='3') {
    console.log('\nKELOMPOK EVIDENCE');
    for (const g of result.evidence_groups) console.log(`${g.category} | ${g.wallet || 'Wallet tidak teridentifikasi'} | E:${g.evidence_strength.score ?? 'N/A'} | R:${g.risk.score ?? 'N/A'} | ${g.member_rule_ids.join(', ')}`);
  } else if (choice==='4') {
    console.log('\nDATA COVERAGE');
    console.log(JSON.stringify(result.summary.coverage, null, 2));
    console.log('\nKETERBATASAN');
    for (const x of result.limitations) console.log(`- ${x}`);
  }
}
async function runMenu(result) {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve=>rl.question(q, resolve));
  try {
    while (true) {
      console.log('\nDETAIL MENU');
      console.log('  [1] Daftar evidence');
      console.log('  [2] Skor wallet');
      console.log('  [3] Kelompok evidence');
      console.log('  [4] Coverage & keterbatasan');
      console.log('  [0] Keluar');
      const answer = (await ask('Pilih menu: ')).trim();
      if (answer==='0') break;
      if (['1','2','3','4'].includes(answer)) printDetails(result, answer);
      else console.log('Pilihan tidak dikenal.');
    }
  } finally { rl.close(); }
}
function main() {
  const args = process.argv.slice(2);
  const mintIndex = args.indexOf('--mint');
  const mint = mintIndex >= 0 ? args[mintIndex+1] : null;
  const root = path.resolve(__dirname, '..');
  const dir = findOutputDir(root, mint);
  const phaseFiles = {};
  for (const n of PHASES) {
    const p = path.join(dir, `phase${n}-result.json`);
    if (fs.existsSync(p)) phaseFiles[n] = readJson(p);
  }
  if (!phaseFiles[9]) throw new Error('phase9-result.json wajib tersedia untuk Phase 10.');
  const inferredMint = mint || phaseFiles[9]?.input?.mint || phaseFiles[8]?.input?.mint || path.basename(dir);
  const result = buildResult({dir, phaseFiles, mint: inferredMint});
  const outputPath = path.join(dir, 'phase10-result.json');
  attachRunMetadata(result,10,inferredMint); fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  printSummary(result);
  return runMenu(result);
}
if (require.main === module) {
  main().catch(err=>{ console.error(`PHASE 10 ERROR: ${err.message}`); process.exitCode=1; });
}
module.exports = { scoreRule, groupEvidence, aggregateCapped, aggregateWalletEvidence, aggregateWalletRisk, makeWalletScores, buildResult, labelFor, riskLabelFor, sourceEvidenceScore, buildPhaseObservations, coverageSummary, RISK_SEVERITY };
