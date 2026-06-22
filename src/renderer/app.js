const content = document.getElementById('content');
const navItems = document.querySelectorAll('#nav li');

navItems.forEach(li => {
  li.addEventListener('click', () => {
    navItems.forEach(x => x.classList.remove('active'));
    li.classList.add('active');
    render(li.dataset.view).then(() => updateNavProgress());
  });
});

function showStatus(el, msg, type = 'success') {
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status-msg';
  }, 2000);
}

async function render(view) {
  let fn;
  switch (view) {
    case 'personal':   fn = renderPersonal; break;
    case 'login':      fn = renderLogin; break;
    case 'cvs':        fn = renderCVs; break;
    case 'search':     fn = renderSearch; break;
    case 'license':    fn = renderLicense; break;
    case 'dashboard':  fn = renderDashboard; break;
    case 'help':       fn = renderHelp; break;
    default:           fn = renderPersonal;
  }
  await fn();
  // Wrap the rendered content in a fluid max-width container so it stretches
  // proportionally at any window size rather than being pinned to a fixed width.
  if (!content.querySelector('.page-content')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-content';
    wrapper.append(...Array.from(content.childNodes));
    content.appendChild(wrapper);
  }
}

// ── 1. Personal Details ─────────────────────────────────────────────────
async function renderPersonal() {
  const p = await window.api.profile.get();
  const country = p.country || 'United Kingdom';
  const empTypes = (p.employment_type || '').split(',').filter(Boolean);

  content.innerHTML = `
    <div class="page-header">
      <h2>Personal Details</h2>
      <p>This information is used to pre-fill job applications.</p>
    </div>

    <div class="card">
      <h3>Your Region</h3>
      <p class="card-hint">Determines which job sites are available and how employer screening questions are answered.</p>
      <div class="country-picker">
        <button class="country-btn${country === 'United Kingdom' ? ' active' : ''}" data-country="United Kingdom">
          <span class="country-flag">🇬🇧</span>
          <span class="country-name">United Kingdom</span>
        </button>
        <button class="country-btn${country === 'United States' ? ' active' : ''}" data-country="United States">
          <span class="country-flag">🇺🇸</span>
          <span class="country-name">United States</span>
        </button>
      </div>
      <input type="hidden" id="country" value="${country}">
    </div>

    <div class="card">
      <h3>Contact Information</h3>
      <div class="field-row">
        <div class="field"><label>First name</label><input id="first_name" value="${p.first_name || ''}"></div>
        <div class="field"><label>Last name</label><input id="last_name" value="${p.last_name || ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Phone</label><input id="phone" value="${p.phone || ''}"></div>
        <div class="field"><label>Email</label><input id="email" value="${p.email || ''}"></div>
      </div>
      <div class="field"><label>Location (city, state/county)</label><input id="location" value="${p.location || ''}"></div>
      <div class="field"><label>LinkedIn URL</label><input id="linkedin_url" value="${p.linkedin_url || ''}"></div>
    </div>

    <div class="card">
      <h3>Work Eligibility</h3>
      <div class="field"><label>Years of experience</label><input id="years_experience" type="number" min="0" value="${p.years_experience ?? 0}"></div>
      <div class="field"><label>Salary expectation (e.g. 45000 or $45,000–$55,000)</label><input id="salary_expectation" value="${p.salary_expectation || ''}"></div>
      <div class="field">
        <label>Countries I am eligible to work in (hold Ctrl/Cmd to select multiple)</label>
        ${(() => {
          const saved = (p.right_to_work_countries || '').split(',').map(s => s.trim()).filter(Boolean);
          const countries = ['United Kingdom','United States','European Union','Ireland','Australia','Canada'];
          return `<select id="right_to_work_countries" multiple size="6" style="height:auto">${
            countries.map(c => `<option value="${c}"${saved.includes(c) ? ' selected' : ''}>${c}</option>`).join('')
          }</select>`;
        })()}
      </div>
      <div class="field">
        <label>Do you require visa sponsorship?</label>
        <select id="requires_sponsorship">
          <option value="0" ${!p.requires_sponsorship ? 'selected' : ''}>No — I do not require sponsorship</option>
          <option value="1" ${p.requires_sponsorship ? 'selected' : ''}>Yes — I require visa sponsorship</option>
        </select>
      </div>
      <div class="checkbox-field">
        <input id="driving_licence" type="checkbox" ${p.driving_licence ? 'checked' : ''}>
        <label for="driving_licence">I have a valid driving licence / driver's license</label>
      </div>
    </div>

    <div class="card">
      <h3>Job Preferences</h3>
      <p class="card-hint">Used by the bot to filter jobs and answer screening questions accurately.</p>
      <div class="field">
        <label>Experience level</label>
        <select id="experience_level">
          <option value="" ${!p.experience_level ? 'selected' : ''}>Not specified</option>
          <option value="entry" ${p.experience_level === 'entry' ? 'selected' : ''}>Entry-level</option>
          <option value="junior" ${p.experience_level === 'junior' ? 'selected' : ''}>Junior</option>
          <option value="mid" ${p.experience_level === 'mid' ? 'selected' : ''}>Mid-level</option>
          <option value="senior" ${p.experience_level === 'senior' ? 'selected' : ''}>Senior</option>
          <option value="lead" ${p.experience_level === 'lead' ? 'selected' : ''}>Lead</option>
          <option value="director" ${p.experience_level === 'director' ? 'selected' : ''}>Director</option>
          <option value="executive" ${p.experience_level === 'executive' ? 'selected' : ''}>Executive</option>
        </select>
      </div>
      <div class="field">
        <label>Employment type</label>
        <div class="checkbox-group">
          <label class="checkbox-label"><input type="checkbox" name="employment_type" value="full_time" ${empTypes.includes('full_time') ? 'checked' : ''}> Full-time</label>
          <label class="checkbox-label"><input type="checkbox" name="employment_type" value="part_time" ${empTypes.includes('part_time') ? 'checked' : ''}> Part-time</label>
          <label class="checkbox-label"><input type="checkbox" name="employment_type" value="contract" ${empTypes.includes('contract') ? 'checked' : ''}> Contract / Freelance</label>
        </div>
      </div>
      <div class="field">
        <label>Availability / notice period</label>
        <select id="availability">
          <option value="immediately" ${(p.availability || 'immediately') === 'immediately' ? 'selected' : ''}>Immediately available</option>
          <option value="1week" ${p.availability === '1week' ? 'selected' : ''}>1 week notice</option>
          <option value="2weeks" ${p.availability === '2weeks' ? 'selected' : ''}>2 weeks notice</option>
          <option value="1month" ${p.availability === '1month' ? 'selected' : ''}>1 month notice</option>
          <option value="2months" ${p.availability === '2months' ? 'selected' : ''}>2 months notice</option>
          <option value="3months" ${p.availability === '3months' ? 'selected' : ''}>3 months notice</option>
        </select>
      </div>
      <div class="checkbox-field">
        <input id="willing_to_relocate" type="checkbox" ${p.willing_to_relocate ? 'checked' : ''}>
        <label for="willing_to_relocate">I am willing to relocate</label>
      </div>
    </div>

    <div class="card">
      <h3>Equal Opportunities</h3>
      <p class="card-hint">Optional. Used to auto-fill employer diversity and inclusion forms. US employers are legally required to collect this information.</p>
      <div class="field-row">
        <div class="field">
          <label>Gender</label>
          <select id="eeo_gender">
            <option value="" ${!p.eeo_gender ? 'selected' : ''}>Prefer not to say</option>
            <option value="male" ${p.eeo_gender === 'male' ? 'selected' : ''}>Male</option>
            <option value="female" ${p.eeo_gender === 'female' ? 'selected' : ''}>Female</option>
            <option value="nonbinary" ${p.eeo_gender === 'nonbinary' ? 'selected' : ''}>Non-binary</option>
            <option value="other" ${p.eeo_gender === 'other' ? 'selected' : ''}>Other / Self-describe</option>
          </select>
        </div>
        <div class="field">
          <label>Ethnicity</label>
          <select id="eeo_ethnicity">
            <option value="" ${!p.eeo_ethnicity ? 'selected' : ''}>Prefer not to say</option>
            <option value="white" ${p.eeo_ethnicity === 'white' ? 'selected' : ''}>White</option>
            <option value="black" ${p.eeo_ethnicity === 'black' ? 'selected' : ''}>Black or African American</option>
            <option value="asian" ${p.eeo_ethnicity === 'asian' ? 'selected' : ''}>Asian or Asian British</option>
            <option value="hispanic" ${p.eeo_ethnicity === 'hispanic' ? 'selected' : ''}>Hispanic or Latino</option>
            <option value="mixed" ${p.eeo_ethnicity === 'mixed' ? 'selected' : ''}>Mixed / Multiple ethnic groups</option>
            <option value="mena" ${p.eeo_ethnicity === 'mena' ? 'selected' : ''}>Middle Eastern or North African</option>
            <option value="other" ${p.eeo_ethnicity === 'other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Disability status</label>
          <select id="eeo_disability">
            <option value="" ${!p.eeo_disability ? 'selected' : ''}>Prefer not to say</option>
            <option value="no" ${p.eeo_disability === 'no' ? 'selected' : ''}>No</option>
            <option value="yes" ${p.eeo_disability === 'yes' ? 'selected' : ''}>Yes</option>
          </select>
        </div>
        <div class="field">
          <label>Veteran status <span class="field-note">(US applications)</span></label>
          <select id="eeo_veteran">
            <option value="" ${!p.eeo_veteran ? 'selected' : ''}>Prefer not to say</option>
            <option value="no" ${p.eeo_veteran === 'no' ? 'selected' : ''}>Not a veteran</option>
            <option value="yes" ${p.eeo_veteran === 'yes' ? 'selected' : ''}>Protected veteran</option>
          </select>
        </div>
      </div>
      <button class="primary" id="save">Save & Continue</button>
      <div class="status-msg" id="status"></div>
    </div>
  `;

  content.querySelectorAll('.country-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('.country-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('country').value = btn.dataset.country;
    });
  });

  document.getElementById('save').addEventListener('click', async () => {
    const selectedEmpTypes = Array.from(document.querySelectorAll('input[name="employment_type"]:checked')).map(cb => cb.value).join(',');
    await window.api.profile.save({
      country: document.getElementById('country').value,
      first_name: document.getElementById('first_name').value,
      last_name: document.getElementById('last_name').value,
      phone: document.getElementById('phone').value,
      email: document.getElementById('email').value,
      location: document.getElementById('location').value,
      linkedin_url: document.getElementById('linkedin_url').value,
      years_experience: Number(document.getElementById('years_experience').value) || 0,
      salary_expectation: document.getElementById('salary_expectation').value.trim(),
      right_to_work_countries: Array.from(document.getElementById('right_to_work_countries').selectedOptions).map(o => o.value).join(','),
      requires_sponsorship: Number(document.getElementById('requires_sponsorship').value),
      driving_licence: document.getElementById('driving_licence').checked ? 1 : 0,
      experience_level: document.getElementById('experience_level').value,
      employment_type: selectedEmpTypes,
      availability: document.getElementById('availability').value,
      willing_to_relocate: document.getElementById('willing_to_relocate').checked ? 1 : 0,
      eeo_gender: document.getElementById('eeo_gender').value,
      eeo_ethnicity: document.getElementById('eeo_ethnicity').value,
      eeo_disability: document.getElementById('eeo_disability').value,
      eeo_veteran: document.getElementById('eeo_veteran').value,
    });
    showStatus(document.getElementById('status'), 'Saved');
  });
}

// ── 2. Job Site Login ────────────────────────────────────────────────────
async function renderLogin() {
  const [reedCred, liCred, indeedCred, gdCred] = await Promise.all([
    window.api.credentials.get('reed'),
    window.api.credentials.get('linkedin'),
    window.api.credentials.get('indeed'),
    window.api.credentials.get('glassdoor'),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <h2>Job Site Login</h2>
      <p>Used by the bot to sign in and submit applications on your behalf. Stored encrypted on this device.</p>
    </div>

    <div class="card">
      <h3>Reed.co.uk</h3>
      <div class="field"><label>Email</label><input id="reed_email" value="${reedCred?.username || ''}"></div>
      <div class="field"><label>Password</label><input id="reed_pass" type="password" value=""></div>
      <button class="primary" id="save-reed">Save Reed Login</button>
      <div class="status-msg" id="status-reed"></div>
    </div>

    <div class="card">
      <h3>LinkedIn</h3>
      <div class="field"><label>Email</label><input id="li_email" value="${liCred?.username || ''}"></div>
      <div class="field"><label>Password</label><input id="li_pass" type="password" value=""></div>
      <button class="primary" id="save-li">Save LinkedIn Login</button>
      <div class="status-msg" id="status-li"></div>
    </div>

    <div class="card">
      <h3>Indeed</h3>
      <div class="field"><label>Email</label><input id="indeed_email" value="${indeedCred?.username || ''}"></div>
      <div class="field"><label>Password</label><input id="indeed_pass" type="password" value=""></div>
      <button class="primary" id="save-indeed">Save Indeed Login</button>
      <div class="status-msg" id="status-indeed"></div>
    </div>

    <div class="card">
      <h3>Glassdoor</h3>
      <div class="field"><label>Email</label><input id="gd_email" value="${gdCred?.username || ''}"></div>
      <div class="field"><label>Password</label><input id="gd_pass" type="password" value=""></div>
      <button class="primary" id="save-gd">Save Glassdoor Login</button>
      <div class="status-msg" id="status-gd"></div>
    </div>
  `;

  const saveCredential = async (site, usernameId, passwordId, statusId, successMsg) => {
    const username = document.getElementById(usernameId).value.trim();
    const password = document.getElementById(passwordId).value;
    const statusEl = document.getElementById(statusId);
    if (!username) { showStatus(statusEl, 'Enter a value', 'error'); return; }
    if (!password || password.length < 6) {
      showStatus(statusEl, 'Password must be at least 6 characters', 'error'); return;
    }
    await window.api.credentials.save(site, username, password);
    showStatus(statusEl, successMsg);
  };

  document.getElementById('save-reed').addEventListener('click', () =>
    saveCredential('reed', 'reed_email', 'reed_pass', 'status-reed', 'Saved — Reed Bot will open a login window on first start to verify'));
  document.getElementById('save-li').addEventListener('click', () =>
    saveCredential('linkedin', 'li_email', 'li_pass', 'status-li', 'Saved — LinkedIn Bot will open a browser window on first start'));
  document.getElementById('save-indeed').addEventListener('click', () =>
    saveCredential('indeed', 'indeed_email', 'indeed_pass', 'status-indeed', 'Saved — Indeed Bot will open a browser window on first start to verify'));
  document.getElementById('save-gd').addEventListener('click', () =>
    saveCredential('glassdoor', 'gd_email', 'gd_pass', 'status-gd', 'Saved — Glassdoor Bot will open a browser window on first start'));
}

// ── 3. CVs ──────────────────────────────────────────────────────────────
async function renderCVs() {
  const cvs = await window.api.cvs.get();

  content.innerHTML = `
    <div class="page-header">
      <h2>Your CVs</h2>
      <p>Upload one or more CVs (PDF). The app will analyse each one with AI to suggest job titles and search terms.</p>
    </div>

    <div id="cv-list">
      ${cvs.map(cv => `
        <div class="card">
          <div class="cv-card-title">${cv.label}</div>
          <div class="cv-card-file">${cv.file_path.split('\\').pop()}</div>
          ${cv.suggested_roles.length ? `
            <div class="cv-card-section">
              <strong>Suggested roles</strong>
              <div class="tag-list">${cv.suggested_roles.map(r => `<div class="tag">${r}</div>`).join('')}</div>
              <button class="secondary" data-cv-id="${cv.id}">+ Add these as search terms</button>
            </div>` : ''}
          ${cv.extracted_keywords.length ? `
            <div class="cv-card-section">
              <strong>Extracted keywords</strong>
              <div class="tag-list">${cv.extracted_keywords.map(k => `<div class="tag">${k}</div>`).join('')}</div>
            </div>` : ''}
          ${!cv.suggested_roles.length && !cv.extracted_keywords.length
            ? '<p class="muted">AI analysis unavailable — add search terms manually in Search Preferences.</p>'
            : ''}
        </div>
      `).join('') || `<div class="card"><div class="empty-upload">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <p>No CVs added yet</p>
        <span>Add a PDF below to get started</span>
      </div></div>`}
    </div>

    <div class="card">
      <h3>Add a CV</h3>
      <div class="field"><label>Label for this CV</label><input id="cv_label" placeholder="e.g. IT Support & Service Desk"></div>
      <button class="primary" id="add-cv">Choose PDF & Add</button>
      <div class="status-msg" id="status"></div>
    </div>
  `;

  document.getElementById('add-cv').addEventListener('click', async () => {
    const label = document.getElementById('cv_label').value || 'CV';
    const addBtn = document.getElementById('add-cv');
    const statusEl = document.getElementById('status');
    addBtn.disabled = true;
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Analysing CV with AI — this can take a couple of minutes...';
    try {
      const result = await window.api.cvs.pickAndAdd(label);
      if (result) {
        renderCVs();
      } else {
        statusEl.textContent = '';
        addBtn.disabled = false;
      }
    } catch (err) {
      statusEl.className = 'status-msg error';
      statusEl.textContent = 'Error: ' + err.message;
      addBtn.disabled = false;
    }
  });

  content.querySelectorAll('button[data-cv-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.cvs.addSuggestedTerms(Number(btn.dataset.cvId));
      showStatus(document.getElementById('status'), 'Search terms added — see Search Preferences');
    });
  });
}

// ── 4. Search Preferences ──────────────────────────────────────────────────
async function renderSearch() {
  const prefs = await window.api.searchPrefs.get();
  const terms = await window.api.searchTerms.get();
  const excludes = await window.api.excludeKeywords.get();

  content.innerHTML = `
    <div class="page-header">
      <h2>Search Preferences</h2>
      <p>Control what jobs the bot searches for, and which ones it skips.</p>
    </div>

    <div class="card">
      <h3>Search Criteria</h3>
      <div class="field-row">
        <div class="field">
          <label>Location</label>
          <input id="location" value="${prefs.location}">
        </div>
        <div class="field">
          <label>Contract type</label>
          <select id="contract_type">
            <option value="any" ${prefs.contract_type === 'any' ? 'selected' : ''}>Any</option>
            <option value="permanent" ${prefs.contract_type === 'permanent' ? 'selected' : ''}>Permanent</option>
            <option value="contract" ${prefs.contract_type === 'contract' ? 'selected' : ''}>Contract</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Work type priority (first = most preferred)</label>
        <select id="work_type_priority">
          <option value='["remote","hybrid","onsite"]'>Remote → Hybrid → Onsite</option>
          <option value='["remote","hybrid"]'>Remote → Hybrid only</option>
          <option value='["remote"]'>Remote only</option>
          <option value='["hybrid","onsite","remote"]'>Hybrid → Onsite → Remote</option>
        </select>
      </div>
      <div class="field">
        <label>Maximum job posting age</label>
        <select id="job_age">
          <option value="r86400"  ${(prefs.job_age||'r1209600')==='r86400'   ? 'selected':''}>Past 24 hours</option>
          <option value="r259200" ${(prefs.job_age||'r1209600')==='r259200'  ? 'selected':''}>Past 3 days</option>
          <option value="r604800" ${(prefs.job_age||'r1209600')==='r604800'  ? 'selected':''}>Past week</option>
          <option value="r1209600"${(prefs.job_age||'r1209600')==='r1209600' ? 'selected':''}>Past 2 weeks</option>
          <option value="r2592000"${(prefs.job_age||'r1209600')==='r2592000' ? 'selected':''}>Past month</option>
          <option value="any"     ${(prefs.job_age||'r1209600')==='any'      ? 'selected':''}>Any time</option>
        </select>
      </div>
    </div>

    <div class="card">
      <h3>Search Terms</h3>
      <div class="tag-list" id="terms-list">
        ${terms.map(t => `<div class="tag">${t.term} <button data-id="${t.id}" data-type="term">×</button></div>`).join('') || '<div class="empty-state">No search terms yet</div>'}
      </div>
      <div class="input-group">
        <div class="field"><input id="new_term" placeholder="Add a job title, e.g. Sales Engineer"></div>
        <button class="primary" id="add-term">Add</button>
      </div>
    </div>

    <div class="card">
      <h3>Exclude Keywords</h3>
      <p class="card-hint">Jobs with these words in the title are skipped.</p>
      <div class="tag-list" id="exclude-list">
        ${excludes.map(e => `<div class="tag exclude">${e.keyword} <button data-id="${e.id}" data-type="exclude">×</button></div>`).join('') || '<div class="empty-state">No exclude keywords yet</div>'}
      </div>
      <div class="input-group">
        <div class="field"><input id="new_exclude" placeholder="Add a keyword to exclude"></div>
        <button class="primary" id="add-exclude">Add</button>
      </div>
    </div>

    <div class="card">
      <h3>Application Limits</h3>
      <div class="field"><label>Max applications per day</label><input id="max_apps" type="number" min="1"></div>
      <div class="field">
        <label>Minimum match score (%)</label>
        <input id="min_score" type="number" min="0" max="100" placeholder="e.g. 60">
        <span class="field-hint">Only apply to jobs where the tailored CV scores at or above this threshold. Leave blank to apply to all.</span>
      </div>
      <div class="checkbox-field">
        <input id="seek_sponsorship" type="checkbox">
        <label for="seek_sponsorship">Only apply to jobs that offer visa sponsorship</label>
      </div>
      <button class="primary" id="save-prefs">Save</button>
      <div class="status-msg" id="status"></div>
    </div>
  `;

  // Pre-select work type priority
  document.getElementById('work_type_priority').value = JSON.stringify(prefs.work_type_priority);

  // Pre-fill profile-backed fields
  const profile = await window.api.profile.get();
  document.getElementById('max_apps').value = profile.max_applications_per_day ?? 15;
  document.getElementById('min_score').value = profile.min_match_score ?? '';
  document.getElementById('seek_sponsorship').checked = !!profile.seek_sponsorship;

  document.getElementById('save-prefs').addEventListener('click', async () => {
    await window.api.searchPrefs.save({
      location: document.getElementById('location').value,
      contract_type: document.getElementById('contract_type').value,
      work_type_priority: JSON.parse(document.getElementById('work_type_priority').value),
      job_age: document.getElementById('job_age').value,
    });
    await window.api.profile.save({
      max_applications_per_day: Number(document.getElementById('max_apps').value) || 15,
      min_match_score: document.getElementById('min_score').value !== '' ? Number(document.getElementById('min_score').value) : null,
      seek_sponsorship: document.getElementById('seek_sponsorship').checked ? 1 : 0,
    });
    showStatus(document.getElementById('status'), 'Saved');
  });

  document.getElementById('add-term').addEventListener('click', async () => {
    const val = document.getElementById('new_term').value.trim();
    if (!val) return;
    await window.api.searchTerms.add([val], 'user_added');
    renderSearch();
  });

  document.getElementById('add-exclude').addEventListener('click', async () => {
    const val = document.getElementById('new_exclude').value.trim();
    if (!val) return;
    await window.api.excludeKeywords.add(val);
    renderSearch();
  });

  content.querySelectorAll('button[data-type="term"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.searchTerms.delete(Number(btn.dataset.id));
      renderSearch();
    });
  });
  content.querySelectorAll('button[data-type="exclude"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.excludeKeywords.delete(Number(btn.dataset.id));
      renderSearch();
    });
  });
}

// ── 5. License ──────────────────────────────────────────────────────────
const LICENSE_ERRORS = {
  missing_key: 'Enter a license key',
  network_error: 'Could not reach the JobBot backend — check your internet connection',
  invalid_license_key: 'Invalid license key',
  missing_license_key: 'Enter a license key',
  license_inactive: 'This license has been revoked',
  license_expired: 'This license has expired',
  rate_limit_exceeded: 'Daily usage limit reached for this license',
  invalid_email: 'Enter a valid email address',
  already_registered: 'A license is already registered to this email — check your inbox',
  server_error: 'Something went wrong on our end — please try again',
};

function licenseBadgeClass(status) {
  switch (status) {
    case 'active': return 'badge-success';
    case 'trial': return 'badge-info';
    case 'expired':
    case 'revoked': return 'badge-danger';
    default: return 'badge-muted';
  }
}

function renderLicenseStatus(license, usage) {
  if (!license || !license.license_key) {
    return '<div class="empty-state">No license activated. Start a free trial or enter a license key above to enable AI CV tailoring.</div>';
  }
  const expires = license.expires_at ? new Date(license.expires_at).toLocaleString() : '—';

  let usageRow = '';
  if (usage) {
    usageRow = `
      <div class="stat-row">
        <span class="stat-label">Usage today</span>
        <span class="stat-value">${usage.usage_today} / ${usage.daily_limit} calls (~$${usage.cost_today_usd.toFixed(4)})</span>
      </div>
    `;
  }

  return `
    <div class="stat-row"><span class="stat-label">Email</span><span class="stat-value">${license.email || '—'}</span></div>
    <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value"><span class="badge ${licenseBadgeClass(license.status)}">${license.status}</span></span></div>
    <div class="stat-row"><span class="stat-label">Expires</span><span class="stat-value">${expires}</span></div>
    ${usageRow}
  `;
}

async function renderLicense() {
  const license = await window.api.license.get();
  const hasLicense = !!(license?.license_key);

  const trialCard = hasLicense ? '' : `
    <div class="card">
      <h3>Start Free Trial</h3>
      <p style="font-size:14px;color:#64748b;margin-bottom:16px">Try JobBot free for 7 days — no card required. Enter your email and we'll send you a license key instantly.</p>
      <div class="field"><label>Your email</label><input id="trial_email" type="email" placeholder="you@example.com"></div>
      <button class="primary" id="start-trial">Start 7-day free trial</button>
      <div class="status-msg" id="trial-status"></div>
    </div>
  `;

  content.innerHTML = `
    <div class="page-header">
      <h2>License</h2>
      <p>Activate a license key to enable AI CV tailoring and scoring. A license is required to start the bots.</p>
    </div>

    ${trialCard}

    <div class="card">
      <h3>Current License</h3>
      <div id="license-current">${renderLicenseStatus(license)}</div>
    </div>

    <div class="card">
      <h3>Activate a License</h3>
      <div class="field"><label>License key</label><input id="license_key" placeholder="jb_..." value="${license?.license_key || ''}"></div>
      <button class="primary" id="activate">Activate</button>
      <div class="status-msg" id="status"></div>
    </div>
  `;

  if (license?.license_key) {
    const result = await window.api.license.verify(license.license_key);
    if (result.ok) {
      document.getElementById('license-current').innerHTML = renderLicenseStatus(result.license, result.usage);
    }
  }

  if (!hasLicense) {
    document.getElementById('start-trial').addEventListener('click', async () => {
      const email = document.getElementById('trial_email').value.trim();
      const statusEl = document.getElementById('trial-status');
      const btn = document.getElementById('start-trial');
      btn.disabled = true;
      statusEl.className = 'status-msg';
      statusEl.textContent = 'Sending trial key...';
      try {
        const result = await window.api.license.startTrial(email);
        if (result.ok) {
          const verify = await window.api.license.verify(result.license_key);
          if (verify.ok) {
            document.getElementById('license-current').innerHTML = renderLicenseStatus(verify.license, verify.usage);
            document.getElementById('license_key').value = result.license_key;
            showStatus(statusEl, 'Trial started! Check your email for your key.', 'success');
            document.querySelector('.card:first-of-type').style.display = 'none';
          }
        } else {
          showStatus(statusEl, LICENSE_ERRORS[result.error] || `Error: ${result.error}`, 'error');
          btn.disabled = false;
        }
      } catch {
        showStatus(statusEl, 'Something went wrong. Please try again.', 'error');
        btn.disabled = false;
      }
    });
  }

  document.getElementById('activate').addEventListener('click', async () => {
    const key = document.getElementById('license_key').value.trim();
    const statusEl = document.getElementById('status');
    const btn = document.getElementById('activate');
    btn.disabled = true;
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Checking...';
    try {
      const result = await window.api.license.verify(key);
      if (result.ok) {
        document.getElementById('license-current').innerHTML = renderLicenseStatus(result.license, result.usage);
        showStatus(statusEl, 'License activated');
      } else {
        showStatus(statusEl, LICENSE_ERRORS[result.error] || `Error: ${result.error}`, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Dashboard ────────────────────────────────────────────────────────────
const BOT_LABELS = { reed: 'Reed Bot', scorer: 'Scorer Bot (AI)', linkedin: 'LinkedIn Bot', indeed: 'Indeed Bot', glassdoor: 'Glassdoor Bot' };

let botLogUnsub = null;
let botStatusUnsub = null;
let dashboardHasLicense = false;

function setBotControlsState(botName, status) {
  const badge = document.getElementById(`status-${botName}`);
  if (badge) {
    badge.textContent = status;
    badge.className = `bot-status bot-status-${status}`;
  }
  const card = document.getElementById(`bot-card-${botName}`);
  if (card) card.classList.toggle('bot-card-running', status === 'running');
  const startBtn = content.querySelector(`button[data-bot="${botName}"][data-action="start"]`);
  const stopBtn = content.querySelector(`button[data-bot="${botName}"][data-action="stop"]`);
  if (startBtn) startBtn.disabled = !dashboardHasLicense || status === 'running';
  if (stopBtn) stopBtn.disabled = status !== 'running';
}

function buildApplicationsGraph(dailyApps) {
  if (!dailyApps || dailyApps.length === 0) {
    return '<div class="graph-empty">No applications recorded yet</div>';
  }
  const W = 560, H = 80, PAD = 4;
  const maxCount = Math.max(...dailyApps.map(d => d.count), 1);
  const barW = Math.floor((W - PAD * 2) / 14);
  // Build a 14-day window with zeroes for missing days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const found = dailyApps.find(r => r.day === key);
    days.push({ key, count: found ? found.count : 0, label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
  }
  const bars = days.map((d, i) => {
    const barH = Math.max(2, Math.round((d.count / maxCount) * (H - 20)));
    const x = PAD + i * barW;
    const y = H - barH - 16;
    const isToday = i === 13;
    return `<rect x="${x}" y="${y}" width="${barW - 2}" height="${barH}" class="graph-bar${isToday ? ' graph-bar-today' : ''}" rx="2">
      <title>${d.label}: ${d.count} application${d.count !== 1 ? 's' : ''}</title></rect>
      ${d.count > 0 ? `<text x="${x + (barW - 2) / 2}" y="${y - 2}" class="graph-label" text-anchor="middle">${d.count}</text>` : ''}`;
  });
  const labels = [days[0], days[6], days[13]].map(d => {
    const i = days.indexOf(d);
    return `<text x="${PAD + i * barW + (barW - 2) / 2}" y="${H}" class="graph-date" text-anchor="middle">${d.label}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H + 4}" class="applications-graph" xmlns="http://www.w3.org/2000/svg">${bars.join('')}${labels.join('')}</svg>`;
}

function buildPreflightWarning(profile) {
  const missing = [];
  if (!profile?.first_name) missing.push('First name');
  if (!profile?.last_name) missing.push('Last name');
  if (!profile?.email) missing.push('Email');
  if (!profile?.phone) missing.push('Phone');
  if (!missing.length) return '';
  return `<div class="preflight-warning">
    ⚠ Your profile is incomplete — the bots may fail on contact fields. Please fill in: <strong>${missing.join(', ')}</strong>
    <button class="preflight-link" data-view="personal">Complete Profile →</button>
  </div>`;
}

function statusBadgeClass(status) {
  switch (status) {
    case 'applied': return 'badge-success';
    case 'apply_failed': return 'badge-danger';
    case 'skipped': return 'badge-muted';
    default: return 'badge-info';
  }
}

async function renderDashboard() {
  const [summary, recent, status, license, profile, dailyApps] = await Promise.all([
    window.api.queue.summary(),
    window.api.queue.recent(20),
    window.api.bot.status(),
    window.api.license.get(),
    window.api.profile.get(),
    window.api.queue.dailyApplications(14),
  ]);
  const isUS = (profile?.country || 'United Kingdom') === 'United States';
  dashboardHasLicense = !!(license?.license_key && (!license.expires_at || new Date(license.expires_at) > Date.now()));

  const counts = {};
  summary.forEach(row => { counts[row.status] = row.count; });

  content.innerHTML = `
    <div class="page-header">
      <h2>Dashboard</h2>
      <p>Monitor bot activity and track your application progress.</p>
    </div>

    ${!dashboardHasLicense ? `
    <div class="no-license-banner">
      <span>⚠ A license is required to start the bots.</span>
      <button class="no-license-cta" data-view="license">Activate license →</button>
    </div>` : ''}

    ${buildPreflightWarning(profile)}

    <div class="bot-controls">
      ${Object.entries(BOT_LABELS).filter(([key]) => !(isUS && key === 'reed')).map(([key, label]) => `
        <div class="card bot-card${status[key] === 'running' ? ' bot-card-running' : ''}" id="bot-card-${key}">
          <div class="bot-card-header">
            <strong>${label}</strong>
            <span class="bot-status bot-status-${status[key]}" id="status-${key}">${status[key]}</span>
          </div>
          <div class="bot-card-actions">
            <button class="primary" data-bot="${key}" data-action="start" ${!dashboardHasLicense || status[key] === 'running' ? 'disabled' : ''}>Start</button>
            <button class="secondary" data-bot="${key}" data-action="stop" ${status[key] !== 'running' ? 'disabled' : ''}>Stop</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="status-msg" id="bot-error"></div>

    <div id="login-prompt" class="login-prompt" style="display:none">
      <div class="login-prompt-icon">🔐</div>
      <div class="login-prompt-body">
        <strong id="login-prompt-title">Bot is waiting for you to log in</strong>
        <span id="login-prompt-body">A browser window has opened — complete the login there and the bot will continue automatically.</span>
      </div>
    </div>

    <div class="card card-wide">
      <h3>Bot Logs</h3>
      <pre class="bot-log" id="bot-log"></pre>
    </div>

    <div class="summary-grid">
      <div class="summary-card applied"><div class="num">${counts.applied || 0}</div><div class="label">Applied</div></div>
      <div class="summary-card pending"><div class="num">${counts.pending || 0}</div><div class="label">Pending</div></div>
      <div class="summary-card cv_ready"><div class="num">${counts.cv_ready || 0}</div><div class="label">CV Ready</div></div>
      <div class="summary-card skipped"><div class="num">${counts.skipped || 0}</div><div class="label">Skipped</div></div>
      <div class="summary-card apply_failed"><div class="num">${counts.apply_failed || 0}</div><div class="label">Failed</div></div>
    </div>

    <div class="card card-wide">
      <h3>Applications — Last 14 Days</h3>
      ${buildApplicationsGraph(dailyApps)}
    </div>

    <div class="card card-wide">
      <h3>Recent Activity</h3>
      <table class="data-table">
        <thead>
          <tr><th>Title</th><th>Company</th><th>Status</th><th>CV Used</th><th>Updated</th><th></th></tr>
        </thead>
        <tbody>
          ${recent.map(r => `
            <tr>
              <td>${r.title || ''}</td>
              <td>${r.company || ''}</td>
              <td><span class="badge ${statusBadgeClass(r.status)}">${r.status}</span></td>
              <td class="cv-name-cell">${r.cv_name || '—'}</td>
              <td>${r.updated_at ? r.updated_at.slice(0, 10) : ''}</td>
              <td>${r.cv_path ? `<button class="view-cv-btn" data-path="${r.cv_path}">View CV</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No activity yet</div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  const noLicenseCta = content.querySelector('.no-license-cta');
  if (noLicenseCta) noLicenseCta.addEventListener('click', () => render('license'));

  const preflightLink = content.querySelector('.preflight-link');
  if (preflightLink) preflightLink.addEventListener('click', () => render(preflightLink.dataset.view));

  content.querySelectorAll('.view-cv-btn').forEach(btn => {
    btn.addEventListener('click', () => window.api.shell.openPath(btn.dataset.path));
  });

  content.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.action === 'start' && !dashboardHasLicense) return;
      const errorEl = document.getElementById('bot-error');
      errorEl.className = 'status-msg';
      errorEl.textContent = '';
      try {
        await window.api.bot[btn.dataset.action](btn.dataset.bot);
      } catch (err) {
        errorEl.className = 'status-msg error';
        errorEl.textContent = `Error: ${err.message}`;
      }
    });
  });

  // Re-subscribe to live log/status streams (drop the previous view's listeners)
  if (botLogUnsub) botLogUnsub();
  if (botStatusUnsub) botStatusUnsub();

  const logEl = document.getElementById('bot-log');
  const loginPrompt = document.getElementById('login-prompt');
  botLogUnsub = window.api.bot.onLog(({ bot, text }) => {
    const prefix = `[${BOT_LABELS[bot] || bot}]`;
    const lines = text.split('\n').filter(line => line.trim().length);
    logEl.textContent += lines.map(line => `${prefix} ${line}`).join('\n') + '\n';
    logEl.scrollTop = logEl.scrollHeight;

    if (loginPrompt) {
      if (bot === 'reed' && (text.includes('Opening login page') || text.includes('Waiting for you to complete login'))) {
        document.getElementById('login-prompt-title').textContent = 'Reed is waiting for you to log in';
        document.getElementById('login-prompt-body').textContent = 'A browser window has opened. Enter your Reed.co.uk password there and click Log In — the bot will continue automatically once you\'re signed in.';
        loginPrompt.style.display = 'flex';
      } else if (bot === 'linkedin' && text.includes('Security check')) {
        document.getElementById('login-prompt-title').textContent = 'LinkedIn security check';
        document.getElementById('login-prompt-body').textContent = 'LinkedIn has shown a CAPTCHA or security check. Complete it in the browser window — the bot will continue automatically.';
        loginPrompt.style.display = 'flex';
      } else if (bot === 'glassdoor' && (text.includes('Opening login page') || text.includes('Waiting for you to complete login'))) {
        document.getElementById('login-prompt-title').textContent = 'Glassdoor is waiting for you to log in';
        document.getElementById('login-prompt-body').textContent = 'A browser window has opened. Enter your Glassdoor password — the bot will continue automatically once signed in.';
        loginPrompt.style.display = 'flex';
      } else if (bot === 'indeed' && (text.includes('Opening login page') || text.includes('Waiting for you to complete login') || text.includes('Verification required'))) {
        document.getElementById('login-prompt-title').textContent = 'Indeed is waiting for you to log in';
        document.getElementById('login-prompt-body').textContent = 'A browser window has opened. Enter your Indeed password (and any verification code) — the bot will continue automatically once signed in.';
        loginPrompt.style.display = 'flex';
      } else if ((text.includes('Logged in') || text.includes('Session restored') || text.includes('ERROR:') || text.includes('login timed out') || text.includes('Logged in successfully'))) {
        loginPrompt.style.display = 'none';
      }
    }
  });

  botStatusUnsub = window.api.bot.onStatus(({ bot, status: newStatus }) => {
    setBotControlsState(bot, newStatus);
  });
}

// ── Expiry banner ───────────────────────────────────────────────────────
async function initExpiryBanner() {
  const license = await window.api.license.get();
  if (!license?.license_key || !license.expires_at) return;

  const daysLeft = Math.ceil((new Date(license.expires_at) - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft > 14) return;

  const banner = document.getElementById('expiry-banner');
  const urgency = daysLeft <= 3 ? 'danger' : 'warning';
  const isTrial = license.status === 'trial';
  const msg = daysLeft <= 0
    ? (isTrial ? 'Your free trial has ended.' : 'Your JobBot license has expired.')
    : (isTrial
        ? `Your free trial expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
        : `Your license expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);

  banner.className = `expiry-banner ${urgency}`;
  banner.innerHTML = `
    <span>${msg}</span>
    <button id="renew-btn">${isTrial ? 'Subscribe to continue →' : 'Contact to Renew'}</button>
  `;
  document.getElementById('renew-btn').addEventListener('click', () => {
    if (isTrial) {
      window.open('https://jobbot-backend-production-1323.up.railway.app', '_blank');
    } else {
      window.open('mailto:merritfemi@gmail.com?subject=JobBot%20License%20Renewal', '_blank');
    }
  });
}

// ── Nav progress dots ────────────────────────────────────────────────────
async function updateNavProgress() {
  const [profile, creds, cvs, terms, license] = await Promise.all([
    window.api.profile.get(),
    window.api.credentials.get('reed'),
    window.api.cvs.get(),
    window.api.searchTerms.get(),
    window.api.license.get(),
  ]);

  const done = {
    personal: !!(profile.first_name && profile.email),
    login:    !!(creds?.username),
    cvs:      cvs.length > 0,
    search:   terms.length > 0,
    license:  !!(license?.license_key),
  };

  navItems.forEach(li => {
    const view = li.dataset.view;
    if (!(view in done)) return;
    let dot = li.querySelector('.nav-check');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'nav-check';
      li.appendChild(dot);
    }
    dot.className = `nav-check${done[view] ? ' done' : ''}`;
  });
}

// ── Onboarding tour (first launch only) ─────────────────────────────────

const TOUR_STEPS = [
  {
    view: 'personal',
    title: 'Your Personal Details',
    tip: 'Your name, email, phone number, and right-to-work status are used by the bot to fill in application forms on every job it applies to automatically.',
    action: 'Fill in all fields and click Save before continuing.',
  },
  {
    view: 'login',
    title: 'Job Site Login',
    tip: 'Enter your Reed.co.uk and LinkedIn credentials. They are encrypted and stored only on your device — never uploaded or shared with anyone.',
    action: 'Enter your Reed.co.uk and LinkedIn email and password, then click Save for each.',
  },
  {
    view: 'cvs',
    title: 'Upload Your CV',
    tip: 'Upload your CV as a PDF. Before every application, the AI rewrites your profile section to match the specific job description — so every application is uniquely personalised.',
    action: 'Click "Add CV" and upload at least one PDF. You can add multiple CVs for different role types.',
  },
  {
    view: 'search',
    title: 'Search Preferences',
    tip: 'Add the job titles you want to apply for — for example "Sales Engineer" or "Solutions Engineer". Both the Reed Bot and LinkedIn Bot search using these terms automatically.',
    action: 'Add at least one search term, choose your preferred work type, then click Save.',
  },
  {
    view: 'license',
    title: 'Activate Your License',
    tip: 'Start your free trial or enter a license key to activate. The AI that tailors your CV runs entirely on our cloud — nothing extra to install or set up.',
    action: 'Click "Start Free Trial" or paste your license key and click Activate.',
  },
  {
    view: 'dashboard',
    title: "You're All Set — Start the Bots",
    tip: 'Reed Bot and LinkedIn Bot find and apply to jobs on their respective sites. The Scorer Bot runs in the middle — it uses AI to tailor your CV for every role before it is sent. Run all three together for best results.',
    action: 'Click Start on Reed Bot, LinkedIn Bot, and Scorer Bot. Applications will begin within minutes.',
  },
];

function tourNavigateTo(view) {
  navItems.forEach(li => {
    li.classList.remove('active', 'nav-tour-active');
    if (li.dataset.view === view) li.classList.add('active', 'nav-tour-active');
  });
  return render(view).then(() => updateNavProgress());
}

function startTour() {
  let step = 0;

  function showPanel() {
    const existing = document.getElementById('tour-panel');
    if (existing) existing.remove();

    const s      = TOUR_STEPS[step];
    const isLast = step === TOUR_STEPS.length - 1;
    const pct    = Math.round(((step + 1) / TOUR_STEPS.length) * 100);

    const panel = document.createElement('div');
    panel.id        = 'tour-panel';
    panel.className = 'tour-panel';
    panel.innerHTML = `
      <div class="tour-progress">
        <div class="tour-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="tour-body">
        <div class="tour-step-label">Step ${step + 1} of ${TOUR_STEPS.length}</div>
        <div class="tour-step-title">${s.title}</div>
        <p class="tour-tip">${s.tip}</p>
        <div class="tour-action">${s.action}</div>
        <div class="tour-nav">
          <button class="tour-skip" id="tour-skip">Skip tour</button>
          <button class="tour-next" id="tour-next">${isLast ? 'Finish setup' : 'Next →'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('tour-next').addEventListener('click', () => {
      if (isLast) { endTour(); return; }
      step++;
      goToStep();
    });

    document.getElementById('tour-skip').addEventListener('click', endTour);
  }

  function endTour() {
    const existing = document.getElementById('tour-panel');
    if (existing) existing.remove();
    navItems.forEach(li => li.classList.remove('nav-tour-active'));
    localStorage.setItem('tour_complete', '1');
  }

  async function goToStep() {
    // Show the panel immediately — don't wait on async nav
    showPanel();
    // Navigate sidebar + page in background
    try {
      await tourNavigateTo(TOUR_STEPS[step].view);
    } catch (e) {
      console.warn('[Tour] Navigation error:', e);
    }
    // Re-render panel after nav in case innerHTML was replaced
    showPanel();
  }

  goToStep();
}

function initOnboarding() {
  if (localStorage.getItem('welcome_seen')) return;

  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `
    <div class="welcome-modal">
      <div class="welcome-logo"></div>
      <h2>Welcome to JobBot</h2>
      <p>Your fully automated job application assistant. Set up once and the bot finds, tailors, and applies to jobs for you — around the clock.</p>
      <div class="welcome-features">
        <div class="welcome-feature">
          <strong>AI CV Tailoring</strong>
          <span>Rewrites your CV for every single job</span>
        </div>
        <div class="welcome-feature">
          <strong>Auto Apply</strong>
          <span>Submits applications on Reed &amp; LinkedIn</span>
        </div>
        <div class="welcome-feature">
          <strong>Smart Matching</strong>
          <span>Scores and filters by relevance</span>
        </div>
        <div class="welcome-feature">
          <strong>No setup needed</strong>
          <span>AI runs entirely on our cloud</span>
        </div>
      </div>
      <div class="welcome-actions">
        <button class="primary" id="welcome-tour-btn">Take the setup tour &rarr;</button>
        <button class="welcome-skip-link" id="welcome-skip-btn">I&rsquo;ll set up myself</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('welcome-tour-btn').addEventListener('click', () => {
    overlay.remove();
    localStorage.setItem('welcome_seen', '1');
    startTour();
  });

  document.getElementById('welcome-skip-btn').addEventListener('click', () => {
    overlay.remove();
    localStorage.setItem('welcome_seen', '1');
  });
}

// ── Help ─────────────────────────────────────────────────────────────────
function renderHelp() {
  const faqs = [
    {
      q: 'How do I get started?',
      a: 'Complete all 4 setup steps in order: (1) Personal Details, (2) Job Site Login, (3) upload your CVs, (4) Search Preferences. Then activate your license and go to the Dashboard to start the bots.'
    },
    {
      q: 'Which job sites does JobBot use?',
      a: 'JobBot searches and applies on Reed.co.uk and LinkedIn. Make sure you have saved your login credentials for both on the Job Site Login page.'
    },
    {
      q: 'What are the three bots and what do they do?',
      a: 'Reed Bot searches Reed.co.uk and submits applications. LinkedIn Bot does the same on LinkedIn. Scorer Bot runs in the middle — it uses AI to tailor your CV for each role before it is sent. You should run all three together.'
    },
    {
      q: 'The bot opened a browser window and stopped — what do I do?',
      a: 'This means the job site is asking you to log in or complete a security check. Complete the login in the browser window that opened — the bot will continue automatically once you are signed in.'
    },
    {
      q: 'Why are some jobs showing as skipped?',
      a: 'Jobs are skipped when they do not match your preferences — for example, wrong work type, no easy apply button, external application site, or below your minimum match score. This is normal and expected.'
    },
    {
      q: 'How do I add more CVs?',
      a: 'Go to the CVs section in the sidebar and click "Add CV". You can upload multiple CVs — JobBot will automatically select the best one for each job based on the match score.'
    },
    {
      q: 'What is the minimum match score?',
      a: 'Set this in Search Preferences. JobBot will only apply to jobs where your tailored CV scores at or above this percentage. Leave it blank to apply to all jobs regardless of score.'
    },
    {
      q: 'The bots are running but no jobs are being found — why?',
      a: 'Your search terms may have exhausted all available jobs. Try adding more search terms in Search Preferences — for example, if you have "IT Support Analyst", also add "IT Support Specialist" or "Help Desk Analyst".'
    },
    {
      q: 'Windows shows a security warning when I install JobBot — is it safe?',
      a: 'Yes, this is normal for new software that has not yet been code-signed. Click "More info" then "Run anyway" to proceed. Your device is not at risk.'
    },
    {
      q: 'Mac shows "unidentified developer" — what do I do?',
      a: 'Go to System Settings → Privacy & Security, scroll down and click "Open Anyway". This is a standard Mac security prompt for new apps and is safe to bypass.'
    },
    {
      q: 'Will my Reed and LinkedIn passwords be shared or stored online?',
      a: 'No. Your credentials are encrypted using your device\'s secure storage and never leave your computer. JobBot does not upload or transmit your passwords anywhere.'
    },
    {
      q: 'How do I cancel or manage my subscription?',
      a: 'Reply to your trial or license email and we will sort it out for you straight away.'
    },
  ];

  content.innerHTML = `
    <div class="view-header"><h2>Help &amp; FAQs</h2></div>
    <div class="help-faq">
      ${faqs.map((f, i) => `
        <div class="faq-item" id="faq-${i}">
          <button class="faq-question" onclick="toggleFaq(${i})">
            <span>${f.q}</span>
            <span class="faq-chevron">›</span>
          </button>
          <div class="faq-answer">${f.a}</div>
        </div>
      `).join('')}
    </div>
    <div class="help-contact">
      <p>Still need help? Email us at <a href="mailto:merritfemi@gmail.com">merritfemi@gmail.com</a> and we'll get back to you.</p>
    </div>
  `;
}

window.toggleFaq = function(i) {
  const item = document.getElementById(`faq-${i}`);
  item.classList.toggle('open');
};

// ── Auto-update banner ────────────────────────────────────────────────────
if (window.api?.onUpdateReady) {
  window.api.onUpdateReady(() => {
    const banner = document.getElementById('expiry-banner');
    if (banner) {
      banner.innerHTML = `<span>A new version of JobBot is ready. It will install automatically when you close the app.</span>`;
      banner.style.display = 'flex';
      banner.style.background = '#4f46e5';
      banner.style.color = '#fff';
    }
  });
}

// Initial view
render('personal').then(() => {
  updateNavProgress();
  initExpiryBanner();
  initOnboarding();
});
