// Run: node bot/modules/title_match.test.js
// Job-AI is used for every kind of job, so title matching is checked across sectors and regions
// (UK, US and Canada's Job Bank titles), not just IT. Add a case whenever a match is fixed.
const t = require('./title_match');

// [the user's job title, a job posting's title, should it match?]
const CASES = [
  // IT support
  ['IT Support', 'IT Service Desk Analyst', true], ['IT Support', 'Mental Health Support Worker', false],
  ['IT Support', '2nd Line Support Consultant', true], ['IT Support Technician', 'help desk technician', true],
  ['IT Support Technician', 'technical support specialist – information technology (IT)', true],
  ['IT Support Technician', 'application development director - information technology (IT)', false],
  ['IT Support Technician', 'information technology (IT) business analyst', false],
  ['IT Technician', 'IT Support Technician', true], ['Service Desk Analyst', '1st Line Service Desk Engineer', true],
  ['Help Desk Analyst', 'computer help desk representative', true],
  ['Systems Support Engineer', 'heating, ventilation and air conditioning (HVAC) systems sales representative', false],
  ['Systems Support Engineer', 'alarm systems installer', false], ['IT Operations Specialist', 'information systems manager', false],
  ['IT Manager', 'IT Manager', true], ['IT Manager', 'IT Business Analyst', false],
  // Software and data
  ['Software Developer', 'Senior Backend Developer', true], ['Software Developer', 'software programmer', true],
  ['Data Analyst', 'Senior Data Analyst', true], ['Data Analyst', 'Data Entry Clerk', false], ['Business Analyst', 'IT Business Analyst', true],
  // Health and care
  ['Staff Nurse', 'Registered Nurse', true], ['Registered Nurse', 'registered nurse (R.N.)', true],
  ['Care Worker', 'home health care worker', true], ['Healthcare Assistant', 'Healthcare Assistant', true],
  // Customer service, admin, HR, finance
  ['Customer Service Advisor', 'Customer Service Representative', true], ['Customer Service Representative', 'customer service supervisor', false],
  ['Administrative Assistant', 'medical administrative assistant', true], ['Admin Assistant', 'Administrative Assistant', true],
  ['HR Advisor', 'People Advisor', true], ['Accountant', 'financial accountant', true], ['Accountant', 'accountants supervisor', false],
  // Warehouse, driving, trades, hospitality, retail
  ['Warehouse Operative', 'Picker Packer', true], ['Warehouse Operative', 'warehouse worker - material handling', true],
  ['Warehouse Operative', 'warehouse manager', false], ['Warehouse Operative', 'warehouse supervisor', false],
  ['Truck Driver', 'long haul truck driver', true], ['Electrician', 'construction electrician', true],
  ['Line Cook', 'line cook', true], ['Retail Sales Associate', 'sales associate - retail', true],
  // "Support" searches need a support job (live Find a Job log, 2026-11-09)
  ['Desktop Support Analyst', 'Software Engineer (C# / Desktop Applications)', false],
  ['Desktop Support Analyst', 'Desktop Support Analyst - Professional Services', true],
  ['Desktop Support Analyst', 'Desktop Engineer', true], ['Desktop Support Analyst', 'Desktop & Infrastructure Engineer', true], ['Desktop Support Analyst', 'Desktop and Endpoint Engineer', true], ['Desktop Support Analyst', 'Desktop Support Technician', true],
  ['Systems Support Analyst', 'Business Systems Analyst', false], ['Systems Support Analyst', 'Finance Systems Analyst', false],
  ['Systems Support Analyst', 'IT Systems Support Engineer', true], ['Application Support Analyst', 'Application Developer', false],
  ['Application Support Analyst', 'Applications Support Engineer', true], ['IT Support', 'IT Technician', true],
  ['IT Support', '2nd Line Engineer', true], ['Technical Support Engineer', 'Technical Sales Engineer', false],
  ['Customer Support Advisor', 'Customer Service Advisor', true], ['Learning Support Assistant', 'Learning Support Assistant (SEN)', true],
  ['Learning Support Assistant', 'Learning and Development Assistant', false], ['Support Worker', 'Senior Support Worker', true],
  ['Mental Health Support Worker', 'Mental Health Nurse', false], ['Payroll Support Officer', 'Payroll Officer', false],
  ['Payroll Support Officer', 'Payroll Support Administrator', true], ['Sales Support Executive', 'Sales Executive', false],
  // Boss roles match only boss searches
  ['Warehouse Manager', 'warehouse manager', true], ['Project Manager', 'construction project manager', true],
  ['Head Chef', 'head chef', true], ['Team Leader', 'Team Leader', true], ['Marketing Coordinator', 'digital marketing coordinator', true],
];

let bad = 0;
for (const [term, title, want] of CASES) {
  const got = t.titleMatches(title, t.compile([term]));
  if (got !== want) { bad++; console.log(`WRONG: "${term}" -> "${title}": got ${got}, want ${want}`); }
}
console.log(bad ? `${bad} of ${CASES.length} wrong` : `all ${CASES.length} correct`);
process.exit(bad ? 1 : 0);
