const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  profile: {
    get: () => ipcRenderer.invoke('profile:get'),
    save: (fields) => ipcRenderer.invoke('profile:save', fields),
  },
  searchPrefs: {
    get: () => ipcRenderer.invoke('searchPrefs:get'),
    save: (fields) => ipcRenderer.invoke('searchPrefs:save', fields),
  },
  searchTerms: {
    get: () => ipcRenderer.invoke('searchTerms:get'),
    add: (terms, source) => ipcRenderer.invoke('searchTerms:add', terms, source),
    delete: (id) => ipcRenderer.invoke('searchTerms:delete', id),
    setActive: (id, isActive) => ipcRenderer.invoke('searchTerms:setActive', id, isActive),
  },
  excludeKeywords: {
    get: () => ipcRenderer.invoke('excludeKeywords:get'),
    add: (keyword) => ipcRenderer.invoke('excludeKeywords:add', keyword),
    delete: (id) => ipcRenderer.invoke('excludeKeywords:delete', id),
    setActive: (id, isActive) => ipcRenderer.invoke('excludeKeywords:setActive', id, isActive),
  },
  cvs: {
    get: () => ipcRenderer.invoke('cvs:get'),
    pickAndAdd: (label) => ipcRenderer.invoke('cvs:pickAndAdd', label),
    addSuggestedTerms: (cvId) => ipcRenderer.invoke('cvs:addSuggestedTerms', cvId),
  },
  credentials: {
    save: (site, username, password) => ipcRenderer.invoke('credentials:save', { site, username, password }),
    get: (site) => ipcRenderer.invoke('credentials:get', site),
  },
  queue: {
    summary: () => ipcRenderer.invoke('queue:summary'),
    recent: (limit) => ipcRenderer.invoke('queue:recent', limit),
  },
  bot: {
    start: (botName) => ipcRenderer.invoke('bot:start', botName),
    stop: (botName) => ipcRenderer.invoke('bot:stop', botName),
    status: () => ipcRenderer.invoke('bot:status'),
    onLog: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('bot:log', handler);
      return () => ipcRenderer.removeListener('bot:log', handler);
    },
    onStatus: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('bot:status', handler);
      return () => ipcRenderer.removeListener('bot:status', handler);
    },
  },
  shell: {
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
  license: {
    get: () => ipcRenderer.invoke('license:get'),
    save: (fields) => ipcRenderer.invoke('license:save', fields),
    verify: (key) => ipcRenderer.invoke('license:verify', key),
    startTrial: (email) => ipcRenderer.invoke('license:startTrial', email),
  },
});
