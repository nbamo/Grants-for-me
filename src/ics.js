// iCalendar (RFC 5545) feed builder — works with Google Calendar, Outlook / Microsoft 365,
// Apple Calendar, Proton, Yahoo, Thunderbird and anything else that can subscribe to a URL.

function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold lines at 75 octets (RFC 5545 §3.1)
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    let end = Math.min(start + (first ? 75 : 74), bytes.length);
    // don't split inside a multi-byte UTF-8 character
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push((first ? '' : ' ') + bytes.slice(start, end).toString('utf8'));
    start = end;
    first = false;
  }
  return parts.join('\r\n');
}

const ymd = iso => iso.replace(/-/g, '');
function nextDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const money = n => (n ? '$' + Number(n).toLocaleString('en-US') : '');

function eventLines(g, { reminders = [14, 7, 1], host = 'grants-for-me' } = {}) {
  const isManual = !!g.manual;
  const prefix = g.oppStatus === 'Forecasted' ? 'Grant deadline (forecast): ' : 'Grant deadline: ';
  const descParts = [
    g.title,
    isManual ? (g.funder ? 'Funder: ' + g.funder : '') : (g.agency ? 'Agency: ' + g.agency : ''),
    g.number ? 'Opportunity #: ' + g.number : '',
    g.ceiling ? 'Award ceiling: ' + money(g.ceiling) : (g.amount ? 'Amount: ' + g.amount : ''),
    g.myStatus ? 'Your status: ' + g.myStatus : '',
    g.applyUrl ? (g.oppStatus === 'Forecasted' ? 'Listing (apply when it opens): ' : 'Apply: ') + g.applyUrl : (g.link ? (isManual ? 'Apply: ' : 'Details: ') + g.link : ''),
    g.programUrl ? (g.programUrlLabel || 'Agency site') + ': ' + g.programUrl : '',
    g.website ? 'Funder website: ' + g.website : '',
    g.contactEmail || g.contactName ? 'Contact: ' + [g.contactName, g.contactEmail, g.contactPhone].filter(Boolean).join(' · ') : '',
    g.notes ? 'Notes: ' + g.notes : ''
  ].filter(Boolean);
  descParts.push('', 'Tracked by Grants for Me. Always confirm the deadline and time zone on the official listing.');

  const lines = [
    'BEGIN:VEVENT',
    `UID:${isManual ? 'manual-' : 'grant-'}${g.id}@${host}`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${ymd(g.deadline)}`,
    `DTEND;VALUE=DATE:${ymd(nextDay(g.deadline))}`,
    `SUMMARY:${esc(prefix + g.title)}`,
    `DESCRIPTION:${esc(descParts.join('\n'))}`,
    g.link ? `URL:${g.link}` : null,
    'TRANSP:TRANSPARENT',
    'CATEGORIES:Grants'
  ].filter(Boolean);

  for (const days of reminders) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      `DESCRIPTION:${esc(`${days} day${days === 1 ? '' : 's'} left: ${g.title}`)}`,
      `TRIGGER:-P${days}D`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

function buildCalendar(events, { name = 'Grant Deadlines', reminders, host } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Grants for Me//Grant Deadlines//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-WR-CALDESC:Grant application deadlines matched to your organization',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H'
  ];
  for (const e of events) lines.push(...eventLines(e, { reminders, host }));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, esc, fold, nextDay };
