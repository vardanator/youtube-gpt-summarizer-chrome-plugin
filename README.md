# YouTube Summarizer for ChatGPT

A Chrome extension that summarizes the YouTube video in your current tab. It reads the video's transcript, sends it to a ChatGPT model, and shows a short **summary** and timestamped **key highlights** in Chrome's side panel. Click a highlight to jump the video to that moment.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder.
3. Pin the extension and click its icon. The side panel opens on the right.

Requires Chrome 116 or later.

## Connect

The side panel offers two ways to reach ChatGPT.

### Use my ChatGPT login (no API credits)

Click **Use ChatGPT** and allow access to chatgpt.com. Be logged in to chatgpt.com in Chrome.

For each summary the extension opens chatgpt.com in a background tab, types the prompt into the message box, sends it, and streams the reply into the side panel. The reply is read from ChatGPT's network response as it arrives, which works while the tab stays in the background; the rendered page is the fallback. The tab closes when the reply is complete. If something needs your attention (logged out, a "verify you are human" check, a usage limit), the tab stays open and **Show ChatGPT tab** takes you to it.

- Chats are **temporary chats** by default, so they don't appear in your ChatGPT history. Turn on *Save summary chats in my ChatGPT history* in Settings to keep them.
- ChatGPT's web app accepts shorter messages than the API, so videos longer than roughly 40 minutes are sent in parts. Each part is a separate chat, followed by one chat for the final summary.
- This drives ChatGPT's web page the way you would by hand. OpenAI's Terms of Use don't allow extracting output from ChatGPT programmatically, so use this mode at your own discretion.
- It depends on ChatGPT's page layout. If it stops working after a ChatGPT redesign, update the selectors at the top of `chatgpt.js`. When a ChatGPT summary fails, **Copy details** in the error box copies a description of the ChatGPT page's layout and network activity (no chat text) to work from.

### Use an OpenAI API key

1. Sign in at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) with your ChatGPT login.
2. Create a secret key and paste it into the side panel (under *Use an OpenAI API key instead*).

API usage is billed separately from a ChatGPT Plus/Pro subscription, so the account needs API credit. With a "mini" model a typical video costs about a cent or less.

The key is stored in `chrome.storage.local` on this device and is sent only to `api.openai.com`. Requests are made with `store: false`.

## Use

Open a YouTube video, open the side panel, and click **Summarize video**. You get a 2–3 sentence summary and up to 8 key highlights. Click a highlight, or its timestamp, to jump the video there. Summaries are cached per video (last 50), so switching back to a video shows its summary instantly. Use **Regenerate** to create a new one.

In **Settings** (gear icon) you can:

- choose the summary language (default: same as the video);
- with an API key, pick the model (the list comes from your account; the default is the newest `gpt-*-mini`);
- with your ChatGPT login, choose whether summary chats are saved in your ChatGPT history;
- disconnect, to switch between the two connection methods.

## How it works

```
manifest.json          MV3 manifest
background.js          opens the side panel when the toolbar icon is clicked
content.js             runs on youtube.com: fetches the transcript, seeks the player
chatgpt.js             injected into a chatgpt.com tab: types the prompt, reads the reply
chatgpt-hook.js        runs in that tab's page: reads the reply from ChatGPT's network stream
sidepanel/
  index.html, panel.*  side panel UI: connect, settings, video card, results
  summarize.js         transcript formatting and prompts; long transcripts are condensed in parts first
  chatgpt-web.js       opens the background ChatGPT tab and relays the streamed reply
  openai.js            OpenAI Responses API client (streaming), model listing
  markdown.js          small, escaping Markdown renderer that turns [m:ss] into seek buttons
icons/
```

**Transcript.** The content script asks YouTube's InnerTube `player` endpoint for the video's caption tracks, using the Android client because web caption URLs now require a proof-of-origin token. It prefers human-made captions in the spoken language, then auto-generated ones, and downloads them as `json3`. If that fails, it opens YouTube's own **Show transcript** panel and reads the segments from the page.

**Summary.** The transcript is merged into ~20-second `[m:ss]` lines and sent with instructions for a short Summary section and at most 8 timestamped Key Highlights. With an API key, the reply streams from the Responses API; transcripts over ~60k tokens are first summarized into notes in parallel parts. With your ChatGPT login, the reply is read from the chat as it renders; over ~12k tokens, the parts are sent one after another.

## Limitations

- Videos without captions or a transcript can't be summarized.
- The transcript comes from undocumented YouTube endpoints. YouTube changes these from time to time, which can break fetching until the extension is updated.
- Live streams in progress usually have no transcript yet.
