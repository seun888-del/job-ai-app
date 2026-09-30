// Clicking the Job-AI icon opens (or focuses) the dashboard tab, which runs the agents.
const URL = chrome.runtime.getURL('dashboard.html');

async function openDashboard() {
  const [tab] = await chrome.tabs.query({ url: URL });
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return; }
  await chrome.tabs.create({ url: URL, pinned: true });
}

chrome.action.onClicked.addListener(openDashboard);
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === 'install') openDashboard(); });
