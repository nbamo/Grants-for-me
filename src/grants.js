// Grants.gov client + matching engine.
// Uses the public, key-free Grants.gov REST API (search2 + fetchOpportunity).
// This product uses the Grants.gov API but is not endorsed or certified by HHS.
const { ORG_TYPES, ALWAYS_ELIGIBLE, POPULATIONS, ACTIVE_STATUSES, LIMITS } = require('./config');

const SEARCH_URL = process.env.GRANTS_SEARCH_URL || 'https://api.grants.gov/v1/api/search2';
const FETCH_URL = process.env.GRANTS_FETCH_URL || 'https://api.grants.gov/v1/api/fetchOpportunity';
const TZ = process.env.TZ_NAME || process.env.TZ || 'America/New_York';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- dates (all handled as YYYY-MM-DD strings) ----------
function todayIso(tz = TZ, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY (Grants.gov format)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}

// ---------- profile -> queries ----------
function eligibilityCodes(profile) {
  const codes = [];
  for (const key of profile.orgTypes || []) {
    const t = ORG_TYPES.find(o => o.key === key);
    if (t) codes.push(...t.codes);
  }
  return [...new Set([...codes, ...ALWAYS_ELIGIBLE])];
}

function searchKeywords(profile) {
  const kws = [...(profile.keywords || [])];
  for (const key of profile.populations || []) {
    const p = POPULATIONS.find(x => x.key === key);
    if (p) kws.push(...p.keywords);
  }
  const seen = new Set();
  return kws
    .map(k => String(k).trim())
    .filter(k => k && k.length > 1 && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()))
    .slice(0, LIMITS.MAX_KEYWORDS);
}

function buildQueries(profile) {
  if (profile.sourceTypes && profile.sourceTypes.federal === false) return [];
  const eligibilities = eligibilityCodes(profile).join('|');
  const oppStatuses = profile.includeForecasted ? 'forecasted|posted' : 'posted';
  const queries = searchKeywords(profile).map(kw => ({
    kind: 'keyword', label: kw,
    body: { keyword: kw, oppStatuses, eligibilities, rows: LIMITS.ROWS_PER_QUERY }
  }));
  if ((profile.focusAreas || []).length) {
    queries.push({
      kind: 'category', label: 'focus areas',
      body: { fundingCategories: profile.focusAreas.join('|'), oppStatuses, eligibilities, rows: LIMITS.ROWS_PER_QUERY }
    });
  }
  return queries;
}

// ---------- HTTP ----------
async function postJson(url, body, fetchImpl = fetch) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrantsForMe/1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      const json = await res.json();
      if (json.errorcode && json.errorcode !== 0) {
        throw Object.assign(new Error(`Grants.gov error ${json.errorcode}: ${json.msg || ''}`), { fatal: true });
      }
      return json.data || {};
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

const DETAILS_VERSION = 2;

function safeUrl(u) {
  if (!u) return '';
  let v = String(u).trim();
  if (!/^[a-z]+:/i.test(v) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) v = 'https://' + v;
  return /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : '';
}
function safeEmail(e) {
  const v = String(e || '').trim().replace(/^mailto:/i, '');
  return /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(v) ? v : '';
}

// Pull application/contact links out of a fetchOpportunity record.
function extractApplyInfo(data, s) {
  let programUrl = safeUrl(s.fundingDescLinkUrl || data.fundingDescLinkUrl || s.additionalInfoUrl);
  let programUrlLabel = stripHtml(s.fundingDescLinkDesc || data.fundingDescLinkDesc || '').slice(0, 80);
  const docLinks = [];
  for (const d of data.synopsisDocumentURLs || []) {
    const url = safeUrl(d && (d.url || d.docUrl || d.documentUrl || d.urlLink));
    if (url) docLinks.push({ url, label: stripHtml(d.description || d.urlDesc || d.title || '').slice(0, 80) || 'Related link' });
  }
  if (!programUrl && docLinks.length) { programUrl = docLinks[0].url; programUrlLabel = docLinks[0].label; }
  let documentCount = 0;
  for (const f of data.synopsisAttachmentFolders || []) documentCount += (f.synopsisAttachments || []).length;
  const email = safeEmail(s.agencyContactEmail);
  return {
    programUrl,
    programUrlLabel: programUrlLabel || (programUrl ? 'Agency program page' : ''),
    extraLinks: docLinks.filter(d => d.url !== programUrl).slice(0, 3),
    documentCount,
    contactName: stripHtml(s.agencyContactName || '').slice(0, 80),
    contactEmail: email,
    contactPhone: stripHtml(s.agencyContactPhone || '').replace(/^TBD-?$/i, '').slice(0, 40)
  };
}

async function fetchDetails(id, fetchImpl = fetch) {
  const data = await postJson(FETCH_URL, { opportunityId: Number(id) }, fetchImpl);
  const s = data.synopsis || data.forecast || {};
  return {
    version: DETAILS_VERSION,
    ...extractApplyInfo(data, s),
    ceiling: toNumber(s.awardCeiling),
    floor: toNumber(s.awardFloor),
    summary: stripHtml(s.synopsisDesc || s.forecastDesc || data.synopsisDesc || '').slice(0, 600),
    eligibilityText: stripHtml(s.applicantEligibilityDesc || '').slice(0, 400),
    altCloseDate: parseDate(s.responseDate || s.estApplicationResponseDate || s.closeDate || '')
  };
}

// ---------- scan ----------
function grantLink(id) { return `https://www.grants.gov/search-results-detail/${id}`; }

/**
 * Runs a full scan for one organization and merges results into org.grants.
 * Returns a summary: { queries, results, kept, newIds, errors }.
 */
async function runScan(org, { fetchImpl = fetch, today = todayIso(), log = () => {} } = {}) {
  const profile = org.profile;
  const queries = buildQueries(profile);
  const hits = new Map(); // id -> { hit, keywords:Set, viaCategory }
  const errors = [];
  let results = 0;

  for (const q of queries) {
    try {
      const data = await postJson(SEARCH_URL, q.body, fetchImpl);
      const list = data.oppHits || [];
      results += list.length;
      for (const h of list) {
        const id = String(h.id);
        if (!hits.has(id)) hits.set(id, { hit: h, keywords: new Set(), viaCategory: false });
        const rec = hits.get(id);
        if (q.kind === 'keyword') rec.keywords.add(q.label); else rec.viaCategory = true;
      }
      log(`query "${q.label}": ${list.length} results`);
    } catch (e) {
      errors.push(`${q.label}: ${e.message}`);
      log(`query "${q.label}" failed: ${e.message}`);
    }
    await sleep(LIMITS.REQUEST_DELAY_MS);
  }

  const prev = org.grants || {};
  const next = {};
  const newIds = [];
  let detailFetches = 0;
  const minDaysLeft = Number(profile.minDaysLeft ?? 3);
  const horizon = Number(profile.horizonDays ?? 365);
  const minAward = Number(profile.minAward || 0);

  for (const [id, rec] of hits) {
    const h = rec.hit;
    const old = prev[id];
    const status = String(h.oppStatus || '').toLowerCase();
    let deadline = parseDate(h.closeDate);

    // Details (award size, summary) — fetched once per grant, cached on the record.
    let details = old && old.detailsFetched && old.details && old.details.version === DETAILS_VERSION ? old.details : null;
    if (!details && detailFetches < LIMITS.MAX_DETAIL_FETCH_PER_RUN) {
      try {
        details = await fetchDetails(id, fetchImpl);
        detailFetches++;
        await sleep(LIMITS.REQUEST_DELAY_MS);
      } catch (e) {
        errors.push(`details ${id}: ${e.message}`);
      }
    }
    if (!deadline && details && details.altCloseDate) deadline = details.altCloseDate;

    const daysLeft = deadline ? daysBetween(today, deadline) : null;

    // Validity filters
    if (deadline) {
      if (daysLeft < minDaysLeft) continue;
      if (daysLeft > horizon) continue;
    } else if (status === 'posted' && !profile.includeRolling) {
      continue; // posted with no deadline = rolling/continuous
    }
    if (minAward && details && details.ceiling && details.ceiling < minAward) continue;

    // Match quality
    const title = String(h.title || '').toLowerCase();
    const titleHits = [...rec.keywords].filter(k => title.includes(k.toLowerCase()));
    const score = rec.keywords.size * 2 + titleHits.length * 2 + (rec.viaCategory ? 1 : 0);
    const match = rec.keywords.size ? 'Strong' : 'Broader';

    next[id] = {
      id,
      number: h.number || '',
      title: h.title || '',
      agency: h.agencyName || h.agencyCode || h.agency || '',
      oppStatus: status === 'forecasted' ? 'Forecasted' : 'Posted',
      openDate: parseDate(h.openDate),
      deadline,
      daysLeft,
      ceiling: details ? details.ceiling : null,
      floor: details ? details.floor : null,
      summary: details ? details.summary : '',
      eligibilityText: details ? details.eligibilityText : '',
      details: details || null,
      detailsFetched: !!details,
      match,
      score,
      matchedOn: [...rec.keywords].concat(rec.viaCategory ? ['focus area'] : []),
      link: grantLink(id),
      applyUrl: grantLink(id),
      programUrl: details ? details.programUrl : '',
      programUrlLabel: details ? details.programUrlLabel : '',
      extraLinks: details ? details.extraLinks : [],
      documentCount: details ? details.documentCount : 0,
      contactName: details ? details.contactName : '',
      contactEmail: details ? details.contactEmail : '',
      contactPhone: details ? details.contactPhone : '',
      myStatus: old ? old.myStatus : 'New',
      notes: old ? old.notes : '',
      firstSeen: old ? old.firstSeen : today,
      lastSeen: today
    };
    if (!old) newIds.push(id);
  }

  // Keep previously found grants that didn't come back today but are still valid,
  // and anything you're actively working on.
  for (const [id, old] of Object.entries(prev)) {
    if (next[id]) continue;
    const daysLeft = old.deadline ? daysBetween(today, old.deadline) : null;
    const working = ACTIVE_STATUSES.includes(old.myStatus);
    if (old.deadline && daysLeft < 0) {
      if (working && daysLeft >= -60) next[id] = { ...old, daysLeft, oppStatus: 'Deadline passed' };
      continue;
    }
    if (!old.deadline && daysBetween(old.lastSeen, today) > 14 && !working) continue;
    next[id] = { ...old, daysLeft };
  }

  org.grants = next;
  org.lastRun = new Date().toISOString();
  const summary = { at: org.lastRun, queries: queries.length, results, kept: Object.keys(next).length, newIds, errors };
  org.runs = [summary, ...(org.runs || [])].slice(0, 30);
  return summary;
}

// Which grants belong on the calendar
function calendarGrants(org, today = todayIso()) {
  const out = [];
  for (const g of Object.values(org.grants || {})) {
    if (!g.deadline || g.myStatus === 'Not a fit') continue;
    if (daysBetween(today, g.deadline) < -7) continue;
    const onCal = g.match === 'Strong' || ACTIVE_STATUSES.includes(g.myStatus) || org.profile.calendarAll;
    if (onCal) out.push(g);
  }
  for (const m of org.manual || []) {
    if (m.deadline && daysBetween(today, m.deadline) >= -7) out.push({ ...m, manual: true });
  }
  return out.sort((a, b) => a.deadline.localeCompare(b.deadline));
}

function sortedGrants(org) {
  return Object.values(org.grants || {}).sort((a, b) => {
    if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    return b.score - a.score;
  });
}

module.exports = {
  runScan, buildQueries, searchKeywords, eligibilityCodes, parseDate, daysBetween, todayIso,
  calendarGrants, sortedGrants, fetchDetails, stripHtml, safeUrl, safeEmail, TZ
};
