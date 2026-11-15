// Offline tests: mocks Grants.gov so the matching, filtering, calendar feed and API can be verified.
// Run: npm test
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
const grants = require('../src/grants');
const { buildCalendar } = require('../src/ics');
const { buildDigest } = require('../src/digest');

const TODAY = '2026-11-14';
const mmddyyyy = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const plus = n => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const DB = {
  '1001': { id: 1001, number: 'HHS-ACL-27-001', title: 'Family Caregiver Support Innovation Grants', agencyName: 'Administration for Community Living', openDate: mmddyyyy(plus(-10)), closeDate: mmddyyyy(plus(45)), oppStatus: 'posted', ceiling: 250000 },
  '1002': { id: 1002, number: 'HHS-ACL-27-002', title: 'Aging in Place Home Modification', agencyName: 'Administration for Community Living', openDate: mmddyyyy(plus(-2)), closeDate: mmddyyyy(plus(2)), oppStatus: 'posted', ceiling: 100000 }, // too soon
  '1003': { id: 1003, number: 'USDA-RD-27-1', title: 'Rural Community Facilities Grant', agencyName: 'USDA Rural Development', openDate: mmddyyyy(plus(-30)), closeDate: mmddyyyy(plus(400)), oppStatus: 'posted', ceiling: 500000 }, // beyond horizon
  '1004': { id: 1004, number: 'HRSA-27-050', title: 'Behavioral Health Workforce Expansion', agencyName: 'HRSA', openDate: '', closeDate: '', oppStatus: 'forecasted', ceiling: 750000, est: plus(120) }, // forecast w/ est date from details
  '1005': { id: 1005, number: 'NIH-27-999', title: 'Basic Research in Cell Signaling', agencyName: 'NIH', openDate: mmddyyyy(plus(-5)), closeDate: mmddyyyy(plus(60)), oppStatus: 'posted', ceiling: 2000000 }, // category-only
  '1006': { id: 1006, number: 'SBA-27-01', title: 'Small Grants for Caregiver Respite', agencyName: 'SBA', openDate: mmddyyyy(plus(-5)), closeDate: mmddyyyy(plus(30)), oppStatus: 'posted', ceiling: 5000 } // below min award
};

const calls = [];
async function fakeFetch(url, opts) {
  const body = JSON.parse(opts.body);
  calls.push({ url, body });
  const ok = data => ({ ok: true, status: 200, json: async () => ({ errorcode: 0, msg: 'ok', data }) });
  if (url.endsWith('search2')) {
    let ids = [];
    if (body.keyword === 'caregiver') ids = ['1001', '1002', '1006'];
    else if (body.keyword === 'aging') ids = ['1002', '1003'];
    else if (body.keyword === 'behavioral health') ids = ['1004'];
    else if (body.fundingCategories) ids = ['1001', '1005'];
    return ok({ hitCount: ids.length, oppHits: ids.map(i => { const { ceiling, est, ...h } = DB[i]; return { ...h, agencyCode: 'X', docType: 'synopsis', alnist: [] }; }) });
  }
  if (url.endsWith('fetchOpportunity')) {
    const g = DB[String(body.opportunityId)];
    if (g.oppStatus === 'forecasted') return ok({ forecast: { awardCeiling: String(g.ceiling), forecastDesc: '<p>Forecast &amp; details</p>', estApplicationResponseDate: mmddyyyy(g.est) } });
    return ok({
      synopsis: { awardCeiling: String(g.ceiling), awardFloor: '1000', synopsisDesc: '<p>Funding for <b>' + g.title + '</b></p>', applicantEligibilityDesc: 'Nonprofits',
        agencyContactName: 'Pat Officer', agencyContactEmail: 'pat.officer@acl.hhs.gov', agencyContactPhone: '202-555-0100',
        fundingDescLinkUrl: g.id === 1001 ? 'https://acl.gov/grants/caregiver-innovation' : '', fundingDescLinkDesc: g.id === 1001 ? 'ACL program page' : '' },
      synopsisDocumentURLs: g.id === 1005 ? [{ url: 'javascript:alert(1)', description: 'bad' }, { url: 'https://nih.gov/foa', description: 'Full NOFO' }] : [],
      synopsisAttachmentFolders: [{ folderName: 'Full Announcement', synopsisAttachments: [{ id: 1 }, { id: 2 }] }]
    });
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

(async () => {
  // --- unit: dates
  assert.strictEqual(grants.parseDate('03/07/2027'), '2027-03-07');
  assert.strictEqual(grants.parseDate('2027-03-07T00:00:00'), '2027-03-07');
  assert.strictEqual(grants.parseDate(''), null);
  assert.strictEqual(grants.daysBetween('2026-11-14', '2026-12-14'), 30);

  // --- queries
  const profile = { orgName: 'Test Care', orgTypes: ['nonprofit501c3', 'smallBusiness'], keywords: ['caregiver', 'aging'], populations: ['mentalHealth'],
    focusAreas: ['HL', 'ISS'], minAward: 10000, horizonDays: 365, minDaysLeft: 7, includeForecasted: true, reminders: [14, 7, 1], digestMode: 'daily', email: 'x@y.org' };
  const q = grants.buildQueries(profile);
  assert.deepStrictEqual(q.map(x => x.label), ['caregiver', 'aging', 'behavioral health', 'substance use', 'focus areas']);
  assert.strictEqual(q[0].body.eligibilities, '12|23|25|99');
  assert.strictEqual(q[0].body.oppStatuses, 'forecasted|posted');
  assert.strictEqual(q[4].body.fundingCategories, 'HL|ISS');

  // --- scan
  const org = { token: 't', profile, grants: {}, manual: [] };
  const s1 = await grants.runScan(org, { fetchImpl: fakeFetch, today: TODAY });
  const kept = Object.keys(org.grants).sort();
  assert.deepStrictEqual(kept, ['1001', '1004', '1005'], 'kept: ' + kept);
  assert.strictEqual(org.grants['1001'].match, 'Strong');
  assert.strictEqual(org.grants['1001'].deadline, plus(45));
  assert.strictEqual(org.grants['1001'].ceiling, 250000);
  assert.ok(org.grants['1001'].matchedOn.includes('caregiver') && org.grants['1001'].matchedOn.includes('focus area'));
  // application links
  const g1 = org.grants['1001'];
  assert.strictEqual(g1.applyUrl, 'https://www.grants.gov/search-results-detail/1001');
  assert.strictEqual(g1.programUrl, 'https://acl.gov/grants/caregiver-innovation');
  assert.strictEqual(g1.programUrlLabel, 'ACL program page');
  assert.strictEqual(g1.contactEmail, 'pat.officer@acl.hhs.gov');
  assert.strictEqual(g1.contactName, 'Pat Officer');
  assert.strictEqual(g1.documentCount, 2);
  assert.strictEqual(org.grants['1005'].programUrl, 'https://nih.gov/foa', 'unsafe javascript: link rejected, next valid link used');
  assert.strictEqual(org.grants['1004'].oppStatus, 'Forecasted');
  assert.strictEqual(org.grants['1004'].deadline, plus(120), 'forecast date taken from details');
  assert.strictEqual(org.grants['1004'].summary, 'Forecast & details');
  assert.strictEqual(org.grants['1005'].match, 'Broader');
  assert.deepStrictEqual(s1.newIds.sort(), ['1001', '1004', '1005']);
  assert.strictEqual(s1.errors.length, 0);

  // --- second run: no new, status preserved, no refetch of details
  org.grants['1001'].myStatus = 'Applying';
  org.grants['1005'].myStatus = 'Not a fit';
  const before = calls.filter(c => c.url.endsWith('fetchOpportunity')).length;
  const s2 = await grants.runScan(org, { fetchImpl: fakeFetch, today: TODAY });
  assert.strictEqual(s2.newIds.length, 0);
  assert.strictEqual(org.grants['1001'].myStatus, 'Applying');
  const after = calls.filter(c => c.url.endsWith('fetchOpportunity')).length;
  assert.strictEqual(after - before, 3, 'only grants filtered out last time (1002, 1003, 1006) get details refetched');

  // --- calendar selection: strong + working, not "Not a fit"; manual included
  org.manual = [{ id: 'mabc', title: 'PA Foundation Community Grant', funder: 'PA Foundation', deadline: plus(20), amount: '$25,000', link: '', notes: '' }];
  const cal = grants.calendarGrants(org, TODAY);
  assert.deepStrictEqual(cal.map(g => g.id), ['mabc', '1001', '1004']);

  // --- ICS validity
  const ics = buildCalendar(cal, { name: 'Grant Deadlines – Test, Care', reminders: [14, 7, 1], host: 'example.org' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, 9);
  assert.ok(ics.includes('DTSTART;VALUE=DATE:' + plus(45).replace(/-/g, '')));
  assert.ok(ics.includes('X-WR-CALNAME:Grant Deadlines – Test\\, Care'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'line too long: ' + line);
  assert.ok(!/[^\r]\n/.test(ics), 'bare LF found');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('Apply: https://www.grants.gov/search-results-detail/1001'));
  assert.ok(unfolded.includes('ACL program page: https://acl.gov/grants/caregiver-innovation'));
  assert.ok(unfolded.includes('Contact: Pat Officer · pat.officer@acl.hhs.gov'));

  // --- digest
  const d = buildDigest(org, s1, 'https://grants.example.org/?org=t');
  assert.ok(d.subject.includes('2 new grants') /* 1005 marked Not a fit */, d.subject);
  assert.ok(d.html.includes('Family Caregiver Support Innovation Grants'));
  assert.ok(d.html.includes('>Apply</a>') && d.html.includes('mailto:pat.officer@acl.hhs.gov'));

  // --- HTTP API end-to-end (with mocked Grants.gov)
  const realFetch = global.fetch;
  global.fetch = fakeFetch; // used by the server's scan
  const { app } = require('../src/server');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, p, body) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ct, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  let r = await http('GET', '/api/options');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.orgTypes.length > 5);
  r = await http('POST', '/api/orgs', { ...profile, minDaysLeft: 0, horizonDays: 730 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const view = r.body;
  assert.ok(view.token && view.links.feed.endsWith(`/cal/${view.token}.ics`));
  assert.ok(view.links.webcal.startsWith('webcal://'));
  assert.ok(view.grants.length >= 3, 'grants via API: ' + view.grants.length);
  r = await http('GET', `/cal/${view.token}.ics`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.ct.startsWith('text/calendar'));
  assert.ok(r.body.includes('BEGIN:VEVENT'));
  r = await http('PATCH', `/api/orgs/${view.token}/grants/1005`, { myStatus: 'Reviewing' });
  assert.strictEqual(r.body.grants.find(g => g.id === '1005').myStatus, 'Reviewing');
  r = await http('POST', `/api/orgs/${view.token}/manual`, { title: 'County Grant', deadline: plus(30), funder: 'County', link: 'https://county.gov/apply', website: 'county.gov', contactEmail: 'grants@county.gov' });
  assert.strictEqual(r.body.manual.length, 1);
  assert.strictEqual(r.body.manual[0].link, 'https://county.gov/apply');
  assert.strictEqual(r.body.manual[0].website, 'https://county.gov', 'bare domain gets https://');
  assert.strictEqual(r.body.manual[0].contactEmail, 'grants@county.gov');
  assert.ok(r.body.grants.find(g => g.id === '1001').applyUrl);
  r = await http('GET', `/cal/${view.token}/1001.ics`);
  assert.strictEqual(r.status, 200);
  r = await http('GET', '/cal/nope.ics');
  assert.strictEqual(r.status, 404);
  server.close();

  console.log('All tests passed ✔');
  console.log('\nSample calendar feed:\n' + ics.split('\r\n').slice(0, 30).join('\n'));
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
