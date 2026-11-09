// Run: node bot/modules/residence.test.js
// "What is your province / state of residence?" for users anywhere: answered from the profile,
// never guessed. A user who doesn't live in a listed place gets no answer (the job is left).
process.env.JOBBOT_USERDATA = process.env.JOBBOT_USERDATA || require('os').tmpdir(); // no real profile needed
const cfg = require('../config');
const f = require('./ats_filler');

const PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Nova Scotia', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan'];
const ON_BC_ONLY = ['British Columbia', 'Ontario']; // employers that can only hire in some provinces
const STATES = ['Alabama', 'California', 'Florida', 'Illinois', 'New York', 'Texas', 'Washington'];
const opts = (list) => list.map((t) => ({ val: t, text: t }));

// [profile, question, options, expected answer (null = left for a person)]
const CASES = [
  [{ country: 'Canada', location: 'Toronto', address: '12 King St W, M5H 1A1' }, 'What is your province of residence?', PROVINCES, 'Ontario'],
  [{ country: 'Canada', location: 'Calgary', address: '' }, 'Province', PROVINCES, 'Alberta'],
  [{ country: 'Canada', location: 'Montréal, QC', address: '' }, 'Province/Territory of residence', PROVINCES, 'Quebec'],
  [{ country: 'Canada', location: 'Kelowna, British Columbia', address: '' }, 'Which province do you live in?', PROVINCES, 'British Columbia'],
  [{ country: 'Canada', location: 'Halifax', address: '5 Spring Garden Rd, B3J 1A1' }, 'What is your province of residence?', PROVINCES, 'Nova Scotia'],
  [{ country: 'Canada', location: 'Winnipeg', address: '' }, 'What is your province of residence?', ON_BC_ONLY, null], // lives in Manitoba, not listed
  [{ country: 'United Kingdom', location: 'London', address: '15 Exchange Gardens, SW8 1BP' }, 'What is your province of residence?', PROVINCES, null],
  [{ country: 'United States', location: 'New York, NY', address: '' }, 'What state do you reside in?', STATES, 'New York'],
  [{ country: 'United States', location: 'Austin', address: '100 Congress Ave, 78701' }, 'State', STATES, 'Texas'],
  [{ country: 'United States', location: 'Seattle, WA 98101', address: '' }, 'Which state do you live in?', STATES, 'Washington'],
  [{ country: 'United States', location: 'Chicago', address: '' }, 'What state do you reside in?', STATES, null], // can't tell: left, not guessed
  [{ country: 'United Kingdom', location: 'Leeds', address: '' }, 'What state do you reside in?', STATES, null],
  // Not residence questions: untouched
  [{ country: 'United States', location: 'New York, NY', address: '' }, 'Are you authorized to work in the United States?', ['Yes', 'No'], 'Yes'],
];

let bad = 0;
for (const [profile, q, list, want] of CASES) {
  cfg.APPLICANT = { ...(cfg.APPLICANT || {}), ...profile, rightToWorkCountries: [profile.country] };
  const got = f._pickDropdownOption(q, opts(list));
  if ((got || null) !== want) { bad++; console.log(`WRONG: ${profile.location} (${profile.country}) "${q}" -> ${got}, want ${want}`); }
}
console.log(bad ? `${bad} of ${CASES.length} wrong` : `all ${CASES.length} correct`);
process.exit(bad ? 1 : 0);
