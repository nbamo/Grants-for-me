// Non-federal grant discovery: state & county government, community/private foundations,
// bank foundations and corporate giving.
//
//  1. Watched pages: official pages the org follows (starter list + anything added in the dashboard).
//  2. Web search (optional, BRAVE_API_KEY): daily searches built from the questionnaire.
//  Every page is read by Claude (ANTHROPIC_API_KEY), which pulls out open grant opportunities.
//  Results are checked against the page itself: the deadline text must appear on the page and the
//  apply link must be a real link from that page, so nothing is invented.
const crypto = require('crypto');
const { parseDate, daysBetween, todayIso, safeUrl, safeEmail, searchKeywords } = require('./grants');
const { STATE_NAMES } = require('./states');
const { ORG_TYPES, FOCUS_AREAS } = require('./config');

const ANTHROPIC_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const BRAVE_URL = process.env.BRAVE_URL || 'https://api.search.brave.com/res/v1/web/search';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_PAGES = Number(process.env.MAX_PAGES_PER_RUN || 20);
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES_PER_RUN || 6);
const PAGE_CHAR_LIMIT = 24000;

// Resale / aggregator sites: details are paywalled or copied from the funder. We go to the source instead.
const SKIP_DOMAINS = ['grantwatch.com', 'instrumentl.com', 'grantexec.com', 'grantedai.com', 'zeffy.com', 'grantforward.com',
  'grantable.co', 'keela.co', 'theshareway.com', 'fundsforngos.org', 'fundinglandscape.com', 'insidephilanthropy.com',
  'apify.com', 'facebook.com', 'linkedin.com', 'x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'reddit.com',
  'grants.gov', 'sam.gov'];

const SOURCE_TYPES = [
  { key: 'federal', label: 'Federal (Grants.gov)' },
  { key: 'state', label: 'State government' },
  { key: 'local', label: 'County & city government' },
  { key: 'foundation', label: 'Community & private foundations' },
  { key: 'bank', label: 'Bank foundations' },
  { key: 'corporate', label: 'Corporate giving' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const capabilities = () => ({ ai: !!process.env.ANTHROPIC_API_KEY, search: !!process.env.BRAVE_API_KEY });

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function skipDomain(u) { const h = hostOf(u); return !h || SKIP_DOMAINS.some(d => h === d || h.endsWith('.' + d)); }

// ---------- page fetching ----------
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&ndash;|&mdash;/g, '-').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"');
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h[1-6]|tr|div|section|article|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractLinks(html, base) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    let url;
    try { url = new URL(decodeEntities(m[1].trim()), base).toString(); } catch { continue; }
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 100);
    out.push({ url, text });
  }
  return out;
}

async function fetchPage(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrantsForMe/1.0; grant deadline tracker)', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow', signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers && res.headers.get && res.headers.get('content-type')) || 'text/html';
  if (!/html|text\/plain/i.test(type)) throw new Error(`not a web page (${type.split(';')[0]})`);
  const html = (await res.text()).slice(0, 2_000_000);
  const finalUrl = res.url || url;
  const text = htmlToText(html);
  return { url: finalUrl, text, links: extractLinks(html, finalUrl), hash: hash(text) };
}

// ---------- web search ----------
function orgTypeWords(profile) {
  const t = profile.orgTypes || [];
  if (t.some(k => k.startsWith('nonprofit'))) return 'nonprofit';
  if (t.includes('smallBusiness')) return 'small business';
  return 'organization';
}

function buildSearches(profile, year = new Date().getFullYear()) {
  const st = STATE_NAMES[profile.state] || profile.state || '';
  const who = orgTypeWords(profile);
  const kws = searchKeywords(profile).slice(0, 3);
  const area = (profile.serviceArea || '').split(/,| and /i).map(s => s.trim()).filter(Boolean)[0] || '';
  const want = profile.sourceTypes || {};
  const q = [];
  if (want.state !== false && st) for (const k of kws.slice(0, 2)) q.push({ type: 'state', q: `${st} state grant program ${k} ${who} application deadline ${year}` });
  if (want.local !== false && area) q.push({ type: 'local', q: `${area} ${st} county grants ${who} application ${year}` });
  if (want.foundation !== false && (area || st)) q.push({ type: 'foundation', q: `${area || st} community foundation grant ${kws[0] || who} deadline ${year}` });
  if (want.bank !== false && st) q.push({ type: 'bank', q: `bank foundation grants ${who} ${st} apply ${year}` });
  if (want.corporate !== false) q.push({ type: 'corporate', q: `corporate foundation grant ${kws[0] || who} ${who} ${st} open application ${year}` });
  return q.slice(0, MAX_SEARCHES);
}

async function braveSearch(query, fetchImpl = fetch) {
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=8&country=us&search_lang=en&freshness=py`;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const json = await res.json();
  return ((json.web && json.web.results) || []).map(r => ({ url: r.url, title: r.title || '' }));
}

// ---------- AI extraction ----------
function profileSummary(profile) {
  const types = (profile.orgTypes || []).map(k => (ORG_TYPES.find(o => o.key === k) || {}).label).filter(Boolean).join(', ');
  const focus = (profile.focusAreas || []).map(c => (FOCUS_AREAS.find(f => f.code === c) || {}).label).filter(Boolean).join(', ');
  return [
    `Organization: ${profile.orgName || '(unnamed)'}`,
    `Type: ${types}`,
    `Location: ${profile.serviceArea || ''} ${STATE_NAMES[profile.state] || profile.state || ''}`.trim(),
    profile.annualBudget ? `Annual budget: ${profile.annualBudget}` : '',
    profile.mission ? `Mission: ${profile.mission}` : '',
    focus ? `Focus areas: ${focus}` : '',
    `Keywords: ${searchKeywords(profile).join(', ')}`
  ].filter(Boolean).join('\n');
}

const SYSTEM_PROMPT = `You extract grant funding opportunities from a single web page for a grant-tracking app.
Return ONLY JSON: {"opportunities":[{"title":"","funder":"","funderType":"state|local|foundation|bank|corporate|federal|other","deadline":"YYYY-MM-DD or null","deadlineQuote":"","rolling":false,"opensDate":"YYYY-MM-DD or null","amount":"","amountMax":0,"applyUrl":"","summary":"","eligibility":"","contactEmail":"","fitsOrg":"yes|no|unclear","relevance":0}]}
Rules:
- Include only grant/funding opportunities that are open now or will open, described on THIS page. Skip news, past award lists, closed cycles, loans, and contracts/RFPs for vendors.
- Never guess. deadline must come from the page; copy the exact deadline wording into deadlineQuote (verbatim, under 80 characters). If no deadline is stated, use null and set rolling=true only if the page says rolling/ongoing/accepted year-round.
- applyUrl must be copied exactly from the LINKS list (the application/apply/details link for that opportunity), or empty.
- fitsOrg: "no" if the organization clearly cannot apply (wrong applicant type, wrong state/region); "unclear" if unsure.
- relevance 0-3: how well the opportunity matches the organization's work (0 = unrelated).
- amountMax: largest dollar amount as a number if stated, else 0.
- At most 15 opportunities. If none, return {"opportunities":[]}.`;

async function aiExtract(page, profile, today, fetchImpl = fetch) {
  const links = page.links.slice(0, 250).map(l => `${l.text || '(link)'} -> ${l.url}`).join('\n');
  const user = `TODAY: ${today}\n\nORGANIZATION PROFILE\n${profileSummary(profile)}\n\nPAGE URL: ${page.url}\n\nPAGE TEXT\n${page.text.slice(0, PAGE_CHAR_LIMIT)}\n\nLINKS\n${links}`;
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  const json = await res.json();
  const text = (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try { return (JSON.parse(m[0]).opportunities || []).slice(0, 15); } catch { return []; }
}

// ---------- verification + normalization ----------
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function verify(op, page, sourceType, profile, today) {
  const title = String(op.title || '').trim().slice(0, 200);
  if (!title || op.fitsOrg === 'no' || Number(op.relevance) === 0) return null;

  // Deadline must be backed by text on the page
  let deadline = parseDate(op.deadline);
  const quote = norm(op.deadlineQuote);
  if (deadline && (!quote || !norm(page.text).includes(quote))) deadline = null;
  const rolling = !deadline && !!op.rolling;
  if (!deadline && !rolling) return null;
  if (deadline) {
    const d = daysBetween(today, deadline);
    if (d < Number(profile.minDaysLeft ?? 3) || d > Number(profile.horizonDays ?? 365)) return null;
  }

  // Apply link must be a real link on the page (or the page itself)
  const linkSet = new Set(page.links.map(l => l.url));
  let applyUrl = safeUrl(op.applyUrl);
  if (!applyUrl || (!linkSet.has(applyUrl) && applyUrl !== page.url)) applyUrl = page.url;

  const amountMax = Number(op.amountMax) > 0 ? Number(op.amountMax) : null;
  if (profile.minAward && amountMax && amountMax < profile.minAward) return null;

  const allowed = ['state', 'local', 'foundation', 'bank', 'corporate', 'federal', 'other'];
  const type = allowed.includes(op.funderType) ? op.funderType : sourceType;
  if (type === 'federal') return null; // Grants.gov already covers federal

  const funder = String(op.funder || hostOf(page.url)).trim().slice(0, 120);
  const id = 'w' + hash(norm(funder) + '|' + norm(title));
  const kws = searchKeywords(profile);
  const hay = norm(title + ' ' + op.summary);
  const matchedOn = kws.filter(k => hay.includes(k.toLowerCase()));
  const relevance = Math.max(0, Math.min(3, Number(op.relevance) || 1));

  return {
    id, origin: 'web', sourceType: type, title, number: '',
    agency: funder, funder,
    oppStatus: rolling ? 'Rolling' : 'Open',
    openDate: parseDate(op.opensDate),
    deadline: deadline || null,
    ceiling: amountMax, amountText: String(op.amount || '').slice(0, 80),
    summary: String(op.summary || '').slice(0, 600),
    eligibilityText: String(op.eligibility || '').slice(0, 400),
    link: applyUrl, applyUrl, sourceUrl: page.url,
    contactEmail: safeEmail(op.contactEmail),
    match: relevance >= 2 || matchedOn.length ? 'Strong' : 'Broader',
    score: relevance * 2 + matchedOn.length * 2,
    matchedOn: matchedOn.length ? matchedOn : [type === 'local' ? 'county/city' : type],
    fitNote: op.fitsOrg === 'unclear' ? 'Check eligibility' : ''
  };
}

// ---------- run ----------
async function runOtherSources(org, { fetchImpl = fetch, today = todayIso(), log = () => {} } = {}) {
  const caps = capabilities();
  const profile = org.profile;
  const want = profile.sourceTypes || {};
  const summary = { pages: 0, aiCalls: 0, found: 0, newIds: [], errors: [], skipped: '' };
  if (!caps.ai) { summary.skipped = 'ANTHROPIC_API_KEY not set — only Grants.gov was searched'; return summary; }

  // Pages to read: watched sources first, then web search results
  const queue = [];
  const seen = new Set();
  for (const s of org.sources || []) {
    if (s.enabled === false || want[s.type] === false) continue;
    if (!seen.has(s.url)) { seen.add(s.url); queue.push({ url: s.url, type: s.type, sourceId: s.id }); }
  }
  if (caps.search) {
    for (const s of buildSearches(profile)) {
      try {
        const results = await braveSearch(s.q, fetchImpl);
        for (const r of results) {
          if (skipDomain(r.url) || seen.has(r.url)) continue;
          seen.add(r.url);
          queue.push({ url: r.url, type: s.type, fromSearch: s.q });
        }
        log(`search "${s.q}": ${results.length} results`);
      } catch (e) { summary.errors.push(`search: ${e.message}`); }
      await sleep(1100); // stay under 1 request/second
    }
  }

  org.pageCache = org.pageCache || {};
  const prev = org.grants || {};
  const found = {};

  for (const item of queue.slice(0, MAX_PAGES)) {
    const src = item.sourceId ? (org.sources || []).find(s => s.id === item.sourceId) : null;
    try {
      const page = await fetchPage(item.url, fetchImpl);
      summary.pages++;
      const cached = org.pageCache[item.url];
      let ops;
      if (cached && cached.hash === page.hash && cached.profileHash === hash(profileSummary(profile))) {
        ops = cached.ops; // page unchanged → reuse, no AI cost
      } else {
        ops = await aiExtract(page, profile, today, fetchImpl);
        summary.aiCalls++;
        org.pageCache[item.url] = { hash: page.hash, profileHash: hash(profileSummary(profile)), ops, at: new Date().toISOString() };
      }
      let n = 0;
      for (const op of ops) {
        const g = verify(op, page, item.type, profile, today);
        if (!g || found[g.id]) continue;
        found[g.id] = g; n++;
      }
      if (src) Object.assign(src, { lastChecked: new Date().toISOString(), lastStatus: 'ok', lastFound: n });
      log(`page ${hostOf(item.url)}: ${n} opportunities`);
    } catch (e) {
      if (src) Object.assign(src, { lastChecked: new Date().toISOString(), lastStatus: e.message });
      summary.errors.push(`${hostOf(item.url)}: ${e.message}`);
    }
    await sleep(400);
  }

  // Merge into org.grants, keeping the user's status and notes
  for (const g of Object.values(found)) {
    const old = prev[g.id];
    org.grants[g.id] = {
      ...g,
      daysLeft: g.deadline ? daysBetween(today, g.deadline) : null,
      myStatus: old ? old.myStatus : 'New',
      notes: old ? old.notes : '',
      firstSeen: old ? old.firstSeen : today,
      lastSeen: today
    };
    if (!old) summary.newIds.push(g.id);
  }
  // Trim cache of pages no longer read
  const keep = new Set(queue.map(q => q.url));
  for (const u of Object.keys(org.pageCache)) if (!keep.has(u)) delete org.pageCache[u];

  summary.found = Object.keys(found).length;
  return summary;
}

module.exports = { runOtherSources, buildSearches, fetchPage, htmlToText, extractLinks, verify, capabilities, SOURCE_TYPES, skipDomain };
