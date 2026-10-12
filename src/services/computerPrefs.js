// computerPrefs.js
// "This computer" settings, changeable in the app or from the phone (tryjobai.com/app):
//   keepAwake    stop the computer going to sleep while agents run (on by default). A laptop
//                with its lid closed still sleeps: that is the operating system's choice.
//   openAtLogin  open Job-AI when the computer starts, minimised, and start again the agents
//                that were running when it last shut down (off by default).
// Stored in userData/computer.json. Only the packaged app registers itself to open at login.

const fs = require('fs');
const path = require('path');
const { app, powerSaveBlocker } = require('electron');

const LOGIN_ARG = '--from-login';
let file = null, prefs = { keepAwake: true, openAtLogin: false, resume: [] }, blocker = null, quitting = false;

function save() { try { fs.writeFileSync(file, JSON.stringify(prefs)); } catch (_) {} }

function applyLogin() {
  if (!app.isPackaged) return; // never register the development build to open at login
  try { app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin, openAsHidden: true, args: [LOGIN_ARG] }); } catch (_) {}
}

function init() {
  file = path.join(app.getPath('userData'), 'computer.json');
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  applyLogin();
}

const get = () => ({ keepAwake: prefs.keepAwake !== false, openAtLogin: !!prefs.openAtLogin });

function set(p) {
  if (typeof p.keepAwake === 'boolean') prefs.keepAwake = p.keepAwake;
  if (typeof p.openAtLogin === 'boolean') prefs.openAtLogin = p.openAtLogin;
  save(); applyLogin(); update(lastStatus);
  return get();
}

// Called on every agent status change: hold the computer awake while any agent runs, and
// remember which agents are running so a start at login can carry on with them.
let lastStatus = {};
function update(status) {
  lastStatus = status || {};
  const running = Object.keys(lastStatus).filter((k) => lastStatus[k] === 'running' && k !== 'uc');
  const want = running.length > 0 && prefs.keepAwake !== false;
  if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blocker !== null) { try { powerSaveBlocker.stop(blocker); } catch (_) {} blocker = null; }
  // While quitting or shutting down, agents stop because the app is closing: keep the list.
  if (!quitting && running.join() !== (prefs.resume || []).join()) { prefs.resume = running; save(); }
}
const markQuitting = () => { quitting = true; };
const isAwakeHeld = () => blocker !== null;

const openedAtLogin = () => process.argv.includes(LOGIN_ARG) || (process.platform === 'darwin' && !!(app.getLoginItemSettings().wasOpenedAtLogin));
const resumeList = () => (prefs.openAtLogin ? (prefs.resume || []).slice() : []);

module.exports = { init, get, set, update, markQuitting, isAwakeHeld, openedAtLogin, resumeList };
