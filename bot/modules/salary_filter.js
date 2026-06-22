// Salary pre-filter — parse the minimum salary from a JD and compare
// against the user's salary expectation. Returns true if acceptable.

function extractMinSalary(text) {
  if (!text) return null;
  const t = text.replace(/,/g, '');

  const patterns = [
    // £30,000 - £45,000 / $50k-$70k
    /[£$€]\s*(\d+(?:\.\d+)?)\s*k?\s*[-–to]+\s*[£$€]?\s*(\d+(?:\.\d+)?)\s*k?/i,
    // 30,000 - 45,000 per year / pa / annually
    /(\d+(?:\.\d+)?)\s*k?\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*k?\s*(?:per year|p\.?a\.?|annually|\/yr)/i,
    // up to £50,000
    /up to\s*[£$€]?\s*(\d+(?:\.\d+)?)\s*k?/i,
    // from £30,000
    /from\s*[£$€]?\s*(\d+(?:\.\d+)?)\s*k?/i,
    // salary: £35000
    /salary[:\s]+[£$€]?\s*(\d{4,})/i,
  ];

  for (const pat of patterns) {
    const m = t.match(pat);
    if (m) {
      const raw = parseFloat(m[1]);
      const val = (m[1].toLowerCase().endsWith('k') || raw < 1000) ? raw * 1000 : raw;
      return val > 0 ? val : null;
    }
  }
  return null;
}

function parseSalaryExpectation(str) {
  if (!str) return null;
  const clean = String(str).replace(/[£$€\s,]/g, '').toLowerCase();
  const val = parseFloat(clean.replace('k', ''));
  if (isNaN(val)) return null;
  return clean.includes('k') ? val * 1000 : val;
}

// Returns true if the job should be processed (salary acceptable or unknown).
function isAcceptable(description, salaryExpectation) {
  const minExpected = parseSalaryExpectation(salaryExpectation);
  if (!minExpected) return true; // no salary filter configured

  const minOffered = extractMinSalary(description);
  if (!minOffered) return true; // salary not stated — don't filter

  // Allow up to 10% below expectation to avoid rejecting slightly lower bands
  return minOffered >= minExpected * 0.90;
}

module.exports = { isAcceptable, extractMinSalary };
