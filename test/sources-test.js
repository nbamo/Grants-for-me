// Offline tests for state / county / foundation / bank / corporate discovery (mocked web, search and AI).
const assert = require('assert');
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.BRAVE_API_KEY = 'test-key';
const { runOtherSources, buildSearches, htmlToText, extractLinks, skipDomain } = require('../src/sources');
const { calendarGrants } = require('../src/grants');
const { starterSourcesFor } = require('../src/states');

const TODAY = '2026-11-14';
const PAGE_HTML = `<html><head><title>x</title><script>var a=1</script></head><body>
<nav>menu</nav>
<h1>Montco Community Foundation – Open Grants</h1>
<p>Aging in Place Fund: grants up to $25,000 for nonprofits serving older adults in Montgomery County, PA.</p>
<p>Applications due January 30, 2027 at 5pm.</p>
<a href="/apply/aging-fund">Apply for the Aging in Place Fund</a>
<p>Youth Arts Mini-Grants — applications accepted on a rolling basis.</p>
<a href="https://montcofoundation.example.org/youth-arts">Youth arts details</a>
<p>2025 Grant Recipients announced!</p>
</body></html>`;

const AI_REPLY = {
  opportunities: [
    { title: 'Aging in Place Fund', funder: 'Montco Community Foundation', funderType: 'foundation', deadline: '2027-01-30',
      deadlineQuote: 'Applications due January 30, 2027', rolling: false, amount: 'Up to $25,000', amountMax: 25000,
      applyUrl: 'https://montcofoundation.example.org/apply/aging-fund', summary: 'Grants for nonprofits serving older adults.',
      fitsOrg: 'yes', relevance: 3, contactEmail: 'grants@montcofoundation.example.org' },
    { title: 'Youth Arts Mini-Grants', funder: 'Montco Community Foundation', funderType: 'foundation', deadline: null,
      deadlineQuote: '', rolling: true, amountMax: 2000, applyUrl: 'https://montcofoundation.example.org/youth-arts',
      summary: 'Arts for youth.', fitsOrg: 'unclear', relevance: 1 },
    // invented deadline (quote not on page) → must be rejected
    { title: 'Phantom Grant', funder: 'Montco Community Foundation', funderType: 'foundation', deadline: '2027-03-01',
      deadlineQuote: 'Due March 1, 2027', rolling: false, applyUrl: 'https://evil.example.com/x', fitsOrg: 'yes', relevance: 3 },
    // wrong applicant → rejected
    { title: 'Scholarships for Students', funder: 'Montco Community Foundation', funderType: 'foundation', deadline: '2027-02-01',
      deadlineQuote: 'Applications due January 30, 2027', fitsOrg: 'no', relevance: 2 },
    // hallucinated apply link → falls back to page URL
    { title: 'Caregiver Respite Grants', funder: 'Montco Community Foundation', funderType: 'foundation', deadline: '2027-01-30',
      deadlineQuote: 'applications due january 30, 2027', applyUrl: 'https://not-on-page.example.com/apply', fitsOrg: 'yes', relevance: 2 }
  ]
};

let aiCalls = 0, searches = 0;
async function fakeFetch(url, opts = {}) {
  const ok = (body, type = 'application/json', finalUrl = url) => ({
    ok: true, status: 200, url: finalUrl,
    headers: { get: () => type },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  });
  if (url.startsWith('https://api.search.brave.com')) {
    searches++;
    return ok({ web: { results: [
      { url: 'https://montcofoundation.example.org/grants', title: 'Open Grants' },
      { url: 'https://www.grantwatch.com/some-listing', title: 'aggregator (skip)' }
    ] } });
  }
  if (url.startsWith('https://api.anthropic.com')) {
    aiCalls++;
    const body = JSON.parse(opts.body);
    assert.ok(body.messages[0].content.includes('Applications due January 30, 2027'), 'page text sent to AI');
    assert.ok(body.messages[0].content.includes('https://montcofoundation.example.org/apply/aging-fund'), 'links sent to AI');
    return ok({ content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify(AI_REPLY) }] });
  }
  if (url === 'https://montcofoundation.example.org/grants') return ok(PAGE_HTML, 'text/html; charset=utf-8');
  if (url === 'https://www.td.com/us/en/about-us/funding-opportunities') return { ok: false, status: 403, headers: { get: () => 'text/html' } };
  throw new Error('unexpected fetch ' + url);
}

(async () => {
  // html helpers
  const text = htmlToText(PAGE_HTML);
  assert.ok(!text.includes('var a=1') && !text.includes('menu') && text.includes('Aging in Place Fund'));
  const links = extractLinks(PAGE_HTML, 'https://montcofoundation.example.org/grants');
  assert.strictEqual(links[0].url, 'https://montcofoundation.example.org/apply/aging-fund');
  assert.ok(skipDomain('https://pennsylvania.grantwatch.com/x') && !skipDomain('https://www.pa.gov/en/grants.html'));

  // starter sources
  const pa = starterSourcesFor('PA', {});
  assert.ok(pa.some(s => s.url.includes('pa.gov')) && pa.some(s => s.label.includes('TD')));
  assert.ok(!starterSourcesFor('CA', {}).some(s => s.label.includes('TD')), 'TD not in CA');
  assert.ok(!starterSourcesFor('PA', { bank: false }).some(s => s.type === 'bank'));

  const profile = { orgName: 'Test Care', orgTypes: ['nonprofit501c3'], state: 'PA', serviceArea: 'Montgomery County, Chester County',
    keywords: ['older adults', 'caregiver'], populations: [], focusAreas: ['HL'], minDaysLeft: 7, horizonDays: 365, minAward: 0,
    sourceTypes: { federal: true, state: true, local: true, foundation: true, bank: true, corporate: true } };

  // search queries
  const qs = buildSearches(profile, 2026);
  assert.ok(qs.length >= 4 && qs.length <= 6, 'queries: ' + qs.length);
  assert.ok(qs.some(q => q.type === 'local' && q.q.includes('Montgomery County')));
  assert.ok(qs.some(q => q.type === 'bank' && q.q.includes('Pennsylvania')));
  assert.strictEqual(buildSearches({ ...profile, sourceTypes: { ...profile.sourceTypes, bank: false, corporate: false } }).some(q => q.type === 'bank' || q.type === 'corporate'), false);

  // full run
  const org = { profile, grants: {}, sources: [{ id: 's1', url: 'https://www.td.com/us/en/about-us/funding-opportunities', label: 'TD', type: 'bank', enabled: true }] };
  const sum = await runOtherSources(org, { fetchImpl: fakeFetch, today: TODAY });
  const got = Object.values(org.grants);
  const titles = got.map(g => g.title).sort();
  assert.deepStrictEqual(titles, ['Aging in Place Fund', 'Caregiver Respite Grants', 'Youth Arts Mini-Grants'], 'titles: ' + titles);
  const aging = got.find(g => g.title === 'Aging in Place Fund');
  assert.strictEqual(aging.deadline, '2027-01-30');
  assert.strictEqual(aging.applyUrl, 'https://montcofoundation.example.org/apply/aging-fund');
  assert.strictEqual(aging.sourceUrl, 'https://montcofoundation.example.org/grants');
  assert.strictEqual(aging.sourceType, 'foundation');
  assert.strictEqual(aging.match, 'Strong');
  assert.strictEqual(aging.ceiling, 25000);
  assert.strictEqual(aging.contactEmail, 'grants@montcofoundation.example.org');
  const respite = got.find(g => g.title === 'Caregiver Respite Grants');
  assert.strictEqual(respite.applyUrl, 'https://montcofoundation.example.org/grants', 'made-up link replaced by the page');
  const youth = got.find(g => g.title === 'Youth Arts Mini-Grants');
  assert.strictEqual(youth.oppStatus, 'Rolling');
  assert.strictEqual(youth.deadline, null);
  assert.strictEqual(youth.fitNote, 'Check eligibility');
  assert.strictEqual(sum.newIds.length, 3);
  assert.strictEqual(sum.pages, 1);
  assert.strictEqual(aiCalls, 1);
  assert.ok(searches >= 4);
  assert.ok(org.sources[0].lastStatus.includes('403'), 'unreadable page reported on the source');

  // calendar: dated strong web grants included, rolling ones not
  const cal = calendarGrants(org, TODAY).map(g => g.title);
  assert.ok(cal.includes('Aging in Place Fund') && !cal.includes('Youth Arts Mini-Grants'));

  // second run: unchanged page → no new AI call, user status preserved
  aging.myStatus = 'Applying';
  const sum2 = await runOtherSources(org, { fetchImpl: fakeFetch, today: TODAY });
  assert.strictEqual(aiCalls, 1, 'unchanged page reuses cached extraction');
  assert.strictEqual(sum2.newIds.length, 0);
  assert.strictEqual(org.grants[aging.id].myStatus, 'Applying');

  // no AI key → skipped gracefully
  delete process.env.ANTHROPIC_API_KEY;
  const sum3 = await runOtherSources({ profile, grants: {}, sources: [] }, { fetchImpl: fakeFetch, today: TODAY });
  assert.ok(sum3.skipped.includes('ANTHROPIC_API_KEY'));

  console.log('Source tests passed ✔');
})().catch(e => { console.error('SOURCE TEST FAILED:', e); process.exit(1); });
