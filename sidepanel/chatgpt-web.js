// Asks ChatGPT through its web app with the user's own login: opens chatgpt.com
// in a background tab, lets chatgpt.js type and send the prompt, and relays the
// reply. The tab closes when done, or stays open on errors so the user can look.

const CHATGPT_URL = 'https://chatgpt.com/';
export const CHATGPT_PERMISSION = { origins: [`${CHATGPT_URL}*`] };

// Reads the reply from ChatGPT's network stream (see chatgpt-hook.js). It has to
// run before ChatGPT's own scripts, so it is registered rather than injected,
// and only acts in tabs whose URL carries TAB_MARK.
const HOOK_ID = 'yts-chatgpt-hook';
const TAB_MARK = '#yts';

export class ChatGPTError extends Error {
  constructor(message, tabId, debug = '') {
    super(message);
    this.tabId = tabId;
    this.debug = debug;
  }
}

async function registerHook() {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [HOOK_ID] });
    if (registered.length) return;
    await chrome.scripting.registerContentScripts([
      { id: HOOK_ID, matches: CHATGPT_PERMISSION.origins, js: ['chatgpt-hook.js'], runAt: 'document_start', world: 'MAIN' },
    ]);
  } catch (error) {
    // Reading the reply from the page still works without it.
    console.warn('Could not register the ChatGPT reply reader', error);
  }
}

export async function unregisterHook() {
  await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] }).catch(() => {});
}

function waitForTabLoad(tabId, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      callback(value);
    };
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && tab.url?.startsWith(CHATGPT_URL)) finish(resolve);
    };
    const timer = setTimeout(() => finish(reject, new ChatGPTError('ChatGPT took too long to load.', tabId)), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function relay(tabId, prompt, onText) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'yts-chatgpt' });
    port.onMessage.addListener((message) => {
      if (message.type === 'progress') onText?.(message.text);
      else if (message.type === 'done') resolve(message.text);
      else if (message.type === 'error') reject(new ChatGPTError(message.message, tabId, message.debug));
      if (message.type !== 'progress') port.disconnect();
    });
    port.onDisconnect.addListener(() =>
      reject(new ChatGPTError('The ChatGPT tab was closed or reloaded before it finished. Try again.', tabId))
    );
    port.postMessage({ type: 'ask', prompt });
  });
}

/**
 * @param temporary use a temporary chat, so it doesn't land in ChatGPT history
 * @param onTab(tabId) called once the ChatGPT tab exists
 * @param onText(markdown) the reply so far, while it streams
 */
export async function askChatGPT(prompt, { temporary = true, onTab, onText } = {}) {
  if (!(await chrome.permissions.contains(CHATGPT_PERMISSION))) {
    throw new ChatGPTError('Access to chatgpt.com was removed. Disconnect in Settings and choose ChatGPT again.');
  }
  await registerHook();
  const url = `${CHATGPT_URL}${temporary ? '?temporary-chat=true' : ''}${TAB_MARK}`;
  const tab = await chrome.tabs.create({ url, active: false });
  onTab?.(tab.id);
  try {
    await waitForTabLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['chatgpt.js'] });
    const text = await relay(tab.id, prompt, onText);
    // Leave the tab open if the user switched to it to watch.
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current && !current.active) await chrome.tabs.remove(tab.id).catch(() => {});
    return text;
  } catch (error) {
    throw error instanceof ChatGPTError ? error : new ChatGPTError(error.message || String(error), tab.id);
  }
}
