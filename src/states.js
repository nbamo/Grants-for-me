// State names + starter list of official grant pages to watch.
// Starter pages were checked when written; anyone can add more from the dashboard.

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

// type: state | local | foundation | bank | corporate
const STARTER_SOURCES = {
  PA: [
    { url: 'https://www.pa.gov/en/grants.html', label: 'Pennsylvania state grants (pa.gov/grants)', type: 'state' }
  ],
  MD: [
    { url: 'https://business.maryland.gov/nonprofit-opportunities/', label: 'Maryland nonprofit grant opportunities', type: 'state' }
  ],
  NJ: [
    { url: 'https://www.nj.gov/treasury/grants-management/opportunities/state', label: 'New Jersey state grants', type: 'state' }
  ]
};

// Bank foundations with multi-state footprints (state codes they serve; '*' = nationwide)
const BANK_SOURCES = [
  { url: 'https://www.td.com/us/en/about-us/funding-opportunities', label: 'TD Charitable Foundation', type: 'bank',
    states: ['CT', 'DE', 'DC', 'FL', 'ME', 'MD', 'MA', 'NH', 'NJ', 'NY', 'NC', 'PA', 'RI', 'SC', 'VT', 'VA'] },
  // Truist serves the Southeast and Mid-Atlantic; the AI eligibility check filters by your state.
  { url: 'https://truist.com/purpose/truist-foundation/grant-application', label: 'Truist Foundation', type: 'bank', states: ['*'] },
  { url: 'https://www.wellsfargo.com/about/responsibility-and-impact/community-giving/grant-process/', label: 'Wells Fargo community giving', type: 'bank', states: ['*'] }
];

function starterSourcesFor(state, wanted = {}) {
  const out = [];
  if (wanted.state !== false) out.push(...(STARTER_SOURCES[state] || []));
  if (wanted.bank !== false) {
    for (const b of BANK_SOURCES) if (b.states.includes('*') || b.states.includes(state)) out.push({ url: b.url, label: b.label, type: b.type });
  }
  return out;
}

module.exports = { STATE_NAMES, starterSourcesFor };
