(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const state = {
    authenticated: false,
    user: null,
    owners: [],
    settings: {},
    view: 'upload',
    folder: null,
    folderInfo: null,
    repoNameAuto: true,
    visibility: 'public',
    repoCheck: null,
    repoCheckSeq: 0,
    uploading: false,
    cloning: false,
    repos: null,
    reposLoading: false,
    history: [],
    gitAvailable: true,
    licenses: [],
    logLines: [],
    releaseRepo: null,
    releases: null,
    latestReleaseId: null,
    releaseRepoInfo: null,
    releaseFiles: [],
    releasing: false
  };

  const STEPS = ['check', 'repo', 'prepare', 'commit', 'push'];

  const LANG_COLORS = {
    JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', 'C#': '#178600',
    'C++': '#f34b7d', C: '#555555', Go: '#00ADD8', Rust: '#dea584', PHP: '#4F5D95', Ruby: '#701516',
    HTML: '#e34c26', CSS: '#563d7c', Kotlin: '#A97BFF', Swift: '#F05138', Dart: '#00B4AB', Shell: '#89e051',
    Vue: '#41b883', Lua: '#000080', GDScript: '#355570', ShaderLab: '#222c37'
  };

  // ---------- Утилиты ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function icon(name, cls = '') {
    return `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'только что';
    if (diff < 3600) { const m = Math.floor(diff / 60); return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`; }
    if (diff < 86400) { const h = Math.floor(diff / 3600); return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`; }
    if (diff < 86400 * 30) { const d = Math.floor(diff / 86400); return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`; }
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function copy(text, label = 'Скопировано') {
    await api.copyText(text);
    toast(label, 'success', { timeout: 2000 });
  }

  // ---------- Уведомления и диалоги ----------

  function toast(message, type = 'info', opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    const iconName = { success: 'check', error: 'x', warn: 'warn', info: 'info' }[type] || 'info';
    el.innerHTML = `${icon(iconName)}<div class="toast-msg">${esc(message)}</div>`;
    if (opts.action) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-ghost';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => { opts.action.fn(); close(); });
      el.appendChild(btn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.innerHTML = icon('x');
    closeBtn.addEventListener('click', () => close());
    el.appendChild(closeBtn);

    const box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }
    setTimeout(close, opts.timeout || (type === 'error' ? 8000 : 4500));
  }

  function confirmDialog({ title, text, okText = 'OK', danger = false }) {
    return new Promise((resolve) => {
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      const ok = $('modalOk');
      ok.textContent = okText;
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      $('modal').classList.remove('hidden');
      ok.focus();

      const done = (value) => {
        $('modal').classList.add('hidden');
        ok.removeEventListener('click', onOk);
        $('modalCancel').removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      ok.addEventListener('click', onOk);
      $('modalCancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  // ---------- Тема и окно ----------

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    const t = state.settings.theme || 'dark';
    const resolved = t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  darkQuery.addEventListener('change', applyTheme);

  $('minimizeBtn').addEventListener('click', () => api.minimizeWindow());
  $('maximizeBtn').addEventListener('click', () => api.toggleMaximizeWindow());
  $('closeBtn').addEventListener('click', () => api.closeWindow());
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.window-controls')) api.toggleMaximizeWindow();
  });
  api.onWindowState(({ maximized }) => {
    $('maximizeBtn').title = maximized ? 'Восстановить' : 'Развернуть';
  });

  // ---------- Навигация ----------

  function showView(name) {
    if (!state.authenticated && (name === 'upload' || name === 'repos' || name === 'releases')) {
      state.view = name;
      setVisibleView('auth');
      highlightNav(name);
      return;
    }
    state.view = name;
    setVisibleView(name);
    highlightNav(name);
    if (name === 'repos' && !state.repos && !state.reposLoading) loadRepos();
    if (name === 'releases') ensureReleasesView();
    if (name === 'history') renderHistory();
    if (name === 'settings') renderAbout();
  }

  function setVisibleView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
    document.querySelector('.main').scrollTop = 0;
  }

  function highlightNav(name) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // ---------- Авторизация ----------

  function setUser(user) {
    state.user = user;
    state.authenticated = !!user;
    $('sidebarUser').classList.toggle('hidden', !user);
    document.querySelectorAll('.nav-item[data-auth]').forEach(b => { b.disabled = !user; });
    if (user) {
      $('userName').textContent = user.name || user.login;
      $('userLogin').textContent = '@' + user.login;
      const avatar = $('userAvatar');
      if (user.avatar_url) { avatar.src = user.avatar_url + '&s=64'; avatar.classList.remove('hidden'); }
      else avatar.removeAttribute('src');
      $('authorGithubHint').textContent = `${user.name || user.login} <${user.id ? user.id + '+' : ''}${user.login}@users.noreply.github.com>`;
    }
  }

  async function checkAuth() {
    let status;
    try {
      status = await api.getAuthStatus();
    } catch (e) {
      status = { authenticated: false };
    }
    $('offlineBanner').classList.toggle('hidden', !status.offline);
    if (status.authenticated) {
      setUser(status.user);
      loadOwners();
      loadGitignoreTemplates();
    } else {
      setUser(null);
      if (status.error) toast(status.error, 'warn');
    }
    showView(state.view);
  }

  $('openTokenBtn').addEventListener('click', async () => {
    await api.openTokenPage();
    toast('Страница GitHub открыта в браузере. Скопируйте созданный токен и вставьте его в поле.', 'info', { timeout: 7000 });
    $('tokenInput').focus();
  });

  $('toggleTokenBtn').addEventListener('click', () => {
    const input = $('tokenInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  async function login() {
    const input = $('tokenInput');
    const token = input.value.trim();
    if (!token) {
      input.classList.add('invalid');
      toast('Вставьте токен', 'error');
      input.focus();
      return;
    }
    const btn = $('authBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div><span class="btn-label">Проверка...</span>';
    const result = await api.authenticate(token);
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Войти</span>';

    if (result.success) {
      input.value = '';
      setUser(result.user);
      toast(`Добро пожаловать, ${result.user.name || result.user.login}!`, 'success');
      if (result.warning) toast(result.warning, 'warn', { timeout: 9000 });
      loadOwners();
      loadGitignoreTemplates();
      state.repos = null;
      showView(state.view === 'repos' ? 'repos' : 'upload');
    } else {
      input.classList.add('invalid');
      toast(result.error || 'Ошибка авторизации', 'error');
    }
  }

  $('authBtn').addEventListener('click', login);
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('tokenInput').addEventListener('input', () => $('tokenInput').classList.remove('invalid'));

  $('logoutBtn').addEventListener('click', async () => {
    if (state.uploading) return toast('Дождитесь окончания загрузки', 'warn');
    const ok = await confirmDialog({ title: 'Выйти из аккаунта?', text: 'Сохранённый токен будет удалён с этого компьютера.', okText: 'Выйти', danger: true });
    if (!ok) return;
    await api.logout();
    setUser(null);
    state.repos = null;
    state.owners = [];
    state.releaseRepo = null;
    state.releases = null;
    toast('Вы вышли из аккаунта', 'success');
    showView('upload');
  });

  $('offlineRetryBtn').addEventListener('click', checkAuth);

  async function loadOwners() {
    const sel = $('ownerSelect');
    const fill = (owners) => {
      const current = sel.value;
      sel.innerHTML = owners.map(o => `<option value="${esc(o.login)}">${esc(o.login)}${o.type === 'org' ? ' (орг.)' : ''}</option>`).join('');
      if (owners.some(o => o.login === current)) sel.value = current;
    };
    fill(state.user ? [{ login: state.user.login, type: 'user' }] : []);
    try {
      state.owners = await api.getOwners();
      if (state.owners.length) fill(state.owners);
    } catch (e) {}
  }

  // ---------- Git ----------

  async function renderAbout() {
    const info = await api.getAppInfo();
    state.gitAvailable = !!info.git;
    $('gitBanner').classList.toggle('hidden', state.gitAvailable);
    const rows = [
      ['Версия', info.version],
      ['Git', info.git || 'не найден'],
      ['Electron', info.electron],
      ['Хранение токена', info.encrypted ? 'зашифрован средствами ОС' : 'без шифрования ОС'],
      ['Журнал', info.logFile]
    ];
    $('aboutInfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    return info;
  }

  $('gitDownloadBtn').addEventListener('click', () => api.openExternal('https://git-scm.com/downloads'));
  $('gitRecheckBtn').addEventListener('click', async () => {
    const info = await renderAbout();
    toast(info.git ? 'Git найден: ' + info.git : 'Git по-прежнему не найден. После установки перезапустите GitLoader.', info.git ? 'success' : 'warn');
    updateUploadButton();
  });

  // ---------- Папка проекта ----------

  async function chooseFolder() {
    if (state.uploading) return;
    const res = await api.selectFolder();
    if (!res.canceled) await setFolder(res.path);
  }

  async function setFolder(folder) {
    if (state.uploading) return;
    const dz = $('dropzone');
    dz.querySelector('.dz-text').innerHTML = '<div class="spinner"></div><span class="muted">Анализ папки...</span>';
    const res = await api.analyzeFolder(folder);
    dz.querySelector('.dz-text').innerHTML = '<b>Перетащите папку сюда</b><span class="muted">или нажмите, чтобы выбрать</span>';

    if (!res.success) {
      toast(res.error || 'Не удалось открыть папку', 'error');
      return;
    }
    const info = res.info;
    state.folder = info.path;
    state.folderInfo = info;
    renderFolderInfo(info);

    if (info.remoteRepo && state.owners.some(o => o.login.toLowerCase() === info.remoteRepo.owner.toLowerCase())) {
      const owner = state.owners.find(o => o.login.toLowerCase() === info.remoteRepo.owner.toLowerCase());
      $('ownerSelect').value = owner.login;
      $('repoName').value = info.remoteRepo.name;
      state.repoNameAuto = true;
    } else if (state.repoNameAuto || !$('repoName').value.trim()) {
      $('repoName').value = info.name;
      state.repoNameAuto = true;
    }

    if (info.hasGit && info.branch && info.branch !== 'HEAD') $('branchInput').value = info.branch;
    else if (!info.hasGit) $('branchInput').value = state.settings.defaultBranch || 'main';

    updateAdvancedHints();
    checkRepoNow();
    updateUploadButton();
  }

  function renderFolderInfo(info) {
    $('dropzone').classList.add('hidden');
    $('folderInfo').classList.remove('hidden');
    $('folderPathText').textContent = info.path;
    $('folderPathText').title = info.path;

    const chips = [];
    chips.push(`<span class="chip">${info.files.toLocaleString('ru-RU')}${info.truncated ? '+' : ''} ${plural(info.files, 'файл', 'файла', 'файлов')}</span>`);
    chips.push(`<span class="chip">${esc(info.sizeText)}</span>`);
    info.types.forEach(t => chips.push(`<span class="chip blue">${esc(t)}</span>`));
    if (info.hasGit) {
      chips.push(`<span class="chip green">${icon('branch')}${esc(info.branch || 'git')}</span>`);
      if (info.commits) chips.push(`<span class="chip">${info.commits} ${plural(info.commits, 'коммит', 'коммита', 'коммитов')}</span>`);
      if (info.changes) chips.push(`<span class="chip warn">${info.changes} ${plural(info.changes, 'изменение', 'изменения', 'изменений')}</span>`);
    } else {
      chips.push('<span class="chip">Git ещё не инициализирован</span>');
    }
    if (info.remoteRepo) chips.push(`<span class="chip blue">${icon('github')}${esc(info.remoteRepo.owner + '/' + info.remoteRepo.name)}</span>`);
    $('folderChips').innerHTML = chips.join('');

    const warns = [];
    if (info.empty) warns.push(['error', 'Папка пустая — загружать нечего.']);
    if (info.remoteHasToken) warns.push(['error', 'В настройках git этой папки сохранён токен в открытом виде (так делала старая версия GitLoader). При загрузке он будет удалён.']);
    if (info.largeFiles.length) {
      const list = info.largeFiles.slice(0, 5).map(f => `${f.path} (${f.size})`).join(', ');
      warns.push(['warn', `Файлы больше 100 МБ не попадут на GitHub и будут добавлены в .gitignore: ${list}${info.largeFiles.length > 5 ? ' и др.' : ''}`]);
    }
    if (info.bigFiles.length) warns.push(['warn', `Есть крупные файлы (50–100 МБ): ${info.bigFiles.slice(0, 3).map(f => f.path).join(', ')}. Загрузка может быть долгой.`]);
    if (info.hasNodeModules) warns.push(['info', 'Папка node_modules будет автоматически исключена.']);
    if (info.truncated) warns.push(['warn', 'Папка очень большая — подсчёт файлов остановлен досрочно.']);

    $('folderWarnings').innerHTML = warns
      .filter(([type]) => type !== 'info')
      .map(([type, text]) => `<div class="warn-line ${type === 'error' ? 'error' : ''}">${icon('warn')}<span>${esc(text)}</span></div>`)
      .join('');
  }

  function updateAdvancedHints() {
    const info = state.folderInfo;
    const gi = $('gitignoreSelect');
    const lic = $('licenseSelect');
    const readme = $('readmeCheck');

    gi.disabled = !!(info && info.hasGitignore);
    $('gitignoreHint').textContent = info && info.hasGitignore
      ? 'В проекте уже есть .gitignore'
      : (gi.value === 'auto' ? (info && info.types.length ? 'Определено: ' + info.types[0] : 'Тип проекта не определён — будет базовый шаблон') : '');

    lic.disabled = !!(info && info.hasLicense);
    $('licenseHint').textContent = info && info.hasLicense ? 'В проекте уже есть лицензия' : '';

    readme.disabled = !!(info && info.hasReadme);
    readme.closest('.check').style.opacity = readme.disabled ? 0.5 : 1;
  }

  $('dropzone').addEventListener('click', chooseFolder);
  $('dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') chooseFolder(); });
  $('changeFolderBtn').addEventListener('click', chooseFolder);
  $('openFolderBtn').addEventListener('click', () => state.folder && api.openPath(state.folder));
  $('gitignoreSelect').addEventListener('change', updateAdvancedHints);

  // Перетаскивание папки в окно
  let dragDepth = 0;
  const canDrop = () => state.authenticated && (state.view === 'releases' ? !state.releasing : !state.uploading);

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!canDrop()) return;
    dragDepth++;
    $('dropOverlay').querySelector('span').textContent = state.view === 'releases'
      ? 'Отпустите, чтобы прикрепить файлы к релизу'
      : 'Отпустите, чтобы выбрать папку';
    $('dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropOverlay').classList.add('hidden');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (!canDrop()) return;
    if (state.view === 'releases') {
      const paths = [...(e.dataTransfer.files || [])].map(f => api.getPathForFile(f)).filter(Boolean);
      const files = await api.describeFiles(paths);
      if (files.length < paths.length) toast('Папки пропущены — к релизу можно прикрепить только файлы (папку сначала запакуйте в .zip)', 'warn');
      addReleaseFiles(files);
      return;
    }
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const p = api.getPathForFile(file);
    if (!p) return toast('Не удалось определить путь к папке', 'error');
    showView('upload');
    await setFolder(p);
  });

  // ---------- Репозиторий ----------

  function setVisibility(value) {
    state.visibility = value;
    document.querySelectorAll('#visibility button').forEach(b => b.classList.toggle('active', b.dataset.value === value));
  }

  document.querySelectorAll('#visibility button').forEach(b => {
    b.addEventListener('click', () => { if (!b.disabled) setVisibility(b.dataset.value); });
  });

  function setRepoStatus(cls, html) {
    const el = $('repoStatus');
    el.className = 'repo-status ' + (cls || '');
    el.innerHTML = html;
  }

  async function checkRepoNow() {
    const name = $('repoName').value.trim();
    const owner = $('ownerSelect').value;
    const seq = ++state.repoCheckSeq;
    state.repoCheck = null;
    document.querySelectorAll('#visibility button').forEach(b => { b.disabled = false; });

    if (!name) {
      setRepoStatus('', '');
      updateUploadButton();
      return;
    }
    if (!state.authenticated) return;

    setRepoStatus('', '<div class="spinner"></div>Проверка...');
    const res = await api.checkRepo({ owner, name });
    if (seq !== state.repoCheckSeq) return;
    state.repoCheck = res;

    const renamed = res.sanitized && res.sanitized !== name ? ` · будет называться <b>${esc(res.sanitized)}</b>` : '';
    if (!res.valid) {
      setRepoStatus('error', icon('x') + 'Недопустимое название: используйте латиницу, цифры, «-», «_» и «.»');
    } else if (res.exists === true) {
      setRepoStatus('exists', `${icon('info')}Репозиторий существует${res.private ? ' (приватный)' : ''} — изменения будут добавлены новым коммитом${renamed}`);
      setVisibility(res.private ? 'private' : 'public');
      document.querySelectorAll('#visibility button').forEach(b => { b.disabled = true; });
      if (!$('commitMsg').value) $('commitMsg').placeholder = 'Обновление ' + new Date().toLocaleDateString('ru-RU');
    } else if (res.exists === false) {
      setRepoStatus('ok', `${icon('check')}Будет создан новый репозиторий ${esc(owner)}/${esc(res.sanitized)}`);
      setVisibility(state.settings.defaultPrivate ? 'private' : 'public');
      $('commitMsg').placeholder = 'Первая загрузка';
    } else {
      setRepoStatus('error', `${icon('warn')}Не удалось проверить: ${esc(res.error || '')}`);
    }
    updateUploadButton();
  }

  const checkRepoDebounced = debounce(checkRepoNow, 450);

  $('repoName').addEventListener('input', () => {
    state.repoNameAuto = false;
    setRepoStatus('', '');
    updateUploadButton();
    checkRepoDebounced();
  });
  $('ownerSelect').addEventListener('change', checkRepoNow);

  function updateUploadButton() {
    const hasFolder = !!state.folder && !(state.folderInfo && state.folderInfo.empty);
    const hasName = $('repoName').value.trim().length > 0;
    const validName = !state.repoCheck || state.repoCheck.valid !== false;
    const ready = hasFolder && hasName && validName && state.authenticated && state.gitAvailable && !state.uploading;
    $('uploadBtn').disabled = !ready;

    let hint = '';
    if (!state.gitAvailable) hint = 'Установите Git, чтобы загружать проекты';
    else if (!hasFolder) hint = state.folderInfo && state.folderInfo.empty ? 'Папка пустая' : 'Выберите папку проекта';
    else if (!hasName) hint = 'Укажите название репозитория';
    else if (!validName) hint = 'Исправьте название репозитория';
    else if (!state.uploading) hint = 'Ctrl + Enter — быстрая загрузка';
    $('uploadHint').textContent = hint;
  }

  // ---------- Загрузка ----------

  function resetProgress() {
    $('progressCard').classList.remove('hidden');
    $('resultBox').classList.add('hidden');
    $('progressFill').classList.remove('error');
    $('progressFill').style.width = '0%';
    $('progressPercent').textContent = '0%';
    $('progressText').textContent = 'Подготовка...';
    document.querySelectorAll('#stepper .step').forEach(s => s.classList.remove('active', 'done', 'failed'));
    state.logLines = [];
    $('logOutput').innerHTML = '';
  }

  function setStep(step) {
    const idx = step === 'done' ? STEPS.length : STEPS.indexOf(step);
    if (idx < 0) return;
    document.querySelectorAll('#stepper .step').forEach((el, i) => {
      el.classList.toggle('done', i < idx);
      el.classList.toggle('active', i === idx);
    });
  }

  function failStep() {
    const active = document.querySelector('#stepper .step.active');
    if (active) { active.classList.remove('active'); active.classList.add('failed'); }
    $('progressFill').classList.add('error');
  }

  api.onProgress((data) => {
    if (data.step === 'clone') {
      $('cloneFill').style.width = data.progress + '%';
      $('cloneStatusText').textContent = data.stage;
      return;
    }
    setStep(data.step);
    $('progressFill').style.width = data.progress + '%';
    $('progressPercent').textContent = data.progress + '%';
    $('progressText').textContent = data.stage;
  });

  api.onLog((entry) => {
    const time = new Date(entry.time).toLocaleTimeString('ru-RU');
    state.logLines.push(`[${time}] ${entry.text}`);
    if (state.logLines.length > 1500) state.logLines.shift();
    const out = $('logOutput');
    const line = document.createElement('div');
    line.className = 'l-' + entry.type;
    line.innerHTML = `<span class="l-time">${esc(time)}</span>${esc(entry.text)}`;
    out.appendChild(line);
    while (out.children.length > 1500) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  });

  $('copyLogBtn').addEventListener('click', (e) => {
    e.preventDefault();
    copy(state.logLines.join('\n'), 'Журнал скопирован');
  });

  function setUploading(on) {
    state.uploading = on;
    const btn = $('uploadBtn');
    btn.innerHTML = on
      ? '<div class="spinner"></div><span class="btn-label">Загрузка...</span>'
      : `${icon('upload')}<span class="btn-label">Загрузить на GitHub</span>`;
    $('cancelBtn').classList.toggle('hidden', !on);
    $('cancelBtn').disabled = false;
    ['repoName', 'ownerSelect', 'repoDesc', 'branchInput', 'commitMsg'].forEach(id => { $(id).disabled = on; });
    $('changeFolderBtn').disabled = on;
    updateUploadButton();
  }

  async function startUpload() {
    if (state.uploading || $('uploadBtn').disabled) return;

    const name = $('repoName').value.trim();
    const branch = $('branchInput').value.trim() || state.settings.defaultBranch || 'main';
    const force = $('forceCheck').checked;

    if (force) {
      const ok = await confirmDialog({
        title: 'Перезаписать ветку на GitHub?',
        text: `Содержимое ветки «${branch}» на GitHub будет заменено локальной версией. Изменения, которых нет у вас на компьютере, будут потеряны.`,
        okText: 'Перезаписать',
        danger: true
      });
      if (!ok) return;
    }

    resetProgress();
    setUploading(true);
    $('logDetails').open = false;
    $('progressCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const result = await api.uploadToGithub({
      folderPath: state.folder,
      owner: $('ownerSelect').value,
      repoName: name,
      description: $('repoDesc').value.trim(),
      isPrivate: state.visibility === 'private',
      branch,
      commitMessage: $('commitMsg').value.trim() || $('commitMsg').placeholder,
      gitignore: $('gitignoreSelect').value,
      license: $('licenseSelect').value,
      addReadme: $('readmeCheck').checked && !$('readmeCheck').disabled,
      openAfter: $('openAfterCheck').checked,
      force
    });

    setUploading(false);
    $('forceCheck').checked = false;
    renderResult(result);
    refreshHistoryBadge();

    if (result.success) {
      state.repos = null;
      $('commitMsg').value = '';
      const info = await api.analyzeFolder(state.folder);
      if (info.success) { state.folderInfo = info.info; renderFolderInfo(info.info); updateAdvancedHints(); }
      checkRepoNow();
    }
  }

  function renderResult(result) {
    const box = $('resultBox');
    box.classList.remove('hidden', 'success', 'failure');

    if (result.success) {
      box.classList.add('success');
      const warnings = (result.warnings || []).map(w => `<div class="warn-line">${icon('warn')}<span>${esc(w)}</span></div>`).join('');
      box.innerHTML = `
        <div class="result-head">${icon('check')}${result.created ? 'Репозиторий создан и проект загружен' : 'Изменения отправлены'}</div>
        <div class="result-text">
          <span class="result-link" data-act="open">${esc(result.repoUrl)}</span><br>
          <span class="muted">Ветка ${esc(result.branch)} · коммит ${esc(result.sha)}${result.private ? ' · приватный' : ''}</span>
        </div>
        ${warnings}
        <div class="result-actions">
          <button class="btn btn-primary btn-sm" data-act="open">${icon('external')}Открыть на GitHub</button>
          <button class="btn btn-ghost btn-sm" data-act="release">${icon('tag')}Создать релиз</button>
          <button class="btn btn-ghost btn-sm" data-act="copy">${icon('copy')}Копировать ссылку</button>
          <button class="btn btn-ghost btn-sm" data-act="clone-cmd">${icon('copy')}Команда git clone</button>
          <button class="btn btn-ghost btn-sm" data-act="folder">${icon('folder')}Открыть папку</button>
        </div>`;
      box.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => {
        const act = el.dataset.act;
        if (act === 'open') api.openExternal(result.repoUrl);
        if (act === 'copy') copy(result.repoUrl, 'Ссылка скопирована');
        if (act === 'release') openReleases(result.fullName);
        if (act === 'clone-cmd') copy(`git clone ${result.repoUrl}.git`, 'Команда скопирована');
        if (act === 'folder') api.openPath(state.folder);
      }));
      toast(result.created ? 'Проект загружен на GitHub!' : 'Изменения отправлены на GitHub!', 'success');
    } else {
      failStep();
      box.classList.add('failure');
      box.innerHTML = `
        <div class="result-head">${icon(result.cancelled ? 'info' : 'x')}${result.cancelled ? 'Загрузка отменена' : 'Не удалось загрузить проект'}</div>
        <div class="result-text">${esc(result.error || 'Неизвестная ошибка')}</div>
        <div class="result-actions">
          <button class="btn btn-ghost btn-sm" data-act="retry">${icon('redo')}Повторить</button>
          <button class="btn btn-ghost btn-sm" data-act="log">Показать журнал</button>
        </div>`;
      box.querySelector('[data-act="retry"]').addEventListener('click', startUpload);
      box.querySelector('[data-act="log"]').addEventListener('click', () => { $('logDetails').open = true; });
      if (!result.cancelled) toast(result.error || 'Ошибка загрузки', 'error');
    }
  }

  $('uploadBtn').addEventListener('click', startUpload);
  $('cancelBtn').addEventListener('click', async () => {
    $('cancelBtn').disabled = true;
    await api.cancelOperation();
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter' && state.view === 'upload') startUpload();
    if (e.ctrlKey && e.key === 'Enter' && state.view === 'releases') publishRelease();
    if (e.ctrlKey && e.key.toLowerCase() === 'o' && state.view === 'upload' && state.authenticated) {
      e.preventDefault();
      chooseFolder();
    }
  });

  async function loadGitignoreTemplates() {
    try {
      const list = await api.getGitignoreTemplates();
      const sel = $('gitignoreSelect');
      const current = sel.value;
      sel.innerHTML = '<option value="auto">Автоопределение</option><option value="none">Не создавать</option>' +
        list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
      sel.value = current;
    } catch (e) {}
  }

  async function loadLicenses() {
    state.licenses = await api.getLicenses();
    $('licenseSelect').innerHTML = '<option value="none">Без лицензии</option>' +
      state.licenses.map(l => `<option value="${esc(l.key)}">${esc(l.name)}</option>`).join('');
  }

  // ---------- Репозитории ----------

  async function loadRepos() {
    state.reposLoading = true;
    $('reposCount').textContent = 'Загрузка списка...';
    $('reposList').innerHTML = '<div class="skeleton"></div>'.repeat(5);
    const res = await api.listRepos();
    state.reposLoading = false;
    if (!res.success) {
      $('reposCount').textContent = 'Ошибка загрузки';
      $('reposList').innerHTML = `<div class="empty">${icon('warn')}<b>Не удалось получить список</b>${esc(res.error)}</div>`;
      return;
    }
    state.repos = res.repos;
    renderRepos();
  }

  function renderRepos() {
    if (!state.repos) return;
    const q = $('reposSearch').value.trim().toLowerCase();
    const filter = $('reposFilter').value;
    const sort = $('reposSort').value;
    const login = state.user && state.user.login;

    let list = state.repos.filter(r => {
      if (filter === 'public' && r.private) return false;
      if (filter === 'private' && !r.private) return false;
      if (filter === 'own' && r.owner !== login) return false;
      if (!q) return true;
      return [r.fullName, r.description, r.language].some(v => v && v.toLowerCase().includes(q));
    });

    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'stars') list.sort((a, b) => b.stars - a.stars);
    else list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const total = state.repos.length;
    $('reposCount').textContent = list.length === total
      ? `${total} ${plural(total, 'репозиторий', 'репозитория', 'репозиториев')}`
      : `Найдено ${list.length} из ${total}`;

    if (!list.length) {
      $('reposList').innerHTML = `<div class="empty">${icon('repo')}<b>${total ? 'Ничего не найдено' : 'Репозиториев пока нет'}</b>${total ? 'Попробуйте изменить поиск или фильтр' : 'Загрузите первый проект на вкладке «Загрузка»'}</div>`;
      return;
    }

    $('reposList').innerHTML = list.map(r => `
      <div class="item" data-id="${r.id}">
        <div class="item-main">
          <div class="item-title">
            <span class="name" data-act="open" title="Открыть на GitHub">${esc(r.owner !== login ? r.fullName : r.name)}</span>
            <span class="badge ${r.private ? 'private' : ''}">${r.private ? 'Private' : 'Public'}</span>
            ${r.fork ? '<span class="badge">Fork</span>' : ''}
            ${r.archived ? '<span class="badge">Архив</span>' : ''}
          </div>
          ${r.description ? `<div class="item-desc" title="${esc(r.description)}">${esc(r.description)}</div>` : ''}
          <div class="item-meta">
            ${r.language ? `<span><i class="lang-dot" style="background:${LANG_COLORS[r.language] || '#8b8b8b'}"></i>${esc(r.language)}</span>` : ''}
            ${r.stars ? `<span>${icon('star')}${r.stars}</span>` : ''}
            <span>${icon('branch')}${esc(r.defaultBranch || '')}</span>
            <span>Обновлён ${esc(relTime(r.updatedAt))}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="icon-btn" data-act="upload" title="Загрузить в этот репозиторий">${icon('upload')}</button>
          <button class="icon-btn" data-act="releases" title="Релизы">${icon('tag')}</button>
          <button class="icon-btn" data-act="clone" title="Клонировать на компьютер">${icon('download')}</button>
          <button class="icon-btn" data-act="copy" title="Копировать ссылку для клонирования">${icon('copy')}</button>
          <button class="icon-btn" data-act="open" title="Открыть на GitHub">${icon('external')}</button>
        </div>
      </div>`).join('');
  }

  $('reposList').addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    const item = e.target.closest('.item');
    if (!actEl || !item || !state.repos) return;
    const repo = state.repos.find(r => String(r.id) === item.dataset.id);
    if (!repo) return;
    const act = actEl.dataset.act;
    if (act === 'open') api.openExternal(repo.htmlUrl);
    if (act === 'copy') copy(repo.cloneUrl, 'Ссылка для клонирования скопирована');
    if (act === 'clone') cloneRepo(repo);
    if (act === 'upload') uploadInto(repo);
    if (act === 'releases') openReleases(repo.fullName);
  });

  function uploadInto(repo) {
    showView('upload');
    if ([...$('ownerSelect').options].some(o => o.value === repo.owner)) $('ownerSelect').value = repo.owner;
    $('repoName').value = repo.name;
    state.repoNameAuto = false;
    if (repo.defaultBranch) $('branchInput').value = repo.defaultBranch;
    checkRepoNow();
    if (!state.folder) toast('Теперь выберите папку, содержимое которой нужно отправить в ' + repo.fullName, 'info');
  }

  async function cloneRepo(repo) {
    if (state.cloning || state.uploading) return toast('Дождитесь окончания текущей операции', 'warn');
    if (!state.gitAvailable) return toast('Для клонирования нужен Git', 'error');
    const res = await api.selectFolder({ title: 'Куда клонировать ' + repo.fullName + '?' });
    if (res.canceled) return;

    state.cloning = true;
    $('cloneStatus').classList.remove('hidden');
    $('cloneFill').style.width = '3%';
    $('cloneStatusText').textContent = 'Клонирование ' + repo.fullName + '...';

    const result = await api.cloneRepo({ fullName: repo.fullName, cloneUrl: repo.cloneUrl, parentFolder: res.path });
    state.cloning = false;
    setTimeout(() => $('cloneStatus').classList.add('hidden'), result.success ? 1200 : 0);

    if (result.success) {
      toast(`${repo.fullName} склонирован`, 'success', { timeout: 8000, action: { label: 'Открыть папку', fn: () => api.openPath(result.path) } });
    } else {
      toast(result.error || 'Ошибка клонирования', result.cancelled ? 'warn' : 'error');
    }
  }

  $('reposRefreshBtn').addEventListener('click', loadRepos);
  $('reposSearch').addEventListener('input', debounce(renderRepos, 150));
  $('reposFilter').addEventListener('change', renderRepos);
  $('reposSort').addEventListener('change', renderRepos);

  // ---------- Релизы ----------

  const ASSET_LIMIT = 2 * 1024 * 1024 * 1024;

  function parseVersion(tag) {
    const m = /^(v?)(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(tag || '').trim());
    if (!m) return null;
    return { prefix: m[1], major: +m[2], minor: +m[3], patch: +(m[4] || 0) };
  }

  function releaseRepoParts() {
    const [owner, repo] = (state.releaseRepo || '').split('/');
    return { owner, repo };
  }

  async function openReleases(fullName) {
    if (fullName) {
      state.releaseRepo = fullName;
      state.releases = null;
    }
    showView('releases');
  }

  async function ensureReleasesView() {
    if (!state.repos && !state.reposLoading) await loadRepos();
    fillReleaseRepoSelect();
    if (state.releaseRepo && !state.releases) loadReleases();
    updatePublishButton();
  }

  function fillReleaseRepoSelect() {
    const sel = $('releaseRepoSelect');
    const repos = (state.repos || []).filter(r => !r.archived);
    if (!state.releaseRepo) {
      const fromHistory = state.history.find(h => repos.some(r => r.fullName === h.fullName));
      state.releaseRepo = fromHistory ? fromHistory.fullName : (repos[0] && repos[0].fullName) || null;
    }
    const names = repos.map(r => r.fullName);
    if (state.releaseRepo && !names.includes(state.releaseRepo)) names.unshift(state.releaseRepo);
    sel.innerHTML = names.length
      ? names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
      : '<option value="">Репозиториев нет</option>';
    if (state.releaseRepo) sel.value = state.releaseRepo;
  }

  $('releaseRepoSelect').addEventListener('change', (e) => {
    state.releaseRepo = e.target.value || null;
    state.releases = null;
    $('releaseTag').value = '';
    $('releaseTarget').value = '';
    loadReleases();
  });

  $('releasesRefreshBtn').addEventListener('click', async () => {
    await loadRepos();
    fillReleaseRepoSelect();
    loadReleases();
  });

  async function loadReleases() {
    const { owner, repo } = releaseRepoParts();
    if (!owner || !repo) {
      $('releasesList').innerHTML = `<div class="empty">${icon('repo')}<b>Нет репозитория</b>Сначала загрузите проект на GitHub</div>`;
      updatePublishButton();
      return;
    }
    const requested = state.releaseRepo;
    $('releasesCount').textContent = '';
    $('releasesList').innerHTML = '<div class="skeleton"></div>'.repeat(2);
    const res = await api.listReleases({ owner, repo });
    if (requested !== state.releaseRepo) return;
    if (!res.success) {
      state.releases = null;
      $('releasesList').innerHTML = `<div class="empty">${icon('warn')}<b>Не удалось получить релизы</b>${esc(res.error)}</div>`;
      updatePublishButton();
      return;
    }
    state.releases = res.releases;
    state.latestReleaseId = res.latestId;
    state.releaseRepoInfo = { defaultBranch: res.defaultBranch, empty: res.empty, htmlUrl: res.htmlUrl };
    $('releaseTarget').placeholder = res.defaultBranch || 'main';
    renderReleases();
    await renderTagSuggestions();
    updatePublishButton();
  }

  async function renderTagSuggestions() {
    const existing = new Set((state.releases || []).map(r => r.tag));
    const last = (state.releases || []).map(r => parseVersion(r.tag)).find(Boolean);
    const chips = [];
    if (last) {
      const p = last.prefix;
      chips.push(`${p}${last.major}.${last.minor}.${last.patch + 1}`);
      chips.push(`${p}${last.major}.${last.minor + 1}.0`);
      chips.push(`${p}${last.major + 1}.0.0`);
    } else {
      chips.push('v1.0.0');
    }
    let fromPkg = null;
    if (state.folder && state.folderInfo && state.folderInfo.remoteRepo &&
        `${state.folderInfo.remoteRepo.owner}/${state.folderInfo.remoteRepo.name}`.toLowerCase() === (state.releaseRepo || '').toLowerCase()) {
      const v = await api.getFolderVersion(state.folder);
      if (v) fromPkg = 'v' + v;
    }
    if (fromPkg && !chips.includes(fromPkg)) chips.unshift(fromPkg);
    const free = chips.filter(c => !existing.has(c));

    $('tagSuggest').innerHTML = free.length
      ? 'Варианты: ' + free.map(c => `<button class="tag-chip" data-tag="${esc(c)}">${esc(c)}${c === fromPkg ? ' · package.json' : ''}</button>`).join('')
      : '';
    if (!$('releaseTag').value && free[0]) $('releaseTag').value = free[0];
  }

  $('tagSuggest').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag]');
    if (!chip) return;
    $('releaseTag').value = chip.dataset.tag;
    updatePublishButton();
  });

  function renderReleases() {
    const list = state.releases || [];
    const { repo } = releaseRepoParts();
    $('releasesCount').textContent = list.length ? `${list.length}` : '';
    if (!list.length) {
      $('releasesList').innerHTML = `<div class="empty">${icon('tag')}<b>Релизов пока нет</b>Опубликуйте первую версию ${esc(repo || '')} с помощью формы выше</div>`;
      return;
    }
    const repoUrl = state.releaseRepoInfo && state.releaseRepoInfo.htmlUrl;
    $('releasesList').innerHTML = list.map(r => {
      const isLatest = r.id === state.latestReleaseId;
      const downloads = r.assets.reduce((s, a) => s + a.downloads, 0);
      const assets = r.assets.map(a => `
        <div class="asset" data-asset="${a.id}">
          ${icon('file')}
          <span class="asset-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="asset-meta">${esc(a.sizeText)} · ${a.downloads} ${plural(a.downloads, 'скачивание', 'скачивания', 'скачиваний')}</span>
          <button class="icon-btn" data-act="copy-asset" title="Копировать ссылку на этот файл">${icon('copy')}</button>
          ${isLatest && repoUrl ? `<button class="icon-btn" data-act="copy-latest" title="Копировать постоянную ссылку на последнюю версию">${icon('link')}</button>` : ''}
          <button class="icon-btn" data-act="delete-asset" title="Удалить файл">${icon('trash')}</button>
        </div>`).join('');
      return `
        <div class="release ${isLatest ? 'is-latest' : ''}" data-id="${r.id}">
          <div class="release-head">
            <div class="release-title">
              <span class="release-tag" data-act="open" title="Открыть на GitHub">${esc(r.tag)}</span>
              ${r.name && r.name !== r.tag ? `<span class="release-name">${esc(r.name)}</span>` : ''}
              ${isLatest ? '<span class="badge green">Последний</span>' : ''}
              ${r.prerelease ? '<span class="badge private">Пре-релиз</span>' : ''}
              ${r.draft ? '<span class="badge draft">Черновик</span>' : ''}
            </div>
            <div class="item-actions">
              ${r.draft ? `<button class="btn btn-sm btn-primary" data-act="publish">${icon('send')}Опубликовать</button>` : ''}
              ${!r.draft && !r.prerelease && !isLatest ? `<button class="btn btn-sm btn-ghost" data-act="make-latest">Сделать последним</button>` : ''}
              <button class="icon-btn" data-act="add-files" title="Добавить файлы">${icon('upload')}</button>
              <button class="icon-btn" data-act="open" title="Открыть на GitHub">${icon('external')}</button>
              <button class="icon-btn" data-act="delete" title="Удалить релиз">${icon('trash')}</button>
            </div>
          </div>
          <div class="release-meta">${r.draft ? 'Создан ' + esc(relTime(r.createdAt)) : 'Опубликован ' + esc(relTime(r.publishedAt))}${r.author ? ' · ' + esc(r.author) : ''}${r.assets.length ? ` · ${r.assets.length} ${plural(r.assets.length, 'файл', 'файла', 'файлов')}, ${downloads} ${plural(downloads, 'скачивание', 'скачивания', 'скачиваний')}` : ''}</div>
          ${r.body ? `<div class="release-body" data-act="toggle-body" title="Нажмите, чтобы развернуть">${esc(r.body)}</div>` : ''}
          ${assets ? `<div class="assets">${assets}</div>` : ''}
        </div>`;
    }).join('');
  }

  $('releasesList').addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const el = e.target.closest('.release');
    if (!actEl || !el || !state.releases) return;
    const r = state.releases.find(x => String(x.id) === el.dataset.id);
    if (!r) return;
    const { owner, repo } = releaseRepoParts();
    const act = actEl.dataset.act;
    const assetEl = e.target.closest('[data-asset]');
    const asset = assetEl && r.assets.find(a => String(a.id) === assetEl.dataset.asset);

    if (act === 'open') api.openExternal(r.htmlUrl);
    if (act === 'toggle-body') actEl.classList.toggle('expanded');
    if (act === 'copy-asset' && asset) copy(asset.url, 'Ссылка на файл скопирована');
    if (act === 'copy-latest' && asset) {
      const url = `${state.releaseRepoInfo.htmlUrl}/releases/latest/download/${encodeURIComponent(asset.name)}`;
      await api.copyText(url);
      toast('Постоянная ссылка скопирована. Она всегда ведёт на этот файл из самого нового релиза — удобно для обновлений.', 'success', { timeout: 6000 });
    }
    if (act === 'delete-asset' && asset) {
      const ok = await confirmDialog({ title: 'Удалить файл?', text: `«${asset.name}» будет удалён из релиза ${r.tag}.`, okText: 'Удалить', danger: true });
      if (!ok) return;
      const res = await api.deleteReleaseAsset({ owner, repo, assetId: asset.id });
      if (res.success) { toast('Файл удалён', 'success'); loadReleases(); } else toast(res.error, 'error');
    }
    if (act === 'publish' || act === 'make-latest') {
      actEl.disabled = true;
      const patch = act === 'publish' ? { draft: false, makeLatest: !r.prerelease } : { makeLatest: true };
      const res = await api.updateRelease({ owner, repo, releaseId: r.id, patch });
      if (res.success) { toast(act === 'publish' ? `Релиз ${r.tag} опубликован` : `${r.tag} отмечен как последний`, 'success'); loadReleases(); }
      else { actEl.disabled = false; toast(res.error, 'error'); }
    }
    if (act === 'delete') {
      const ok = await confirmDialog({
        title: `Удалить релиз ${r.tag}?`,
        text: `Релиз, его файлы${r.assets.length ? ` (${r.assets.length})` : ''} и тег ${r.tag} будут удалены с GitHub. Это действие нельзя отменить.`,
        okText: 'Удалить',
        danger: true
      });
      if (!ok) return;
      const res = await api.deleteRelease({ owner, repo, releaseId: r.id, tag: r.tag, deleteTag: true });
      if (res.success) {
        toast(res.warning || `Релиз ${r.tag} удалён`, res.warning ? 'warn' : 'success');
        $('releaseTag').value = '';
        loadReleases();
      } else toast(res.error, 'error');
    }
    if (act === 'add-files') addFilesToRelease(r);
  });

  async function addFilesToRelease(r) {
    if (state.releasing || state.uploading) return toast('Дождитесь окончания текущей операции', 'warn');
    const files = await api.selectFiles();
    if (!files.length) return;
    const tooBig = files.find(f => f.size > ASSET_LIMIT);
    if (tooBig) return toast(`Файл ${tooBig.name} больше 2 ГБ — GitHub такие не принимает`, 'error');
    const clash = files.filter(f => r.assets.some(a => a.name === f.name));
    if (clash.length) {
      const ok = await confirmDialog({
        title: 'Заменить файлы?',
        text: `В релизе ${r.tag} уже есть: ${clash.map(f => f.name).join(', ')}. Заменить их новыми?`,
        okText: 'Заменить'
      });
      if (!ok) return;
    }
    const { owner, repo } = releaseRepoParts();
    setReleasing(true);
    const res = await api.addReleaseAssets({ owner, repo, releaseId: r.id, files: files.map(f => f.path), replace: clash.length > 0 });
    setReleasing(false, res.success);
    if (res.success) toast(`Файлы добавлены в ${r.tag}`, 'success');
    else toast(res.error, res.cancelled ? 'warn' : 'error');
    loadReleases();
  }

  // Файлы нового релиза

  function addReleaseFiles(files) {
    for (const f of files) {
      if (!state.releaseFiles.some(x => x.path === f.path)) state.releaseFiles.push(f);
    }
    renderReleaseFiles();
  }

  function renderReleaseFiles() {
    const names = state.releaseFiles.map(f => f.name);
    $('releaseFiles').innerHTML = state.releaseFiles.map((f, i) => {
      const big = f.size > ASSET_LIMIT;
      const dup = names.indexOf(f.name) !== i;
      return `<div class="file-row ${big || dup ? 'too-big' : ''}" data-i="${i}">
        ${icon('file')}
        <span class="file-name" title="${esc(f.path)}">${esc(f.name)}</span>
        <span class="file-size">${big ? 'больше 2 ГБ' : dup ? 'имя повторяется' : esc(f.sizeText)}</span>
        <button class="icon-btn" data-act="remove" title="Убрать">${icon('x')}</button>
      </div>`;
    }).join('');
    updatePublishButton();
  }

  $('releaseFiles').addEventListener('click', (e) => {
    const row = e.target.closest('[data-act="remove"]') && e.target.closest('.file-row');
    if (!row || state.releasing) return;
    state.releaseFiles.splice(+row.dataset.i, 1);
    renderReleaseFiles();
  });

  async function pickReleaseFiles() {
    if (state.releasing) return;
    addReleaseFiles(await api.selectFiles());
  }

  $('releaseDrop').addEventListener('click', pickReleaseFiles);
  $('releaseDrop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pickReleaseFiles(); });

  function updatePublishButton() {
    const tag = $('releaseTag').value.trim();
    const exists = (state.releases || []).some(r => r.tag === tag);
    const names = state.releaseFiles.map(f => f.name);
    const badFiles = state.releaseFiles.some((f, i) => f.size > ASSET_LIMIT || names.indexOf(f.name) !== i);
    const empty = state.releaseRepoInfo && state.releaseRepoInfo.empty;
    const ready = state.releaseRepo && state.releases && tag && !exists && !badFiles && !empty && !state.releasing && !state.uploading;
    $('publishReleaseBtn').disabled = !ready;
    $('releaseTag').classList.toggle('invalid', !!exists);

    let hint = '';
    if (!state.releaseRepo) hint = 'Выберите репозиторий';
    else if (empty) hint = 'Репозиторий пуст — сначала загрузите в него проект';
    else if (!tag) hint = 'Укажите версию, например v1.0.0';
    else if (exists) hint = `Релиз ${tag} уже существует — укажите новую версию`;
    else if (badFiles) hint = 'Уберите отмеченные красным файлы';
    else if (!state.releaseFiles.length) hint = 'Файлы можно не прикреплять — GitHub сам добавит архив с исходным кодом';
    $('releaseHint').textContent = hint;
  }

  $('releaseTag').addEventListener('input', updatePublishButton);

  function setReleasing(on, success) {
    state.releasing = on;
    const btn = $('publishReleaseBtn');
    btn.innerHTML = on
      ? '<div class="spinner"></div><span class="btn-label">Публикация...</span>'
      : `${icon('send')}<span class="btn-label">Опубликовать релиз</span>`;
    $('cancelReleaseBtn').classList.toggle('hidden', !on);
    $('cancelReleaseBtn').disabled = false;
    ['releaseTag', 'releaseTarget', 'releaseName', 'releaseBody', 'releaseRepoSelect'].forEach(id => { $(id).disabled = on; });
    if (on) {
      $('releaseProgress').classList.remove('hidden');
      $('releaseFill').classList.remove('error');
      $('releaseFill').style.width = '2%';
      $('releaseProgressPercent').textContent = '';
      $('releaseProgressText').textContent = 'Подготовка...';
    } else {
      if (success === false) $('releaseFill').classList.add('error');
      setTimeout(() => { if (!state.releasing) $('releaseProgress').classList.add('hidden'); }, success === false ? 6000 : 2500);
    }
    updatePublishButton();
  }

  api.onReleaseProgress((d) => {
    $('releaseFill').style.width = d.progress + '%';
    $('releaseProgressPercent').textContent = d.progress + '%';
    $('releaseProgressText').textContent = (d.files > 1 ? `[${d.file}/${d.files}] ` : '') + d.stage;
  });

  async function publishRelease() {
    if ($('publishReleaseBtn').disabled) return;
    const { owner, repo } = releaseRepoParts();
    const tag = $('releaseTag').value.trim();
    const draft = $('releaseDraft').checked;

    setReleasing(true);
    const res = await api.createRelease({
      owner,
      repo,
      tag,
      target: $('releaseTarget').value.trim() || (state.releaseRepoInfo && state.releaseRepoInfo.defaultBranch),
      name: $('releaseName').value.trim(),
      body: $('releaseBody').value.trim(),
      generateNotes: $('releaseGenerate').checked,
      prerelease: $('releasePrerelease').checked,
      draft,
      openAfter: $('releaseOpenAfter').checked,
      files: state.releaseFiles.map(f => f.path)
    });
    setReleasing(false, res.success);

    if (res.success) {
      toast(draft ? `Черновик ${tag} сохранён` : `Релиз ${tag} опубликован!`, 'success', {
        timeout: 8000,
        action: { label: 'Открыть', fn: () => api.openExternal(res.release.htmlUrl) }
      });
      state.releaseFiles = [];
      renderReleaseFiles();
      ['releaseTag', 'releaseName', 'releaseBody'].forEach(id => { $(id).value = ''; });
      $('releaseDraft').checked = false;
      $('releasePrerelease').checked = false;
    } else if (res.partial) {
      toast(`Релиз ${res.partial.tag} создан, но не все файлы загрузились: ${res.error}. Догрузите их кнопкой «Добавить файлы».`, 'error', { timeout: 12000 });
    } else {
      toast(res.error || 'Не удалось создать релиз', res.cancelled ? 'warn' : 'error');
    }
    loadReleases();
  }

  $('publishReleaseBtn').addEventListener('click', publishRelease);
  $('cancelReleaseBtn').addEventListener('click', async () => {
    $('cancelReleaseBtn').disabled = true;
    await api.cancelOperation();
  });

  // ---------- История ----------

  async function refreshHistoryBadge() {
    state.history = await api.getHistory();
    const badge = $('historyBadge');
    badge.textContent = state.history.length;
    badge.classList.toggle('hidden', state.history.length === 0);
    if (state.view === 'history') renderHistory(true);
  }

  async function renderHistory(skipFetch) {
    if (!skipFetch) state.history = await api.getHistory();
    $('clearHistoryBtn').disabled = state.history.length === 0;
    if (!state.history.length) {
      $('historyList').innerHTML = `<div class="empty">${icon('history')}<b>История пуста</b>Здесь появятся загруженные проекты</div>`;
      return;
    }
    $('historyList').innerHTML = state.history.map(h => `
      <div class="item" data-id="${esc(h.id)}">
        <div class="item-main">
          <div class="item-title">
            <span class="name" data-act="open" title="Открыть на GitHub">${esc(h.fullName)}</span>
            <span class="badge ${h.created ? 'green' : ''}">${h.created ? 'Создан' : 'Обновлён'}</span>
            ${h.private ? '<span class="badge private">Private</span>' : ''}
          </div>
          <div class="item-desc" title="${esc(h.folder)}">${esc(h.folder)}</div>
          <div class="item-meta">
            <span>${esc(formatDate(h.date))}</span>
            <span>${icon('branch')}${esc(h.branch)}</span>
            <span>${esc(h.sha)}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="icon-btn" data-act="repeat" title="Загрузить снова">${icon('redo')}</button>
          <button class="icon-btn" data-act="folder" title="Открыть папку">${icon('folder')}</button>
          <button class="icon-btn" data-act="open" title="Открыть на GitHub">${icon('external')}</button>
          <button class="icon-btn" data-act="remove" title="Удалить из истории">${icon('trash')}</button>
        </div>
      </div>`).join('');
  }

  $('historyList').addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const item = e.target.closest('.item');
    if (!actEl || !item) return;
    const h = state.history.find(x => x.id === item.dataset.id);
    if (!h) return;
    const act = actEl.dataset.act;
    if (act === 'open') api.openExternal(h.url);
    if (act === 'folder') {
      const r = await api.openPath(h.folder);
      if (!r.success) toast('Папка не найдена: ' + h.folder, 'error');
    }
    if (act === 'remove') {
      state.history = await api.removeHistoryItem(h.id);
      refreshHistoryBadge();
    }
    if (act === 'repeat') {
      if (!state.authenticated) return showView('upload');
      showView('upload');
      if ([...$('ownerSelect').options].some(o => o.value === h.owner)) $('ownerSelect').value = h.owner;
      $('repoName').value = h.name;
      state.repoNameAuto = false;
      await setFolder(h.folder);
      $('branchInput').value = h.branch;
    }
  });

  $('clearHistoryBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Очистить историю?', text: 'Записи будут удалены только из GitLoader. Репозитории на GitHub останутся.', okText: 'Очистить', danger: true });
    if (!ok) return;
    await api.clearHistory();
    refreshHistoryBadge();
    renderHistory();
  });

  // ---------- Настройки ----------

  function bindSegmented(id, key, map = (v) => v) {
    document.querySelectorAll(`#${id} button`).forEach(b => {
      b.addEventListener('click', () => saveSetting({ [key]: map(b.dataset.value) }));
    });
  }

  function renderSettings() {
    const s = state.settings;
    document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.value === s.theme));
    document.querySelectorAll('#defaultVisSeg button').forEach(b => b.classList.toggle('active', (b.dataset.value === 'private') === !!s.defaultPrivate));
    if (document.activeElement !== $('defaultBranchInput')) $('defaultBranchInput').value = s.defaultBranch;
    $('openAfterSetting').checked = !!s.openAfterUpload;
    $('openAfterCheck').checked = !!s.openAfterUpload;
    document.querySelectorAll('input[name="authorMode"]').forEach(r => { r.checked = r.value === s.authorMode; });
    $('authorFields').classList.toggle('disabled', s.authorMode !== 'custom');
    if (document.activeElement !== $('authorNameInput')) $('authorNameInput').value = s.authorName || '';
    if (document.activeElement !== $('authorEmailInput')) $('authorEmailInput').value = s.authorEmail || '';
  }

  async function saveSetting(patch) {
    state.settings = await api.saveSettings(patch);
    applyTheme();
    renderSettings();
  }

  bindSegmented('themeSeg', 'theme');
  bindSegmented('defaultVisSeg', 'defaultPrivate', (v) => v === 'private');
  $('defaultBranchInput').addEventListener('change', (e) => saveSetting({ defaultBranch: e.target.value.trim() || 'main' }));
  $('openAfterSetting').addEventListener('change', (e) => saveSetting({ openAfterUpload: e.target.checked }));
  document.querySelectorAll('input[name="authorMode"]').forEach(r => {
    r.addEventListener('change', () => saveSetting({ authorMode: r.value }));
  });
  const saveAuthor = debounce(() => saveSetting({ authorName: $('authorNameInput').value.trim(), authorEmail: $('authorEmailInput').value.trim() }), 500);
  $('authorNameInput').addEventListener('input', saveAuthor);
  $('authorEmailInput').addEventListener('input', saveAuthor);
  $('openLogBtn').addEventListener('click', () => api.openLog());
  $('tokenSettingsBtn').addEventListener('click', () => api.openExternal('https://github.com/settings/tokens'));

  // ---------- Запуск ----------

  async function init() {
    state.settings = await api.getSettings();
    applyTheme();
    renderSettings();
    $('branchInput').value = state.settings.defaultBranch || 'main';
    setVisibility(state.settings.defaultPrivate ? 'private' : 'public');

    await Promise.all([renderAbout(), loadLicenses(), refreshHistoryBadge()]);
    await checkAuth();
    updateUploadButton();
  }

  init().catch((e) => {
    console.error(e);
    toast('Ошибка запуска интерфейса: ' + e.message, 'error');
  });
})();
