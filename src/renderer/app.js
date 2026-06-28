const content = document.getElementById('content');
const navItems = document.querySelectorAll('#nav li');
let _statsPoll = null;

navItems.forEach(li => {
  li.addEventListener('click', () => {
    if (_statsPoll) { clearInterval(_statsPoll); _statsPoll = null; }
    navItems.forEach(x => x.classList.remove('active'));
    li.classList.add('active');
    render(li.dataset.view).then(() => updateNavProgress());
  });
});

function navigate(view) {
  if (_statsPoll) { clearInterval(_statsPoll); _statsPoll = null; }
  const navLi = document.querySelector(`#nav li[data-view="${view}"]`);
  navItems.forEach(x => x.classList.remove('active'));
  if (navLi) navLi.classList.add('active');
  render(view).then(() => updateNavProgress());
}

function showStatus(el, msg, type = 'success') {
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status-msg';
  }, 4000);
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
    case 'tracker':    fn = renderTracker; break;
    case 'analytics':  fn = renderAnalytics; break;
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

// â”€â”€ 1. Personal Details â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      <div class="field"><label>Salary expectation (e.g. 45000 or $45,000—$55,000)</label><input id="salary_expectation" value="${p.salary_expectation || ''}"></div>
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
      <p class="card-hint">Used by the Agent to filter jobs and answer screening questions accurately.</p>
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

// â”€â”€ 2. Job Site Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderLogin() {
  const [reedCred, liCred, gdCred, cvlibCred, tjCred, cwCred] = await Promise.all([
    window.api.credentials.get('reed'),
    window.api.credentials.get('linkedin'),
    window.api.credentials.get('glassdoor'),
    window.api.credentials.get('cvlibrary'),
    window.api.credentials.get('totaljobs'),
    window.api.credentials.get('cwjobs'),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <h2>Job Site Login</h2>
      <p>Used by the Agent to sign in and submit applications on your behalf. Stored encrypted on this device.</p>
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
      <p style="font-size:13px;color:#64748b;margin:0 0 12px">LinkedIn uses a persistent browser session instead of a stored password. Use the <strong>Connect account</strong> button on the Dashboard — log in once and the session is saved automatically.</p>
      <button class="secondary" id="go-dashboard-li">Go to Dashboard →</button>
    </div>

    <div class="card">
      <h3>Glassdoor</h3>
      <p style="color:#888;font-size:13px;margin:0 0 12px">Click Connect to open a Chrome window and log in to Glassdoor. The Agent will reuse that session automatically — no bot detection.</p>
      <button class="primary" id="connect-gd">Connect Glassdoor Account</button>
      <div class="status-msg" id="status-gd"></div>
    </div>

    <div class="card">
      <h3>CV-Library</h3>
      <p style="color:#888;font-size:13px;margin:0 0 12px">Click Connect to open a Chrome window and log in to CV-Library. The Agent will reuse that session automatically — no bot detection.</p>
      <button class="primary" id="connect-cvlib">Connect CV-Library Account</button>
      <div class="status-msg" id="status-cvlib"></div>
    </div>

    <div class="card">
      <h3>Totaljobs</h3>
      <p style="color:#888;font-size:13px;margin:0 0 12px">Click Connect to open a Chrome window and log in to Totaljobs. The Agent will reuse that session automatically — no bot detection.</p>
      <button class="primary" id="connect-tj">Connect Totaljobs Account</button>
      <div class="status-msg" id="status-tj"></div>
    </div>

    <div class="card">
      <h3>CWJobs</h3>
      <p style="color:#888;font-size:13px;margin:0 0 12px">Click Connect to open a Chrome window and log in to CWJobs. The Agent will reuse that session automatically — no bot detection.</p>
      <button class="primary" id="connect-cw">Connect CWJobs Account</button>
      <div class="status-msg" id="status-cw"></div>
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
    saveCredential('reed', 'reed_email', 'reed_pass', 'status-reed', 'Saved — Reed Agent will open a login window on first start to verify'));

  document.getElementById('go-dashboard-li').addEventListener('click', () => navigate('dashboard'));

  const connectSite = async (site, loginUrl, btnId, statusId) => {
    const btn = document.getElementById(btnId);
    const statusEl = document.getElementById(statusId);
    btn.disabled = true;
    btn.textContent = 'Opening Chrome...';
    showStatus(statusEl, 'Log in to the site in the Chrome window, then close it when done.', 'info');
    const result = await window.api.site.connect(site, loginUrl);
    btn.disabled = false;
    btn.textContent = btn.dataset.label;
    if (result.success) {
      showStatus(statusEl, 'Session saved — Agent will start already logged in next time.');
    } else {
      showStatus(statusEl, `Error: ${result.error}`, 'error');
    }
  };

  document.getElementById('connect-gd').dataset.label    = 'Connect Glassdoor Account';
  document.getElementById('connect-cvlib').dataset.label = 'Connect CV-Library Account';
  document.getElementById('connect-tj').dataset.label    = 'Connect Totaljobs Account';
  document.getElementById('connect-cw').dataset.label    = 'Connect CWJobs Account';

  document.getElementById('connect-gd').addEventListener('click', () =>
    connectSite('glassdoor', 'https://www.glassdoor.co.uk', 'connect-gd', 'status-gd'));
  document.getElementById('connect-cvlib').addEventListener('click', () =>
    connectSite('cvlibrary', 'https://www.cv-library.co.uk/login', 'connect-cvlib', 'status-cvlib'));
  document.getElementById('connect-tj').addEventListener('click', () =>
    connectSite('totaljobs', 'https://www.totaljobs.com/en-GB/candidate/login', 'connect-tj', 'status-tj'));
  document.getElementById('connect-cw').addEventListener('click', () =>
    connectSite('cwjobs',    'https://www.cwjobs.co.uk/', 'connect-cw', 'status-cw'));
}

// â”€â”€ 3. CVs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderCVs() {
  const cvs = await window.api.cvs.get();

  content.innerHTML = `
    <div class="page-header">
      <h2>Your CVs</h2>
      <p>Upload your CV to get started. <strong>Word (.docx) is recommended</strong> — it's read more accurately, so your tailored CV captures every detail. PDF also works, but can occasionally be misread during tailoring.</p>
    </div>

    <div id="cv-list">
      ${cvs.map(cv => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
            <div>
              <div class="cv-card-title">${cv.label}</div>
              <div class="cv-card-file">${cv.file_path.split('\\').pop()}</div>
            </div>
            <button class="secondary cv-remove-btn" data-remove-cv-id="${cv.id}" style="flex-shrink:0;color:#c0392b;border-color:#c0392b;padding:4px 10px;font-size:12px">Remove</button>
          </div>
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
        <span>Add a Word document (.docx) below for best results</span>
      </div></div>`}
    </div>

    <div class="card">
      <h3>Add a CV</h3>
      <p class="muted" style="margin-top:0;margin-bottom:12px">Upload a <strong>Word (.docx)</strong> for best quality tailored CVs. PDF is also supported.</p>
      <div class="field"><label>Label for this CV</label><input id="cv_label" placeholder="e.g. IT Support & Service Desk"></div>
      <button class="primary" id="add-cv">Choose File & Add</button>
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

  content.querySelectorAll('.cv-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.removeCvId);
      btn.disabled = true;
      btn.textContent = 'Removing...';
      await window.api.cvs.remove(id);
      renderCVs();
    });
  });
}

// â”€â”€ 4. Search Preferences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderSearch() {
  const [prefs, terms, excludes, blacklist] = await Promise.all([
    window.api.searchPrefs.get(),
    window.api.searchTerms.get(),
    window.api.excludeKeywords.get(),
    window.api.blacklist.get(),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <h2>Search Preferences</h2>
      <p>Control what jobs the Agent searches for, and which ones it skips.</p>
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
      <h3>Blocked Companies</h3>
      <p class="card-hint">Jobs from these companies are skipped automatically.</p>
      <div class="tag-list" id="blacklist-list">
        ${blacklist.map(b => `<div class="tag exclude">${b.company} <button data-id="${b.id}" data-type="blacklist">×</button></div>`).join('') || '<div class="empty-state">No blocked companies</div>'}
      </div>
      <div class="input-group">
        <div class="field"><input id="new_company" placeholder="e.g. Capita, Serco, Reed Staffing"></div>
        <button class="primary" id="add-company">Block</button>
      </div>
    </div>

    <div class="card">
      <h3>Agent Schedule</h3>
      <p class="card-hint">Restrict the search Agents to specific hours. The Scorer Agent always runs regardless of schedule.</p>
      <div class="checkbox-field" style="margin-bottom:16px">
        <input id="schedule_enabled" type="checkbox" ${prefs.schedule_enabled ? 'checked' : ''}>
        <label for="schedule_enabled">Enable schedule</label>
      </div>
      <div id="schedule-settings" style="${prefs.schedule_enabled ? '' : 'opacity:0.4;pointer-events:none'}">
        <div class="field-row" style="align-items:flex-end;gap:16px;margin-bottom:14px">
          <div class="field">
            <label>Start time</label>
            <select id="schedule_start">
              ${Array.from({length:24},(_,h)=>`<option value="${h}" ${(prefs.schedule_start??9)==h?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>End time</label>
            <select id="schedule_end">
              ${Array.from({length:24},(_,h)=>`<option value="${h}" ${(prefs.schedule_end??18)==h?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label>Active days</label>
          <div class="day-picker">
            ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => {
              const active = (prefs.schedule_days||'Mon,Tue,Wed,Thu,Fri').split(',').includes(d);
              return `<button class="day-btn${active?' active':''}" data-day="${d}">${d}</button>`;
            }).join('')}
          </div>
        </div>
      </div>
      <button class="primary" id="save-schedule" style="margin-top:16px">Save Schedule</button>
      <div class="status-msg" id="status-schedule"></div>
    </div>

    <div class="card">
      <h3>Application Limits</h3>
      <div class="field">
        <label>Max applications per day</label>
        <select id="max_apps">
          <option value="5">5</option>
          <option value="10">10</option>
          <option value="15">15</option>
          <option value="20">20</option>
          <option value="25">25</option>
        </select>
        <span class="field-hint">Total across all agents. Capped at 25/day to protect your accounts and keep applications looking human.</span>
      </div>
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
  // Snap any stored value (incl. legacy values above the cap) to a valid option ≤ 25
  const allowedApps = [5, 10, 15, 20, 25];
  const storedApps = Math.min(Number(profile.max_applications_per_day) || 15, 25);
  document.getElementById('max_apps').value = String(
    allowedApps.reduce((a, b) => Math.abs(b - storedApps) <= Math.abs(a - storedApps) ? b : a, 15)
  );
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
      max_applications_per_day: Math.min(Number(document.getElementById('max_apps').value) || 15, 25),
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

  // Company blacklist
  document.getElementById('add-company').addEventListener('click', async () => {
    const val = document.getElementById('new_company').value.trim();
    if (!val) return;
    await window.api.blacklist.add(val);
    document.getElementById('new_company').value = '';
    renderSearch();
  });
  document.getElementById('new_company').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const val = e.target.value.trim();
    if (!val) return;
    await window.api.blacklist.add(val);
    e.target.value = '';
    renderSearch();
  });
  content.querySelectorAll('button[data-type="blacklist"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.blacklist.remove(Number(btn.dataset.id));
      renderSearch();
    });
  });

  // Schedule toggle
  const scheduleToggle = document.getElementById('schedule_enabled');
  const scheduleSettings = document.getElementById('schedule-settings');
  scheduleToggle.addEventListener('change', () => {
    scheduleSettings.style.opacity = scheduleToggle.checked ? '1' : '0.4';
    scheduleSettings.style.pointerEvents = scheduleToggle.checked ? '' : 'none';
  });

  // Day picker
  content.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  document.getElementById('save-schedule').addEventListener('click', async () => {
    const activeDays = [...content.querySelectorAll('.day-btn.active')].map(b => b.dataset.day).join(',');
    await window.api.searchPrefs.save({
      schedule_enabled: scheduleToggle.checked ? 1 : 0,
      schedule_days: activeDays || 'Mon,Tue,Wed,Thu,Fri',
      schedule_start: Number(document.getElementById('schedule_start').value),
      schedule_end: Number(document.getElementById('schedule_end').value),
    });
    showStatus(document.getElementById('status-schedule'), 'Schedule saved');
  });}

// â”€â”€ 5. License â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LICENSE_ERRORS = {
  missing_key: 'Enter a license key',
  network_error: 'Could not reach the Job-AI backend — check your internet connection',
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
      <p style="font-size:14px;color:#64748b;margin-bottom:16px">Try Job-AI free for 7 days — no card required. Enter your email and we'll send you a license key instantly.</p>
      <div class="field"><label>Your email</label><input id="trial_email" type="email" placeholder="you@example.com"></div>
      <button class="primary" id="start-trial">Start 7-day free trial</button>
      <div class="status-msg" id="trial-status"></div>
    </div>
  `;

  content.innerHTML = `
    <div class="page-header">
      <h2>License</h2>
      <p>A license key is required to start the Agents. Start a free trial or enter your key below.</p>
    </div>

    ${trialCard}

    <div class="card">
      <h3>Current License</h3>
      <div id="license-current">${renderLicenseStatus(license)}</div>
    </div>

    <div class="card">
      <h3>Activate a License Key</h3>
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
            document.querySelector('.card').style.display = 'none';
            dashboardHasLicense = true;
            statusEl.className = 'status-msg success';
            statusEl.innerHTML = 'Trial activated! Your key has been saved. <button class="preflight-link" data-view="dashboard">Go to Dashboard →</button>';
            statusEl.querySelector('[data-view]').addEventListener('click', () => navigate('dashboard'));
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
        showStatus(statusEl, 'License activated — Agents are now unlocked', 'success');
        dashboardHasLicense = true;
      } else {
        showStatus(statusEl, LICENSE_ERRORS[result.error] || `Error: ${result.error}`, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BOT_LABELS = { reed: 'Reed Agent', scorer: 'Scorer Agent (AI)', linkedin: 'LinkedIn Agent' };

let botLogUnsub = null;
let botStatusUnsub = null;
let dashboardHasLicense = false;

function setBotControlsState(botName, status) {
  // The Scorer has no card — it auto-runs alongside the application agents — so
  // reflect its state in the status pill next to the Start applying button.
  if (botName === 'scorer') {
    const pill = document.getElementById('scorer-pill');
    if (pill) {
      const running = status === 'running';
      pill.dataset.status = status;
      pill.textContent = running ? '✨ AI tailoring active' : 'AI tailoring: idle';
      pill.classList.toggle('scorer-pill-active', running);
    }
  }
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
  updateStartAllState();
}

// Keep the "Start applying" / "Stop" all-agents buttons in sync with the live
// per-agent statuses (read from the visible application-agent cards).
function updateStartAllState() {
  const startAll = content && content.querySelector('.start-applying-btn');
  const stopAll  = content && content.querySelector('.stop-all-btn');
  if (!startAll && !stopAll) return;
  const statuses = Array.from(content.querySelectorAll('.bot-card .bot-status')).map(b => b.textContent.trim());
  const anyRunning = statuses.some(s => s === 'running');
  const allRunning = statuses.length > 0 && statuses.every(s => s === 'running');
  if (startAll) startAll.disabled = !dashboardHasLicense || allRunning;
  if (stopAll)  stopAll.disabled  = !anyRunning;
  // Light up checklist step 4 while the agents are applying
  const mark4 = document.getElementById('gs-mark-4');
  if (mark4) mark4.innerHTML = gsMark(anyRunning, 4);
  const done4 = document.getElementById('gs-done-4');
  if (done4) done4.style.display = anyRunning ? '' : 'none';
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

function buildPreflightWarning(profile, cvs) {
  const warnings = [];
  const profileMissing = [];
  if (!profile?.first_name) profileMissing.push('First name');
  if (!profile?.last_name)  profileMissing.push('Last name');
  if (!profile?.email)      profileMissing.push('Email');
  if (!profile?.phone)      profileMissing.push('Phone');
  if (profileMissing.length) {
    warnings.push(`<div class="preflight-warning">
      &#9888; Profile incomplete — Agents will leave contact fields blank: <strong>${profileMissing.join(', ')}</strong>
      <button class="preflight-link" data-view="personal">Complete Profile →</button>
    </div>`);
  }
  if (!cvs || cvs.length === 0) {
    warnings.push(`<div class="preflight-warning">
      &#9888; No CV uploaded — the Agent cannot tailor applications without one.
      <button class="preflight-link" data-view="cvs">Add a CV →</button>
    </div>`);
  }
  return warnings.join('');
}

// "How to start" checklist — makes the two-step flow (connect → Start applying)
// obvious. Profile/CV steps are auto-ticked; connect/start are guided actions.
function gsMark(ok, n) {
  return ok
    ? '<span class="gs-step gs-step-done">✓</span>'
    : `<span class="gs-step gs-step-num">${n}</span>`;
}
function buildGetStartedCard(profile, cvs, anyConnected, anyRunning) {
  const profileDone = !!(profile?.first_name && profile?.last_name && profile?.email && profile?.phone);
  const cvDone      = !!(cvs && cvs.length);
  const mark = gsMark;
  return `
    <div class="card get-started-card">
      <h3>How to start applying</h3>
      <ol class="get-started-steps">
        <li>${mark(profileDone, 1)}<span>Complete your profile</span>
          ${profileDone ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link" data-view="personal">Complete profile →</button>'}</li>
        <li>${mark(cvDone, 2)}<span>Upload a CV</span>
          ${cvDone ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link" data-view="cvs">Add a CV →</button>'}</li>
        <li>${mark(anyConnected, 3)}<span>Connect your job sites — click <strong>Connect account</strong> on a card below and log in once</span>
          ${anyConnected ? '<em class="gs-ok">Done</em>' : ''}</li>
        <li><span id="gs-mark-4">${mark(anyRunning, 4)}</span><span>Click <strong>Start applying</strong> — the AI scores jobs, tailors your CV and applies for you automatically</span>
          <em class="gs-ok" id="gs-done-4" style="${anyRunning ? '' : 'display:none'}">Applying…</em></li>
      </ol>
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

// All job sites use persistent Chrome profiles - Connect opens Chrome so the user logs in once
const CREDS_NEEDED = new Set();
// Sites that benefit from importing the user's real Chrome session to bypass Cloudflare
const CHROME_SESSION_BOTS = new Set([]);
const CONNECT_URLS = {
  reed:     'https://secure.reed.co.uk/login',
  linkedin: 'https://www.linkedin.com/login',
};
const CRED_SITE_NAMES = { reed: 'Reed.co.uk', linkedin: 'LinkedIn' };

// Recent Activity rows — shared by the initial render and the 5 s poll so the
// table stays in sync in real time, not just on page load.
function recentRowsHtml(recent) {
  return (recent || []).map(r => `
            <tr>
              <td>${r.title || ''}</td>
              <td>${r.company || ''}</td>
              <td><span class="badge ${statusBadgeClass(r.status)}">${r.status}</span></td>
              <td class="cv-name-cell">${r.cv_name || '—'}</td>
              <td>${r.updated_at ? r.updated_at.slice(0, 10) : ''}</td>
              <td>${r.cv_path ? `<button class="view-cv-btn" data-path="${r.cv_path}">View CV</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No activity yet</div></td></tr>';
}

function bindViewCvButtons(root = content) {
  root.querySelectorAll('.view-cv-btn').forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', () => window.api.shell.openPath(btn.dataset.path));
  });
}

async function renderDashboard() {
  const [summary, recent, status, license, profile, dailyApps, cvs, reedCred, liCred, gdCred, cvlibCred, tjCred, cwCred, connectedStatus] = await Promise.all([
    window.api.queue.summary(),
    window.api.queue.recent(20),
    window.api.bot.status(),
    window.api.license.get(),
    window.api.profile.get(),
    window.api.queue.dailyApplications(14),
    window.api.cvs.get(),
    window.api.credentials.get('reed'),
    window.api.credentials.get('linkedin'),
    window.api.credentials.get('glassdoor'),
    window.api.credentials.get('cvlibrary'),
    window.api.credentials.get('totaljobs'),
    window.api.credentials.get('cwjobs'),
    window.api.site.connectedStatus().catch(() => ({})),
  ]);
  const anyConnected = Object.values(connectedStatus || {}).some(Boolean);
  const isUS = (profile?.country || 'United Kingdom') === 'United States';
  // License key required to start bots
  dashboardHasLicense = !!(license?.license_key);

  const dashCreds = { reed: reedCred, linkedin: liCred, glassdoor: gdCred, cvlibrary: cvlibCred, totaljobs: tjCred, cwjobs: cwCred };
  // Application agents shown on the dashboard (the Scorer is hidden — it auto-runs
  // alongside these and is surfaced only as the "AI tailoring" pill).
  const appAgentKeys = Object.keys(BOT_LABELS).filter(k => k !== 'scorer' && !(isUS && k === 'reed'));
  const scorerRunning = status.scorer === 'running';
  const allAppRunning = appAgentKeys.length > 0 && appAgentKeys.every(k => status[k] === 'running');
  const anyAppRunning = appAgentKeys.some(k => status[k] === 'running');
  const counts = {};
  summary.forEach(row => { counts[row.status] = row.count; });

  function buildBotCard(key, label) {
    const needsCreds = CREDS_NEEDED.has(key);
    const isConnected = !needsCreds || !!dashCreds[key]?.username;
    const isRunning = status[key] === 'running';

    if (!isConnected) {
      return `
        <div class="card bot-card bot-card-unconnected" id="bot-card-${key}">
          <div class="bot-card-header">
            <strong>${label}</strong>
            <span class="bot-badge-lock">Not connected</span>
          </div>
          <p class="bot-connect-hint">Connect your ${CRED_SITE_NAMES[key]} account to enable this Agent.</p>
          <div class="bot-card-actions">
            <button class="connect-btn" data-bot="${key}" data-action="connect">Connect account →</button>
          </div>
        </div>`;
    }

    return `
      <div class="card bot-card${isRunning ? ' bot-card-running' : ''}" id="bot-card-${key}">
        <div class="bot-card-header">
          <strong>${label}</strong>
          <span class="bot-status bot-status-${status[key]}" id="status-${key}">${status[key]}</span>
        </div>
        <div class="bot-card-actions">
          ${needsCreds ? `<button class="btn-connect" data-bot="${key}" data-action="connect">Connect account</button>` : ''}
          ${!needsCreds && CONNECT_URLS[key] ? `<button class="btn-connect" data-bot="${key}" data-action="connect-session">Connect account</button>` : ''}
          ${CHROME_SESSION_BOTS.has(key) ? `<button class="btn-connect" data-bot="${key}" data-action="import-chrome" title="Copy your real Chrome session into the bot profile — bypasses Cloudflare verification">Use my Chrome →</button>` : ''}
        </div>
      </div>`;
  }

  content.innerHTML = `
    <div class="page-header">
      <h2>Dashboard</h2>
      <p>Monitor Agent activity and track your application progress.</p>
    </div>

    ${!dashboardHasLicense ? `
    <div class="no-license-banner">
      <span>&#9888;  A license is required to start the Agents.</span>
      <button class="no-license-cta" data-view="license">Activate license →</button>
    </div>` : ''}

    ${buildPreflightWarning(profile, cvs)}

    ${buildGetStartedCard(profile, cvs, anyConnected, anyAppRunning)}

    <div class="start-applying-bar">
      <button class="primary start-applying-btn" data-action="start-all"
        ${(!dashboardHasLicense || allAppRunning) ? 'disabled' : ''}
        ${!dashboardHasLicense ? 'title="Activate a license to start the Agents"' : ''}>▶ Start applying</button>
      <button class="secondary stop-all-btn" data-action="stop-all" ${anyAppRunning ? '' : 'disabled'}>Stop</button>
      <span class="scorer-pill${scorerRunning ? ' scorer-pill-active' : ''}" id="scorer-pill" data-status="${status.scorer || 'stopped'}"
        title="The AI tailoring engine runs automatically while the Agents are applying — you don't start it yourself.">${scorerRunning ? '✨ AI tailoring active' : 'AI tailoring: idle'}</span>
    </div>

    <div class="bot-controls">
      ${appAgentKeys.map(key => buildBotCard(key, BOT_LABELS[key])).join('')}
    </div>
    <div class="status-msg" id="bot-error"></div>

    <div id="login-prompt" class="login-prompt" style="display:none">
      <div class="login-prompt-icon">🔐</div>
      <div class="login-prompt-body">
        <strong id="login-prompt-title">Agent is waiting for you to log in</strong>
        <span id="login-prompt-body">A browser window has opened — complete the login there and the Agent will continue automatically.</span>
      </div>
    </div>

    <div class="card card-wide">
      <h3>Agent Logs</h3>
      <pre class="bot-log" id="bot-log"></pre>
    </div>

    <div class="summary-grid">
      <div class="summary-card applied"><div class="num" id="stat-applied">${counts.applied || 0}</div><div class="label">Applied</div></div>
      <div class="summary-card pending"><div class="num" id="stat-pending">${counts.pending || 0}</div><div class="label">Pending</div></div>
      <div class="summary-card cv_ready"><div class="num" id="stat-tailored">${counts.tailored || 0}</div><div class="label">CVs Tailored</div></div>
      <div class="summary-card skipped"><div class="num" id="stat-skipped">${counts.skipped || 0}</div><div class="label">Skipped</div></div>
      <div class="summary-card apply_failed"><div class="num" id="stat-failed">${counts.apply_failed || 0}</div><div class="label">Failed</div></div>
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
        <tbody id="recent-activity-body">
          ${recentRowsHtml(recent)}
        </tbody>
      </table>
    </div>
  `;

  const noLicenseCta = content.querySelector('.no-license-cta');
  if (noLicenseCta) noLicenseCta.addEventListener('click', () => render('license'));

  const preflightLink = content.querySelector('.preflight-link');
  if (preflightLink) preflightLink.addEventListener('click', () => render(preflightLink.dataset.view));

  bindViewCvButtons();

  content.querySelectorAll('a[data-view]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.view); });
  });

  content.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.action === 'connect') {
        openCredModal(btn.dataset.bot, dashCreds[btn.dataset.bot]?.username || '');
        return;
      }
      if (btn.dataset.action === 'connect-session') {
        const site = btn.dataset.bot;
        const loginUrl = CONNECT_URLS[site];
        if (!loginUrl) return;
        btn.textContent = 'Opening…';
        btn.disabled = true;
        const result = await window.api.site.connect(site, loginUrl).catch(e => ({ success: false, error: e.message }));
        if (!result.success) {
          btn.textContent = 'Connect account';
          btn.disabled = false;
          const errorEl = document.getElementById('bot-error');
          if (errorEl) { errorEl.className = 'status-msg error'; errorEl.textContent = result.error || 'Failed to open login window'; }
          return;
        }
        // Chrome is now open — guide the user to just log in and click Start
        btn.textContent = 'Logged in? Click Start';
        btn.disabled = false;
        btn.style.background = 'var(--primary-soft)';
        // Show a tip below the card
        const tip = document.createElement('p');
        tip.id = `connect-tip-${site}`;
        tip.style.cssText = 'font-size:11px;color:var(--text-muted);margin:4px 0 0;text-align:center;';
        tip.textContent = site === 'glassdoor'
          ? 'Two tabs opened: log into Indeed (tab 1) then Glassdoor (tab 2), then click Start.'
          : 'Log in to the site, then click Start - the browser closes automatically.';
        const card = btn.closest('.bot-card');
        if (card && !card.querySelector(`#connect-tip-${site}`)) card.appendChild(tip);
        return;
      }
      if (btn.dataset.action === 'import-chrome') {
        const site = btn.dataset.bot;
        const origText = btn.textContent;
        btn.textContent = 'Copying session…';
        btn.disabled = true;
        const result = await window.api.session.importChrome(site).catch(e => ({ ok: false, error: e.message }));
        const errorEl = document.getElementById('bot-error');
        if (!result.ok) {
          btn.textContent = origText;
          btn.disabled = false;
          if (errorEl) { errorEl.className = 'status-msg error'; errorEl.textContent = result.error || 'Import failed'; }
          return;
        }
        btn.textContent = '✓ Session imported';
        btn.style.background = 'var(--success, #16a34a)';
        btn.style.color = '#fff';
        if (errorEl) { errorEl.className = 'status-msg'; errorEl.textContent = ''; }
        const card = btn.closest('.bot-card');
        const tip = document.createElement('p');
        tip.style.cssText = 'font-size:11px;color:var(--text-muted);margin:4px 0 0;text-align:center;';
        tip.textContent = 'Your Chrome session is now active — click Start to run the Agent.';
        if (card && !card.querySelector('.chrome-import-tip')) { tip.className = 'chrome-import-tip'; card.appendChild(tip); }
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; btn.style.background = ''; btn.style.color = ''; }, 5000);
        return;
      }
      if (btn.dataset.action === 'start-all' || btn.dataset.action === 'stop-all') {
        if (btn.dataset.action === 'start-all' && !dashboardHasLicense) return;
        const errorEl = document.getElementById('bot-error');
        errorEl.className = 'status-msg';
        errorEl.textContent = '';
        const op = btn.dataset.action === 'start-all' ? 'start' : 'stop';
        btn.disabled = true;
        for (const key of appAgentKeys) {
          try { await window.api.bot[op](key); } catch (err) {
            errorEl.className = 'status-msg error';
            errorEl.textContent = `Error starting ${BOT_LABELS[key]}: ${err.message}`;
          }
        }
        return;
      }
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

  ensureCredModal();

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
        document.getElementById('login-prompt-body').textContent = 'A browser window has opened. Enter your Reed.co.uk password there and click Log In — the Agent will continue automatically once you\'re signed in.';
        loginPrompt.style.display = 'flex';
      } else if (bot === 'linkedin' && text.includes('Security check')) {
        document.getElementById('login-prompt-title').textContent = 'LinkedIn security check';
        document.getElementById('login-prompt-body').textContent = 'LinkedIn has shown a CAPTCHA or security check. Complete it in the browser window — the Agent will continue automatically.';
        loginPrompt.style.display = 'flex';
      } else if (bot === 'glassdoor' && (text.includes('Opening login page') || text.includes('Waiting for you to complete login'))) {
        document.getElementById('login-prompt-title').textContent = 'Glassdoor is waiting for you to log in';
        document.getElementById('login-prompt-body').textContent = 'A browser window has opened. Enter your Glassdoor password — the Agent will continue automatically once signed in.';
        loginPrompt.style.display = 'flex';
      } else if ((text.includes('Logged in') || text.includes('Session restored') || text.includes('ERROR:') || text.includes('login timed out') || text.includes('Logged in successfully'))) {
        loginPrompt.style.display = 'none';
      }
    }
  });

  botStatusUnsub = window.api.bot.onStatus(({ bot, status: newStatus }) => {
    setBotControlsState(bot, newStatus);
  });

  // Poll every 5 s and patch the stat numbers AND the Recent Activity table
  // in-place, so the dashboard stays live without a full re-render.
  if (_statsPoll) clearInterval(_statsPoll);
  _statsPoll = setInterval(async () => {
    if (!document.getElementById('stat-applied')) { clearInterval(_statsPoll); _statsPoll = null; return; }
    try {
      const [summary, recent] = await Promise.all([
        window.api.queue.summary(),
        window.api.queue.recent(20),
      ]);
      const c = {};
      summary.forEach(r => { c[r.status] = r.count; });
      const map = { 'stat-applied': c.applied || 0, 'stat-pending': c.pending || 0, 'stat-tailored': c.tailored || 0, 'stat-skipped': c.skipped || 0, 'stat-failed': c.apply_failed || 0 };
      for (const [id, val] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el && el.textContent !== String(val)) el.textContent = val;
      }
      // Refresh Recent Activity only when it actually changed (avoids clobbering
      // the table — and its scroll — on every tick)
      const body = document.getElementById('recent-activity-body');
      if (body) {
        const html = recentRowsHtml(recent);
        if (body._lastHtml !== html) {
          body._lastHtml = html;
          body.innerHTML = html;
          bindViewCvButtons();
        }
      }
    } catch (_) {}
  }, 5000);
}

// â”€â”€ Interview Tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TRACKER_STAGES = ['applied', 'phone_screen', 'interview', 'offer', 'rejected', 'withdrawn'];
const STAGE_LABELS = { applied: 'Applied', phone_screen: 'Phone Screen', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const STAGE_COLORS = { applied: '#2563eb', phone_screen: '#8b5cf6', interview: '#f59e0b', offer: '#10b981', rejected: '#ef4444', withdrawn: '#94a3b8' };

async function renderTracker() {
  content.innerHTML = `
    <div class="page-header">
      <h2>Interview Tracker</h2>
      <p>Track every application from submission to offer. Syncs automatically from the Agents.</p>
    </div>
    <div class="tracker-loading">Syncing from Agents...</div>`;

  let entries = [];
  try {
    entries = await window.api.tracker.sync();
  } catch (_) {
    entries = await window.api.tracker.get().catch(() => []);
  }

  const stageHtml = (id, currentStage) => `
    <select class="tracker-stage-select" data-id="${id}" style="color:${STAGE_COLORS[currentStage] || '#94a3b8'}">
      ${TRACKER_STAGES.map(s => `<option value="${s}" ${s === currentStage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}
    </select>`;

  const SOURCE_BADGE = { reed: '#2563eb', linkedin: '#0077b5', indeed: '#2164f3', glassdoor: '#0caa41', cvlibrary: '#ff5c35', totaljobs: '#E84B2A', cwjobs: '#003057' };

  content.innerHTML = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2>Interview Tracker</h2>
        <p>Track every application from submission to offer.</p>
      </div>
      <button class="secondary" id="sync-tracker">Sync now</button>
    </div>

    ${!entries.length ? `
      <div class="card"><div class="empty-state">No applications tracked yet. The tracker syncs automatically once Agents start applying.</div></div>
    ` : `
    <div class="card card-wide">
      <table class="data-table tracker-table">
        <thead>
          <tr><th>Role</th><th>Company</th><th>Source</th><th>Applied</th><th>Stage</th><th>Notes</th><th></th></tr>
        </thead>
        <tbody>
          ${entries.map(e => `
            <tr data-id="${e.id}">
              <td class="tracker-title">${e.title ? `<a href="${e.url || '#'}" class="tracker-link" data-url="${e.url || ''}">${e.title}</a>` : '—'}</td>
              <td>${e.company || '—'}</td>
              <td>${e.source ? `<span class="tracker-source-badge" style="background:${SOURCE_BADGE[e.source] || '#2563eb'}">${e.source}</span>` : '—'}</td>
              <td>${e.applied_at ? e.applied_at.slice(0, 10) : '—'}</td>
              <td>${stageHtml(e.id, e.stage || 'applied')}</td>
              <td><input class="tracker-notes-input" data-id="${e.id}" value="${(e.notes || '').replace(/"/g, '&quot;')}" placeholder="Add notes..."></td>
              <td><button class="tracker-delete-btn" data-id="${e.id}">×</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`}
  `;

  document.getElementById('sync-tracker')?.addEventListener('click', async () => {
    const btn = document.getElementById('sync-tracker');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    await render('tracker');
  });

  content.querySelectorAll('.tracker-stage-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      sel.style.color = STAGE_COLORS[sel.value] || '#94a3b8';
      await window.api.tracker.update(Number(sel.dataset.id), { stage: sel.value });
    });
  });

  content.querySelectorAll('.tracker-notes-input').forEach(inp => {
    inp.addEventListener('blur', async () => {
      await window.api.tracker.update(Number(inp.dataset.id), { notes: inp.value });
    });
    inp.addEventListener('keydown', async e => {
      if (e.key === 'Enter') { inp.blur(); }
    });
  });

  content.querySelectorAll('.tracker-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this entry from the tracker?')) return;
      await window.api.tracker.delete(Number(btn.dataset.id));
      btn.closest('tr').remove();
    });
  });

  content.querySelectorAll('.tracker-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      if (a.dataset.url) window.api.shell.openPath(a.dataset.url);
    });
  });
}

// â”€â”€ Analytics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildAnalyticsGraph(daily30) {
  if (!daily30 || daily30.length === 0) return '<div class="graph-empty">No applications in the past 30 days</div>';
  const W = 560, H = 80, PAD = 4;
  const maxCount = Math.max(...daily30.map(d => d.count), 1);
  const barW = Math.floor((W - PAD * 2) / 30);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const found = daily30.find(r => r.day === key);
    days.push({ key, count: found ? found.count : 0, label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
  }
  const bars = days.map((d, i) => {
    const barH = Math.max(2, Math.round((d.count / maxCount) * (H - 20)));
    const x = PAD + i * barW;
    const y = H - barH - 16;
    const isToday = i === 29;
    return `<rect x="${x}" y="${y}" width="${barW - 1}" height="${barH}" class="graph-bar${isToday ? ' graph-bar-today' : ''}" rx="1">
      <title>${d.label}: ${d.count}</title></rect>
      ${d.count > 0 && barW > 10 ? `<text x="${x + (barW - 1) / 2}" y="${y - 2}" class="graph-label" text-anchor="middle">${d.count}</text>` : ''}`;
  });
  const labels = [days[0], days[14], days[29]].map(d => {
    const i = days.indexOf(d);
    return `<text x="${PAD + i * barW + (barW - 1) / 2}" y="${H}" class="graph-date" text-anchor="middle">${d.label}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H + 4}" class="applications-graph" xmlns="http://www.w3.org/2000/svg">${bars.join('')}${labels.join('')}</svg>`;
}

async function renderAnalytics() {
  content.innerHTML = `<div class="page-header"><h2>Analytics</h2><p>Application performance and patterns over time.</p></div><div style="padding:40px;color:#64748b">Loading...</div>`;

  const data = await window.api.analytics.get();

  if (!data) {
    content.innerHTML = `<div class="page-header"><h2>Analytics</h2><p>No data yet — run the Agents to see analytics.</p></div>`;
    return;
  }

  const { totals, bySource, byCV, skipReasons, daily30, topCompanies, topTitles } = data;
  const totalApplied = Number(totals.total_applied) || 0;
  const totalSkipped = Number(totals.total_skipped) || 0;
  const totalFailed  = Number(totals.total_failed) || 0;
  const skipRate = totalApplied + totalSkipped > 0 ? Math.round((totalSkipped / (totalApplied + totalSkipped)) * 100) : 0;
  const totalDaysActive = daily30.filter(d => d.count > 0).length || 1;
  const avgPerDay = totalDaysActive > 0 ? (totalApplied / totalDaysActive).toFixed(1) : '0';
  const topSource = bySource[0]?.source || '—';

  const barRow = (label, count, max, color) => {
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return `<div class="analytics-bar-row">
      <span class="analytics-bar-label">${label}</span>
      <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="analytics-bar-count">${count}</span>
    </div>`;
  };

  const SOURCE_COLORS = { reed: '#2563eb', linkedin: '#0077b5', indeed: '#2164f3', glassdoor: '#0caa41', cvlibrary: '#ff5c35', totaljobs: '#E84B2A', cwjobs: '#003057' };
  const maxSource = bySource[0]?.count || 1;
  const maxCV     = byCV[0]?.count || 1;
  const maxSkip   = skipReasons[0]?.count || 1;

  content.innerHTML = `
    <div class="page-header">
      <h2>Analytics</h2>
      <p>Application performance and patterns over time.</p>
    </div>

    <div class="summary-grid">
      <div class="summary-card applied"><div class="num">${totalApplied}</div><div class="label">Total Applied</div></div>
      <div class="summary-card pending"><div class="num">${avgPerDay}</div><div class="label">Avg / Active Day</div></div>
      <div class="summary-card cv_ready"><div class="num">${topSource}</div><div class="label">Top Source</div></div>
      <div class="summary-card skipped"><div class="num">${skipRate}%</div><div class="label">Skip Rate</div></div>
      <div class="summary-card apply_failed"><div class="num">${totalFailed}</div><div class="label">Failed</div></div>
    </div>

    <div class="card card-wide">
      <h3>Applications — Last 30 Days</h3>
      ${buildAnalyticsGraph(daily30)}
    </div>

    <div class="analytics-grid">
      <div class="card">
        <h3>By Site</h3>
        ${bySource.length
          ? bySource.map(r => barRow(r.source, r.count, maxSource, SOURCE_COLORS[r.source] || '#2563eb')).join('')
          : '<div class="empty-state">No data yet</div>'}
      </div>
      <div class="card">
        <h3>By CV</h3>
        ${byCV.length
          ? byCV.map(r => barRow(r.cv_name || 'Unknown', r.count, maxCV, '#2563eb')).join('')
          : '<div class="empty-state">No data yet</div>'}
      </div>
      <div class="card">
        <h3>Why Jobs Were Skipped</h3>
        ${skipReasons.length
          ? skipReasons.map(r => barRow(r.reason, r.count, maxSkip, '#94a3b8')).join('')
          : '<div class="empty-state">No data yet</div>'}
      </div>
    </div>

    <div class="analytics-tables">
      <div class="card">
        <h3>Top Companies Applied To</h3>
        <table class="data-table">
          <thead><tr><th>Company</th><th>Applications</th></tr></thead>
          <tbody>
            ${topCompanies.length
              ? topCompanies.map(r => `<tr><td>${r.company}</td><td>${r.count}</td></tr>`).join('')
              : '<tr><td colspan="2"><div class="empty-state">No data yet</div></td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Top Job Titles Applied To</h3>
        <table class="data-table">
          <thead><tr><th>Title</th><th>Count</th></tr></thead>
          <tbody>
            ${topTitles.length
              ? topTitles.map(r => `<tr><td>${r.title}</td><td>${r.count}</td></tr>`).join('')
              : '<tr><td colspan="2"><div class="empty-state">No data yet</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// â”€â”€ Credential modal (shared across all bot cards) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let credModalBot = null;

function ensureCredModal() {
  if (document.getElementById('cred-modal')) return;

  const el = document.createElement('div');
  el.id = 'cred-modal';
  el.className = 'cred-modal-overlay';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="cred-modal-card">
      <h3 id="cred-modal-title">Connect account</h3>
      <p class="cred-modal-hint">Stored encrypted on this device only — never sent to our servers.</p>
      <div class="field"><label>Email</label><input id="cred-email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label>Password</label><input id="cred-password" type="password" autocomplete="current-password" placeholder="••••••••"></div>
      <div class="status-msg" id="cred-status"></div>
      <div class="cred-modal-actions">
        <button class="primary" id="cred-save">Save & Connect</button>
        <button class="secondary" id="cred-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener('click', e => { if (e.target === el) el.style.display = 'none'; });
  document.getElementById('cred-cancel').addEventListener('click', () => { el.style.display = 'none'; });
  document.getElementById('cred-save').addEventListener('click', async () => {
    const email = document.getElementById('cred-email').value.trim();
    const password = document.getElementById('cred-password').value;
    const statusEl = document.getElementById('cred-status');
    if (!email) { showStatus(statusEl, 'Enter your email', 'error'); return; }
    if (!password || password.length < 6) { showStatus(statusEl, 'Password must be at least 6 characters', 'error'); return; }
    await window.api.credentials.save(credModalBot, email, password);
    el.style.display = 'none';
    await render('dashboard');
  });
}

function openCredModal(botName, existingEmail = '') {
  ensureCredModal();
  credModalBot = botName;
  document.getElementById('cred-modal-title').textContent = `Connect ${CRED_SITE_NAMES[botName]}`;
  document.getElementById('cred-email').value = existingEmail;
  document.getElementById('cred-password').value = '';
  document.getElementById('cred-status').textContent = '';
  document.getElementById('cred-modal').style.display = 'flex';
  document.getElementById('cred-email').focus();
}

// â”€â”€ Expiry banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initExpiryBanner() {
  const license = await window.api.license.get();
  if (!license?.license_key || !license.expires_at) return;

  const daysLeft = Math.ceil((new Date(license.expires_at) - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft > 14) return;

  const banner = document.getElementById('expiry-banner');
  // Professional, calm by default: brand blue while the trial is active, a
  // single amber nudge on the final day, red only once actually expired.
  const urgency = daysLeft <= 0 ? 'danger' : (daysLeft <= 1 ? 'warning' : 'info');
  const isTrial = license.status === 'trial';
  const msg = daysLeft <= 0
    ? (isTrial ? 'Your free trial has ended.' : 'Your Job-AI license has expired.')
    : (isTrial
        ? `Your free trial expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
        : `Your license expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);

  banner.className = `expiry-banner ${urgency}`;
  banner.innerHTML = `
    <span>${msg}</span>
    <button id="renew-btn">${isTrial ? 'Subscribe to continue ->' : 'Contact to Renew'}</button>
  `;
  document.getElementById('renew-btn').addEventListener('click', () => {
    if (isTrial) {
      window.open('https://jobbot-backend-production-1323.up.railway.app', '_blank');
    } else {
      window.open('mailto:merritfemi@gmail.com?subject=Job-AI%20License%20Renewal', '_blank');
    }
  });
}

// â”€â”€ Nav progress dots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function updateNavProgress() {
  const [profile, cvs, terms, license] = await Promise.all([
    window.api.profile.get(),
    window.api.cvs.get(),
    window.api.searchTerms.get(),
    window.api.license.get(),
  ]);

  const done = {
    personal: !!(profile.first_name && profile.email),
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

// â”€â”€ Onboarding tour (first launch only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TOUR_STEPS = [
  {
    view: 'personal',
    title: 'Step 1 - Your Personal Details',
    tip: 'Your name, email, phone, location, and right-to-work status are used to fill in application forms automatically. The more complete this is, the fewer forms the Agent leaves blank.',
    action: 'Fill in every field and click Save before moving on.',
  },
  {
    view: 'cvs',
    title: 'Step 2 - Upload Your CV',
    tip: 'Upload your CV as a PDF. Before each application, the AI rewrites your professional summary and your bullet points to match that specific job - naturally, so it reads well to a recruiter, not just keyword-stuffed.',
    action: 'Click “Add CV” and upload at least one PDF. You can add multiple CVs for different role types and the Agent picks the best one per job.',
  },
  {
    view: 'search',
    title: 'Step 3 - Search Preferences',
    tip: 'Add the job titles you want to apply for - for example “IT Support Analyst” or “Service Desk Engineer”. Every Agent uses these terms when searching across all job sites.',
    action: 'Add at least one search term, set your preferred work type and salary, then click Save.',
  },
  {
    view: 'license',
    title: 'Step 4 - Activate Your License',
    tip: 'Start your free trial or enter a license key. The AI that tailors your CV runs on our cloud - nothing extra to install.',
    action: 'Click “Start Free Trial” or paste your license key and click Activate.',
  },
  {
    view: 'dashboard',
    title: 'Step 5 - Connect Your Job Site Accounts',
    tip: 'On the Dashboard, each job site (Reed, LinkedIn) has a “Connect account” button. Click it and a browser window opens - just log in as normal. Your session is saved so the Agent can apply on your behalf without ever seeing your password.',
    action: 'Click “Connect account” on a job site card, log in, then close the browser window. You only need one connected to begin.',
  },
  {
    view: 'dashboard',
    title: 'All Set - Start Applying',
    tip: 'When you click Start applying, the job site Agents (Reed, LinkedIn) search and apply to matching roles - and the AI tailoring engine runs automatically in the background to customise your CV for every job before it is submitted. You do not start it yourself.',
    action: 'Click the “Start applying” button on the Dashboard. The “How to start applying” checklist there walks you through anything missing. Applications begin within minutes.',
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
          <button class="tour-next" id="tour-next">${isLast ? 'Finish setup' : 'Next ->'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#tour-next').onclick = () => {
      if (isLast) { endTour(); return; }
      step++;
      goToStep();
    };

    panel.querySelector('#tour-skip').onclick = endTour;
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

  function dismiss() {
    overlay.remove();
    try { localStorage.setItem('welcome_seen', '1'); } catch(_) {}
  }

  // Create buttons with handlers attached directly to the element reference —
  // avoids any getElementById/querySelector lookup after DOM insertion.
  const tourBtn = document.createElement('button');
  tourBtn.className = 'primary';
  tourBtn.innerHTML = 'Take the setup tour &rarr;';
  tourBtn.addEventListener('click', () => { dismiss(); startTour(); });

  const skipBtn = document.createElement('button');
  skipBtn.className = 'welcome-skip-link';
  skipBtn.innerHTML = 'I&rsquo;ll set up myself';
  skipBtn.addEventListener('click', dismiss);

  const actions = document.createElement('div');
  actions.className = 'welcome-actions';
  actions.appendChild(tourBtn);
  actions.appendChild(skipBtn);

  const modal = document.createElement('div');
  modal.className = 'welcome-modal';
  modal.innerHTML = `
    <div class=”welcome-logo”></div>
    <h2>Welcome to Job-AI</h2>
    <p>Your fully automated job application assistant. Set up once - the Agents find, tailor, and apply to jobs across multiple sites for you, around the clock.</p>
    <div class=”welcome-features”>
      <div class=”welcome-feature”><strong>6 Job Sites</strong><span>Reed, LinkedIn, Glassdoor, CV-Library, Totaljobs &amp; CWJobs</span></div>
      <div class=”welcome-feature”><strong>AI CV Tailoring</strong><span>Powered by Groq AI — no API key needed, works out of the box</span></div>
      <div class=”welcome-feature”><strong>Secure Login</strong><span>Log in once per site - session saved locally, never shared</span></div>
      <div class=”welcome-feature”><strong>Auto Apply</strong><span>Fills forms, uploads your tailored CV, and submits — hands free</span></div>
    </div>
  `;
  modal.appendChild(actions);

  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// â”€â”€ Help â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderHelp() {
  const faqs = [
    {
      q: 'How do I get started?',
      a: 'Complete the 4 setup steps in order: (1) Personal Details, (2) CVs, (3) Search Preferences, (4) License. Then go to the Dashboard, click “Connect account” on each Agent card to log in to the job site, and click Start.'
    },
    {
      q: 'Which job sites does Job-AI use?',
      a: 'Job-AI searches and applies across 6 job sites: Reed.co.uk, LinkedIn, Glassdoor, CV-Library, Totaljobs, and CWJobs. Each site has its own Agent card on the Dashboard.'
    },
    {
      q: 'How do I connect my job site accounts?',
      a: 'On the Dashboard, each Agent card has a “Connect account” button. Click it and a regular browser window opens on that site\'s login page - log in as you normally would. Your session is saved locally so the Agent can apply on your behalf. You only need to do this once per site (or when your session expires).'
    },
    {
      q: 'What are the Agents and what do they do?',
      a: 'Each job site (Reed, LinkedIn, Glassdoor, CV-Library, Totaljobs, CWJobs) has its own Agent that searches and submits applications. The Scorer Agent runs in the middle - it uses AI to tailor your CV for every role before it is submitted. Start the Scorer Agent first, then the job site Agents.'
    },
    {
      q: 'Why are some jobs showing as skipped?',
      a: 'Jobs are skipped when they do not match your preferences - for example, wrong work type, no easy apply button, external application site, or below your minimum match score. This is normal and expected.'
    },
    {
      q: 'The Agent says “not logged in” - what do I do?',
      a: 'Your session for that site has expired. Click the “Connect account” button on that Agent\'s card on the Dashboard, log in again in the browser that opens, then close it and click Start.'
    },
    {
      q: 'How do I add more CVs?',
      a: 'Go to CVs in the sidebar and click “Add CV”. You can upload multiple CVs - Job-AI will automatically select the best one for each job based on the AI match score.'
    },
    {
      q: 'What is the minimum match score?',
      a: 'Set this in Search Preferences. Job-AI will only apply to jobs where your tailored CV scores at or above this percentage. Leave it blank to apply to all matching jobs.'
    },
    {
      q: 'The Agents are running but no jobs are being found - why?',
      a: 'Your search terms may have exhausted all available jobs. Try adding more search terms in Search Preferences - for example, if you have “IT Support Analyst”, also add “IT Support Specialist” or “Help Desk Analyst”.'
    },
    {
      q: 'Windows shows a security warning when I install Job-AI - is it safe?',
      a: 'Yes, this is normal for new software that has not yet been code-signed. Click “More info” then “Run anyway” to proceed. Your device is not at risk.'
    },
    {
      q: 'Mac shows “unidentified developer” - what do I do?',
      a: 'Go to System Settings → Privacy & Security, scroll down and click “Open Anyway”. This is a standard Mac security prompt for new apps and is safe to bypass.'
    },
    {
      q: 'Are my login sessions shared or stored online?',
      a: 'No. When you click “Connect account” and log in, the session cookie is saved in a profile folder on your own device only. Job-AI never uploads or transmits your credentials or sessions anywhere.'
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

// â”€â”€ Auto-update banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (window.api?.onUpdateAvailable) {
  window.api.onUpdateAvailable(() => {
    const banner = document.getElementById('expiry-banner');
    if (banner) {
      banner.innerHTML = `<span>A new version of Job-AI is available — downloading in the background...</span>`;
      banner.style.display = 'flex';
      banner.style.background = '#0891b2';
      banner.style.color = '#fff';
    }
  });
}
if (window.api?.onUpdateReady) {
  window.api.onUpdateReady((version) => {
    const banner = document.getElementById('expiry-banner');
    if (!banner) return;
    const vLabel = version ? ` ${version}` : '';
    banner.innerHTML = `
      <span style="flex:1">✅ <strong>Job-AI${vLabel} is ready</strong> — new look &amp; smarter CV tailoring. It installs when you next close the app, or update now.</span>
      <button id="update-install-btn" style="background:#fff;color:#1d4ed8;border:none;padding:7px 16px;border-radius:7px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;margin-left:14px">Restart &amp; update now</button>`;
    banner.style.display = 'flex';
    banner.style.alignItems = 'center';
    banner.style.background = '#1d4ed8';
    banner.style.color = '#fff';

    const btn = document.getElementById('update-install-btn');
    if (btn) btn.addEventListener('click', async () => {
      // Warn if Agents are mid-run — restarting will stop them
      let running = false;
      try {
        const status = await window.api.bot.status();
        running = Object.values(status || {}).some(s => s === 'running');
      } catch (_) {}
      if (running && !window.confirm('This will stop your running Agents and restart Job-AI to finish updating. Continue?')) {
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Restarting…';
      try { await window.api.installUpdate(); } catch (_) {}
    });
  });
}

// Initial view
render('personal').then(() => {
  updateNavProgress();
  initExpiryBanner();
  initOnboarding();
}).catch(err => {
  content.innerHTML = `<div style="padding:40px;color:#e74c3c;font-family:sans-serif"><h3>Failed to load</h3><p>${err.message}</p><p>Try restarting the app.</p></div>`;
});

