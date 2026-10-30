// Injected into a chatgpt.com tab that the side panel opened. Types the prompt
// into the composer, sends it, and streams the reply back over a port named
// "yts-chatgpt" as { type: 'progress' | 'done' | 'error' } messages.
//
// The reply is taken from chatgpt-hook.js, which reads ChatGPT's network
// stream, or else from the page.
(() => {
  if (globalThis.__ytsChatGPT) return;
  globalThis.__ytsChatGPT = true;

  // ChatGPT's markup changes often, so each element has several candidates,
  // tried in order. Update these first if the integration stops working.
  const SELECTORS = {
    composer: [
      '#prompt-textarea',
      'textarea[name="prompt"]',
      '[contenteditable="true"][role="textbox"]',
      'form textarea',
      'form [contenteditable="true"]',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'form button[type="submit"]',
    ],
    stopButton: ['button[data-testid="stop-button"]', 'button[aria-label^="Stop"]'],
    userMessage: ['[data-message-author-role="user"]', '[data-turn="user"]'],
    assistantMessage: ['[data-message-author-role="assistant"]', '[data-turn="assistant"]'],
    loginButton: ['[data-testid="login-button"]'],
  };

  const REPLY_TIMEOUT_MS = 5 * 60_000;
  // Thinking models can take a while before the first word.
  const NO_REPLY_TIMEOUT_MS = 150_000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (el) => el.getClientRects().length > 0;
  const clean = (text) => text.replace(/\s+/g, ' ').trim();
  const textLength = (text) => text.replace(/\s/g, '').length;

  function find(key) {
    for (const selector of SELECTORS[key]) {
      for (const el of document.querySelectorAll(selector)) if (isVisible(el)) return el;
    }
    return null;
  }

  async function waitFor(fn, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  function isLoggedOut() {
    if (find('loginButton')) return true;
    return [...document.querySelectorAll('button, a')].some(
      (el) => /^log ?in$/i.test(el.textContent.trim()) && isVisible(el)
    );
  }

  // ---- Reply from the network (chatgpt-hook.js) -----------------------------

  let hook = null; // the hook's latest { reply: { text, done, ended, error }, stats }
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'yts-hook') hook = event.data;
  });
  // Asks the hook for a report, so we know it is there.
  window.postMessage({ source: 'yts-content' }, location.origin);

  // ---- Typing and sending -------------------------------------------------

  const composerText = (composer) => composer.value ?? composer.innerText;

  function typeIntoComposer(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      composer.select();
      document.execCommand('insertText', false, text);
      if (composer.value !== text) {
        // React-controlled textarea: set through the native setter so React sees the change.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, text);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return composer.value === text;
    }
    document.getSelection().selectAllChildren(composer);
    document.execCommand('insertText', false, text);
    if (textLength(composer.innerText) < textLength(text) * 0.9) {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
    return textLength(composer.innerText) >= textLength(text) * 0.9;
  }

  async function submit(composer) {
    const button = await waitFor(() => {
      const el = find('sendButton');
      return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' ? el : null;
    }, 10_000);
    if (button) {
      button.click();
    } else {
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
  }

  // ---- Our prompt on the page ---------------------------------------------

  const EDITABLE = 'textarea, [contenteditable="true"]';

  // ChatGPT may show the sent prompt formatted as Markdown, or shortened, so
  // text is compared without whitespace and anything that could be a Markdown
  // marker (list numbers included), on both sides alike.
  const squash = (text) => text.replace(/\d+[.)]|[\s*_`#>+•-]+/g, '');

  function describePrompt(text) {
    return { length: textLength(text), first: text.split('\n')[0].trim().slice(0, 60), squashed: squash(text) };
  }

  const isPromptPart = (el, prompt) => prompt.squashed.includes(squash(el.textContent).slice(0, 50));

  // Deepest element whose text contains `needle`, ignoring the composer.
  function deepestContaining(needle) {
    let node = document.body;
    if (!needle || !node.textContent.includes(needle)) return null;
    descend: while (true) {
      for (const child of node.children) {
        if (child.matches(`${EDITABLE}, script, style, template`)) continue;
        if (child.textContent.includes(needle)) {
          node = child;
          continue descend;
        }
      }
      // Found only in the composer: not sent yet.
      return node.querySelector(EDITABLE) ? null : node;
    }
  }

  // ChatGPT accepted the prompt: it shows a message, starts answering, or
  // emptied the composer we typed into.
  function wasSent(prompt) {
    if (hook?.stats.requests || document.querySelector(SELECTORS.userMessage.join(','))) return true;
    if (find('stopButton') || deepestContaining(prompt.first)) return true;
    const composer = find('composer');
    return Boolean(composer) && textLength(composerText(composer)) < prompt.length * 0.1;
  }

  // ---- Reading the reply from the page --------------------------------------

  const hasContent = (el) => /^(P|LI|H[1-6]|PRE)$/.test(el.tagName) || el.querySelector('p, li, h1, h2, h3, h4, pre');

  // ChatGPT marks messages with their author. The chat is new, so the last
  // assistant message is the reply.
  function markedReply() {
    return [...document.querySelectorAll(SELECTORS.assistantMessage.join(','))].filter(hasContent).at(-1) || null;
  }

  // Without author marks: climbs from the start of our prompt to the level
  // where the following elements aren't part of the prompt, i.e. the reply.
  function replyAfterPrompt(prompt) {
    const composer = find('composer');
    for (let node = deepestContaining(prompt.first); node?.parentElement && node.parentElement !== document.body; node = node.parentElement) {
      if (composer && node.parentElement.contains(composer)) break;
      const after = [];
      for (let el = node.nextElementSibling; el; el = el.nextElementSibling) {
        if (!isPromptPart(el, prompt)) after.push(el);
      }
      if (after.some(hasContent)) return after;
    }
    return [];
  }

  function inlineMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || /^(UL|OL|BUTTON|SVG|STYLE|SCRIPT)$/i.test(node.tagName)) return '';
    const inner = [...node.childNodes].map(inlineMarkdown).join('');
    switch (node.tagName) {
      case 'STRONG':
      case 'B':
        return inner.trim() ? `**${inner.trim()}**` : inner;
      case 'EM':
      case 'I':
        return inner.trim() ? `*${inner.trim()}*` : inner;
      case 'CODE':
        return `\`${inner}\``;
      case 'BR':
        return '\n';
      case 'P':
      case 'DIV':
        return `${inner} `;
      default:
        return inner;
    }
  }

  function listMarkdown(list, out) {
    let n = 0;
    for (const item of list.children) {
      if (item.tagName !== 'LI') continue;
      const text = clean(inlineMarkdown(item));
      if (text) out.push(`${list.tagName === 'OL' ? `${++n}.` : '-'} ${text}`);
      for (const nested of item.querySelectorAll(':scope > ul, :scope > ol')) listMarkdown(nested, out);
    }
  }

  // Converts rendered Markdown back to Markdown. Only block elements count, so
  // stray UI text (buttons, "Thinking" labels) is ignored.
  function toMarkdown(elements, blocks = []) {
    for (const el of elements) {
      const tag = el.tagName;
      // Skip collapsed content such as hidden reasoning.
      if (/^(H[1-6]|P|UL|OL|PRE)$/.test(tag) && !isVisible(el)) continue;
      if (/^H[1-6]$/.test(tag)) {
        // Skip screen-reader-only labels such as "ChatGPT said:".
        if (el.offsetWidth > 1 || el.offsetHeight > 1) blocks.push(`${'#'.repeat(Number(tag[1]))} ${clean(inlineMarkdown(el))}`);
      } else if (tag === 'P') {
        const text = clean(inlineMarkdown(el));
        if (text) blocks.push(text);
      } else if (tag === 'UL' || tag === 'OL') {
        const items = [];
        listMarkdown(el, items);
        if (items.length) blocks.push(items.join('\n'));
      } else if (tag === 'PRE') {
        blocks.push(`\`\`\`\n${el.textContent.trimEnd()}\n\`\`\``);
      } else if (!/^(BUTTON|TEXTAREA|FORM|SVG)$/i.test(tag)) {
        toMarkdown(el.children, blocks);
      }
    }
    return blocks;
  }

  function readPage(prompt) {
    const marked = markedReply();
    const text = toMarkdown(marked ? [marked] : replyAfterPrompt(prompt)).join('\n\n').trim();
    // Never hand back our own prompt as the answer.
    return { text: text.includes(prompt.first) ? '' : text, marked: Boolean(marked) };
  }

  // ---- Waiting for the reply ------------------------------------------------

  async function waitForReply(prompt, onProgress) {
    const start = Date.now();
    let last = '';
    let lastChange = start;
    let sawStop = false;
    let errorSince = 0;
    while (Date.now() - start < REPLY_TIMEOUT_MS) {
      const network = hook?.reply;
      const stopShown = Boolean(find('stopButton'));
      sawStop ||= stopShown;
      const generating = stopShown || Boolean(network && !network.ended);
      const page = readPage(prompt);
      // The network copy is exact Markdown and arrives even while the tab is in
      // the background. Prefer it, unless the page's reply is clearly longer,
      // which would mean the stream wasn't fully understood.
      const useNetwork = Boolean(network?.text) && !(page.marked && textLength(network.text) < textLength(page.text) * 0.8);
      const text = useNetwork ? network.text.trim() : page.text;
      if (text !== last) {
        last = text;
        lastChange = Date.now();
        if (text) onProgress(text);
      }
      if (useNetwork && network.done) return text;
      // If the stop button was never recognized (e.g. a translated UI), fall
      // back to waiting until the text stops changing.
      const quietMs = Date.now() - lastChange;
      if (text && !generating && quietMs > (sawStop || network?.ended ? 1000 : 5000)) return text;
      if (!text && network?.error) {
        errorSince ||= Date.now();
        if (Date.now() - errorSince > 10_000) throw new Error(`ChatGPT couldn't answer: ${network.error}`);
      }
      if (!text && !generating && Date.now() - start > NO_REPLY_TIMEOUT_MS) break;
      await sleep(500);
    }
    if (last) return last;
    throw new Error("ChatGPT didn't answer. Open the ChatGPT tab to see what happened.");
  }

  async function ask(text, onProgress) {
    const prompt = describePrompt(text);
    const composer = await waitFor(() => find('composer'), 30_000);
    if (isLoggedOut()) throw new Error("You're not logged in to ChatGPT. Log in in the ChatGPT tab, then try again.");
    if (!composer) {
      throw new Error(
        "Couldn't find ChatGPT's message box. If ChatGPT shows a check or popup, finish it in the ChatGPT tab and try again."
      );
    }
    if (!typeIntoComposer(composer, text)) throw new Error("Couldn't type into ChatGPT's message box.");
    await submit(composer);

    if (!(await waitFor(() => wasSent(prompt), 15_000))) {
      throw new Error("ChatGPT didn't accept the message. Open the ChatGPT tab to see why.");
    }
    return waitForReply(prompt, onProgress);
  }

  // ---- Troubleshooting ------------------------------------------------------

  // The page's structure, without any conversation text: tags, ids, data-*
  // attributes, and text lengths. Shared by the user to fix the selectors.
  function describePage() {
    const reply = hook?.reply;
    const lines = [
      `page: ${location.pathname}${location.search} (${document.visibilityState})`,
      `network: ${hook ? JSON.stringify({ ...hook.stats, textLength: reply?.text.length, done: reply?.done, ended: reply?.ended, error: reply?.error }) : 'no reports'}`,
      ...Object.entries(SELECTORS).map(
        ([key, list]) => `${key}: ${list.map((selector) => `${selector} ×${document.querySelectorAll(selector).length}`).join(', ')}`
      ),
      '',
    ];
    const describe = (el) => {
      const classes = [...el.classList].slice(0, 3).map((name) => `.${name.slice(0, 30)}`).join('');
      const attrs = [...el.attributes]
        .filter(({ name }) => /^(id|role|data-[\w-]+|aria-label|contenteditable|hidden)$/.test(name))
        .map(({ name, value }) => ` ${name}="${value.slice(0, 40)}"`)
        .join('');
      return `${el.tagName.toLowerCase()}${classes}${attrs}`;
    };
    const walk = (el, depth) => {
      const children = [...el.children].filter((child) => !/^(SCRIPT|STYLE|TEMPLATE|SVG|NOSCRIPT)$/i.test(child.tagName));
      for (let i = 0; i < children.length && lines.length < 300; i++) {
        const signature = describe(children[i]);
        let run = 1;
        while (i + run < children.length && describe(children[i + run]) === signature) run++;
        const child = children[i];
        const size = `[${textLength(child.textContent)}${isVisible(child) ? '' : ', hidden'}]`;
        lines.push(`${'  '.repeat(depth)}${signature} ${size}${run > 1 ? ` ×${run}` : ''}`);
        if (!/^(P|LI|H[1-6]|PRE|BUTTON|A|TEXTAREA)$/.test(child.tagName)) walk(child, depth + 1);
        i += run - 1;
      }
    };
    walk(document.querySelector('main') || document.body, 0);
    return lines.join('\n');
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'yts-chatgpt') return;
    const post = (message) => {
      try {
        port.postMessage(message);
      } catch {} // The side panel went away.
    };
    port.onMessage.addListener((message) => {
      if (message?.type !== 'ask') return;
      ask(message.prompt, (text) => post({ type: 'progress', text })).then(
        (text) => post({ type: 'done', text }),
        (error) => post({ type: 'error', message: error.message || String(error), debug: describePage() })
      );
    });
  });
})();
