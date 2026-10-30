// Runs on youtube.com. Answers requests from the side panel:
//   yts:getTranscript -> transcript + metadata for a video
//   yts:seek          -> jump the player to a timestamp
// May be injected more than once (manifest + scripting.executeScript), so guard.
(() => {
  if (globalThis.__ytSummarizer) return;

  const NO_TRANSCRIPT =
    "This video doesn't have captions or a transcript, so it can't be summarized.";

  // YouTube's web client needs a proof-of-origin token to download captions;
  // the Android clients don't, so the transcript is fetched through them.
  const INNERTUBE_CLIENTS = [
    { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
    { clientName: 'ANDROID_VR', clientVersion: '1.62.27', androidSdkVersion: 32 },
  ];

  // Matches both the classic and the newer ("modern_transcript_view") panels.
  const TRANSCRIPT_PANELS = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
  const CLOCK = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;

  function getVideoId(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  // ---- Timed text parsing -------------------------------------------------

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(text) {
    return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      const code =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    });
  }

  const cleanText = (text) => text.replace(/\s+/g, ' ').trim();

  // Accepts json3, srv3 (<p t d>) and srv1 (<text start dur>) caption formats.
  function parseTimedText(body) {
    const segments = [];
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      for (const event of JSON.parse(trimmed).events || []) {
        if (!event.segs) continue;
        const text = cleanText(event.segs.map((s) => s.utf8 || '').join(''));
        if (text) {
          segments.push({ start: (event.tStartMs || 0) / 1000, dur: (event.dDurationMs || 0) / 1000, text });
        }
      }
      return segments;
    }
    const srv3 = /<p\b[^>]*?\bt="(\d+)"(?:[^>]*?\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
    const srv1 = /<text\b[^>]*?\bstart="([\d.]+)"(?:[^>]*?\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
    const isSrv3 = /<timedtext[^>]*format="3"/.test(trimmed);
    for (const m of trimmed.matchAll(isSrv3 ? srv3 : srv1)) {
      // srv1 text is entity-encoded twice (e.g. "&amp;#39;").
      const text = cleanText(decodeEntities(decodeEntities(m[3].replace(/<[^>]+>/g, ''))));
      if (!text) continue;
      const scale = isSrv3 ? 1000 : 1;
      segments.push({ start: Number(m[1]) / scale, dur: Number(m[2] || 0) / scale, text });
    }
    return segments;
  }

  // ---- Transcript via InnerTube player API -------------------------------

  const trackName = (track) =>
    track.name?.simpleText || track.name?.runs?.map((r) => r.text).join('') || track.languageCode;

  const baseLanguage = (code) => code?.split('-')[0].toLowerCase();

  // The language the video was recorded in. Auto-dubbed videos carry an
  // auto-generated track for every dub language (listed alphabetically, so
  // Arabic first), so with several of those, trust the original audio track
  // ("en-US.4") or the track YouTube translates from instead. The audio
  // tracks' "default" flags follow the viewer's UI language, so not those.
  function spokenLanguage(tracks, renderer) {
    const asr = tracks.filter((t) => t.kind === 'asr');
    const originalAudio = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex]?.audioTrackId;
    const source = tracks[renderer?.defaultTranslationSourceTrackIndices?.[0]];
    return (
      originalAudio?.split('.')[0] ||
      (asr.length === 1 ? asr[0].languageCode : null) ||
      source?.languageCode ||
      asr[0]?.languageCode
    );
  }

  // Prefer human-made captions in the spoken language, then auto-generated
  // ones, then whatever YouTube would show by default.
  function pickTrack(tracks, renderer) {
    const spoken = baseLanguage(spokenLanguage(tracks, renderer));
    const inSpoken = (t) => spoken && baseLanguage(t.languageCode) === spoken;
    const defaultIndex = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex;
    return (
      tracks.find((t) => t.kind !== 'asr' && inSpoken(t)) ||
      tracks.find((t) => t.kind === 'asr' && inSpoken(t)) ||
      tracks[renderer?.defaultTranslationSourceTrackIndices?.[0]] ||
      tracks[defaultIndex] ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0]
    );
  }

  async function fetchPlayer(videoId, client) {
    const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { ...client, hl: document.documentElement.lang || 'en' } },
        videoId,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`YouTube player request failed (${res.status}).`);
    return res.json();
  }

  async function transcriptFromApi(videoId) {
    let lastError = new Error(NO_TRANSCRIPT);
    for (const client of INNERTUBE_CLIENTS) {
      try {
        const player = await fetchPlayer(videoId, client);
        const renderer = player.captions?.playerCaptionsTracklistRenderer;
        const tracks = renderer?.captionTracks || [];
        if (!tracks.length) {
          const status = player.playabilityStatus;
          lastError = new Error(
            !status || status.status === 'OK'
              ? NO_TRANSCRIPT
              : `YouTube didn't provide the transcript (${status.reason || status.status}). Try again in a moment.`
          );
          continue;
        }
        const track = pickTrack(tracks, renderer);
        const url = new URL(track.baseUrl, location.origin);
        url.searchParams.set('fmt', 'json3');
        const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
        const segments = res.ok ? parseTimedText(await res.text()) : [];
        if (!segments.length) {
          lastError = new Error('YouTube returned an empty transcript.');
          continue;
        }
        const details = player.videoDetails || {};
        return {
          videoId,
          title: details.title || '',
          author: details.author || '',
          lengthSeconds: Number(details.lengthSeconds) || 0,
          description: details.shortDescription || '',
          language: track.languageCode,
          languageName: trackName(track),
          autoGenerated: track.kind === 'asr',
          segments,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // ---- Fallback: read YouTube's own "Show transcript" panel ---------------

  const parseClock = (text) => text.split(':').reduce((total, n) => total * 60 + Number(n), 0);

  const openTranscriptPanel = () =>
    [...document.querySelectorAll(TRANSCRIPT_PANELS)].find(
      (panel) => panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
    );

  // Uses the classic segment elements when present; otherwise reads the
  // panel's visible text, which is "timestamp" / "caption" line pairs.
  function readPanelSegments(panel) {
    const segments = [];
    const nodes = panel.querySelectorAll('ytd-transcript-segment-renderer');
    if (nodes.length) {
      for (const node of nodes) {
        const clock = cleanText(node.querySelector('.segment-timestamp')?.textContent || '');
        const text = cleanText(node.querySelector('.segment-text')?.textContent || '');
        if (CLOCK.test(clock) && text) segments.push({ start: parseClock(clock), dur: 0, text });
      }
      return segments;
    }
    let current = null;
    for (const line of panel.innerText.split('\n').map(cleanText).filter(Boolean)) {
      if (CLOCK.test(line)) segments.push((current = { start: parseClock(line), dur: 0, text: '' }));
      else if (current) current.text = current.text ? `${current.text} ${line}` : line;
    }
    return segments.filter((segment) => segment.text);
  }

  async function transcriptFromPanel(videoId) {
    if (getVideoId(location.href) !== videoId) throw new Error(NO_TRANSCRIPT);
    const wasOpen = Boolean(openTranscriptPanel());
    if (!wasOpen) {
      const button = document.querySelector('ytd-video-description-transcript-section-renderer button');
      if (!button) throw new Error(NO_TRANSCRIPT);
      button.click();
    }

    const segments = await waitFor(() => {
      const panel = openTranscriptPanel();
      const found = panel ? readPanelSegments(panel) : [];
      return found.length ? found : null;
    }, 10000);

    const panel = openTranscriptPanel();
    if (!wasOpen && panel) {
      (panel.querySelector('#visibility-button button') || panel.querySelector('#visibility-button'))?.click();
    }
    if (!segments) throw new Error('Timed out waiting for the YouTube transcript panel.');

    const video = document.querySelector('#movie_player video, video');
    return {
      videoId,
      title: cleanText(document.querySelector('ytd-watch-metadata h1')?.textContent || ''),
      author: cleanText(document.querySelector('ytd-watch-metadata #channel-name a')?.textContent || ''),
      lengthSeconds: Math.round(video?.duration || 0),
      description: '',
      language: '',
      languageName: '',
      autoGenerated: false,
      segments,
    };
  }

  async function getTranscript(videoId) {
    try {
      return await transcriptFromApi(videoId);
    } catch (apiError) {
      console.warn('[YT Summarizer] Transcript API failed, trying the transcript panel:', apiError);
      try {
        return await transcriptFromPanel(videoId);
      } catch (panelError) {
        console.warn('[YT Summarizer] Transcript panel failed:', panelError);
        throw apiError;
      }
    }
  }

  function seek(videoId, seconds) {
    if (getVideoId(location.href) !== videoId) {
      location.href = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;
      return;
    }
    const video = document.querySelector('#movie_player video, video.html5-main-video, video');
    if (!video) return;
    video.currentTime = seconds;
    video.play?.().catch(() => {});
    // Bring the player back into view if the page is scrolled to the comments.
    const player = document.querySelector('#movie_player') || video;
    const { top, bottom } = player.getBoundingClientRect();
    if (bottom < 80 || top > innerHeight - 80) player.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  globalThis.__ytSummarizer = { getVideoId, parseTimedText, pickTrack, getTranscript };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'yts:getTranscript':
        getTranscript(message.videoId).then(
          (data) => sendResponse({ ok: true, data }),
          (error) => sendResponse({ ok: false, error: error.message || String(error) })
        );
        return true;
      case 'yts:seek':
        seek(message.videoId, message.seconds);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
