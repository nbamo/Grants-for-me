// Questionnaire options and the Grants.gov codes they map to.
// Served to the browser via GET /api/options so there is one source of truth.

// Grants.gov eligibility codes (search2 "eligibilities" filter, pipe-delimited)
const ORG_TYPES = [
  { key: 'nonprofit501c3', label: 'Nonprofit with 501(c)(3) status', codes: ['12'] },
  { key: 'nonprofitOther', label: 'Nonprofit without 501(c)(3) status', codes: ['13'] },
  { key: 'smallBusiness', label: 'Small business', codes: ['23'] },
  { key: 'forProfit', label: 'For-profit (not a small business)', codes: ['22'] },
  { key: 'tribal', label: 'Tribal government or organization', codes: ['07', '11'] },
  { key: 'localGov', label: 'City, county or township government', codes: ['01', '02', '04'] },
  { key: 'stateGov', label: 'State government', codes: ['00'] },
  { key: 'school', label: 'School district', codes: ['05'] },
  { key: 'higherEd', label: 'College or university', codes: ['06', '20'] },
  { key: 'housingAuthority', label: 'Public housing authority', codes: ['08'] },
  { key: 'individual', label: 'Individual', codes: ['21'] }
];

// "Unrestricted" (99) and "Others – see eligibility text" (25) are always included.
const ALWAYS_ELIGIBLE = ['25', '99'];

// Grants.gov funding category codes (search2 "fundingCategories")
const FOCUS_AREAS = [
  { code: 'HL', label: 'Health' },
  { code: 'ISS', label: 'Income security & social services' },
  { code: 'HO', label: 'Housing' },
  { code: 'CD', label: 'Community development' },
  { code: 'ED', label: 'Education' },
  { code: 'ELT', label: 'Employment, labor & training' },
  { code: 'BC', label: 'Business & commerce' },
  { code: 'FN', label: 'Food & nutrition' },
  { code: 'AG', label: 'Agriculture' },
  { code: 'AR', label: 'Arts' },
  { code: 'HU', label: 'Humanities' },
  { code: 'ENV', label: 'Environment' },
  { code: 'EN', label: 'Energy' },
  { code: 'NR', label: 'Natural resources' },
  { code: 'ST', label: 'Science & technology' },
  { code: 'LJL', label: 'Law, justice & legal services' },
  { code: 'DPR', label: 'Disaster prevention & relief' },
  { code: 'RD', label: 'Regional development' },
  { code: 'T', label: 'Transportation' },
  { code: 'IS', label: 'Information & statistics' },
  { code: 'O', label: 'Other' }
];

// Populations served -> search keywords
const POPULATIONS = [
  { key: 'seniors', label: 'Seniors / older adults', keywords: ['older adults', 'aging'] },
  { key: 'disability', label: 'People with disabilities', keywords: ['disabilities'] },
  { key: 'youth', label: 'Children & youth', keywords: ['youth'] },
  { key: 'families', label: 'Low-income families', keywords: ['low-income families'] },
  { key: 'homeless', label: 'People experiencing homelessness', keywords: ['homelessness'] },
  { key: 'veterans', label: 'Veterans', keywords: ['veterans'] },
  { key: 'women', label: 'Women & girls', keywords: ['women'] },
  { key: 'minority', label: 'Minority communities', keywords: ['minority', 'underserved'] },
  { key: 'rural', label: 'Rural communities', keywords: ['rural'] },
  { key: 'immigrants', label: 'Immigrants & refugees', keywords: ['refugee'] },
  { key: 'reentry', label: 'Justice-involved / reentry', keywords: ['reentry'] },
  { key: 'mentalHealth', label: 'Mental health / substance use', keywords: ['behavioral health', 'substance use'] },
  { key: 'caregivers', label: 'Family caregivers', keywords: ['caregiver'] },
  { key: 'entrepreneurs', label: 'Entrepreneurs / workforce', keywords: ['entrepreneurship', 'workforce development'] }
];

const STATUS_OPTIONS = ['New', 'Reviewing', 'Applying', 'Submitted', 'Not a fit'];
const ACTIVE_STATUSES = ['Reviewing', 'Applying', 'Submitted'];

const LIMITS = {
  MAX_KEYWORDS: 15,
  ROWS_PER_QUERY: 100,
  MAX_DETAIL_FETCH_PER_RUN: 40,
  REQUEST_DELAY_MS: 250
};

module.exports = { ORG_TYPES, ALWAYS_ELIGIBLE, FOCUS_AREAS, POPULATIONS, STATUS_OPTIONS, ACTIVE_STATUSES, LIMITS };
