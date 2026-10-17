const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  authenticate: (token) => ipcRenderer.invoke('authenticate', token),
  logout: () => ipcRenderer.invoke('logout'),
  openTokenPage: () => ipcRenderer.invoke('open-token-page'),
  getOwners: () => ipcRenderer.invoke('get-owners'),

  selectFolder: (opts) => ipcRenderer.invoke('select-folder', opts),
  analyzeFolder: (folder) => ipcRenderer.invoke('analyze-folder', folder),
  getPathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),

  sanitizeName: (name) => ipcRenderer.invoke('sanitize-name', name),
  checkRepo: (data) => ipcRenderer.invoke('check-repo', data),
  getGitignoreTemplates: () => ipcRenderer.invoke('get-gitignore-templates'),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  uploadToGithub: (data) => ipcRenderer.invoke('upload-to-github', data),
  cancelOperation: () => ipcRenderer.invoke('cancel-operation'),

  listRepos: () => ipcRenderer.invoke('list-repos'),
  cloneRepo: (data) => ipcRenderer.invoke('clone-repo', data),

  selectFiles: () => ipcRenderer.invoke('select-files'),
  describeFiles: (paths) => ipcRenderer.invoke('describe-files', paths),
  getFolderVersion: (folder) => ipcRenderer.invoke('get-folder-version', folder),
  listReleases: (data) => ipcRenderer.invoke('list-releases', data),
  createRelease: (data) => ipcRenderer.invoke('create-release', data),
  addReleaseAssets: (data) => ipcRenderer.invoke('add-release-assets', data),
  updateRelease: (data) => ipcRenderer.invoke('update-release', data),
  deleteRelease: (data) => ipcRenderer.invoke('delete-release', data),
  deleteReleaseAsset: (data) => ipcRenderer.invoke('delete-release-asset', data),
  onReleaseProgress: subscribe('release-progress'),

  getHistory:() => ipcRenderer.invoke('get-history'),
  removeHistoryItem: (id) => ipcRenderer.invoke('remove-history-item', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openLog: () => ipcRenderer.invoke('open-log'),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('toggle-maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  onProgress: subscribe('progress'),
  onLog: subscribe('log'),
  onWindowState: subscribe('window-state')
});
