// node bot/modules/cv_parser.test.js : role headers in the layouts real CVs use.
const assert = require('assert');
const { parseCV } = require('./cv_parser');

const cv = (roles) => `Sam Taylor\nLeeds | 07700 900123 | sam@example.com\n\nPROFILE\nIT support analyst.\n\nWORK EXPERIENCE\n${roles}\n\nEDUCATION\nBTEC IT, Leeds City College (2018 - 2020)\n\nSKILLS\nMicrosoft 365`;
const cases = [
  ['pipe (app layout)', 'IT Support Analyst | Kirkstall Homes  Mar 2022 – Present\n• Fixed tickets.\n• Managed accounts.', [['IT Support Analyst', 'Kirkstall Homes', 2]]],
  ['comma + brackets', 'IT Support Analyst, Kirkstall Homes, Leeds (Mar 2022 - Present)\n- Fixed tickets.\n- Managed accounts.\nService Desk Agent, Aire Valley Council (Jun 2020 - Feb 2022)\n- Logged incidents.', [['IT Support Analyst', 'Kirkstall Homes, Leeds', 2], ['Service Desk Agent', 'Aire Valley Council', 1]]],
  ['at + full months', 'Care Assistant at Meadow View Care Home, January 2019 to December 2023\n• Supported 12 residents with daily care.', [['Care Assistant', 'Meadow View Care Home', 1]]],
  ['dash separator', 'Warehouse Operative - Wharfe Logistics 2017 - 2019\n• Picked 200 orders a shift.', [['Warehouse Operative', 'Wharfe Logistics', 1]]],
];
let fail = 0;
for (const [name, roles, want] of cases) {
  const r = parseCV(cv(roles));
  const got = r.experience.map((e) => [e.title, e.company, e.bullets.length]);
  try { assert.deepStrictEqual(got, want); console.log('ok  ', name); } catch (_) { fail++; console.log('FAIL', name, JSON.stringify(got)); }
}
// A bullet-less sentence that mentions years must stay a bullet, not become a role.
const r = parseCV(cv('IT Support Analyst | Kirkstall Homes  Mar 2022 – Present\nCut repeat calls by a third between 2022 and 2023.\nLed the move to Windows 11, finished 2023 - 2024'));
const ok = r.experience.length === 1 && r.experience[0].bullets.length === 2;
console.log(ok ? 'ok  ' : 'FAIL', 'sentences with years stay bullets', JSON.stringify(r.experience.map((e) => [e.title, e.bullets])));
if (!ok) fail++;
process.exit(fail ? 1 : 0);
