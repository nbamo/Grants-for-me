// Daily email digest (optional — only runs when SMTP_URL is configured).
const { sortedGrants, daysBetween, todayIso } = require('./grants');

let transporter = null;
function getTransport() {
  if (!process.env.SMTP_URL) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport(process.env.SMTP_URL);
  }
  return transporter;
}

const h = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => (n ? '$' + Number(n).toLocaleString('en-US') : '');

function row(g, today) {
  const d = g.deadline ? daysBetween(today, g.deadline) : null;
  const when = g.deadline ? `${g.deadline} · <b style="color:${d <= 7 ? '#b42318' : d <= 30 ? '#b54708' : '#344054'}">${d} days left</b>` : '<i>No deadline posted yet</i>';
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #eaecf0">
    <a href="${h(g.link)}" style="color:#1d4ed8;font-weight:600;text-decoration:none">${h(g.title)}</a><br>
    <span style="color:#475467;font-size:13px">${h(g.agency || g.funder || '')}${g.ceiling ? ' · up to ' + money(g.ceiling) : ''}</span><br>
    <span style="font-size:13px">${when}</span><br>
    <span style="font-size:13px">${[
      g.applyUrl || g.link ? `<a href="${h(g.applyUrl || g.link)}" style="color:#1f5f4a;font-weight:600">${g.oppStatus === 'Forecasted' ? 'View listing' : 'Apply'}</a>` : '',
      g.programUrl ? `<a href="${h(g.programUrl)}" style="color:#1d4ed8">Agency site</a>` : '',
      g.website ? `<a href="${h(g.website)}" style="color:#1d4ed8">Funder website</a>` : '',
      g.contactEmail ? `<a href="mailto:${h(g.contactEmail)}" style="color:#1d4ed8">Email ${h(g.contactName || 'program officer')}</a>` : ''
    ].filter(Boolean).join(' &nbsp;·&nbsp; ')}</span></td></tr>`;
}

function buildDigest(org, summary, appUrl) {
  const today = todayIso();
  const all = sortedGrants(org).filter(g => g.myStatus !== 'Not a fit');
  const manual = (org.manual || []).filter(m => m.deadline && daysBetween(today, m.deadline) >= 0).map(m => ({ ...m, agency: m.funder }));
  const newOnes = all.filter(g => summary.newIds.includes(g.id));
  const closing = all.concat(manual).filter(g => g.deadline && daysBetween(today, g.deadline) >= 0 && daysBetween(today, g.deadline) <= 14)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  const strong = all.filter(g => g.match === 'Strong').length;

  const name = org.profile.orgName || 'your organization';
  const subjectBits = [];
  if (newOnes.length) subjectBits.push(`${newOnes.length} new grant${newOnes.length === 1 ? '' : 's'}`);
  if (closing.length) subjectBits.push(`${closing.length} closing within 14 days`);
  const subject = `Grants for Me for ${name}: ${subjectBits.join(' · ') || 'no changes today'}`;

  const section = (title, list) => list.length
    ? `<h3 style="margin:24px 0 4px;font-size:15px">${title}</h3><table width="100%" cellspacing="0" cellpadding="0">${list.map(g => row(g, today)).join('')}</table>` : '';

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;color:#101828">
    <h2 style="margin:0 0 4px">Grants for Me daily update</h2>
    <div style="color:#475467">${h(name)} · ${today} · ${strong} strong matches tracked</div>
    ${section('New since yesterday', newOnes.slice(0, 25))}
    ${section('Deadlines in the next 14 days', closing)}
    ${!newOnes.length && !closing.length ? '<p>No new matches and no deadlines in the next 14 days.</p>' : ''}
    ${appUrl ? `<p style="margin-top:24px"><a href="${h(appUrl)}" style="background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open your dashboard</a></p>` : ''}
    <p style="color:#98a2b3;font-size:12px;margin-top:24px">Federal opportunities from Grants.gov. This product uses the Grants.gov API but is not endorsed or certified by HHS. Always confirm eligibility and deadlines on the official listing.</p>
  </div>`;
  return { subject, html, hasNews: newOnes.length > 0 || closing.some(g => daysBetween(today, g.deadline) <= 7) };
}

async function sendDigest(org, summary, appUrl, { force = false } = {}) {
  const t = getTransport();
  const to = org.profile.email;
  if (!t || !to) return { sent: false, reason: !t ? 'SMTP not configured' : 'no email on profile' };
  const { subject, html, hasNews } = buildDigest(org, summary, appUrl);
  if (!force && org.profile.digestMode === 'new_only' && !hasNews) return { sent: false, reason: 'nothing new' };
  if (org.profile.digestMode === 'off' && !force) return { sent: false, reason: 'digest off' };
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_FROM || 'Grants for Me <no-reply@localhost>', to, subject, html });
  return { sent: true };
}

module.exports = { sendDigest, buildDigest };
