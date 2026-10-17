const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, clipboard, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const tls = require('tls');

// Портативный Git, который скачивает запуск.bat, если Git не установлен в системе
const LOCAL_GIT = path.join(__dirname, 'runtime', 'git', 'cmd');
if (fs.existsSync(LOCAL_GIT)) process.env.PATH = LOCAL_GIT + path.delimiter + process.env.PATH;

const USER_DATA = app.getPath('userData');
const LOG_FILE = path.join(USER_DATA, 'gitloader.log');
const TOKEN_FILE = path.join(USER_DATA, 'github_token.enc');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');
const HISTORY_FILE = path.join(USER_DATA, 'history.json');

const GITHUB_LIMIT = 100 * 1024 * 1024;
const GITHUB_WARN = 50 * 1024 * 1024;
const HISTORY_LIMIT = 100;

const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultPrivate: false,
  defaultBranch: 'main',
  openAfterUpload: false,
  authorMode: 'github',
  authorName: '',
  authorEmail: ''
};

const FALLBACK_GITIGNORE = {
  Node: 'node_modules/\nnpm-debug.log*\nyarn-error.log*\n.env\n.env.local\ndist/\nbuild/\ncoverage/\n.DS_Store\n',
  Python: '__pycache__/\n*.py[cod]\n.venv/\nvenv/\nenv/\n.env\n*.egg-info/\ndist/\nbuild/\n.pytest_cache/\n',
  VisualStudio: '.vs/\nbin/\nobj/\n*.user\n*.suo\n[Dd]ebug/\n[Rr]elease/\npackages/\n',
  Java: '*.class\n*.jar\n*.war\ntarget/\nbuild/\n.gradle/\n.idea/\n*.iml\n',
  Unity: '[Ll]ibrary/\n[Tt]emp/\n[Oo]bj/\n[Bb]uild/\n[Bb]uilds/\n[Ll]ogs/\n[Uu]ser[Ss]ettings/\n*.csproj\n*.sln\n',
  Go: '*.exe\n*.test\n*.out\nvendor/\n',
  Rust: 'target/\n',
  'C++': '*.o\n*.obj\n*.exe\n*.dll\n*.so\n*.a\n*.lib\nbuild/\n'
};

const LICENSES = [
  { key: 'mit', name: 'MIT' },
  { key: 'apache-2.0', name: 'Apache 2.0' },
  { key: 'gpl-3.0', name: 'GPL v3' },
  { key: 'bsd-3-clause', name: 'BSD 3-Clause' },
  { key: 'unlicense', name: 'Unlicense' }
];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

let mainWindow = null;
let auth = { token: null, user: null, scopes: null };
let settings = { ...DEFAULT_SETTINGS };
let gitVersion = null;
let currentProc = null;
let cancelRequested = false;
let busy = false;
let gitignoreTemplatesCache = null;
let currentRequest = null;

// ---------- Утилиты ----------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    writeLog('error', 'Не удалось прочитать ' + path.basename(file) + ': ' + e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function basicAuthValue() {
  if (!auth.token) return null;
  const login = (auth.user && auth.user.login) || 'x-access-token';
  return Buffer.from(login + ':' + auth.token).toString('base64');
}

function mask(text) {
  let s = String(text);
  for (const secret of [auth.token, basicAuthValue()]) {
    if (secret) s = s.split(secret).join('***');
  }
  return s
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(https?:\/\/)[^@\s/]+@/g, '$1');
}

function writeLog(level, msg) {
  const clean = mask(msg);
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${clean}\n`);
  } catch (e) {}
  if (level === 'error') console.error(clean); else console.log(clean);
}

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch (e) {}
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function uiLog(text, type = 'info') {
  writeLog(type === 'error' ? 'error' : 'info', text);
  send('log', { text: mask(text), type, time: Date.now() });
}

function progress(step, percent, stage) {
  send('progress', { step, progress: percent, stage });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
}

function sanitizeRepoName(name) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  let s = String(name || '').trim().replace(/[а-яё]/gi, (c) => {
    const lower = c.toLowerCase();
    const t = map[lower] || '';
    return c === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
  });
  s = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (s === '.' || s === '..') s = '';
  return s.slice(0, 100);
}

class CancelError extends Error {
  constructor() { super('Операция отменена'); this.cancelled = true; }
}

function checkCancel() {
  if (cancelRequested) throw new CancelError();
}

function openUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
}

// ---------- Настройки, история, токен ----------

function loadSettings() {
  settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
}

function saveSettings(patch) {
  const next = { ...settings };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (!['dark', 'light', 'system'].includes(next.theme)) next.theme = 'dark';
  if (!['github', 'custom', 'git'].includes(next.authorMode)) next.authorMode = 'github';
  next.defaultBranch = String(next.defaultBranch || 'main').trim() || 'main';
  settings = next;
  writeJson(SETTINGS_FILE, settings);
  applyTheme();
  return settings;
}

function applyTheme() {
  nativeTheme.themeSource = settings.theme;
  if (mainWindow) mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f5f6fa');
}

function loadHistory() {
  const h = readJson(HISTORY_FILE, []);
  return Array.isArray(h) ? h : [];
}

function addHistory(entry) {
  const history = loadHistory().filter(h => !(h.folder === entry.folder && h.fullName === entry.fullName));
  history.unshift(entry);
  writeJson(HISTORY_FILE, history.slice(0, HISTORY_LIMIT));
}

function saveToken(token, user) {
  const payload = JSON.stringify({ token, user });
  let file;
  if (safeStorage.isEncryptionAvailable()) {
    file = { v: 2, enc: safeStorage.encryptString(payload).toString('base64') };
  } else {
    file = { v: 2, plain: Buffer.from(payload).toString('base64') };
  }
  writeJson(TOKEN_FILE, file);
}

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    let data = null;
    try {
      const file = JSON.parse(raw);
      if (file.enc) data = JSON.parse(safeStorage.decryptString(Buffer.from(file.enc, 'base64')));
      else if (file.plain) data = JSON.parse(Buffer.from(file.plain, 'base64').toString('utf8'));
    } catch (e) {
      // Формат старой версии: base64 от {token, username} или от самого токена
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      try {
        const legacy = JSON.parse(decoded);
        data = { token: legacy.token, user: legacy.username ? { login: legacy.username } : null };
      } catch (e2) {
        data = { token: decoded, user: null };
      }
      if (data.token) saveToken(data.token, data.user);
    }
    if (data && data.token) {
      auth.token = data.token;
      auth.user = data.user || null;
    }
  } catch (e) {
    writeLog('error', 'Ошибка загрузки токена: ' + e.message);
  }
}

function clearToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (e) {
    writeLog('error', 'Ошибка удаления токена: ' + e.message);
  }
  auth = { token: null, user: null, scopes: null };
}

// ---------- GitHub API ----------

function describeApiError(status, data, headers) {
  const msg = data && data.message ? data.message : '';
  if (status === 401) return 'Токен недействителен или истёк. Войдите заново.';
  if (status === 403 && headers && headers.get('x-ratelimit-remaining') === '0') {
    return 'Превышен лимит запросов к GitHub. Попробуйте позже.';
  }
  if (status === 403) return 'Нет доступа: у токена недостаточно прав (нужно право repo). ' + msg;
  if (status === 404) return 'Не найдено';
  if (status === 422 && data && Array.isArray(data.errors)) {
    return data.errors.map(e => e.message || e.code).join('; ') || msg;
  }
  return msg || 'Ошибка GitHub API (' + status + ')';
}

async function githubRequest(method, endpoint, body, opts = {}) {
  const token = opts.token || auth.token;
  if (!token) {
    const e = new Error('Требуется авторизация');
    e.status = 401;
    throw e;
  }
  const url = endpoint.startsWith('https://') ? endpoint : 'https://api.github.com' + endpoint;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (body) headers['Content-Type'] = 'application/json';

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await net.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {}
      if (res.ok) return opts.raw ? { data, headers: res.headers } : data;

      const err = new Error(describeApiError(res.status, data, res.headers));
      err.status = res.status;
      err.data = data;
      if (res.status >= 500) {
        lastErr = err;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (e) {
      if (e.status) throw e;
      lastErr = new Error('Нет соединения с GitHub: ' + e.message);
      lastErr.network = true;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function githubPaged(endpoint, maxPages = 10) {
  const items = [];
  const sep = endpoint.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page++) {
    const data = await githubRequest('GET', endpoint + sep + 'per_page=100&page=' + page);
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

function publicUser(u) {
  if (!u) return null;
  return { login: u.login, name: u.name || null, id: u.id || null, avatar_url: u.avatar_url || null, html_url: u.html_url || null };
}

// ---------- Git ----------

function runGit(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const full = ['-c', 'core.quotepath=false'];
    if (opts.auth) {
      const basic = basicAuthValue();
      if (basic) full.push('-c', 'credential.helper=', '-c', 'http.extraHeader=Authorization: Basic ' + basic);
    }
    full.push(...args);

    if (!opts.quiet) uiLog('$ git ' + args.join(' '), 'cmd');

    let proc;
    try {
      proc = spawn('git', full, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LANGUAGE: 'en', LC_ALL: 'C.UTF-8' }
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, notFound: true });
      return;
    }
    currentProc = proc;

    let stdout = '';
    let stderr = '';
    let pending = '';

    const emit = (chunk) => {
      pending += chunk;
      const parts = pending.split(/\r|\n/);
      pending = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        if (opts.onLine) opts.onLine(line);
        if (!opts.quiet) uiLog(line, 'out');
      }
    };

    proc.stdout.on('data', d => { const s = d.toString(); stdout += s; if (opts.stream) emit(s); });
    proc.stderr.on('data', d => { const s = d.toString(); stderr += s; emit(s); });

    proc.on('close', (code) => {
      if (currentProc === proc) currentProc = null;
      if (pending.trim() && !opts.quiet) uiLog(pending, 'out');
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (e) => {
      if (currentProc === proc) currentProc = null;
      resolve({ code: -1, stdout, stderr: e.message, notFound: e.code === 'ENOENT' });
    });
  });
}

async function git(args, cwd, opts = {}) {
  checkCancel();
  const r = await runGit(args, cwd, opts);
  checkCancel();
  if (r.notFound) throw new Error('Git не найден. Установите Git: https://git-scm.com/downloads');
  if (r.code !== 0 && !opts.allowFail) {
    const lines = (r.stderr || r.stdout).trim().split('\n').filter(Boolean);
    const err = new Error(mask(lines.slice(-3).join(' ')) || 'Команда git завершилась с ошибкой');
    err.stderr = r.stderr;
    throw err;
  }
  return r;
}

// git не видит системный прокси Windows (его ставят VPN-клиенты) — передаём его через переменные окружения
async function applySystemProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
  try {
    const rule = await session.defaultSession.resolveProxy('https://github.com');
    const m = rule.match(/(?:PROXY|HTTPS)\s+([^;\s]+)/i);
    if (m) {
      process.env.HTTPS_PROXY = 'http://' + m[1];
      process.env.HTTP_PROXY = 'http://' + m[1];
      writeLog('info', 'Используется системный прокси: ' + m[1]);
    }
  } catch (e) {}
}

async function detectGit() {
  const r = await runGit(['--version'], undefined, { quiet: true });
  gitVersion = r.code === 0 ? r.stdout.trim().replace(/^git version\s*/, '') : null;
  return gitVersion;
}

async function authorArgs(cwd) {
  if (settings.authorMode === 'custom' && settings.authorName && settings.authorEmail) {
    return ['-c', 'user.name=' + settings.authorName, '-c', 'user.email=' + settings.authorEmail];
  }
  if (settings.authorMode === 'git') {
    const name = await runGit(['config', 'user.name'], cwd, { quiet: true });
    const email = await runGit(['config', 'user.email'], cwd, { quiet: true });
    if (name.code === 0 && email.code === 0 && name.stdout.trim() && email.stdout.trim()) return [];
  }
  const u = auth.user || {};
  const login = u.login || 'gitloader';
  const email = u.id ? `${u.id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  return ['-c', 'user.name=' + (u.name || login), '-c', 'user.email=' + email];
}

function classifyPushError(stderr) {
  const s = stderr || '';
  if (/GH001|exceeds GitHub's file size limit|Large files detected/i.test(s)) return 'LARGE_FILE';
  if (/non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(s)) return 'CONFLICT';
  if (/protected branch|GH006/i.test(s)) return 'PROTECTED';
  if (/Authentication failed|403|401|Permission to .* denied|could not read Username/i.test(s)) return 'AUTH';
  if (/RPC failed|timed out|timeout|Could not resolve host|early EOF|Connection (reset|refused)|unexpected disconnect|SSL|TLS/i.test(s)) return 'NETWORK';
  return 'UNKNOWN';
}

// ---------- Анализ папки ----------

function detectProjectTypes(names) {
  const has = (n) => names.has(n);
  const types = [];
  if (has('package.json')) types.push('Node');
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('Pipfile')) types.push('Python');
  if (has('pom.xml')) types.push('Maven');
  if (has('build.gradle') || has('build.gradle.kts')) types.push('Gradle');
  if ([...names].some(n => /\.(sln|csproj)$/i.test(n))) types.push('VisualStudio');
  if (has('Cargo.toml')) types.push('Rust');
  if (has('go.mod')) types.push('Go');
  if (has('ProjectSettings') && has('Assets')) types.push('Unity');
  if (has('CMakeLists.txt')) types.push('C++');
  if (has('composer.json')) types.push('Composer');
  if (has('pubspec.yaml')) types.push('Dart');
  return types;
}

async function analyzeFolder(dir) {
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new Error('Это не папка');

  const top = await fsp.readdir(dir);
  const topSet = new Set(top);
  const result = {
    path: dir,
    name: path.basename(dir),
    files: 0,
    size: 0,
    empty: top.length === 0,
    largeFiles: [],
    bigFiles: [],
    truncated: false,
    hasGit: topSet.has('.git'),
    hasGitignore: topSet.has('.gitignore'),
    hasReadme: top.some(n => /^readme(\.|$)/i.test(n)),
    hasLicense: top.some(n => /^(license|licence|copying)(\.|$)/i.test(n)),
    hasNodeModules: topSet.has('node_modules'),
    types: detectProjectTypes(topSet),
    remote: null,
    remoteRepo: null,
    remoteHasToken: false,
    branch: null,
    commits: null,
    changes: null
  };

  const started = Date.now();
  const stack = [dir];
  while (stack.length) {
    if (result.files > 200000 || Date.now() - started > 5000) { result.truncated = true; break; }
    const current = stack.pop();
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch (e) { continue; }
        result.files++;
        result.size += size;
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (size > GITHUB_LIMIT) result.largeFiles.push({ path: rel, size: formatSize(size) });
        else if (size > GITHUB_WARN) result.bigFiles.push({ path: rel, size: formatSize(size) });
      }
    }
  }
  result.sizeText = formatSize(result.size);

  if (result.hasGit && gitVersion) {
    const remote = await runGit(['remote', 'get-url', 'origin'], dir, { quiet: true });
    if (remote.code === 0) {
      const url = remote.stdout.trim();
      result.remoteHasToken = /https?:\/\/[^/\s]*@/.test(url);
      result.remote = mask(url);
      const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
      if (m) result.remoteRepo = { owner: m[1], name: m[2] };
    }
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, { quiet: true });
    if (branch.code === 0) result.branch = branch.stdout.trim();
    else {
      const sym = await runGit(['symbolic-ref', '--short', 'HEAD'], dir, { quiet: true });
      if (sym.code === 0) result.branch = sym.stdout.trim();
    }
    const count = await runGit(['rev-list', '--count', 'HEAD'], dir, { quiet: true });
    result.commits = count.code === 0 ? parseInt(count.stdout.trim(), 10) : 0;
    const status = await runGit(['status', '--porcelain'], dir, { quiet: true });
    if (status.code === 0) result.changes = status.stdout.split('\n').filter(Boolean).length;
  }
  return result;
}

// ---------- Подготовка файлов ----------

async function getGitignoreTemplate(name) {
  try {
    const data = await githubRequest('GET', '/gitignore/templates/' + encodeURIComponent(name));
    if (data && data.source) return data.source;
  } catch (e) {
    uiLog('Шаблон .gitignore из GitHub недоступен: ' + e.message, 'warn');
  }
  return FALLBACK_GITIGNORE[name] || null;
}

async function getLicenseText(key) {
  const data = await githubRequest('GET', '/licenses/' + encodeURIComponent(key));
  const u = auth.user || {};
  const year = String(new Date().getFullYear());
  return String(data.body || '')
    .replace(/\[year\]|\[yyyy\]/g, year)
    .replace(/\[fullname\]|\[name of copyright owner\]/g, u.name || u.login || '');
}

function gitignoreHas(content, entry) {
  const clean = entry.replace(/^\/|\/$/g, '');
  return content.split(/\r?\n/).some(l => l.trim().replace(/^\/|\/$/g, '') === clean);
}

async function appendGitignore(folder, lines) {
  const file = path.join(folder, '.gitignore');
  let content = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '';
  const add = lines.filter(l => !gitignoreHas(content, l));
  if (!add.length) return false;
  if (content && !content.endsWith('\n')) content += '\n';
  await fsp.writeFile(file, content + add.join('\n') + '\n');
  return true;
}

async function prepareFiles(folder, opts, info, warnings) {
  const gitignorePath = path.join(folder, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    let content = null;
    let template = opts.gitignore;
    if (template === 'auto') template = info.types[0] || null;
    if (template && template !== 'none') {
      content = await getGitignoreTemplate(template);
      if (content) uiLog('Создан .gitignore по шаблону ' + template, 'ok');
    }
    if (!content && template !== 'none') {
      content = 'node_modules/\ndist/\n*.log\n.env\n.DS_Store\nThumbs.db\n';
      uiLog('Создан базовый .gitignore', 'ok');
    }
    if (content) await fsp.writeFile(gitignorePath, content);
  }

  if (info.hasNodeModules) {
    if (await appendGitignore(folder, ['node_modules/'])) uiLog('node_modules/ добавлен в .gitignore', 'ok');
  }
  if (await appendGitignore(folder, ['.env'])) uiLog('.env добавлен в .gitignore (секреты не попадут в репозиторий)', 'ok');

  if (opts.addReadme && !info.hasReadme) {
    const title = opts.repoName;
    const body = `# ${title}\n\n${opts.description ? opts.description + '\n' : ''}`;
    await fsp.writeFile(path.join(folder, 'README.md'), body);
    uiLog('Создан README.md', 'ok');
  }

  if (opts.license && opts.license !== 'none' && !info.hasLicense) {
    try {
      await fsp.writeFile(path.join(folder, 'LICENSE'), await getLicenseText(opts.license));
      uiLog('Добавлена лицензия ' + opts.license.toUpperCase(), 'ok');
    } catch (e) {
      warnings.push('Не удалось добавить лицензию: ' + e.message);
    }
  }
}

async function unstageLargeFiles(folder, warnings) {
  const r = await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=AM'], folder, { quiet: true });
  const files = r.stdout.split('\0').filter(Boolean);
  const removed = [];
  for (const rel of files) {
    try {
      const size = (await fsp.stat(path.join(folder, rel))).size;
      if (size > GITHUB_LIMIT) {
        await git(['rm', '--cached', '-q', '--', rel], folder);
        removed.push('/' + rel);
        warnings.push(`Файл ${rel} (${formatSize(size)}) больше 100 МБ — исключён и добавлен в .gitignore`);
      } else if (size > GITHUB_WARN) {
        warnings.push(`Файл ${rel} весит ${formatSize(size)} — GitHub рекомендует файлы до 50 МБ`);
      }
    } catch (e) {}
  }
  if (removed.length) {
    await appendGitignore(folder, removed);
    await git(['add', '.gitignore'], folder);
  }
}

// ---------- Окно ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f5f6fa',
    title: 'GitLoader',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openUrl(url);
    }
  });

  mainWindow.on('maximize', () => send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => send('window-state', { maximized: false }));
  mainWindow.on('close', (e) => {
    if (busy) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Остаться', 'Закрыть'],
        defaultId: 0,
        cancelId: 0,
        title: 'GitLoader',
        message: 'Идёт загрузка. Закрыть приложение и прервать операцию?'
      });
      if (choice === 0) e.preventDefault();
      else if (currentProc) currentProc.kill();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    rotateLog();
    loadSettings();
    loadToken();
    applyTheme();
    await applySystemProxy();
    await detectGit();
    writeLog('info', 'GitLoader ' + app.getVersion() + ' запущен, git: ' + (gitVersion || 'не найден'));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: авторизация ----------

ipcMain.handle('get-auth-status', async () => {
  if (!auth.token) return { authenticated: false };
  try {
    const { data, headers } = await githubRequest('GET', '/user', null, { raw: true });
    auth.user = publicUser(data);
    auth.scopes = headers.get('x-oauth-scopes');
    saveToken(auth.token, auth.user);
    return { authenticated: true, user: auth.user, scopes: auth.scopes };
  } catch (e) {
    if (e.status === 401) {
      clearToken();
      return { authenticated: false, error: e.message };
    }
    // Без сети не выходим из аккаунта — работаем с сохранёнными данными
    return { authenticated: true, offline: true, user: auth.user || { login: 'GitHub' }, error: e.message };
  }
});

ipcMain.handle('authenticate', async (event, token) => {
  token = String(token || '').trim();
  if (!token) return { success: false, error: 'Вставьте токен' };
  try {
    const { data, headers } = await githubRequest('GET', '/user', null, { raw: true, token });
    auth = { token, user: publicUser(data), scopes: headers.get('x-oauth-scopes') };
    saveToken(token, auth.user);
    writeLog('info', 'Вход выполнен: ' + auth.user.login);
    const warning = auth.scopes !== null && auth.scopes !== undefined && !/\brepo\b/.test(auth.scopes)
      ? 'У токена нет права repo — создание и загрузка репозиториев может не работать.'
      : null;
    return { success: true, user: auth.user, scopes: auth.scopes, warning };
  } catch (e) {
    writeLog('error', 'Ошибка входа: ' + e.message);
    return { success: false, error: e.message || 'Ошибка авторизации. Проверьте токен.' };
  }
});

ipcMain.handle('open-token-page', () => {
  const url = 'https://github.com/settings/tokens/new?description=GitLoader&scopes=repo,read:org';
  openUrl(url);
  return { success: true, url };
});

ipcMain.handle('logout', () => {
  clearToken();
  return { success: true };
});

ipcMain.handle('get-owners', async () => {
  const owners = [];
  if (auth.user) owners.push({ login: auth.user.login, type: 'user', avatar_url: auth.user.avatar_url });
  try {
    const orgs = await githubRequest('GET', '/user/orgs?per_page=100');
    for (const o of orgs || []) owners.push({ login: o.login, type: 'org', avatar_url: o.avatar_url });
  } catch (e) {
    writeLog('info', 'Организации недоступны: ' + e.message);
  }
  return owners;
});

// ---------- IPC: файлы и окно ----------

ipcMain.handle('select-folder', async (event, opts = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Выберите папку проекта',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('analyze-folder', async (event, folder) => {
  try {
    return { success: true, info: await analyzeFolder(folder) };
  } catch (e) {
    return { success: false, error: e.code === 'ENOENT' ? 'Папка не найдена' : e.message };
  }
});

ipcMain.handle('sanitize-name', (event, name) => sanitizeRepoName(name));

ipcMain.handle('check-repo', async (event, { owner, name }) => {
  const sanitized = sanitizeRepoName(name);
  if (!sanitized) return { valid: false, sanitized };
  const fullOwner = owner || (auth.user && auth.user.login);
  try {
    const repo = await githubRequest('GET', `/repos/${encodeURIComponent(fullOwner)}/${encodeURIComponent(sanitized)}`);
    return {
      valid: true, sanitized, exists: true,
      fullName: repo.full_name, private: repo.private, htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      canPush: !repo.permissions || repo.permissions.push
    };
  } catch (e) {
    if (e.status === 404) return { valid: true, sanitized, exists: false };
    return { valid: true, sanitized, exists: null, error: e.message };
  }
});

ipcMain.handle('get-gitignore-templates', async () => {
  if (gitignoreTemplatesCache) return gitignoreTemplatesCache;
  try {
    const list = await githubRequest('GET', '/gitignore/templates');
    if (Array.isArray(list) && list.length) gitignoreTemplatesCache = list;
  } catch (e) {}
  return gitignoreTemplatesCache || Object.keys(FALLBACK_GITIGNORE);
});

ipcMain.handle('get-licenses', () => LICENSES);

ipcMain.handle('open-external', (event, url) => openUrl(url));

ipcMain.handle('open-path', async (event, p) => {
  if (!p || !fs.existsSync(p)) return { success: false, error: 'Путь не найден' };
  const err = await shell.openPath(p);
  return { success: !err, error: err || null };
});

ipcMain.handle('copy-text', (event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('open-log', async () => {
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  return shell.openPath(LOG_FILE);
});

ipcMain.handle('get-app-info', async () => {
  await detectGit();
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    git: gitVersion,
    platform: process.platform,
    logFile: LOG_FILE,
    encrypted: safeStorage.isEncryptionAvailable()
  };
});

ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (event, patch) => saveSettings(patch));

ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('remove-history-item', (event, id) => {
  writeJson(HISTORY_FILE, loadHistory().filter(h => h.id !== id));
  return loadHistory();
});
ipcMain.handle('clear-history', () => {
  writeJson(HISTORY_FILE, []);
  return [];
});

ipcMain.handle('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.handle('toggle-maximize-window', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('close-window', () => mainWindow && mainWindow.close());

ipcMain.handle('cancel-operation', () => {
  if (!busy) return false;
  cancelRequested = true;
  if (currentProc) currentProc.kill();
  if (currentRequest) currentRequest.abort();
  uiLog('Отмена операции...', 'warn');
  return true;
});

// ---------- IPC: репозитории ----------

ipcMain.handle('list-repos', async () => {
  try {
    const repos = await githubPaged('/user/repos?sort=updated&affiliation=owner,collaborator,organization_member');
    return {
      success: true,
      repos: repos.map(r => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        owner: r.owner && r.owner.login,
        description: r.description,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        language: r.language,
        stars: r.stargazers_count,
        updatedAt: r.pushed_at || r.updated_at,
        htmlUrl: r.html_url,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
        size: r.size
      }))
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clone-repo', async (event, { fullName, cloneUrl, parentFolder }) => {
  if (busy) return { success: false, error: 'Уже выполняется другая операция' };
  if (!gitVersion && !(await detectGit())) return { success: false, error: 'Git не найден. Установите Git: https://git-scm.com/downloads' };
  const name = String(fullName || '').split('/').pop();
  const dest = path.join(parentFolder, name);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return { success: false, error: `Папка ${dest} уже существует и не пуста` };
  }
  busy = true;
  cancelRequested = false;
  try {
    progress('clone', 5, 'Клонирование ' + fullName + '...');
    await git(['clone', '--progress', cloneUrl, dest], parentFolder, {
      auth: true,
      onLine: (line) => {
        const m = line.match(/(Receiving objects|Resolving deltas):\s+(\d+)%/);
        if (m) {
          const p = m[1] === 'Receiving objects' ? 5 + parseInt(m[2], 10) * 0.8 : 85 + parseInt(m[2], 10) * 0.15;
          progress('clone', Math.round(p), m[1] === 'Receiving objects' ? `Получение объектов: ${m[2]}%` : `Обработка: ${m[2]}%`);
        }
      }
    });
    progress('clone', 100, 'Готово');
    uiLog('Репозиторий склонирован в ' + dest, 'ok');
    return { success: true, path: dest };
  } catch (e) {
    return { success: false, error: e.message, cancelled: !!e.cancelled };
  } finally {
    busy = false;
    cancelRequested = false;
  }
});

// ---------- IPC: релизы ----------

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

// Поле size у репозитория GitHub пересчитывает с задержкой (у свежих репозиториев там 0),
// поэтому пустоту проверяем по наличию коммитов: для пустого репозитория API отвечает 409
async function isRepoEmpty(owner, repo) {
  try {
    await githubRequest('GET', `${repoPath(owner, repo)}/commits?per_page=1`);
    return false;
  } catch (e) {
    if (e.status === 409) return true;
    return false;
  }
}

function mapRelease(r) {
  return {
    id: r.id,
    tag: r.tag_name,
    name: r.name,
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    target: r.target_commitish,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    uploadUrl: r.upload_url,
    author: r.author && r.author.login,
    assets: (r.assets || []).map(a => ({
      id: a.id,
      name: a.name,
      size: a.size,
      sizeText: formatSize(a.size),
      downloads: a.download_count,
      url: a.browser_download_url,
      state: a.state
    }))
  };
}

// Прокси для прямых HTTPS-соединений Node.js (системный прокси Windows или HTTPS_PROXY)
async function getProxyFor(url) {
  try {
    const rule = await session.defaultSession.resolveProxy(url);
    const m = rule.match(/PROXY\s+([^;\s]+)/i);
    if (m) {
      const u = new URL('http://' + m[1]);
      return { host: u.hostname, port: Number(u.port) || 80 };
    }
    if (/^DIRECT/i.test(rule.trim())) return null;
  } catch (e) {}
  const env = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (env) {
    try {
      const u = new URL(env);
      return { host: u.hostname, port: Number(u.port) || 80 };
    } catch (e) {}
  }
  return null;
}

function openTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` }
    });
    req.setTimeout(30000, () => req.destroy(new Error('прокси не отвечает')));
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error('прокси отклонил соединение (' + res.statusCode + ')'));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

// Загрузка файла через https Node.js: модуль net Electron не позволяет задать Content-Length,
// без которого uploads.github.com не принимает файл
async function uploadAsset(uploadUrl, filePath, onProgress) {
  let size;
  try { size = fs.statSync(filePath).size; } catch (e) { throw new Error('Файл не найден: ' + filePath); }
  const name = path.basename(filePath);
  const target = new URL(uploadUrl.replace(/\{.*\}$/, ''));
  target.searchParams.set('name', name);

  const proxy = await getProxyFor(target.href);
  let tunnel = null;
  if (proxy) {
    try {
      tunnel = await openTunnel(proxy, target.hostname, 443);
    } catch (e) {
      throw new Error(`Ошибка загрузки файла ${name}: ${e.message}`);
    }
  }
  checkCancel();

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      headers: {
        Authorization: 'Bearer ' + auth.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitLoader',
        'Content-Type': 'application/octet-stream',
        'Content-Length': size
      }
    };
    if (tunnel) options.createConnection = () => tls.connect({ socket: tunnel, servername: target.hostname });

    const req = https.request(options);
    let settled = false;
    let stream = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (currentRequest && currentRequest.req === req) currentRequest = null;
      if (stream) stream.destroy();
      fn(value);
    };
    currentRequest = { req, abort: () => { req.destroy(); finish(reject, new CancelError()); } };

    req.setTimeout(120000, () => req.destroy(new Error('сервер не отвечает')));
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (res.statusCode === 201) return finish(resolve, data);
        let message = describeApiError(res.statusCode, data);
        if (res.statusCode === 422 && /already_exists/.test(text)) message = `Файл «${name}» уже есть в этом релизе`;
        const err = new Error(message);
        err.status = res.statusCode;
        finish(reject, err);
      });
    });
    req.on('error', (e) => finish(reject, cancelRequested ? new CancelError() : new Error(`Ошибка загрузки файла ${name}: ${e.message}`)));

    stream = fs.createReadStream(filePath, { highWaterMark: 512 * 1024 });
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress(sent, size);
      if (!req.write(chunk)) {
        stream.pause();
        req.once('drain', () => { if (!settled) stream.resume(); });
      }
    });
    stream.on('end', () => req.end());
    stream.on('error', (e) => { req.destroy(); finish(reject, e); });
  });
}

async function uploadAssets(owner, repo, release, files, replace) {
  const total = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch (e) { return s; } }, 0) || 1;
  let done = 0;
  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    checkCancel();
    const file = files[i];
    const name = path.basename(file);
    const existing = (release.assets || []).find(a => a.name === name);
    if (existing) {
      if (!replace) throw new Error(`Файл «${name}» уже есть в релизе ${release.tag_name || release.tag}`);
      await githubRequest('DELETE', `${repoPath(owner, repo)}/releases/assets/${existing.id}`);
      uiLog('Удалён старый файл ' + name, 'info');
    }
    uiLog(`Загрузка файла ${name}...`, 'info');
    const asset = await uploadAsset(release.upload_url || release.uploadUrl, file, (sent, size) => {
      const percent = Math.round(10 + ((done + sent) / total) * 88);
      send('release-progress', { progress: percent, stage: `${name}: ${formatSize(sent)} из ${formatSize(size)}`, file: i + 1, files: files.length });
    });
    try { done += fs.statSync(file).size; } catch (e) {}
    uploaded.push(asset);
    uiLog(`Файл ${name} загружен`, 'ok');
  }
  return uploaded;
}

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Файлы для релиза',
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths.map(p => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) {}
    return { path: p, name: path.basename(p), size, sizeText: formatSize(size) };
  });
});

ipcMain.handle('describe-files', (event, paths) => {
  return (paths || []).map(p => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      return { path: p, name: path.basename(p), size: st.size, sizeText: formatSize(st.size) };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
});

ipcMain.handle('list-releases', async (event, { owner, repo }) => {
  try {
    const [releases, info, empty] = await Promise.all([
      githubRequest('GET', `${repoPath(owner, repo)}/releases?per_page=50`),
      githubRequest('GET', repoPath(owner, repo)),
      isRepoEmpty(owner, repo)
    ]);
    let latestId = null;
    try {
      const latest = await githubRequest('GET', `${repoPath(owner, repo)}/releases/latest`);
      latestId = latest.id;
    } catch (e) {}
    return {
      success: true,
      releases: releases.map(mapRelease),
      latestId,
      defaultBranch: info.default_branch,
      empty,
      htmlUrl: info.html_url
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-folder-version', async (event, folder) => {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(folder, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('create-release', async (event, params) => {
  if (busy) return { success: false, error: 'Уже выполняется другая операция' };
  busy = true;
  cancelRequested = false;
  const { owner, repo } = params;
  let release = null;
  try {
    const tag = String(params.tag || '').trim();
    if (!tag) throw new Error('Укажите тег версии, например v1.0.0');
    const tagCheck = await runGit(['check-ref-format', 'refs/tags/' + tag], undefined, { quiet: true });
    if (tagCheck.code !== 0 && !tagCheck.notFound) throw new Error('Некорректный тег: ' + tag);

    send('release-progress', { progress: 4, stage: 'Создание релиза ' + tag + '...' });
    uiLog(`Создание релиза ${tag} в ${owner}/${repo}`, 'info');
    const body = {
      tag_name: tag,
      name: String(params.name || '').trim() || tag,
      body: params.body || '',
      draft: !!params.draft,
      prerelease: !!params.prerelease,
      generate_release_notes: !!params.generateNotes
    };
    if (params.target) body.target_commitish = params.target;
    if (!params.draft && !params.prerelease) body.make_latest = 'true';

    try {
      release = await githubRequest('POST', `${repoPath(owner, repo)}/releases`, body);
    } catch (e) {
      if (e.status === 422 && /already_exists/.test(JSON.stringify(e.data || ''))) {
        throw new Error(`Релиз с тегом ${tag} уже существует. Укажите новую версию или добавьте файлы в существующий релиз.`);
      }
      if (e.status === 422 && /target_commitish|Repository is empty/i.test(JSON.stringify(e.data || '') + e.message)) {
        throw new Error('Не найдена ветка «' + (params.target || '') + '» или репозиторий пуст. Сначала загрузите проект.');
      }
      throw e;
    }
    uiLog('Релиз создан: ' + release.html_url, 'ok');

    const files = params.files || [];
    if (files.length) await uploadAssets(owner, repo, release, files, false);

    send('release-progress', { progress: 100, stage: 'Готово!' });
    const fresh = await githubRequest('GET', `${repoPath(owner, repo)}/releases/${release.id}`);
    if (params.openAfter) openUrl(fresh.html_url);
    return { success: true, release: mapRelease(fresh) };
  } catch (e) {
    writeLog('error', 'Ошибка релиза: ' + (e.stack || e.message));
    uiLog(e.message, e.cancelled ? 'warn' : 'error');
    return {
      success: false,
      cancelled: !!e.cancelled,
      error: e.message,
      partial: release ? { htmlUrl: release.html_url, tag: release.tag_name } : null
    };
  } finally {
    busy = false;
    cancelRequested = false;
    currentRequest = null;
  }
});

ipcMain.handle('add-release-assets', async (event, { owner, repo, releaseId, files, replace }) => {
  if (busy) return { success: false, error: 'Уже выполняется другая операция' };
  busy = true;
  cancelRequested = false;
  try {
    const release = await githubRequest('GET', `${repoPath(owner, repo)}/releases/${releaseId}`);
    send('release-progress', { progress: 8, stage: 'Загрузка файлов в ' + release.tag_name + '...' });
    await uploadAssets(owner, repo, release, files, replace);
    send('release-progress', { progress: 100, stage: 'Готово!' });
    return { success: true };
  } catch (e) {
    uiLog(e.message, e.cancelled ? 'warn' : 'error');
    return { success: false, cancelled: !!e.cancelled, error: e.message };
  } finally {
    busy = false;
    cancelRequested = false;
    currentRequest = null;
  }
});

ipcMain.handle('update-release', async (event, { owner, repo, releaseId, patch }) => {
  try {
    const allowed = {};
    for (const key of ['name', 'body', 'draft', 'prerelease', 'tag_name']) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) allowed[key] = patch[key];
    }
    if (patch && patch.makeLatest) allowed.make_latest = 'true';
    const r = await githubRequest('PATCH', `${repoPath(owner, repo)}/releases/${releaseId}`, allowed);
    return { success: true, release: mapRelease(r) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-release', async (event, { owner, repo, releaseId, tag, deleteTag }) => {
  try {
    await githubRequest('DELETE', `${repoPath(owner, repo)}/releases/${releaseId}`);
    if (deleteTag && tag) {
      try {
        await githubRequest('DELETE', `${repoPath(owner, repo)}/git/refs/tags/${encodeURIComponent(tag)}`);
      } catch (e) {
        if (e.status !== 404 && e.status !== 422) return { success: true, warning: 'Релиз удалён, но тег остался: ' + e.message };
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-release-asset', async (event, { owner, repo, assetId }) => {
  try {
    await githubRequest('DELETE', `${repoPath(owner, repo)}/releases/assets/${assetId}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ---------- IPC: загрузка ----------

ipcMain.handle('upload-to-github', async (event, params) => {
  if (busy) return { success: false, error: 'Уже выполняется другая операция' };
  busy = true;
  cancelRequested = false;
  const warnings = [];
  try {
    return await upload(params || {}, warnings);
  } catch (e) {
    writeLog('error', 'Ошибка загрузки: ' + (e.stack || e.message));
    if (e.cancelled) uiLog('Операция отменена пользователем', 'warn');
    else uiLog(e.message, 'error');
    return { success: false, error: e.message || 'Ошибка загрузки', cancelled: !!e.cancelled, warnings };
  } finally {
    busy = false;
    cancelRequested = false;
    currentProc = null;
  }
});

async function upload(params, warnings) {
  const folder = params.folderPath;
  const owner = params.owner || (auth.user && auth.user.login);
  const repoName = sanitizeRepoName(params.repoName);
  const branch = String(params.branch || settings.defaultBranch || 'main').trim();
  const commitMessage = String(params.commitMessage || '').trim() || 'Загрузка через GitLoader';

  // 1. Проверки
  progress('check', 3, 'Проверка...');
  if (!auth.token || !auth.user) throw new Error('Вы не авторизованы. Войдите заново.');
  if (!gitVersion && !(await detectGit())) throw new Error('Git не найден. Установите Git: https://git-scm.com/downloads');
  if (!repoName) throw new Error('Укажите корректное название репозитория (латиница, цифры, - _ .)');
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Папка не существует. Выберите другую папку.');
  if (fs.readdirSync(folder).length === 0) throw new Error('Папка пустая. Добавьте файлы в папку.');

  const branchCheck = await runGit(['check-ref-format', '--branch', branch], folder, { quiet: true });
  if (branchCheck.code !== 0) throw new Error('Некорректное имя ветки: ' + branch);

  uiLog(`Загрузка «${folder}» → ${owner}/${repoName} (ветка ${branch})`, 'info');
  const info = await analyzeFolder(folder);
  if (info.remoteHasToken) uiLog('В адресе remote найден токен (старая версия GitLoader) — он будет удалён', 'warn');

  // 2. Репозиторий на GitHub
  checkCancel();
  progress('repo', 12, 'Проверка репозитория на GitHub...');
  let repo = null;
  let created = false;
  try {
    repo = await githubRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
    uiLog('Репозиторий уже существует: ' + repo.full_name + ' — будет отправлен новый коммит', 'info');
    if (repo.permissions && !repo.permissions.push) throw new Error('Нет прав на запись в ' + repo.full_name);
  } catch (e) {
    if (e.status !== 404) throw e;
    progress('repo', 18, 'Создание репозитория...');
    const body = { name: repoName, private: !!params.isPrivate, description: params.description || undefined, auto_init: false };
    const endpoint = owner === auth.user.login ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`;
    repo = await githubRequest('POST', endpoint, body);
    created = true;
    uiLog('Создан репозиторий ' + repo.full_name + (repo.private ? ' (приватный)' : ' (публичный)'), 'ok');
  }
  const cleanRemote = `https://github.com/${repo.full_name}.git`;

  // 3. Подготовка файлов
  checkCancel();
  progress('prepare', 25, 'Подготовка файлов...');
  await prepareFiles(folder, { ...params, repoName }, info, warnings);

  if (!info.hasGit) {
    await git(['init'], folder);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/' + branch], folder);
  }

  if (info.hasNodeModules) {
    await git(['rm', '-r', '--cached', '--ignore-unmatch', '-q', 'node_modules'], folder);
  }

  // 4. Коммит
  progress('commit', 35, 'Добавление файлов...');
  await git(['add', '-A'], folder);
  await unstageLargeFiles(folder, warnings);

  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], folder, { quiet: true })).code === 0;
  const diff = await runGit(['diff', '--cached', '--quiet'], folder, { quiet: true });
  const hasChanges = diff.code === 1;

  if (hasChanges) {
    progress('commit', 48, 'Создание коммита...');
    await git([...(await authorArgs(folder)), 'commit', '-q', '-m', commitMessage], folder);
  } else if (!hasHead) {
    throw new Error('Нет файлов для коммита — возможно, все файлы исключены в .gitignore');
  } else {
    uiLog('Новых изменений нет — отправляются существующие коммиты', 'info');
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'], folder, { quiet: true })).stdout.trim();

  // 5. Remote (без токена в адресе)
  checkCancel();
  progress('push', 55, 'Настройка remote...');
  const existing = await runGit(['remote', 'get-url', 'origin'], folder, { quiet: true });
  if (existing.code === 0) {
    if (existing.stdout.trim() !== cleanRemote) await git(['remote', 'set-url', 'origin', cleanRemote], folder);
  } else {
    await git(['remote', 'add', 'origin', cleanRemote], folder);
  }

  // 6. Push
  const pushArgs = ['push', '--progress', '-u', 'origin', 'HEAD:refs/heads/' + branch];
  if (params.force) pushArgs.splice(1, 0, '--force');
  const onLine = (line) => {
    const m = line.match(/Writing objects:\s+(\d+)%/);
    if (m) progress('push', 60 + Math.round(parseInt(m[1], 10) * 0.35), `Отправка: ${m[1]}%`);
  };

  let pushed = false;
  let pulled = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
    progress('push', 60, attempt === 1 ? 'Отправка на GitHub...' : `Повторная отправка (${attempt}/3)...`);
    const r = await git(pushArgs, folder, { auth: true, allowFail: true, onLine });
    if (r.code === 0) { pushed = true; break; }

    lastError = r.stderr;
    const type = classifyPushError(r.stderr);
    uiLog('Ошибка отправки: ' + type, 'warn');

    if (type === 'NETWORK') {
      await sleep(attempt * 2000);
      continue;
    }
    if (type === 'CONFLICT' && !pulled) {
      pulled = true;
      progress('push', 62, 'На GitHub есть изменения — синхронизация...');
      const pull = await git([...(await authorArgs(folder)), 'pull', '--rebase', '--no-edit', 'origin', branch], folder, { auth: true, allowFail: true });
      if (pull.code === 0) continue;
      await runGit(['rebase', '--abort'], folder, { quiet: true });
      throw new Error('В удалённой ветке есть изменения, которые конфликтуют с локальными. Включите «Перезаписать ветку на GitHub» в дополнительных настройках или выберите другую ветку.');
    }
    if (type === 'CONFLICT') throw new Error('GitHub отклонил отправку: ветка изменилась. Включите «Перезаписать ветку на GitHub» или выберите другую ветку.');
    if (type === 'LARGE_FILE') throw new Error('GitHub отклонил большой файл (>100 МБ), который есть в истории коммитов. Удалите его из истории или используйте Git LFS.');
    if (type === 'PROTECTED') throw new Error('Ветка ' + branch + ' защищена на GitHub — укажите другую ветку.');
    if (type === 'AUTH') throw new Error('GitHub отказал в доступе. Проверьте, что у токена есть право repo (или Contents: Read and write).');
    break;
  }
  if (!pushed) {
    const lines = mask(lastError).trim().split('\n').filter(Boolean);
    throw new Error('Ошибка отправки: ' + (lines.slice(-2).join(' ') || 'неизвестная ошибка'));
  }

  progress('done', 100, 'Готово!');
  uiLog(`Готово: ${repo.html_url} (${sha})`, 'ok');

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    folder,
    fullName: repo.full_name,
    owner: repo.full_name.split('/')[0],
    name: repo.name,
    url: repo.html_url,
    branch,
    sha,
    private: repo.private,
    created,
    files: info.files
  };
  addHistory(entry);

  if (params.openAfter) openUrl(repo.html_url + (branch !== repo.default_branch && repo.default_branch ? '/tree/' + branch : ''));

  return { success: true, repoUrl: repo.html_url, fullName: repo.full_name, created, branch, sha, private: repo.private, warnings };
}
