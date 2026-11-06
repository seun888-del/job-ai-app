// Clicking the Job-AI icon opens (or focuses) the dashboard tab, which runs the agents.
const URL = chrome.runtime.getURL('dashboard.html');

async function openDashboard(quiet) {
  const [tab] = await chrome.tabs.query({ url: URL });
  if (tab) { if (quiet !== true) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } return; }
  await chrome.tabs.create({ url: URL, pinned: true, active: quiet !== true });
}

chrome.action.onClicked.addListener(() => openDashboard());
// "Open when Chrome starts" (dashboard, This computer): open the dashboard in the background and
// tell it Chrome has just started, so it carries on with the agents that were running.
chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings || !settings.openOnStartup) return;
  await chrome.storage.local.set({ startupOpen: Date.now() });
  openDashboard(true);
});
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') openDashboard();
  // People who had Job-AI before extra job sites (0.5.41) see a one-time Dashboard card about them.
  if (d.reason === 'update' && d.previousVersion) {
    const [a, b, c] = d.previousVersion.split('.').map(Number);
    const before = a < 0 || (a === 0 && (b < 5 || (b === 5 && c < 41)));
    if (before && !(await chrome.storage.local.get('extraNotice')).extraNotice) await chrome.storage.local.set({ extraNotice: 'show' });
  }
  // Back after an update the dashboard asked for: reopen it so the agents pick up again.
  if (d.reason === 'update' && (await chrome.storage.local.get('resumeAfterUpdate')).resumeAfterUpdate) openDashboard();
});

// A new version from the Web Store. Left alone, Chrome swaps it in as soon as the extension
// goes idle, which closes the dashboard tab (where the agents run) mid-application. So: with
// no dashboard open, update now; otherwise flag it and the dashboard updates at a safe moment.
chrome.runtime.onUpdateAvailable.addListener(async (d) => {
  const [tab] = await chrome.tabs.query({ url: URL });
  if (!tab) { chrome.runtime.reload(); return; }
  await chrome.storage.local.set({ updatePending: d.version });
});
