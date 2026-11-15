// Grants for Me — questionnaire + daily grant scan + calendar feed for any calendar app.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { Store } = require('./store');
const grants = require('./grants');
const { buildCalendar } = require('./ics');
const { sendDigest } = require('./digest');
const cfg = require('./config');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SCAN_CRON = process.env.SCAN_CRON || '0 6 * * *'; // 6:00 every day
const TZ = grants.TZ;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';

const store = new Store(DATA_DIR);
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- helpers ----------
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const arr = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(Boolean);
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.min(hi, Math.max(lo, n)); };

function cleanProfile(p = {}) {
  const orgTypes = arr(p.orgTypes).filter(k => cfg.ORG_TYPES.some(o => o.key === k));
  const focusAreas = arr(p.focusAreas).filter(c => cfg.FOCUS_AREAS.some(f => f.code === c));
  const populations = arr(p.populations).filter(k => cfg.POPULATIONS.some(x => x.key === k));
  const keywords = arr(p.keywords).map(k => k.slice(0, 60)).slice(0, 20);
  const reminders = arr(p.reminders).map(Number).filter(n => [1, 3, 7, 14, 21, 30].includes(n));
  return {
    orgName: String(p.orgName || '').slice(0, 120).trim(),
    orgTypes: orgTypes.length ? orgTypes : ['nonprofit501c3'],
    state: String(p.state || '').slice(0, 2).toUpperCase(),
    serviceArea: String(p.serviceArea || '').slice(0, 200),
    mission: String(p.mission || '').slice(0, 1000),
    annualBudget: String(p.annualBudget || ''),
    focusAreas,
    populations,
    keywords,
    minAward: clampInt(p.minAward, 0, 100000000, 0),
    horizonDays: clampInt(p.horizonDays, 14, 730, 365),
    minDaysLeft: clampInt(p.minDaysLeft, 0, 60, 7),
    includeForecasted: p.includeForecasted !== false,
    includeRolling: !!p.includeRolling,
    calendarAll: !!p.calendarAll,
    reminders: reminders.length ? [...new Set(reminders)].sort((a, b) => b - a) : [14, 7, 1],
    email: String(p.email || '').slice(0, 200).trim(),
    digestMode: ['daily', 'new_only', 'off'].includes(p.digestMode) ? p.digestMode : 'daily'
  };
}

function publicGrant(g, today) {
  const { details, detailsFetched, ...rest } = g;
  return { ...rest, daysLeft: g.deadline ? grants.daysBetween(today, g.deadline) : null };
}

function orgView(org, req) {
  const today = grants.todayIso();
  const base = baseUrl(req);
  const feedHttps = `${base}/cal/${org.token}.ics`;
  return {
    token: org.token,
    profile: org.profile,
    lastRun: org.lastRun,
    lastSummary: org.runs && org.runs[0] ? { ...org.runs[0], newCount: org.runs[0].newIds.length, newIds: org.runs[0].newIds } : null,
    grants: grants.sortedGrants(org).map(g => publicGrant(g, today)),
    manual: (org.manual || []).map(m => ({ ...m, daysLeft: m.deadline ? grants.daysBetween(today, m.deadline) : null })),
    onCalendar: grants.calendarGrants(org, today).length,
    links: {
      dashboard: `${base}/?org=${org.token}`,
      feed: feedHttps,
      webcal: feedHttps.replace(/^https?:/, 'webcal:'),
      download: `${feedHttps}?download=1`
    },
    emailEnabled: !!process.env.SMTP_URL,
    today
  };
}

const running = new Set();
async function scanOrg(org, { email = false, reason = 'manual', appBase = process.env.PUBLIC_URL } = {}) {
  if (running.has(org.token)) return null;
  running.add(org.token);
  try {
    const summary = await grants.runScan(org, { log: m => log(`[${org.profile.orgName || org.token.slice(0, 6)}] ${m}`) });
    org.updatedAt = new Date().toISOString();
    await store.save();
    log(`scan (${reason}) ${org.profile.orgName}: kept ${summary.kept}, new ${summary.newIds.length}, errors ${summary.errors.length}`);
    if (email) {
      try {
        const r = await sendDigest(org, summary, appBase ? `${appBase.replace(/\/$/, '')}/?org=${org.token}` : '');
        log(`digest ${org.profile.orgName}: ${r.sent ? 'sent' : 'skipped (' + r.reason + ')'}`);
      } catch (e) { log(`digest failed: ${e.message}`); }
    }
    return summary;
  } finally {
    running.delete(org.token);
  }
}

// ---------- optional password gate (dashboard + API only; calendar feeds stay open for calendar apps) ----------
function gate(req, res, next) {
  if (!APP_PASSWORD) return next();
  const hdr = req.headers.authorization || '';
  const [, b64] = hdr.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const ok = pass.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(APP_PASSWORD));
  if (ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="Grants for Me"').status(401).send('Password required');
}

// ---------- calendar feeds (secret-token URLs) ----------
app.get('/cal/:token.ics', (req, res) => {
  const org = store.getOrg(req.params.token);
  if (!org) return res.status(404).send('Not found');
  const body = buildCalendar(grants.calendarGrants(org), {
    name: `Grant Deadlines${org.profile.orgName ? ' – ' + org.profile.orgName : ''}`,
    reminders: org.profile.reminders,
    host: req.get('host') || 'grants-for-me'
  });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  if (req.query.download) res.set('Content-Disposition', 'attachment; filename="grant-deadlines.ics"');
  res.send(body);
});

app.get('/cal/:token/:id.ics', (req, res) => {
  const org = store.getOrg(req.params.token);
  if (!org) return res.status(404).send('Not found');
  let g = org.grants[req.params.id];
  if (!g) { const m = (org.manual || []).find(x => x.id === req.params.id); if (m) g = { ...m, manual: true }; }
  if (!g || !g.deadline) return res.status(404).send('No deadline for this grant');
  const body = buildCalendar([g], { name: 'Grant deadline', reminders: org.profile.reminders, host: req.get('host') || 'grants-for-me' });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="grant-${req.params.id}.ics"`);
  res.send(body);
});

app.get('/healthz', (req, res) => res.json({ ok: true, orgs: store.listOrgs().length }));

// ---------- dashboard + API ----------
app.use(gate);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/options', (req, res) => res.json({
  orgTypes: cfg.ORG_TYPES.map(({ key, label }) => ({ key, label })),
  focusAreas: cfg.FOCUS_AREAS,
  populations: cfg.POPULATIONS.map(({ key, label }) => ({ key, label })),
  statusOptions: cfg.STATUS_OPTIONS,
  emailEnabled: !!process.env.SMTP_URL,
  allowSignup: ALLOW_SIGNUP
}));

app.post('/api/orgs', async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'New sign-ups are disabled on this server.' });
  const org = store.createOrg(cleanProfile(req.body));
  await store.save();
  await scanOrg(org, { reason: 'signup' });
  res.json(orgView(org, req));
});

function withOrg(fn) {
  return async (req, res) => {
    const org = store.getOrg(req.params.token);
    if (!org) return res.status(404).json({ error: 'Organization not found. Check your dashboard link.' });
    try { await fn(org, req, res); } catch (e) { log(e); res.status(500).json({ error: e.message }); }
  };
}

app.get('/api/orgs/:token', withOrg((org, req, res) => res.json(orgView(org, req))));

app.put('/api/orgs/:token', withOrg(async (org, req, res) => {
  org.profile = cleanProfile(req.body);
  await store.save();
  await scanOrg(org, { reason: 'profile update' });
  res.json(orgView(org, req));
}));

app.post('/api/orgs/:token/scan', withOrg(async (org, req, res) => {
  await scanOrg(org, { reason: 'manual', email: !!req.body.email, appBase: baseUrl(req) });
  res.json(orgView(org, req));
}));

app.patch('/api/orgs/:token/grants/:id', withOrg(async (org, req, res) => {
  const g = org.grants[req.params.id];
  if (!g) return res.status(404).json({ error: 'Grant not found' });
  if (req.body.myStatus !== undefined) {
    if (!cfg.STATUS_OPTIONS.includes(req.body.myStatus)) return res.status(400).json({ error: 'Bad status' });
    g.myStatus = req.body.myStatus;
  }
  if (req.body.notes !== undefined) g.notes = String(req.body.notes).slice(0, 2000);
  await store.save();
  res.json(orgView(org, req));
}));

app.post('/api/orgs/:token/manual', withOrg(async (org, req, res) => {
  const b = req.body || {};
  const deadline = grants.parseDate(b.deadline);
  if (!b.title || !deadline) return res.status(400).json({ error: 'Title and a valid deadline are required' });
  org.manual = org.manual || [];
  org.manual.push({
    id: 'm' + crypto.randomBytes(5).toString('hex'),
    title: String(b.title).slice(0, 200), funder: String(b.funder || '').slice(0, 120),
    deadline, amount: String(b.amount || '').slice(0, 40), link: grants.safeUrl(b.link), website: grants.safeUrl(b.website),
    contactEmail: grants.safeEmail(b.contactEmail),
    notes: String(b.notes || '').slice(0, 1000), oppStatus: 'Manual', myStatus: 'Applying'
  });
  await store.save();
  res.json(orgView(org, req));
}));

app.delete('/api/orgs/:token/manual/:id', withOrg(async (org, req, res) => {
  org.manual = (org.manual || []).filter(m => m.id !== req.params.id);
  await store.save();
  res.json(orgView(org, req));
}));

app.delete('/api/orgs/:token', withOrg(async (org, req, res) => {
  store.deleteOrg(org.token);
  await store.save();
  res.json({ deleted: true });
}));

// ---------- daily job ----------
async function dailyJob() {
  log(`daily scan starting for ${store.listOrgs().length} org(s)`);
  for (const org of store.listOrgs()) {
    try { await scanOrg(org, { email: true, reason: 'daily' }); } catch (e) { log(`daily scan failed for ${org.token}: ${e.message}`); }
  }
}

if (require.main === module) {
  cron.schedule(SCAN_CRON, dailyJob, { timezone: TZ });
  app.listen(PORT, () => log(`Grants for Me on :${PORT} · daily scan "${SCAN_CRON}" (${TZ}) · data in ${DATA_DIR}`));
  if (process.argv.includes('--scan-now')) dailyJob();
}

module.exports = { app, store, dailyJob, cleanProfile };
