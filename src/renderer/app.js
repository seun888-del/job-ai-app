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
  switch (view) {
    case 'personal':   return renderPersonal();
    case 'login':      return renderLogin();
    case 'cvs':        return renderCVs();
    case 'search':     return renderSearch();
    case 'license':    return renderLicense();
    case 'dashboard':  return renderDashboard();
    default:           return renderPersonal();
  }
}

// ── 1. Personal Details ─────────────────────────────────────────────────
async function renderPersonal() {
  const p = await window.api.profile.get();

  content.innerHTML = `
    <div class="page-header">
      <h2>Personal Details</h2>
      <p>This information is used to pre-fill job applications.</p>
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
      <div class="field"><label>Location</label><input id="location" value="${p.location || ''}"></div>
      <div class="field"><label>LinkedIn URL</label><input id="linkedin_url" value="${p.linkedin_url || ''}"></div>
    </div>

    <div class="card">
      <h3>Work Eligibility</h3>
      <div class="field"><label>Years of experience</label><input id="years_experience" type="number" min="0" value="${p.years_experience ?? 0}"></div>
      <div class="field"><label>Salary expectation (e.g. 35000 or £35,000–£40,000)</label><input id="salary_expectation" value="${p.salary_expectation || ''}"></div>
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
        <label for="driving_licence">I have a valid driving licence</label>
      </div>
      <button class="primary" id="save">Save & Continue</button>
      <div class="status-msg" id="status"></div>
    </div>
  `;

  document.getElementById('save').addEventListener('click', async () => {
    await window.api.profile.save({
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
    });
    showStatus(document.getElementById('status'), 'Saved');
  });
}

// ── 2. Job Site Login ────────────────────────────────────────────────────
async function renderLogin() {
  const [reedCred, liCred] = await Promise.all([
    window.api.credentials.get('reed'),
    window.api.credentials.get('linkedin'),
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
  `;

  document.getElementById('save-reed').addEventListener('click', async () => {
    const username = document.getElementById('reed_email').value.trim();
    const password = document.getElementById('reed_pass').value;
    const statusEl = document.getElementById('status-reed');

    if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      showStatus(statusEl, 'Enter a valid email address', 'error');
      return;
    }
    if (!password || password.length < 6) {
      showStatus(statusEl, 'Password must be at least 6 characters', 'error');
      return;
    }

    await window.api.credentials.save('reed', username, password);
    showStatus(statusEl, 'Saved — Reed Bot will open a login window on first start to verify');
  });

  document.getElementById('save-li').addEventListener('click', async () => {
    const username = document.getElementById('li_email').value.trim();
    const password = document.getElementById('li_pass').value;
    const statusEl = document.getElementById('status-li');

    if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      showStatus(statusEl, 'Enter a valid email address', 'error');
      return;
    }
    if (!password || password.length < 6) {
      showStatus(statusEl, 'Password must be at least 6 characters', 'error');
      return;
    }

    await window.api.credentials.save('linkedin', username, password);
    showStatus(statusEl, 'Saved — LinkedIn Bot will open a browser window on first start');
  });
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
const BOT_LABELS = { reed: 'Reed Bot', scorer: 'Scorer Bot', linkedin: 'LinkedIn Bot' };

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

function statusBadgeClass(status) {
  switch (status) {
    case 'applied': return 'badge-success';
    case 'apply_failed': return 'badge-danger';
    case 'skipped': return 'badge-muted';
    default: return 'badge-info';
  }
}

async function renderDashboard() {
  const [summary, recent, status, license] = await Promise.all([
    window.api.queue.summary(),
    window.api.queue.recent(20),
    window.api.bot.status(),
    window.api.license.get(),
  ]);
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

    <div class="bot-controls">
      ${Object.entries(BOT_LABELS).map(([key, label]) => `
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

// Initial view
render('personal').then(() => {
  updateNavProgress();
  initExpiryBanner();
  initOnboarding();
});
