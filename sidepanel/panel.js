import { FALLBACK_MODEL, listModels, pickDefaultModel, streamText, textModels } from './openai.js';
import { API_LIMITS, CHATGPT_LIMITS, describeTranscriptLanguage, summarize } from './summarize.js';
import { CHATGPT_PERMISSION, askChatGPT, unregisterHook } from './chatgpt-web.js';
import { renderMarkdown } from './markdown.js';

const CACHE_PREFIX = 'summary:';
const CACHE_LIMIT = 50;
// provider: 'chatgpt' (web app, user's login) | 'api' (OpenAI API key) | '' (not connected)
const DEFAULT_SETTINGS = { provider: '', apiKey: '', model: '', models: [], language: 'auto', keepHistory: false };

const el = Object.fromEntries(
  [
    'settings-button', 'connect-view', 'use-chatgpt-button', 'chatgpt-error', 'connect-form', 'api-key',
    'connect-button', 'connect-error', 'settings-view', 'settings-back', 'connection-label', 'disconnect-button',
    'api-settings', 'model', 'model-options', 'chatgpt-settings', 'keep-history', 'language', 'main-view',
    'no-video', 'video', 'thumbnail', 'video-title', 'video-channel', 'summarize-button', 'progress',
    'progress-text', 'progress-tab-button', 'error', 'error-text', 'retry-button', 'error-tab-button',
    'error-debug-button', 'result', 'result-footer', 'result-meta', 'copy-button', 'regenerate-button',
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)])
);

const state = {
  settings: { ...DEFAULT_SETTINGS },
  view: 'main', // 'main' | 'settings'
  windowId: null,
  tab: null,
  videoId: null,
  // videoId -> { status: 'working' | 'done' | 'error', step, markdown, error, debug, chatTabId,
  //              title, author, transcriptLanguage, model, createdAt }
  jobs: new Map(),
};

// ---- Helpers --------------------------------------------------------------

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function cleanTabTitle(title = '') {
  const cleaned = title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
  return cleaned === 'YouTube' ? '' : cleaned;
}

const maskKey = (key) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••');

const isConnected = ({ provider, apiKey }) => provider === 'chatgpt' || (provider === 'api' && Boolean(apiKey));

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  // Settings saved before the ChatGPT option existed only had an API key.
  if (!settings?.provider && state.settings.apiKey) state.settings.provider = 'api';
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await chrome.storage.local.set({ settings: state.settings });
}

async function loadCachedSummary(videoId) {
  const key = CACHE_PREFIX + videoId;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function saveCachedSummary(videoId, entry) {
  await chrome.storage.local.set({ [CACHE_PREFIX + videoId]: entry });
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all)
    .filter((key) => key.startsWith(CACHE_PREFIX))
    .sort((a, b) => all[b].createdAt - all[a].createdAt)
    .slice(CACHE_LIMIT);
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Messages the YouTube tab's content script, injecting it first if the tab was
// opened before the extension was installed or reloaded.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function requestTranscript(tabId, videoId) {
  const response = await sendToTab(tabId, { type: 'yts:getTranscript', videoId });
  if (!response?.ok) throw new Error(response?.error || 'Could not read the transcript from the YouTube tab.');
  return response.data;
}

// The model call for the chosen provider, in the shape summarize() expects.
function backendFor(job) {
  const { provider, apiKey, keepHistory } = state.settings;
  if (provider === 'chatgpt') {
    return {
      label: 'ChatGPT',
      limits: CHATGPT_LIMITS,
      complete: ({ instructions, input, onText }) =>
        askChatGPT(`${instructions}\n\n${input}`, {
          temporary: !keepHistory,
          onText,
          onTab: (tabId) => {
            job.chatTabId = tabId;
            scheduleRender();
          },
        }),
    };
  }
  const model = state.settings.model || FALLBACK_MODEL;
  return {
    label: model,
    limits: API_LIMITS,
    complete: (options) => streamText({ apiKey, model, ...options }),
  };
}

// ---- Rendering ------------------------------------------------------------

let renderedMarkdown = null;
let frame = 0;

function scheduleRender() {
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render() {
  const connected = isConnected(state.settings);
  el.settingsButton.hidden = !connected || state.view === 'settings';
  el.connectView.hidden = connected;
  el.settingsView.hidden = !connected || state.view !== 'settings';
  el.mainView.hidden = !connected || state.view !== 'main';
  if (connected && state.view === 'main') renderMain();
}

function renderMain() {
  const { videoId } = state;
  el.noVideo.hidden = Boolean(videoId);
  el.video.hidden = !videoId;
  if (!videoId) return;

  const job = state.jobs.get(videoId);
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  if (el.thumbnail.getAttribute('src') !== thumbnail) el.thumbnail.src = thumbnail;
  el.videoTitle.textContent = job?.title || cleanTabTitle(state.tab?.title) || 'YouTube video';
  el.videoChannel.textContent = job?.author || '';
  el.videoChannel.hidden = !job?.author;

  el.summarizeButton.hidden = Boolean(job);
  el.progress.hidden = job?.status !== 'working';
  el.progressText.textContent = job?.step || '';
  el.progressTabButton.hidden = !job?.chatTabId;
  el.error.hidden = job?.status !== 'error';
  el.errorText.textContent = job?.error || '';
  el.errorTabButton.hidden = !job?.chatTabId;
  el.errorDebugButton.hidden = !job?.debug;

  const markdown = job?.markdown || '';
  el.result.hidden = !markdown;
  el.result.classList.toggle('streaming', job?.status === 'working');
  if (markdown !== renderedMarkdown) {
    el.result.innerHTML = renderMarkdown(markdown);
    renderedMarkdown = markdown;
  }

  el.resultFooter.hidden = job?.status !== 'done';
  if (job?.status === 'done') {
    el.resultMeta.textContent = [job.model, job.transcriptLanguage].filter(Boolean).join(' · ');
  }
}

function openSettings() {
  const { provider, apiKey, model, language, keepHistory, models } = state.settings;
  state.view = 'settings';
  el.connectionLabel.textContent = provider === 'chatgpt' ? 'ChatGPT (your login)' : `API key ${maskKey(apiKey)}`;
  el.apiSettings.hidden = provider !== 'api';
  el.chatgptSettings.hidden = provider !== 'chatgpt';
  el.model.value = model || FALLBACK_MODEL;
  el.keepHistory.checked = keepHistory;
  el.language.value = language;
  fillModelOptions(models);
  render();
  if (provider !== 'api') return;
  // Refresh the list quietly in case new models became available.
  listModels(apiKey)
    .then((ids) => {
      const fresh = textModels(ids);
      fillModelOptions(fresh);
      return saveSettings({ models: fresh });
    })
    .catch(() => {});
}

function fillModelOptions(models) {
  el.modelOptions.replaceChildren(
    ...models.map((id) => Object.assign(document.createElement('option'), { value: id }))
  );
}

// ---- Actions --------------------------------------------------------------

async function startSummary() {
  const { videoId, tab } = state;
  if (!videoId || !tab) return;

  const previous = state.jobs.get(videoId);
  const job = { status: 'working', step: 'Fetching transcript…', markdown: '', title: previous?.title, author: previous?.author };
  state.jobs.set(videoId, job);
  render();

  try {
    const transcript = await requestTranscript(tab.id, videoId);
    job.title = transcript.title || job.title;
    job.author = transcript.author || job.author;
    job.transcriptLanguage = describeTranscriptLanguage(transcript);

    const backend = backendFor(job);
    job.markdown = await summarize({
      transcript,
      language: state.settings.language,
      ...backend,
      onStatus: (step) => {
        job.step = step;
        scheduleRender();
      },
      onText: (text) => {
        job.markdown = text;
        scheduleRender();
      },
    });
    Object.assign(job, { status: 'done', model: backend.label, createdAt: Date.now(), chatTabId: null });
    const { title, author, transcriptLanguage, markdown, model, createdAt } = job;
    await saveCachedSummary(videoId, { title, author, transcriptLanguage, markdown, model, createdAt });
  } catch (error) {
    console.error(error);
    Object.assign(job, {
      status: 'error',
      error: error.message || String(error),
      debug: error.debug || '',
      chatTabId: error.tabId ?? null,
    });
  }
  scheduleRender();
}

async function connectWithApiKey(event) {
  event.preventDefault();
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) return;

  el.connectButton.disabled = true;
  el.connectButton.textContent = 'Connecting…';
  el.connectError.hidden = true;
  try {
    let models = [];
    try {
      models = textModels(await listModels(apiKey));
    } catch (error) {
      // Restricted keys may be unable to list models but can still generate text.
      if (error.status !== 403) throw error;
    }
    const current = state.settings.model;
    const model = models.length ? (models.includes(current) ? current : pickDefaultModel(models)) : current || FALLBACK_MODEL;
    await saveSettings({ provider: 'api', apiKey, models, model });
    el.apiKey.value = '';
    state.view = 'main';
    render();
  } catch (error) {
    el.connectError.textContent =
      error.status === 401 ? 'OpenAI rejected this API key. Check that you copied all of it.' : error.message;
    el.connectError.hidden = false;
  } finally {
    el.connectButton.disabled = false;
    el.connectButton.textContent = 'Connect';
  }
}

async function connectWithChatGPT() {
  el.chatgptError.hidden = true;
  // Must be the first await: Chrome only shows the prompt during a user gesture.
  const granted = await chrome.permissions.request(CHATGPT_PERMISSION).catch(() => false);
  if (!granted) {
    el.chatgptError.textContent = 'The extension needs access to chatgpt.com to use your ChatGPT login.';
    el.chatgptError.hidden = false;
    return;
  }
  await saveSettings({ provider: 'chatgpt' });
  state.view = 'main';
  render();
}

async function disconnect() {
  if (state.settings.provider === 'chatgpt') {
    await unregisterHook();
    await chrome.permissions.remove(CHATGPT_PERMISSION).catch(() => {});
  }
  await saveSettings({ provider: '', apiKey: '' });
  state.view = 'main';
  render();
}

function showChatTab() {
  const job = state.jobs.get(state.videoId);
  if (job?.chatTabId == null) return;
  chrome.tabs.update(job.chatTabId, { active: true }).catch(() => {
    // The tab is gone (closed by the user, or finished).
    job.chatTabId = null;
    render();
  });
}

async function copySummary() {
  const job = state.jobs.get(state.videoId);
  if (!job?.markdown) return;
  const header = [job.title && `# ${job.title}`, `https://www.youtube.com/watch?v=${state.videoId}`].filter(Boolean);
  await navigator.clipboard.writeText(`${header.join('\n')}\n\n${job.markdown}`);
  el.copyButton.textContent = 'Copied';
  setTimeout(() => (el.copyButton.textContent = 'Copy'), 1500);
}

// For reporting a broken ChatGPT integration; holds no conversation text.
async function copyDebugDetails() {
  const job = state.jobs.get(state.videoId);
  if (!job?.debug) return;
  await navigator.clipboard.writeText(`${job.error}\n\n${job.debug}`);
  el.errorDebugButton.textContent = 'Copied';
  setTimeout(() => (el.errorDebugButton.textContent = 'Copy details'), 1500);
}

// Timestamps and whole highlight rows ("moments") jump the video.
function seekTo(event) {
  const target = event.target.closest('.ts, .moment');
  if (!target || !state.tab) return;
  // Selecting text in a highlight shouldn't jump.
  if (!target.matches('.ts') && !document.getSelection().isCollapsed) return;
  for (const moment of el.result.querySelectorAll('.moment.active')) moment.classList.remove('active');
  target.closest('.moment')?.classList.add('active');
  sendToTab(state.tab.id, { type: 'yts:seek', videoId: state.videoId, seconds: Number(target.dataset.seconds) }).catch(
    (error) => console.error('Seek failed', error)
  );
}

// ---- Active tab tracking --------------------------------------------------

async function setTab(tab) {
  state.tab = tab || null;
  const videoId = tab?.url ? getVideoId(tab.url) : null;
  if (videoId !== state.videoId) {
    state.videoId = videoId;
    if (videoId && !state.jobs.has(videoId)) {
      const cached = await loadCachedSummary(videoId);
      if (cached && !state.jobs.has(videoId)) state.jobs.set(videoId, { ...cached, status: 'done' });
    }
  }
  render();
}

async function syncActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  await setTab(tab);
}

// ---- Init -----------------------------------------------------------------

async function init() {
  el.useChatgptButton.addEventListener('click', connectWithChatGPT);
  el.connectForm.addEventListener('submit', connectWithApiKey);
  el.settingsButton.addEventListener('click', openSettings);
  el.settingsBack.addEventListener('click', () => {
    state.view = 'main';
    render();
  });
  el.model.addEventListener('change', () => {
    saveSettings({ model: el.model.value.trim() || pickDefaultModel(state.settings.models) });
  });
  el.keepHistory.addEventListener('change', () => saveSettings({ keepHistory: el.keepHistory.checked }));
  el.language.addEventListener('change', () => saveSettings({ language: el.language.value }));
  el.disconnectButton.addEventListener('click', disconnect);
  el.summarizeButton.addEventListener('click', startSummary);
  el.retryButton.addEventListener('click', startSummary);
  el.regenerateButton.addEventListener('click', startSummary);
  el.progressTabButton.addEventListener('click', showChatTab);
  el.errorTabButton.addEventListener('click', showChatTab);
  el.errorDebugButton.addEventListener('click', copyDebugDetails);
  el.copyButton.addEventListener('click', copySummary);
  el.result.addEventListener('click', seekTo);

  // Keep several open side panels (one per window) in sync.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    render();
  });

  await loadSettings();
  state.windowId = (await chrome.windows.getCurrent()).id;
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.windowId) syncActiveTab();
  });
  chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
    if (tab.active && tab.windowId === state.windowId) setTab(tab);
  });
  await syncActiveTab();
}

init();
