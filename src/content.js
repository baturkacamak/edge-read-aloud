/**
 * Sesli Oku — content script.
 *
 * Extracts readable blocks, turns them into paragraph-sized chunks, asks the
 * service worker for audio, and plays it with a fixed shadow-DOM toolbar.
 */

(() => {
  if (window.__sesliOkuLoaded) return;
  window.__sesliOkuLoaded = true;

  // After an extension reload the old content script is invalidated, but its
  // player/spotlight nodes stay in the page until the tab is refreshed. Remove
  // them so a newly injected instance cannot create a second fixed highlight.
  for (const node of document.querySelectorAll("#sesli-oku-host")) node.remove();
  for (const node of document.querySelectorAll("#sesli-oku-spotlight")) node.remove();
  for (const node of document.querySelectorAll("#sesli-oku-spacer, #sesli-oku-layout, #sesli-oku-theme-highlight")) node.remove();
  for (const element of document.querySelectorAll("[data-sesli-oku-header]")) {
    try {
      const original = JSON.parse(element.getAttribute("data-sesli-oku-header"));
      if (original.value) element.style.setProperty("top", original.value, original.priority);
      else element.style.removeProperty("top");
    } catch {}
    element.removeAttribute("data-sesli-oku-header");
  }
  for (const node of document.querySelectorAll(".edge-ra-current")) {
    node.classList.remove("edge-ra-current");
  }
  try {
    CSS.highlights?.delete("edge-ra-word");
  } catch {
    // The Highlight API may be unavailable on very old browsers.
  }

  const themes = globalThis.SesliOkuThemes;
  const preferences = globalThis.SesliOkuSettings;
  const library = globalThis.SesliOkuLibrary;
  const themeHighlightStyle = document.createElement("style");
  themeHighlightStyle.id = "sesli-oku-theme-highlight";

  function applyTheme(theme) {
    const wrap = state.host?.shadowRoot?.querySelector(".wrap");
    if (wrap) themes.apply(wrap, theme, state.host);
    if (state.ui?.theme) state.ui.theme.value = theme;
    renderHighlightStyle();
    if (state.host?.isConnected) schedulePageLayout();
  }

  const TEST_MODE = new URLSearchParams(location.search).has("sesliOkuTest");
  const MAX_CHUNK_CHARS = 900;
  const CANDIDATE_SELECTOR =
    "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, figcaption, div, section";
  const SKIP_SELECTOR =
    "nav, aside, footer, form, button, select, textarea, script, style, noscript, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], [role='button'], " +
    "[role='menu'], [role='dialog'], [role='complementary'], [aria-hidden='true'], " +
    "[contenteditable='true'], .sidebar, .widget-area, " +
    "[class~='sidebar'], [id~='sidebar'], [data-sesli-oku-excluded]";

  const DEFAULT_SETTINGS = preferences.defaults;

  const state = {
    chunks: [],
    index: 0,
    session: 0,
    playing: false,
    paused: false,
    settings: { ...DEFAULT_SETTINGS },
    audio: null,
    audios: new Set(),
    blockedResult: null,
    blockedIndex: -1,
    cache: new Map(),
    replayCache: new Map(), replayChunks: null,
    highlighted: null,
    host: null,
    ui: null,
    voicesLoaded: false,
    voicesLoading: false,
    spotlight: null,
    spotlightRange: null,
    spotlightRect: null,
    spotlightScrollRange: null,
    spotlightThemeElement: null,
    spotlightDark: false,
    spotlightTimer: null,
    spotlightDocTop: null,
    spotlightDocLeft: null,
    followReading: true,
    autoScrollUntil: 0,
    lastManualScrollAt: 0,
    hideTimer: null,
    sleepTimer: null,
    sleepTimeout: null,
    timerOwner: crypto.randomUUID(),
    testAudioMs: 0,
    testAudio: null,
    testRequestDelay: 0,
    testRequests: [],
    testPlayed: [],
    gapWaiting: false,
    queueItemId: null,
    voiceCatalog: null,
  };

  const experience = globalThis.SesliOkuExperience.create({ state,
    prepareChunks: () => buildChunks(collectBlocks()), startSession, showUi, updateUi, setStatus, toggleSettings, renderHighlightStyle, sendToBackground, stop, togglePlayback, skip, previewWord });

  themes.subscribe(applyTheme);

  let lastPoint = null;
  let lastCaretRange = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  const normalizeSettings = preferences.normalize;

  function renderHighlightStyle() {
    const setting = state.settings;
    const theme = themes.current();
    const hex = preferences.highlightColorFor(setting, theme);
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const color = rgb.join(", ");
    const alpha = setting.highlightOpacity / 100;
    const glow = setting.glowIntensity / 100;
    const word = ["both", "word"].includes(setting.highlightMode);
    const paragraph = ["both", "paragraph"].includes(setting.highlightMode);
    const contrast = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150 ? "#111" : "#fff";
    themeHighlightStyle.textContent = `
      .edge-ra-current { background-color: ${paragraph ? `rgba(${color}, ${alpha})` : "transparent"} !important;
        box-shadow: ${paragraph ? `0 0 0 2px rgba(${color}, ${alpha * .8})` : "none"} !important; }
      ::highlight(edge-ra-word) { background-color: ${word ? `rgba(${color}, ${Math.min(1, alpha * 2)})` : "transparent"}; color: ${word && alpha >= .35 ? contrast : "inherit"}; text-shadow: none; }
      #sesli-oku-spotlight, #sesli-oku-spotlight[data-theme="dark"] {
        border-color: rgba(${color}, ${glow * .7}); background: rgba(${color}, ${glow * .08});
        border-radius: ${theme === "win95" || theme === "win98" ? "0" : "7px"};
        box-shadow: ${glow ? `0 0 ${12 + glow * 20}px ${glow * 7}px rgba(${color}, ${glow * .35})` : "none"};
        ${!word || !glow || experience.focusOpen() ? "opacity: 0 !important;" : ""}
      }`;
    if (!themeHighlightStyle.isConnected) document.documentElement.appendChild(themeHighlightStyle);
  }

  function cleanText(value) {
    return (value || "")
      .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitText(text, maxChars = MAX_CHUNK_CHARS) {
    // Split after sentence punctuation only when whitespace follows, so
    // decimals like "3.5" and abbreviations inside a token stay intact.
    const sentences = text.split(/(?<=[.!?…])\s+/u);
    const parts = [];
    let current = "";

    const push = (piece) => {
      if (!piece) return;
      if (!current) {
        current = piece;
      } else if (current.length + 1 + piece.length <= maxChars) {
        current += ` ${piece}`;
      } else {
        parts.push(current);
        current = piece;
      }
    };

    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length <= maxChars) {
        push(sentence);
        continue;
      }
      for (const word of sentence.split(/\s+/)) {
        if (word.length > maxChars) {
          for (let i = 0; i < word.length; i += maxChars) {
            push(word.slice(i, i + maxChars));
          }
        } else {
          push(word);
        }
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  function collectBlocks() {
    if(globalThis.SesliOkuDocument?.book?.kind==='audio')return [...document.querySelectorAll('[data-book-part]')].map(el=>({el,map:buildTextMap(el),text:cleanText(el.textContent)}));
    const preferred = document.querySelector("article, main, [role='main']");
    const scope = preferred && cleanText(preferred.innerText).length > 400
      ? preferred
      : document.body;
    if (!scope) return [];

    const blocks = [];
    for (const el of scope.querySelectorAll(CANDIDATE_SELECTOR)) {
      if (el.closest(SKIP_SELECTOR)) continue;
      if (!el.getClientRects().length) continue;

      const innerText = cleanText(el.innerText || el.textContent);
      if (innerText.length < 25) continue;
      if (!/[\p{L}\p{N}]/u.test(innerText)) continue;

      // Navigation lists and topic indexes are mostly links. Reading them as
      // article text is noisy, so skip blocks whose text is mostly link text.
      const linkLength = Array.from(el.querySelectorAll("a")).reduce(
        (sum, link) => sum + cleanText(link.innerText).length,
        0
      );
      if (linkLength > innerText.length * 0.6) continue;

      // Prefer the deepest readable blocks. If child blocks cover most of the
      // wrapper's text, keep the children so each paragraph gets its own
      // highlight and scroll target. Direct text outside the children is
      // preserved by keeping the wrapper.
      let childTextLength = 0;
      for (const child of el.children) {
        if (!child.matches(CANDIDATE_SELECTOR)) continue;
        const childText = cleanText(child.innerText).length;
        if (childText >= 25) childTextLength += childText;
      }
      let directTextLength = 0;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          directTextLength += cleanText(node.nodeValue).length;
        }
      }
      if (
        directTextLength < 50 &&
        childTextLength >= innerText.length * 0.8
      ) {
        continue;
      }

      // The range mapper and the text sent to TTS must use the same source,
      // otherwise a single soft hyphen or hidden node makes word highlighting
      // silently fail. Prefer the TreeWalker map and fall back to innerText.
      const map = buildTextMap(el);
      const text = map ? map.text : innerText;
      if (text.length < 25) continue;

      blocks.push({ el, text, map });
    }

    // A kept wrapper already contains its children's text. Drop descendants so
    // the same paragraph is not read twice.
    const byElement = new Map(blocks.map((block) => [block.el, block]));
    for (const block of blocks) {
      let parent = block.el.parentElement;
      while (parent && parent !== scope) {
        if (byElement.has(parent)) {
          block.drop = true;
          break;
        }
        parent = parent.parentElement;
      }
    }
    return blocks.filter((block) => !block.drop);
  }

  function buildChunks(blocks) {
    const chunks = [];
    for (const block of blocks) {
      const map = block.map || buildTextMap(block.el);
      let cursor = 0;
      for (const part of globalThis.SesliOkuDocument?.book?.kind==='audio' ? [block.text] : splitText(block.text)) {
        if (part.length < 2) continue;
        let offset = block.text.indexOf(part, cursor);
        if (offset < 0) offset = cursor;
        chunks.push({ text: part, el: block.el, map, offset });
        cursor = offset + part.length;
      }
    }
    return chunks;
  }

  async function sendToBackground(message) {
    let request;
    try {
      request = chrome.runtime.sendMessage({
        target: "background",
        ...message,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const response = await request;
    if (!response?.ok) {
      throw new Error(response?.error || "Arka plan servisi yanıt vermedi.");
    }
    return response;
  }

  // An extension update/reload leaves already-injected content scripts alive
  // but disconnected from the extension. Such an orphan can no longer stop
  // audio or talk to the player, so its highlight would otherwise stay on the
  // page forever.
  function extensionContextValid() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  async function speechSettings(text, chunk, settings) {
    if (!settings.autoVoice) return settings;
    const languageNode = chunk?.el?.closest("[lang]");
    const explicit = languageNode && languageNode !== document.documentElement ? languageNode.lang : "";
    const language = library.detectLanguage(text, explicit, document.documentElement.lang || settings.voice);
    const preferred = language === "tr" ? settings.turkishVoice : language === "en" ? settings.englishVoice : "";
    if (preferred) return { ...settings, voice: preferred };
    if (!state.voiceCatalog) {
      try { state.voiceCatalog = (await sendToBackground({ type: "GET_VOICES" })).voices || []; } catch { state.voiceCatalog = []; }
    }
    const voice = state.voiceCatalog.find(item => item.Locale?.toLowerCase().startsWith(language + "-"));
    return { ...settings, voice: voice?.ShortName || settings.voice };
  }

  async function requestAudio(text, chunk = null, override = state.settings) {
    if(globalThis.SesliOkuDocument?.book?.kind==='audio')return globalThis.SesliOkuDocument.audioFor(text,chunk);
    const settings = await speechSettings(text, chunk, override);
    const spoken = library.pronounce(text, settings.pronunciationRules);
    if (TEST_MODE && state.testAudio) {
      if (state.testRequestDelay) await sleep(state.testRequestDelay);
      state.testRequests.push({ text: spoken.text, source: text, settings: { ...settings } });
      const words = [...spoken.text.matchAll(/\S+/gu)];
      const boundaries = words.map((word, index) => ({ offset: Math.round(index / words.length * state.testAudioMs * 10000), duration: Math.round(state.testAudioMs * 10000 / words.length), text: word[0] }));
      return { audio: state.testAudio, boundaries, spoken, sourceOffsets: library.mapBoundaries(spoken, boundaries), voice: settings.voice };
    }
    const response = await sendToBackground({ type: "SPEAK", text: spoken.text, settings });
    const boundaries = response.boundaries || [];
    return { audio: fromBase64(response.audio), boundaries, spoken, sourceOffsets: library.mapBoundaries(spoken, boundaries), voice: settings.voice };
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function audioFor(index) {
    if (state.cache.has(index)) return state.cache.get(index);
    if(state.replayChunks!==state.chunks){state.replayCache.clear();state.replayChunks=state.chunks;}
    if(state.replayCache.has(index))return state.replayCache.get(index);
    const promise = requestAudio(state.chunks[index].text, state.chunks[index]);
    state.cache.set(index, promise);state.replayCache.set(index,promise);
    if(state.replayCache.size>4)state.replayCache.delete(state.replayCache.keys().next().value);
    promise.catch(()=>{if(state.replayCache.get(index)===promise)state.replayCache.delete(index);});
    return promise;
  }

  function prefetch(index) {
    if (index >= state.chunks.length || state.cache.has(index)) return;
    const promise = audioFor(index);
    state.cache.set(index, promise);
    promise.catch(() => { if (state.cache.get(index) === promise) state.cache.delete(index); });
  }

  // ---------------------------------------------------------------- player UI

  const languageNames = (() => {
    try {
      return new Intl.DisplayNames(["tr"], { type: "language" });
    } catch {
      return null;
    }
  })();

  function localeLabel(locale) {
    const [language, region] = (locale || "").split("-");
    let name = language || locale;
    try {
      name = languageNames?.of(language) || name;
    } catch {}
    name = name.charAt(0).toUpperCase() + name.slice(1);
    return region ? `${name} (${region})` : name;
  }

  function voiceLabel(voice) {
    const short = voice.ShortName || "";
    const pieces = short.split("-");
    let name = pieces.slice(2).join("-") || short;
    name = name.replace(/MultilingualNeural$|Neural$/, "");
    const gender =
      voice.Gender === "Female"
        ? "Kadın"
        : voice.Gender === "Male"
          ? "Erkek"
          : "";
    return gender ? `${name} · ${gender}` : name;
  }

  function formatPercent(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? "+" : ""}${number}%`;
  }

  function renderVoices(voices) {
    if (!state.ui) return;
    const select = state.ui.voice;
    const groups = new Map();
    for (const voice of voices) {
      const locale = voice.Locale || "other";
      if (!groups.has(locale)) groups.set(locale, []);
      groups.get(locale).push(voice);
    }

    const sorted = [...groups.keys()].sort((a, b) => {
      if (a.startsWith("tr")) return -1;
      if (b.startsWith("tr")) return 1;
      return localeLabel(a).localeCompare(localeLabel(b), "tr");
    });

    select.innerHTML = "";
    for (const locale of sorted) {
      const group = document.createElement("optgroup");
      group.label = localeLabel(locale);
      const voicesInGroup = groups
        .get(locale)
        .sort((a, b) => voiceLabel(a).localeCompare(voiceLabel(b), "tr"));
      for (const voice of voicesInGroup) {
        const option = document.createElement("option");
        option.value = voice.ShortName;
        option.textContent = voiceLabel(voice);
        group.appendChild(option);
      }
      select.appendChild(group);
    }

    if (!voices.some((voice) => voice.ShortName === state.settings.voice)) {
      const option = document.createElement("option");
      option.value = state.settings.voice;
      option.textContent = state.settings.voice;
      select.appendChild(option);
    }
    select.value = state.settings.voice;
    state.ui.preferences.renderVoiceChoices(voices);
    state.voiceCatalog = voices;
    state.voicesLoaded = true;
  }

  async function loadVoices() {
    if (state.voicesLoaded || state.voicesLoading || !state.ui) return;
    state.voicesLoading = true;
    state.ui.voice.disabled = true;
    try {
      const response = await sendToBackground({ type: "GET_VOICES" });
      renderVoices(response.voices || []);
    } catch {
      renderVoices([]);
    } finally {
      state.voicesLoading = false;
      if (state.ui) { state.ui.voice.disabled = globalThis.SesliOkuDocument?.book?.kind==='audio';state.ui.preferences.sync(state.settings); }
    }
  }

  function syncSettingsInputs() {
    if(!state.ui)return;
    state.ui.preferences.sync(state.settings);
  }

  function applyReadingSettings(patch) {
    return preferences.update(patch).catch(error => setStatus(error.message, true));
  }

  function applyAudioPlaybackRate(audio = state.audio) {
    if (!audio) return;
    const rate = state.settings.playbackRate;
    // Loading a resource resets playbackRate to defaultPlaybackRate. Keep both
    // in sync so a new chunk cannot silently return to 1x after src is set.
    if (audio.defaultPlaybackRate !== rate) audio.defaultPlaybackRate = rate;
    if (audio.playbackRate !== rate) audio.playbackRate = rate;
  }

  function receiveSettings(next) {
    const previous = state.settings;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    state.settings = next;
    syncSettingsInputs();
    renderHighlightStyle();
    if (previous.autoFollow !== next.autoFollow) {
      state.followReading = next.autoFollow;
      state.lastManualScrollAt = next.autoFollow ? 0 : performance.now();
    }
    applyAudioPlaybackRate();
    experience.invalidate();
    const speechChanged = ["voice", "rate", "pitch", "volume", "autoVoice", "turkishVoice", "englishVoice", "pronunciationRules"].some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
    if (speechChanged) {
      state.cache.clear();state.replayCache.clear();
      if (state.playing) {
        const wasPaused = state.paused;
        const follow = state.followReading;
        const lastScroll = state.lastManualScrollAt;
        startSession(state.index);
        state.followReading = follow;
        state.lastManualScrollAt = lastScroll;
        if (wasPaused) { state.paused = true; state.audio?.pause(); }
      }
    }
    updateUi();
  }

  function publishSleepTimer() {
    const value = state.sleepTimer ? { mode: state.sleepTimer.mode, deadline: state.sleepTimer.deadline || null, owner: state.timerOwner } : null;
    chrome.storage.local.get("readingTimer").then(stored => {
      if (value || stored.readingTimer?.owner === state.timerOwner) return chrome.storage.local.set({ readingTimer: value });
    }).catch(() => {});
    state.ui?.preferences.syncTimer(value);
    updateSleepStatus();
  }

  function configureSleepTimer(timer) {
    if (!state.playing && timer.mode !== "off") throw new Error("Önce okumayı başlatın.");
    if (!["off", "paragraph"].includes(timer.mode)) {
      const minutes = timer.mode === "custom" ? Number(timer.minutes) : Number(timer.mode);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new Error("Süre 1–180 dakika olmalıdır.");
    }
    clearTimeout(state.sleepTimeout);
    state.sleepTimeout = null;
    if (timer.mode === "off") state.sleepTimer = null;
    else if (timer.mode === "paragraph") state.sleepTimer = { mode: "paragraph", endElement: state.chunks[state.index]?.el };
    else {
      const minutes = timer.mode === "custom" ? Number(timer.minutes) : Number(timer.mode);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new Error("Süre 1–180 dakika olmalıdır.");
      state.sleepTimer = { mode: "time", deadline: Date.now() + minutes * 60000 };
      armSleepTimeout();
    }
    publishSleepTimer();
  }

  function armSleepTimeout() {
    if (!state.sleepTimer?.deadline) return;
    state.sleepTimeout = setTimeout(() => { if (!checkSleepDeadline()) armSleepTimeout(); }, Math.max(0, state.sleepTimer.deadline - Date.now()));
  }

  function checkSleepDeadline() {
    if (!state.sleepTimer?.deadline || Date.now() < state.sleepTimer.deadline) return false;
    stop();
    setStatus("Zamanlayıcı: okuma durduruldu");
    return true;
  }

  function updateSleepStatus() {
    if (!state.ui?.sleepStatus) return;
    const timer = state.sleepTimer;
    state.ui.sleepStatus.hidden = !timer;
    if (!timer) return;
    if (timer.mode === "paragraph") state.ui.sleepStatus.textContent = "⏱ Paragraf sonu";
    else {
      const seconds = Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000));
      state.ui.sleepStatus.textContent = `⏱ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
  }

  function atParagraphEnd(index) {
    const current = state.chunks[index];
    const next = state.chunks[index + 1];
    return !next || !current?.el || current.el !== next.el;
  }

  async function waitParagraphGap(session) {
    let elapsed = 0;
    state.gapWaiting = true;
    try {
      while (elapsed < state.settings.paragraphDelay && session === state.session && state.playing) {
        if (checkSleepDeadline()) return;
        await waitWhilePaused(session);
        const started = performance.now();
        await sleep(Math.min(50, state.settings.paragraphDelay - elapsed));
        if (!state.paused) elapsed += performance.now() - started;
      }
    } finally { state.gapWaiting = false; }
  }

  let layoutFrame = null;
  let savedOverflowAnchor = null;

  function changePlayerLayout(change) {
    const root = document.documentElement;
    if (layoutFrame === null) {
      savedOverflowAnchor = {
        value: root.style.getPropertyValue("overflow-anchor"),
        priority: root.style.getPropertyPriority("overflow-anchor"),
      };
    } else {
      cancelAnimationFrame(layoutFrame);
    }
    root.style.setProperty("overflow-anchor", "none", "important");
    change();
    // Commit the new geometry while anchoring is disabled. Otherwise opening
    // the settings can be cancelled visually by an automatic scroll jump.
    root.getBoundingClientRect();
    layoutFrame = requestAnimationFrame(() => {
      if (savedOverflowAnchor.value) {
        root.style.setProperty("overflow-anchor", savedOverflowAnchor.value, savedOverflowAnchor.priority);
      } else {
        root.style.removeProperty("overflow-anchor");
      }
      layoutFrame = null;
      repositionSpotlight();
    });
  }

  let pageLayoutStyle = null;
  let layoutObserver = null;
  let pageObserver = null;
  let pageLayoutFrame = null;
  let pageBasePadding = "0px";
  const shiftedHeaders = new Map();

  function restoreShiftedHeaders() {
    for (const [element, original] of shiftedHeaders) {
      if (original.value) element.style.setProperty("top", original.value, original.priority);
      else element.style.removeProperty("top");
      element.removeAttribute("data-sesli-oku-header");
    }
    shiftedHeaders.clear();
  }

  function syncPageLayout() {
    if (!state.host || state.host.style.display === "none") return;
    changePlayerLayout(() => {
      // Measure the site's own layout before applying our offset, so repeated
      // resizes never accumulate padding or header offsets.
      pageLayoutStyle?.remove();
      restoreShiftedHeaders();
      const padding = getComputedStyle(document.documentElement).paddingTop;
      pageBasePadding = padding;
      const height = state.host.getBoundingClientRect().height;
      const rules = [`html:root { padding-top: calc(${padding} + ${height}px) !important; }`];
      for (const element of document.body?.querySelectorAll("*") || []) {
        if (element === state.host || element.id.startsWith("sesli-oku-")) continue;
        const style = getComputedStyle(element);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        const top = parseFloat(style.top);
        if (!Number.isFinite(top) || top < 0 || top > 160) continue;
        if (element.getBoundingClientRect().width < window.innerWidth * .3) continue;
        // A nested header is positioned within its parent's layout already.
        let nested = false;
        for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
          const parentStyle = getComputedStyle(parent);
          if (shiftedHeaders.has(parent) ||
              (style.position === "sticky" && /(auto|scroll|hidden)/.test(parentStyle.overflowY))) {
            nested = true;
            break;
          }
        }
        if (nested) continue;
        const original = {
          value: element.style.getPropertyValue("top"),
          priority: element.style.getPropertyPriority("top"),
          baseTop: top,
        };
        element.setAttribute("data-sesli-oku-header", JSON.stringify(original));
        shiftedHeaders.set(element, original);
        element.style.setProperty("top", `${top + height}px`, "important");
      }
      pageLayoutStyle ||= document.createElement("style");
      pageLayoutStyle.id = "sesli-oku-layout";
      pageLayoutStyle.textContent = rules.join("\n");
      document.documentElement.appendChild(pageLayoutStyle);
    });
  }

  function syncToolbarHeight() {
    if (!pageLayoutStyle?.isConnected || state.host?.style.display === "none") return;
    const height = state.host.getBoundingClientRect().height;
    changePlayerLayout(() => {
      // Height may change every animation frame. Reuse measured page styles
      // instead of rescanning the entire document throughout a theme fade.
      pageLayoutStyle.sheet?.cssRules[0]?.style.setProperty(
        "padding-top", `calc(${pageBasePadding} + ${height}px)`, "important"
      );
      for (const [element, original] of shiftedHeaders) {
        element.style.setProperty("top", `${original.baseTop + height}px`, "important");
      }
    });
  }

  function schedulePageLayout() {
    if (pageLayoutFrame !== null) return;
    pageLayoutFrame = requestAnimationFrame(() => {
      pageLayoutFrame = null;
      syncPageLayout();
    });
  }

  function releasePageLayout() {
    layoutObserver?.disconnect();
    pageObserver?.disconnect();
    if (pageLayoutFrame !== null) cancelAnimationFrame(pageLayoutFrame);
    pageLayoutFrame = null;
    pageLayoutStyle?.remove();
    restoreShiftedHeaders();
  }

  function observePageLayout() {
    layoutObserver ||= new ResizeObserver(syncToolbarHeight);
    layoutObserver.observe(state.host);
    pageObserver ||= new MutationObserver((records) => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(
        node => node.nodeType === Node.ELEMENT_NODE && !node.id?.startsWith("sesli-oku-")
      ))) schedulePageLayout();
    });
    if (document.body) pageObserver.observe(document.body, { childList: true, subtree: true });
    syncPageLayout();
  }

  function toggleSettings(force) {
    if (!state.ui) return;
    themes.finishTransition(state.host.shadowRoot.querySelector(".wrap"));
    const open =
      typeof force === "boolean"
        ? force
        : !state.ui.settings.classList.contains("open");
    changePlayerLayout(() => {
      if (!open) state.ui.preferences.closeDropdowns();
      state.ui.settings.classList.toggle("open", open);
    });
    syncPageLayout();
    state.ui.settingsButton.setAttribute("aria-expanded", String(open));
    if (open) {
      syncSettingsInputs();
      loadVoices();
    }
  }

  function removeLegacySpacers() {
    for (const spacer of document.querySelectorAll("#sesli-oku-spacer")) {
      spacer.remove();
    }
  }

  function buildUi() {
    if (state.host?.isConnected) {
      for (const host of document.querySelectorAll("#sesli-oku-host")) {
        if (host !== state.host) host.remove();
      }
      return state.ui;
    }
    for (const host of document.querySelectorAll("#sesli-oku-host")) host.remove();
    removeLegacySpacers();

    const host = document.createElement("div");
    host.id = "sesli-oku-host";
    host.style.cssText =
      "all: initial; position: fixed; inset: 0 0 auto; z-index: 2147483647; " +
      "display: block; width: 100%; box-sizing: border-box; margin: 0; " +
      "padding: 0; border: 0; max-width: none; max-height: 100dvh; overflow: auto; " +
      "overflow-anchor: none;";
    // The top layer paints above the root's margins, transforms, and site UI.
    // Manual popovers stay open when users interact with the page.
    host.setAttribute("popover", "manual");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        @layer base, themes;
        @layer base {
        :host { all: initial; }
        .wrap {
          font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #f7f7f5;
          pointer-events: auto;
          display: flex;
          flex-direction: column;
          width: 100%;
          box-sizing: border-box;
          background: #171b18;
          border-bottom: 1px solid #343c30;
          box-shadow: 0 2px 8px rgba(0,0,0,.12);
          color-scheme: dark;
          position: relative;
          animation: reveal 180ms ease-out;
        }
        @keyframes reveal {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .bar {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 64px;
          width: 100%;
          max-width: 1120px;
          margin: 0 auto;
          padding: 10px 24px;
          box-sizing: border-box;
          flex-wrap: wrap;
        }
        .brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
        .brand svg { width: 22px; height: 22px; color: #d9f27a; }
        .brand strong { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
        .brand small { display: block; color: #9ca793; font-size: 10px; }
        .transport, .actions { display: flex; align-items: center; gap: 4px; }
        .actions { margin-left: auto; }
        .player-tools { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
        button {
          all: unset;
          box-sizing: border-box;
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 8px;
          cursor: pointer;
          color: #f7f7f5;
          font-size: 15px;
          transition: background .15s ease, color .15s ease;
        }
        button:hover { background: rgba(255,255,255,.12); }
        button:focus-visible, select:focus-visible, input:focus-visible {
          outline: 2px solid #d9f27a;
          outline-offset: 3px;
        }
        button:active { transform: scale(.96); }
        button.primary {
          background: #d9f27a;
          color: #12160f;
          width: 38px;
          height: 38px;
        }
        button.primary:hover { background: #e6fb96; }
        button.speed {
          width: auto;
          padding: 0 9px;
          border-radius: 999px;
          font-variant-numeric: tabular-nums;
          font-size: 12px;
        }
        button.icon { font-size: 17px; }
        button.close { font-size: 16px; color: #b9bdb6; }
        button.follow {
          display: none;
          width: auto;
          height: 26px;
          padding: 0 10px;
          border-radius: 999px;
          border: 1px solid rgba(217,242,122,.35);
          background: rgba(217,242,122,.10);
          color: #d9f27a;
          font-size: 11px;
          white-space: nowrap;
        }
        button.follow.visible { display: grid; }
        button.follow:hover { background: rgba(217,242,122,.18); }
        .divider {
          width: 1px;
          height: 20px;
          background: rgba(255,255,255,.14);
          margin: 0 2px;
        }
        .status {
          min-width: 64px;
          padding: 0 4px;
          text-align: center;
          font-variant-numeric: tabular-nums;
          color: #d7d9d3;
          font-size: 12px;
        }
        .error { color: #ffb4a8; }
        .settings {
          display: none;
          box-sizing: border-box;
          width: 100%;
          max-width: 1120px;
          margin: 0 auto;
          padding: 16px 24px 20px;
          border-top: 1px solid rgba(255,255,255,.10);
          grid-template-columns: 1fr 1.5fr 1fr 1fr;
          gap: 24px;
        }
        .settings.open { display: grid; }
        .field { min-width: 0; }
        .field label {
          display: block;
          margin-bottom: 6px;
          font-size: 11px;
          letter-spacing: .02em;
          color: #b9bdb6;
        }
        .label-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .label-row label { margin-bottom: 6px; }
        .label-row output {
          margin-bottom: 6px;
          color: #d9f27a;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        select {
          box-sizing: border-box;
          width: 100%;
          padding: 8px 10px;
          border-radius: 9px;
          border: 1px solid rgba(255,255,255,.16);
          background: rgba(255,255,255,.06);
          color: #f7f7f5;
          font: inherit;
          font-size: 12px;
        }
        select option, select optgroup { background: #171b18; color: #f7f7f5; }
        input[type="range"] {
          box-sizing: border-box;
          width: 100%;
          margin: 0;
          accent-color: #d9f27a;
        }
        @media (max-width: 640px) {
          .bar { gap: 6px; padding: 8px 12px; }
          .brand small { display: none; }
          .brand { gap: 6px; }
          .settings { padding: 14px 12px; gap: 16px; grid-template-columns: 1fr; }
          .status { min-width: 48px; font-size: 11px; }
          button.follow { padding: 0 7px; }
        }
        @media (max-width: 460px) {
          .brand { flex-basis: 100%; }
          button { width: 30px; height: 32px; }
          button.primary { width: 34px; height: 34px; }
          .bar { column-gap: 4px; }
          .actions { gap: 2px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wrap { animation: none; }
          button { transition: none; }
        }
        }
      </style>
      <div class="wrap">
        <div class="bar" role="toolbar" aria-label="Sesli okuma kontrolleri">
          <div class="brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/></svg>
            <div><strong>Sesli Oku</strong><small>Dinle, takip et.</small></div>
          </div>
          <div class="transport">
          <button data-act="prev" title="Önceki paragraf">⏮</button>
          <button data-act="toggle" class="primary" title="Oynat / duraklat">▶</button>
          <button data-act="next" title="Sonraki paragraf">⏭</button>
          </div>
          <span class="divider" aria-hidden="true"></span>
          <span class="status">Hazır</span>
          <div class="player-tools">
          <span class="sleep-status" hidden></span>
          <button data-act="follow" class="follow" title="Okumaya dön">Okumaya dön</button>
          <div class="actions">
          <button data-act="speed" class="speed" title="Oynatma hızı">1.0×</button>
          <button data-act="settings" class="icon" title="Okuma ayarları" aria-label="Okuma ayarları" aria-expanded="false" aria-controls="sesli-oku-settings">⚙</button>
          <button data-act="close" class="close" title="Durdur ve kapat">✕</button>
          </div>
          </div>
        </div>
        <div id="sesli-oku-settings" class="settings" role="region" aria-label="Okuma ayarları"></div>
      </div>`;

    const themeStyle = document.createElement("style");
    themeStyle.textContent = themes.css + preferences.css + library.css;
    shadow.appendChild(themeStyle);
    state.ui?.preferences?.dispose();
    const settingsUi = preferences.mount(shadow.querySelector(".settings"), {
      prefix: "sesli-oku-", onTimer: configureSleepTimer, onLayout: schedulePageLayout,
    });
    shadow.querySelector(".wrap").dataset.theme = themes.current();

    const ui = {
      status: shadow.querySelector(".status"),
      toggle: shadow.querySelector("[data-act='toggle']"),
      speed: shadow.querySelector("[data-act='speed']"),
      follow: shadow.querySelector("[data-act='follow']"),
      settingsButton: shadow.querySelector("[data-act='settings']"),
      settings: shadow.querySelector(".settings"),
      preferences: settingsUi,
      sleepStatus: shadow.querySelector(".sleep-status"),
      theme: settingsUi.theme,
      voice: shadow.querySelector("#sesli-oku-voice"),
      rate: shadow.querySelector("#sesli-oku-rate"),
      rateValue: shadow.querySelector("#sesli-oku-rate-value"),
      volume: shadow.querySelector("#sesli-oku-volume"),
      volumeValue: shadow.querySelector("#sesli-oku-volume-value"),
    };

    shadow.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.act;
      if (action === "toggle") togglePlayback();
      else if (action === "prev") skip(-1);
      else if (action === "next") skip(1);
      else if (action === "speed") cycleSpeed();
      else if (action === "follow") resumeFollow();
      else if (action === "settings") toggleSettings();
      else if (action === "close") stop();
    });

    document.documentElement.appendChild(host);
    state.host = host;
    state.ui = ui;
    experience.mount(shadow);
    host.showPopover();
    observePageLayout();
    syncSettingsInputs();
    return ui;
  }

  function showUi() {
    buildUi();
    clearTimeout(state.hideTimer);
    updateUi();
  }

  function hideUiSoon(delay = 1600) {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      if (!state.playing && state.host) {
        toggleSettings(false);
        changePlayerLayout(() => {
          themes.finishTransition(state.host.shadowRoot.querySelector(".wrap"));
          state.host.hidePopover();
          state.host.style.display = "none";
          releasePageLayout();
        });
        removeLegacySpacers();
      }
    }, delay);
  }

  function updateUi() {
    if (!state.ui) return;
    if (state.host?.style.display === "none") {
      changePlayerLayout(() => {
        state.host.style.display = "block";
        state.host.showPopover();
      });
      observePageLayout();
    }

    const ui = state.ui;
    updateSleepStatus();
    experience.updateProgress();
    ui.toggle.textContent = state.paused ? "▶" : state.playing ? "❚❚" : "▶";
    ui.speed.textContent = `${state.settings.playbackRate.toFixed(2).replace(/0$/, "")}×`;
    if (ui.follow) {
      ui.follow.classList.toggle(
        "visible",
        !state.followReading && state.playing
      );
    }

    if (!state.playing && state.chunks.length && state.index >= state.chunks.length) {
      ui.status.textContent = "Bitti";
      ui.status.classList.remove("error");
    } else if (state.paused) {
      ui.status.textContent = "Duraklatıldı";
      ui.status.classList.remove("error");
    } else if (state.playing) {
      ui.status.textContent = `${Math.min(state.index + 1, state.chunks.length)}/${state.chunks.length}`;
      ui.status.classList.remove("error");
    }
  }

  function setStatus(text, isError = false) {
    if (!state.ui) return;
    state.ui.status.textContent = text;
    state.ui.status.classList.toggle("error", isError);
  }


  // ----------------------------------------------------------- page highlight

  function clearHighlight() {
    clearWordHighlight();
    if (state.highlighted) {
      state.highlighted.classList.remove("edge-ra-current");
      state.highlighted = null;
    }
    document
      .querySelectorAll(".edge-ra-current")
      .forEach((el) => el.classList.remove("edge-ra-current"));
  }

  function highlight(el) {
    clearHighlight();
    if (!el || !el.isConnected) return;
    el.classList.add("edge-ra-current");
    state.highlighted = el;
  }

  // ------------------------------------------------------- word highlighting

  const WORD_HIGHLIGHT = "edge-ra-word";
  const TEXT_SKIP_SELECTOR =
    "script, style, noscript, template, [aria-hidden='true'], [data-sesli-oku-excluded]";

  function supportsWordHighlight() {
    return (
      typeof Highlight === "function" &&
      typeof CSS !== "undefined" &&
      !!CSS.highlights
    );
  }

  function parseColor(value) {
    const match = /^rgba?\(([^)]+)\)$/.exec(value || "");
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts[3] ?? 1,
    };
  }

  function isDarkBackground(element) {
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.5) {
        const luminance =
          (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        return luminance < 0.45;
      }
      node = node.parentElement;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  }

  function ensureSpotlight() {
    // Never adopt an element left by a previous/duplicate instance: it may
    // still carry inline geometry from an older layout. Keep only the element
    // this instance owns and create a clean one when necessary.
    const current = state.spotlight?.isConnected ? state.spotlight : null;
    for (const other of document.querySelectorAll("#sesli-oku-spotlight")) {
      if (other !== current) other.remove();
    }
    for (const host of document.querySelectorAll("#sesli-oku-host")) {
      if (host !== state.host) host.remove();
    }
    if (!current) {
      state.spotlight = document.createElement("div");
      state.spotlight.id = "sesli-oku-spotlight";
      document.documentElement.appendChild(state.spotlight);
    } else {
      state.spotlight = current;
    }
    return state.spotlight;
  }

  function setSpotlightGeometry(element, rect, padX, padY, offsetY, scale) {
    element.style.width = `${rect.width + padX * 2}px`;
    element.style.height = `${rect.height + padY * 2}px`;
    element.style.translate = `${rect.left - padX}px ${
      rect.top - padY + offsetY
    }px`;
    element.style.scale = String(scale);
  }

  function showSpotlight(range, snap = false, autoScroll = true) {
    if (!range) {
      hideSpotlight();
      return;
    }
    // The same word fires timeupdate several times; do not restart its
    // transition on every tick.
    if (!snap && range === state.spotlightRange && state.spotlightRect) {
      return;
    }

    let rect;
    try {
      rect = range.getBoundingClientRect();
    } catch {
      hideSpotlight();
      return;
    }
    if (!rect || rect.width < 1 || rect.height < 1) {
      hideSpotlight();
      return;
    }

    const element = ensureSpotlight();
    const padX = 7;
    const padY = 5;

    const wordElement = range.startContainer.parentElement;
    const view = getReadingViewport(wordElement);
    if (wordElement && wordElement !== state.spotlightThemeElement) {
      state.spotlightThemeElement = wordElement;
      state.spotlightDark = isDarkBackground(wordElement);
      element.dataset.theme = state.spotlightDark ? "dark" : "light";
    }

    const docTop = rect.top + view.offsetTop;
    const docLeft = rect.left + view.offsetLeft;
    const previousDocTop = state.spotlightDocTop;
    const previousDocLeft = state.spotlightDocLeft;
    const wasHidden = element.style.opacity !== "1";
    const dx =
      previousDocTop != null && previousDocLeft != null
        ? docLeft - previousDocLeft
        : 0;
    const dy =
      previousDocTop != null ? docTop - previousDocTop : 0;
    const paragraphChange =
      previousDocTop == null || wasHidden || Math.abs(dx) > 240 || Math.abs(dy) > 80;
    const lineChange =
      !paragraphChange && previousDocTop != null && Math.abs(dy) > 6;

    // If the user scrolled back to the current word and paused interacting,
    // resume following automatically.
    if (
      !snap &&
      !state.followReading &&
      state.settings.autoFollow &&
      state.playing &&
      performance.now() - state.lastManualScrollAt > 900 &&
      rect.top >= view.top &&
      rect.bottom <= view.bottom
    ) {
      state.followReading = true;
      updateUi();
    }

    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // Scroll slightly ahead of the animation and place the box at the final
    // viewport position while the page glides there. This prevents the scroll
    // handler from interrupting the arrival animation.
    // Both edges are viewport coordinates. Do not subtract bottom from the
    // window height: a tall settings panel can then invert the reading area
    // and make successive words alternate between opposing scroll targets.
    const availableHeight = view.bottom - view.top;
    const margin = Math.min(12, Math.max(0, (availableHeight - rect.height) / 4));
    const topMargin = view.top + margin;
    const bottomMargin = view.bottom - margin;
    let target = rect;
    if (
      !snap &&
      autoScroll &&
      state.settings.autoFollow &&
      state.followReading &&
      !experience.focusOpen() &&
      availableHeight >= rect.height + 2 &&
      range !== state.spotlightScrollRange
    ) {
      state.spotlightScrollRange = range;
      let delta = 0;
      if (rect.top < topMargin - 2) {
        delta = rect.top - topMargin;
      } else if (rect.bottom > bottomMargin + 2) {
        delta = rect.bottom - bottomMargin;
      }
      if (delta) {
        state.autoScrollUntil = performance.now() + 2000;
        scrollReading(
          view.container,
          delta,
          reduceMotion ? "auto" : "smooth"
        );
        target = {
          left: rect.left,
          top: rect.top - delta,
          right: rect.right,
          bottom: rect.bottom - delta,
          width: rect.width,
          height: rect.height,
        };
      }
    }

    if (state.spotlightTimer) {
      clearTimeout(state.spotlightTimer);
      state.spotlightTimer = null;
    }

    if (reduceMotion || snap || !state.followReading) {
      // Manual scrolling pauses follow. While paused, the glow must stay
      // glued to the current word instead of animating from the previous one.
      // Keep transitions disabled until a word arrives while following again.
      element.style.transition = "none";
      setSpotlightGeometry(element, target, padX, padY, 0, 1);
      element.style.opacity = "1";
    } else if (paragraphChange || lineChange) {
      // New line/paragraph: do not glide diagonally backwards over the text.
      // Fade the box in at the new word with a tiny vertical settle and scale.
      const duration = paragraphChange ? 260 : 190;
      const offset = paragraphChange ? 9 : 4;
      const startScale = paragraphChange ? 0.96 : 0.985;
      const direction =
        previousDocTop != null && docTop < previousDocTop ? 1 : -1;

      element.style.transition = "none";
      setSpotlightGeometry(
        element,
        target,
        padX,
        padY,
        direction * offset,
        startScale
      );
      element.style.opacity = "0";
      void element.offsetWidth;

      element.style.transition =
        `translate ${duration}ms cubic-bezier(0.16, 1, 0.3, 1), ` +
        `scale ${duration}ms cubic-bezier(0.16, 1, 0.3, 1), ` +
        `opacity ${Math.max(140, duration - 40)}ms ease`;
      setSpotlightGeometry(element, target, padX, padY, 0, 1);
      element.style.opacity = "1";

      state.spotlightTimer = setTimeout(() => {
        state.spotlightTimer = null;
        if (state.spotlight === element) element.style.transition = "";
      }, duration + 40);
    } else {
      // Same line: glide horizontally and resize smoothly.
      element.style.transition = "";
      setSpotlightGeometry(element, target, padX, padY, 0, 1);
      element.style.opacity = "1";
    }

    state.spotlightRange = range;
    state.spotlightRect = target;
    state.spotlightDocTop = docTop;
    state.spotlightDocLeft = docLeft;
  }

  function hideSpotlight() {
    if (state.spotlightTimer) {
      clearTimeout(state.spotlightTimer);
      state.spotlightTimer = null;
    }
    state.spotlightRange = null;
    state.spotlightRect = null;
    state.spotlightScrollRange = null;
    state.spotlightDocTop = null;
    state.spotlightDocLeft = null;
    // Hide every overlay, not only the element this instance happens to own.
    // After an extension update an orphaned older content script can still
    // have created its own #sesli-oku-spotlight; hiding just our node would
    // leave that glow visible after reading stops.
    for (const element of document.querySelectorAll("#sesli-oku-spotlight")) {
      element.style.opacity = "0";
    }
    if (state.spotlight) state.spotlight.style.opacity = "0";
  }

  // Fixed/sticky panels at the bottom of the viewport (chat composers, cookie
  // bars, video controls) hide the page even though window.innerHeight still
  // reports them as visible. Detect their edge and keep the spoken word above
  // them, otherwise auto-follow believes the word is visible while it is
  // actually covered.
  let viewportInsets = { at: 0, top: 96, bottom: 120 };

  function fixedOverlayAt(x, y) {
    const stack = document.elementsFromPoint?.(x, y) || [];
    for (const element of stack) {
      if (!element || element === state.host) continue;
      if (element.id === "sesli-oku-spotlight") continue;
      if (state.host && element.getRootNode?.() === state.host.shadowRoot) {
        continue;
      }
      for (
        let node = element;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.3) continue;
        if (rect.height < 24 || rect.height > window.innerHeight * 0.62) {
          continue;
        }
        return rect;
      }
    }
    return null;
  }

  function getViewportInsets(force = false) {
    const now = performance.now();
    const toolbarBottom = state.host?.style.display !== "none"
      ? (state.host?.getBoundingClientRect().bottom || 0) : 0;
    if (!force && now - viewportInsets.at < 700 && viewportInsets.toolbarBottom === toolbarBottom) return viewportInsets;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = Math.max(96, toolbarBottom + 8);
    let bottom = 120;

    for (const x of [vw * 0.5, vw * 0.2, vw * 0.8]) {
      for (const y of [vh - 1, vh - 40, vh - 120]) {
        const rect = fixedOverlayAt(x, y);
        if (!rect) continue;
        if (rect.top > vh * 0.35 && rect.bottom > vh - 60) {
          bottom = Math.max(bottom, vh - rect.top + 8);
        }
      }
    }

    for (const x of [vw * 0.5, vw * 0.2, vw * 0.8]) {
      // Site headers (including WordPress' admin bar) start below our player,
      // so probing only the window's original top edge misses them entirely.
      for (const y of [toolbarBottom + 1, top + 1, top + 40]) {
        if (y >= vh) continue;
        const rect = fixedOverlayAt(x, y);
        if (!rect) continue;
        if (rect.top <= top + 8 && rect.bottom > top) {
          top = Math.max(top, rect.bottom + 8);
        }
      }
    }

    viewportInsets = {
      at: now,
      toolbarBottom,
      top: Math.min(top, vh - 32),
      bottom: Math.min(bottom, Math.round(vh * 0.55)),
    };
    return viewportInsets;
  }

  // Some apps (Gemini, ChatGPT, mail clients) never scroll the window: the
  // article lives inside an overflow container. Auto-follow must move that
  // container, otherwise window.scrollBy() is a no-op and the page appears
  // frozen while the spoken word disappears.
  function isScrollableBox(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (
      element === document.documentElement ||
      element === document.body ||
      element === state.host
    ) {
      return false;
    }
    if (element.scrollHeight <= element.clientHeight + 8) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return (
      overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay"
    );
  }

  function findScrollContainer(element) {
    let node = element;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollableBox(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Visible reading area for an element, in viewport coordinates. Accounts for
   * window insets (fixed/sticky panels) and for an inner scroll container that
   * may end above the window bottom.
   */
  function getReadingViewport(element) {
    const container = findScrollContainer(element);
    const insets = getViewportInsets();
    let top = 0;
    let bottom = window.innerHeight;
    let offsetTop = window.scrollY;
    let offsetLeft = window.scrollX;
    if (container) {
      const rect = container.getBoundingClientRect();
      top = Math.max(rect.top, 0);
      bottom = Math.min(rect.bottom, window.innerHeight);
      offsetTop = container.scrollTop - rect.top;
      offsetLeft = container.scrollLeft - rect.left;
    }
    const safeTop = Math.max(top, insets.top);
    const safeBottom = Math.min(bottom, window.innerHeight - insets.bottom);
    return {
      container,
      // Keep the real edges even when panels leave no room. Callers must
      // skip following instead of inventing a visible area behind the UI.
      top: safeTop,
      bottom: Math.max(safeTop, safeBottom),
      offsetTop,
      offsetLeft,
    };
  }

  function scrollReading(container, delta, behavior) {
    if (!delta) return;
    if (state.settings.scrollBehavior === "instant") behavior = "instant";
    if (container) {
      container.scrollBy({ top: delta, behavior });
    } else {
      window.scrollBy({ top: delta, behavior });
    }
  }

  let spotlightFrame = null;

  function repositionSpotlight() {
    if (!state.spotlightRange || spotlightFrame || state.spotlightTimer) return;
    spotlightFrame = requestAnimationFrame(() => {
      spotlightFrame = null;
      if (state.spotlightRange) showSpotlight(state.spotlightRange, true, false);
    });
  }

  function markManualScroll() {
    if (!state.playing) return;
    state.autoScrollUntil = 0;
    state.lastManualScrollAt = performance.now();
    if (state.followReading) {
      state.followReading = false;
      updateUi();
    }
  }

  let scrollSnapFrame = null;

  function onScroll(event) {
    if (event && isPlayerTarget(event.target)) return;
    viewportInsets.at = 0;
    if (!state.playing) return;
    if (performance.now() < state.autoScrollUntil) return;

    state.lastManualScrollAt = performance.now();
    if (state.followReading) {
      state.followReading = false;
      updateUi();
    }

    if (scrollSnapFrame) return;
    scrollSnapFrame = requestAnimationFrame(() => {
      scrollSnapFrame = null;
      if (state.spotlightRange) {
        showSpotlight(state.spotlightRange, true, false);
      }
    });
  }

  function resumeFollow() {
    if (experience.focusOpen()) { experience.resumeFocus(); return; }
    if (!state.settings.autoFollow) applyReadingSettings({ autoFollow: true });
    state.followReading = true;
    state.lastManualScrollAt = 0;
    state.autoScrollUntil = performance.now() + 2000;
    updateUi();

    const range = state.spotlightRange;
    const chunkElement = state.chunks[state.index]?.el;
    let rect = null;
    let anchorElement = null;
    if (range) {
      rect = range.getBoundingClientRect();
      anchorElement = range.startContainer.parentElement;
    } else if (chunkElement?.isConnected) {
      rect = chunkElement.getBoundingClientRect();
      anchorElement = chunkElement;
    }
    if (!rect) return;

    // Clicking "Okumaya dön" is an explicit request to return to the reading
    // position, so move the current word to a comfortable anchor even when it
    // is technically inside the viewport. This also lifts it above large
    // in-page panels at the bottom and out of inner scroll containers.
    const view = getReadingViewport(anchorElement);
    if (view.bottom - view.top < rect.height + 2) return;
    const anchorMin = view.top + 12;
    const anchorMax = Math.max(anchorMin, view.bottom - rect.height - 16);
    const preferred = Math.round(view.top + (view.bottom - view.top) * 0.32);
    const readingAnchor = Math.min(anchorMax, Math.max(anchorMin, preferred));
    const delta = rect.top - readingAnchor;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (Math.abs(delta) > 4) {
      scrollReading(
        view.container,
        delta,
        reduceMotion ? "auto" : "smooth"
      );
    }

    setTimeout(
      () => {
        if (state.spotlightRange) {
          // Use the current word: it may have advanced while the page scrolled.
          showSpotlight(state.spotlightRange, true, false);
        }
      },
      reduceMotion ? 0 : 450
    );
  }

  function clearWordHighlight() {
    try {
      CSS.highlights?.delete(WORD_HIGHLIGHT);
    } catch {
      // The registry can be gone after a document swap.
    }
    hideSpotlight();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Flatten the visible text of an element into a string plus a per-character
   * map back to text nodes. Used to turn word boundaries into DOM Ranges.
   */
  function buildTextMap(root) {
    if (!root || !root.isConnected) return null;

    const styleCache = new Map();
    const blockCache = new Map();

    const styleOf = (element) => {
      let style = styleCache.get(element);
      if (!style) {
        style = getComputedStyle(element);
        styleCache.set(element, style);
      }
      return style;
    };

    const isHidden = (element) =>
      !element ||
      !element.getClientRects().length ||
      styleOf(element).visibility === "hidden";

    const isBlock = (element) => {
      if (!element) return false;
      if (blockCache.has(element)) return blockCache.get(element);
      const style = styleOf(element);
      const result =
        !isHidden(element) &&
        style.display !== "inline" &&
        style.display !== "contents" &&
        style.display !== "none";
      blockCache.set(element, result);
      return result;
    };

    const nearestBlock = (element) => {
      let node = element;
      while (node && node !== root) {
        if (isBlock(node)) return node;
        node = node.parentElement;
      }
      return root;
    };

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
            if (node.closest(TEXT_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          const parent = node.parentElement;
          if (!parent || parent.closest(TEXT_SKIP_SELECTOR)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let text = "";
    const positions = [];
    let lastBlock = null;

    const pushSpace = () => {
      if (!text || text.endsWith(" ")) return;
      text += " ";
      positions.push(null);
    };

    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "BR") pushSpace();
        continue;
      }

      const parent = node.parentElement;
      const block = nearestBlock(parent);
      if (block !== lastBlock) {
        pushSpace();
        lastBlock = block;
      }

      const value = node.nodeValue || "";
      for (let index = 0; index < value.length; index++) {
        const char = value[index];
        // Keep the map identical to cleanText(): drop soft hyphens and
        // zero-width characters that innerText-based text never contains.
        if (/[\u00ad\u200b-\u200d\ufeff]/.test(char)) continue;
        if (/\s/.test(char)) {
          pushSpace();
        } else {
          text += char;
          positions.push({ node, offset: index });
        }
      }
    }

    let start = 0;
    let end = text.length;
    while (start < end && text[start] === " ") start++;
    while (end > start && text[end - 1] === " ") end--;

    return {
      text: text.slice(start, end),
      positions: positions.slice(start, end),
    };
  }

  function findWord(haystack, needle, from = 0) {
    if (!needle) return null;
    const direct = haystack.indexOf(needle, from);
    if (direct >= 0) return { index: direct, length: needle.length };
    try {
      const match = new RegExp(escapeRegExp(needle), "iu").exec(
        haystack.slice(from)
      );
      return match
        ? { index: from + match.index, length: match[0].length }
        : null;
    } catch {
      return null;
    }
  }

  function buildWordRanges(chunk, boundaries, sourceOffsets) {
    if (!supportsWordHighlight() || !chunk?.el || !boundaries?.length) return null;
    const map = chunk.map || buildTextMap(chunk.el); if (!map) return null;
    let base = typeof chunk.offset === "number" ? chunk.offset : -1;
    if (base < 0 || map.text.slice(base, base + chunk.text.length) !== chunk.text) base = map.text.indexOf(chunk.text);
    if (base < 0) return null;
    const offsets = sourceOffsets || library.mapBoundaries(library.pronounce(chunk.text), boundaries);
    return offsets.map(offset => {
      if (!offset) return null;
      const first = map.positions[base + offset.start]; const last = map.positions[base + offset.end - 1];
      if (!first || !last) return null;
      try { const range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1); return range; } catch { return null; }
    });
  }

  function previewWord(index, offsets) {
    const chunk=state.chunks[index];if(!chunk)return;
    const activeHighlight=CSS.highlights?.get(WORD_HIGHLIGHT);
    highlight(chunk.el);
    const range=buildWordRanges(chunk,[{text:chunk.text.slice(offsets.start,offsets.end)}],[offsets])?.[0];
    if(!range)return;
    const wordHighlight=activeHighlight||new Highlight();wordHighlight.clear();wordHighlight.add(range);CSS.highlights.set(WORD_HIGHLIGHT,wordHighlight);
    if(state.settings.autoFollow&&!experience.focusOpen()){
      const view=getReadingViewport(chunk.el);const rect=range.getBoundingClientRect();const room=view.bottom-view.top;
      if(room>=rect.height+4){
        const margin=Math.min(12,(room-rect.height)/4);let delta=0;
        if(rect.top<view.top+margin)delta=rect.top-view.top-margin;
        else if(rect.bottom>view.bottom-margin)delta=rect.bottom-view.bottom+margin;
        if(delta){state.autoScrollUntil=performance.now()+2000;scrollReading(view.container,delta,'instant');}
      }
    }
    showSpotlight(range,true,false);
  }

  // ---------------------------------------------------------------- playback

  function playResult(result, session, chunk) {
    return new Promise((resolve) => {
      if (session !== state.session) return resolve();
      if (TEST_MODE && state.testAudio) state.testPlayed.push({ id: chunk.el?.id, at: performance.now() });

      const blob = new Blob([result.audio], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      const boundaries = result.boundaries || [];
      const wordRanges = buildWordRanges(chunk, boundaries, result.sourceOffsets);
      let wordHighlight = null;

      if (wordRanges && supportsWordHighlight()) {
        try {
          wordHighlight = new Highlight();
          CSS.highlights.set(WORD_HIGHLIGHT, wordHighlight);
        } catch {
          wordHighlight = null;
        }
      }

      let boundaryIndex = 0;

      state.audio = audio;
      experience.audioStarted();
      state.audios.add(audio);

      const onTimeUpdate = () => {
        if (session !== state.session || !state.playing || checkSleepDeadline() || experience.scrubbing()) return;
        experience.updateProgress();
        experience.save();
        if (experience.loopTick(audio,result)) return;
        if (!boundaries.length) return;
        const ticks = audio.currentTime * 1e7;
        if (boundaries[boundaryIndex]?.offset > ticks) boundaryIndex = 0;
        while (
          boundaryIndex + 1 < boundaries.length &&
          boundaries[boundaryIndex + 1].offset <= ticks
        ) {
          boundaryIndex++;
        }

        experience.spokenWord(result, boundaryIndex);
        if (wordHighlight && wordRanges) {
          wordHighlight.clear();
          const range = wordRanges[boundaryIndex];
          if (range) {
            wordHighlight.add(range);
            showSpotlight(range);
          } else {
            hideSpotlight();
          }
        }
      };

      let settled = false;
      let guard = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (guard) clearInterval(guard);
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        audio.onloadedmetadata = null;
        URL.revokeObjectURL(url);
        state.audios.delete(audio);
        if (session === state.session) clearWordHighlight();
        resolve(value?.blocked ? { blocked: true } : {});
      };

      audio.onloadedmetadata = () => { if (session === state.session) { applyAudioPlaybackRate(audio); experience.metadata(audio, result); onTimeUpdate(); } };
      audio.onended = finish;
      audio.onerror = finish;
      audio.ontimeupdate = onTimeUpdate;
      applyAudioPlaybackRate(audio);

      audio.src = url;
      audio.play().catch((error) => {
        // Pausing while play() is still pending cancels that request, not the paragraph.
        if (error?.name === "AbortError" && state.paused && session === state.session) return;
        console.warn(
          "[Sesli Oku] audio.play() failed:",
          error?.name,
          error?.message
        );
        if (error?.name === "NotAllowedError") {
          setStatus("Oynatmak için ▶ düğmesine basın", true);
          finish({ blocked: true });
        } else {
          setStatus("Oynatma engellendi", true);
          finish();
        }
      });

      guard = setInterval(() => {
        if (checkSleepDeadline() || session !== state.session) {
          audio.pause();
          finish();
          return;
        }
        if (!extensionContextValid()) {
          audio.pause();
          finish();
          stop();
        }
      }, 400);
    });
  }

  async function waitWhilePaused(session) {
    while (state.paused && state.playing && session === state.session) {
      await sleep(100);
    }
  }

  async function run(session) {
    while (
      state.playing &&
      session === state.session &&
      state.index < state.chunks.length
    ) {
      if (checkSleepDeadline()) return;
      const index = state.index;
      const chunk = state.chunks[index];

      highlight(chunk.el);
      updateUi();
      setStatus(state.ui ? `${index + 1}/${state.chunks.length}` : "");

      let result;
      try {
        result = await audioFor(index);
      } catch (error) {
        if (session !== state.session) return;
        setStatus(error.message || "Ses üretilemedi", true);
        if (state.queueItemId) sendToBackground({ type: "READING_FAILED", queueItemId: state.queueItemId, error: error.message }).catch(() => {});
        state.playing = false;
        state.paused = false;
        clearTimeout(state.sleepTimeout);
        state.sleepTimer = null;
        publishSleepTimer();
        clearHighlight();
        updateUi();
        hideUiSoon(5000);
        return;
      }
      state.cache.delete(index);
      if (session !== state.session) return;

      prefetch(index + 1);
      await waitWhilePaused(session);
      if (session !== state.session) return;

      const outcome = await playResult(result, session, chunk);
      if (session !== state.session) return;
      if (outcome?.blocked) {
        state.blockedResult = result;
        state.blockedIndex = index;
        state.playing = false;
        state.paused = false;
        clearHighlight();
        updateUi();
        return;
      }
      const paragraphEnd = atParagraphEnd(index);
      if (paragraphEnd && state.sleepTimer?.mode === "paragraph" &&
          (!state.sleepTimer.endElement || state.sleepTimer.endElement === chunk.el)) {
        stop(); setStatus("Paragraf tamamlandı"); return;
      }
      const repeated=experience.nextRepeat(index);
      if(repeated){startSession(repeated.index,{anchor:repeated});return;}
      state.index++;
      if (paragraphEnd && state.index < state.chunks.length) await waitParagraphGap(session);
    }

    if (session === state.session) {
      state.playing = false;
      state.paused = false;
      clearHighlight();
      updateUi();
      clearTimeout(state.sleepTimeout);
      state.sleepTimer = null;
      publishSleepTimer();
      hideUiSoon(2200);
      experience.save(true, true);
      sendToBackground({ type: "READING_FINISHED", queueItemId: state.queueItemId }).catch(() => {});
    }
  }

  function startSession(index, options = {}) {
    state.session++;
    for (const audio of state.audios) audio.pause();
    if (state.audio) {
      state.audio.removeAttribute("src");
      state.audio.load();
    }
    const session = state.session;
    state.index = index;
    experience.beforeSession(index, options);
    if (state.sleepTimer?.mode === "paragraph") state.sleepTimer.endElement = state.chunks[index]?.el;
    state.playing = true;
    state.paused = !!options.paused;
    state.followReading = state.settings.autoFollow;
    state.autoScrollUntil = 0;
    state.lastManualScrollAt = 0;

    const blocked =
      state.blockedIndex === index && state.blockedResult
        ? state.blockedResult
        : null;
    state.cache.clear();
    if (blocked) state.cache.set(index, Promise.resolve(blocked));
    state.blockedResult = null;
    state.blockedIndex = -1;

    clearWordHighlight();
    showUi();
    syncSettingsInputs();
    updateUi();
    run(session).catch((error) => {
      console.warn("[Sesli Oku] playback loop failed:", error);
      if (session !== state.session) return;
      state.playing = false;
      state.paused = false;
      setStatus(error?.message || "Okuma hatası", true);
      updateUi();
      hideUiSoon(5000);
    });
  }

  function togglePlayback() {
    if (!state.chunks.length) return;

    if (!state.playing) {
      if (state.index >= state.chunks.length) state.index = 0;
      startSession(state.index);
      return;
    }

    state.paused = !state.paused;
    experience.save(true);
    if (state.audio) {
      if (state.paused) state.audio.pause();
      else state.audio.play().catch(() => {});
    }
    updateUi();
  }

  function skip(direction) {
    if (!state.chunks.length) return;
    experience.clearRepeat();
    const next = Math.min(
      state.chunks.length - 1,
      Math.max(0, state.index + direction)
    );
    startSession(next);
  }

  function cycleSpeed() {
    const rates = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const current = state.settings.playbackRate;
    const next = rates[(rates.indexOf(current) + 1) % rates.length] || 1;
    applyReadingSettings({ playbackRate: next });
  }

  function stop(keepQueue = false) {
    experience.stopped();
    clearTimeout(state.sleepTimeout);
    state.sleepTimeout = null;
    state.sleepTimer = null;
    publishSleepTimer();
    state.session++;
    state.playing = false;
    state.paused = false;
    state.followReading = true;
    state.lastManualScrollAt = 0;
    state.index = 0;
    state.chunks = [];
    state.cache.clear();state.replayCache.clear();
    state.blockedResult = null;
    state.blockedIndex = -1;
    clearHighlight();

    for (const audio of state.audios) audio.pause();
    if (state.audio) {
      state.audio.removeAttribute("src");
      state.audio.load();
    }

    setStatus("Durduruldu");
    updateUi();
    toggleSettings(false);
    hideUiSoon(600);
    sendToBackground({ type: "STOP", keepQueue }).catch(() => {});
  }

  // ---------------------------------------------------------- read from here

  function caretRangeFromPoint(x, y) {
    if (typeof document.caretRangeFromPoint === "function") {
      return document.caretRangeFromPoint(x, y);
    }
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function findReadableContainer(start) {
    if (!start) return null;
    const element =
      start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    if (!element) return null;

    const candidate = element.closest(CANDIDATE_SELECTOR);
    if (candidate && candidate.getClientRects().length) return candidate;

    let node = element;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE && node.getClientRects().length) {
        const display = getComputedStyle(node).display;
        if (display !== "none" && !display.startsWith("inline")) {
          const text = cleanText(node.innerText || node.textContent);
          if (text.length >= 25) return node;
        }
      }
      node = node.parentElement;
    }
    return element.closest("p, li, div, td, dd, section") || null;
  }

  function caretIndex(map, range) {
    if (!map || !range) return 0;
    const node = range.startContainer;
    const offset = range.startOffset;

    if (node.nodeType === Node.TEXT_NODE) {
      for (let index = 0; index < map.positions.length; index++) {
        const position = map.positions[index];
        if (position && position.node === node && position.offset >= offset) {
          return index;
        }
      }
      return map.text.length;
    }

    const child = node.childNodes[offset];
    if (child) {
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode();
      if (textNode) {
        for (let index = 0; index < map.positions.length; index++) {
          const position = map.positions[index];
          if (position && position.node === textNode) return index;
        }
      }
    }
    return 0;
  }

  function sentenceStart(text, index) {
    const before = text.slice(0, index);
    const regex = /[.!?…]["'”’)]*\s+/gu;
    let start = 0;
    let match;
    while ((match = regex.exec(before))) {
      start = match.index + match[0].length;
    }
    return start;
  }

  function caretTargetFromRange(range) {
    if (!range) return null;
    const node = range.startContainer;
    const element =
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const container = findReadableContainer(element);
    return container ? { container, range } : null;
  }

  function resolveCaretTarget(fromPoint) {
    if (fromPoint && lastPoint) {
      const range = caretRangeFromPoint(lastPoint.x, lastPoint.y);
      if (range) {
        const target = caretTargetFromRange(range);
        if (target) return target;
      }
      const element = document.elementFromPoint(lastPoint.x, lastPoint.y);
      const container = findReadableContainer(element);
      if (container) return { container, range: null };
    }

    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      const caret = range.collapsed ? range : range.cloneRange();
      if (!caret.collapsed) caret.collapse(true);
      const target = caretTargetFromRange(caret);
      if (target) return target;
    }

    if (lastCaretRange) {
      const target = caretTargetFromRange(lastCaretRange);
      if (target) return target;
    }

    if (lastPoint) {
      const range = caretRangeFromPoint(lastPoint.x, lastPoint.y);
      if (range) {
        const target = caretTargetFromRange(range);
        if (target) return target;
      }
      const element = document.elementFromPoint(lastPoint.x, lastPoint.y);
      const container = findReadableContainer(element);
      if (container) return { container, range: null };
    }
    return null;
  }

  function startFromCursor(settings, fromPoint = false) {
    state.settings = preferences.forPage({ ...preferences.current(), ...settings },location.href);
    const target = resolveCaretTarget(fromPoint);
    if (!target) {
      showUi();
      setStatus("İmleci bir metnin üzerine getirin", true);
      hideUiSoon(3500);
      return;
    }

    let container = target.container;
    let map = buildTextMap(container);
    let text = map?.text || cleanText(container.innerText);
    let startIndex = 0;

    const blocks = collectBlocks();

    // collectBlocks may merge several short paragraphs into one readable
    // ancestor. In that case the caret sits in a child element, but reading
    // must continue through the ancestor; otherwise it stops after the first
    // paragraph.
    const owner = blocks.find(
      (block) => block.el === container || block.el.contains(container)
    );
    if (owner && owner.el !== container) {
      container = owner.el;
      map = owner.map || buildTextMap(container);
      text = owner.text || map?.text || cleanText(container.innerText);
    }

    if (map && target.range) {
      const index = caretIndex(map, target.range);
      if (index > 0) startIndex = sentenceStart(map.text, index);
    }
    let remaining = text.slice(startIndex).trim();
    let remainingStart = text.indexOf(remaining, startIndex);
    if (remainingStart < 0) remainingStart = startIndex;

    let following = blocks.filter(
      (block) =>
        block.el !== container &&
        !container.contains(block.el) &&
        (container.compareDocumentPosition(block.el) &
          Node.DOCUMENT_POSITION_FOLLOWING)
    );

    if (!remaining && following.length) {
      container = following[0].el;
      map = following[0].map || buildTextMap(container);
      text = following[0].text;
      remaining = text;
      remainingStart = 0;
      following = following.slice(1);
    }

    if (!remaining) {
      showUi();
      setStatus("Buradan okunacak metin bulunamadı", true);
      hideUiSoon(3500);
      return;
    }

    const chunks = [];
    let localCursor = 0;
    for (const part of splitText(remaining)) {
      if (part.length < 2) continue;
      let local = remaining.indexOf(part, localCursor);
      if (local < 0) local = localCursor;
      chunks.push({
        text: part,
        el: container,
        map,
        offset: remainingStart + local,
      });
      localCursor = local + part.length;
    }
    for (const block of following) {
      chunks.push(...buildChunks([block]));
    }

    state.chunks = chunks;
    startSession(0);
  }

  // ------------------------------------------------------------------- start

  function startPage(settings, options = {}) {
    state.queueItemId = options.queueItemId || null;
    state.settings = preferences.forPage({ ...preferences.current(), ...settings },location.href);
    const blocks = collectBlocks();
    const chunks = buildChunks(blocks);
    if (!chunks.length) {
      state.chunks = [];
      state.playing = false;
      showUi();
      setStatus("Okunacak metin bulunamadı", true);
      hideUiSoon(3500);
      return false;
    }
    state.chunks = chunks;
    startSession(0);
    return true;
  }

  function startSelection(settings, providedText) {
    state.queueItemId = null;
    state.settings = preferences.forPage({ ...preferences.current(), ...settings },location.href);

    const selection = window.getSelection();
    const hasRange =
      selection?.rangeCount > 0 && !selection.getRangeAt(0).collapsed;

    // Continuing from the selection is the default: users expect the article
    // to keep going after the selected paragraph. Uncheck the popup option to
    // read only the selected text.
    if (state.settings.continueSelection && hasRange) {
      startFromCursor(state.settings);
      return;
    }

    const selected = providedText || selection?.toString() || "";
    const text = cleanText(selected);
    if (!text) {
      // No selection: treat it as "read from the caret" so placing the cursor
      // in a paragraph and choosing "Seçimi oku" does the expected thing.
      startFromCursor(settings);
      return;
    }
    state.chunks = splitText(text).map((part) => ({ text: part, el: null }));
    startSession(0);
  }



  document.addEventListener(
    "mousedown",
    (event) => {
      lastPoint = { x: event.clientX, y: event.clientY };
    },
    true
  );

  document.addEventListener(
    "contextmenu",
    (event) => {
      lastPoint = { x: event.clientX, y: event.clientY };
    },
    true
  );

  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", repositionSpotlight);
  window.addEventListener("resize", schedulePageLayout);

  const isPlayerTarget = (target) =>
    target instanceof Element && !!target.closest("#sesli-oku-host");

  document.addEventListener(
    "wheel",
    (event) => {
      if (isPlayerTarget(event.target)) return;
      markManualScroll();
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (isPlayerTarget(event.target)) return;
      markManualScroll();
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (isPlayerTarget(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable='true']"
        )
      ) {
        return;
      }
      const keys = new Set([
        "PageDown",
        "PageUp",
        "Home",
        "End",
        "ArrowDown",
        "ArrowUp",
        " ",
      ]);
      if (keys.has(event.key)) markManualScroll();
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      // A drag on the classic scrollbar has no wheel/touch event.
      if (isPlayerTarget(event.target)) return;
      if (event.clientX >= document.documentElement.clientWidth - 18) {
        markManualScroll();
      }
    },
    true
  );

  document.addEventListener(
    "selectionchange",
    () => {
      const selection = window.getSelection();
      if (selection?.rangeCount === 1) {
        const range = selection.getRangeAt(0);
        if (range.collapsed) lastCaretRange = range.cloneRange();
      }
    },
    true
  );

  // Capture the text caret before outside-click handling collapses settings
  // and moves the document under the pointer. Only actual text glyphs count.
  const CLICK_CONTROL = "a, button, input, select, textarea, label, summary, audio, video, [contenteditable]:not([contenteditable='false']), [role='link'], [role='button'], [role='checkbox'], [role='switch'], [role='slider'], [role='textbox'], [role='combobox'], [role='tab'], #sesli-oku-host";
  let readingClick = null;
  document.addEventListener("mousedown", event => {
    readingClick = null;
    if (!state.playing || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        !(event.target instanceof Element) || event.target.closest(`${CLICK_CONTROL}, ${SKIP_SELECTOR}`)) return;
    const caret = caretRangeFromPoint(event.clientX, event.clientY);
    const node = caret?.startContainer;
    if (node?.nodeType !== Node.TEXT_NODE || !event.target.contains(node)) return;
    for (const offset of [caret.startOffset, caret.startOffset - 1]) {
      if (offset < 0 || offset >= node.length || /\s/u.test(node.data[offset])) continue;
      const glyph = document.createRange(); glyph.setStart(node, offset); glyph.setEnd(node, offset + 1);
      const hit = [...glyph.getClientRects()].some(rect => event.clientX >= rect.left - 1 && event.clientX <= rect.right + 1 && event.clientY >= rect.top && event.clientY <= rect.bottom);
      if (!hit) continue;
      glyph.collapse(true);
      readingClick = { range: glyph, element: event.target, x: event.clientX, y: event.clientY, session: state.session };
      break;
    }
  }, true);

  document.addEventListener("click", event => {
    const click = readingClick; readingClick = null;
    if (!click || !event.isTrusted || event.defaultPrevented || !state.playing || click.session !== state.session ||
        event.button !== 0 || event.detail > 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        (event.pointerType && event.pointerType !== "mouse") || !click.range.startContainer.isConnected ||
        Math.hypot(event.clientX - click.x, event.clientY - click.y) > 6 || !window.getSelection()?.isCollapsed ||
        click.element.closest(`${CLICK_CONTROL}, ${SKIP_SELECTOR}`)) return;
    const node = click.range.startContainer;
    const locate = chunks => {
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]; if (!chunk.el?.contains(node)) continue;
        const map = chunk.map || buildTextMap(chunk.el); if (!map) continue;
        let offset = caretIndex(map, click.range);
        const begin = chunk.offset || 0;
        if (offset < begin || offset >= begin + chunk.text.length) continue;
        while (offset > begin && /[\p{L}\p{N}\p{M}'’_-]/u.test(map.text[offset - 1])) offset--;
        return { index, charOffset: offset - begin };
      }
      return null;
    };
    let chunks = state.chunks; let target = locate(chunks);
    if (!target) { chunks = buildChunks(collectBlocks()); target = locate(chunks); }
    if (!target) return;
    state.chunks = chunks;
    experience.clearRepeat();
    startSession(target.index, { anchor: { charOffset: target.charOffset, seconds: 0 } });
  });

  // Close the on-page settings panel when clicking anywhere outside the bar.
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!state.ui?.settings.classList.contains("open")) return;
      // Clicks inside the shadow root are retargeted to the host element.
      if (event.target !== state.host) toggleSettings(false);
    },
    true
  );







  experience.initialize();
  preferences.setContext(location.href);
  preferences.subscribe(receiveSettings);
  library.ready.then(() => sendToBackground({ type: "CONTENT_READY" })).catch(() => {});
  setInterval(() => {
    if (state.sleepTimer) { checkSleepDeadline(); updateSleepStatus(); }
  }, 1000);

  if (TEST_MODE) {
    window.__sesliOkuTest = {
      syntheticAudio: (duration = 150) => {
        const frames = Math.round(8000 * duration / 1000);
        const buffer = new ArrayBuffer(44 + frames * 2);
        const view = new DataView(buffer);
        const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        ascii(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        ascii(36, "data"); view.setUint32(40, frames * 2, true);
        state.testAudio = new Uint8Array(buffer); state.testAudioMs = duration;
        state.testRequests = []; state.testPlayed = [];
      },
      startBlocks: (selectors, settings = {}) => {
        state.settings = preferences.forPage({ ...preferences.current(), ...settings },location.href);
        state.chunks = buildChunks(selectors.map(selector => {
          const el = document.querySelector(selector);
          return { el, text: cleanText(el.innerText) };
        }));
        startSession(0);
      },
      playback: () => togglePlayback(),
      timer: timer => configureSleepTimer(timer),
      deadline: ms => {
        configureSleepTimer({ mode: "custom", minutes: 1 });
        clearTimeout(state.sleepTimeout); state.sleepTimer.deadline = Date.now() + ms;
        armSleepTimeout(); publishSleepTimer();
      },
      experience: () => experience.debug(),
      seekBy: seconds => experience.seekBy(seconds),
      seekTo: seconds => experience.seekTo(seconds),
      libraryAction: (action, args = {}) => experience.perform(action, args, requestAudio),
      savePosition: () => experience.save(true),
      requestDelay: ms => { state.testRequestDelay = ms; },
      audioData: base64 => { state.testAudio = fromBase64(base64); state.testAudioMs = 1000; },
      start: (settings = {}) => startPage(settings),
      stop: () => stop(),
      pause: () => {
        state.paused = true;
        if (state.audio) state.audio.pause();
        updateUi();
      },
      resume: () => resumeFollow(),
      setFollow: (value) => {
        state.followReading = value;
        updateUi();
      },
      showWord: (selector, start = 0, end = 6) => {
        const element = document.querySelector(selector);
        const node = element?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const range = document.createRange();
        range.setStart(node, Math.min(start, node.length));
        range.setEnd(node, Math.min(end, node.length));
        CSS.highlights.set(WORD_HIGHLIGHT, new Highlight(range));
        showSpotlight(range);
        return true;
      },
      toggleSettings: (force) => toggleSettings(force),
      snapshot: () => {
        const root = state.host?.shadowRoot;
        const highlight = CSS.highlights?.get(WORD_HIGHLIGHT);
        const range = highlight ? Array.from(highlight)[0] : null;
        const wordRect = range ? range.getBoundingClientRect() : null;
        const spotRect = state.spotlight?.getBoundingClientRect() || null;
        return {
          wordText: range?.toString() || "",
          chunks: state.chunks.map(chunk => ({ id: chunk.el?.id, text: chunk.text })),
          settings: { ...state.settings },
          audioState: state.audio ? {rate:state.audio.playbackRate,defaultRate:state.audio.defaultPlaybackRate,currentTime:state.audio.currentTime,duration:state.audio.duration,readyState:state.audio.readyState,paused:state.audio.paused} : null,
          speedLabel: state.ui?.speed.textContent,
          sleepTimer: state.sleepTimer ? { mode: state.sleepTimer.mode, deadline: state.sleepTimer.deadline } : null,
          gapWaiting: state.gapWaiting,
          testRequests: state.testRequests,
          testPlayed: state.testPlayed,
          status: state.ui?.status.textContent,
          theme: themes.current(),
          session: state.session,
          playing: state.playing,
          paused: state.paused,
          follow: state.followReading,
          followVisible: !!root?.querySelector(".follow.visible"),
          scrollY: window.scrollY,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          index: state.index,
          total: state.chunks.length,
          spotlights: document.querySelectorAll("#sesli-oku-spotlight").length,
          visibleSpotlights: Array.from(
            document.querySelectorAll("#sesli-oku-spotlight")
          ).filter((element) => getComputedStyle(element).opacity !== "0").length,
          hosts: document.querySelectorAll("#sesli-oku-host").length,
          hostTop: state.host ? state.host.style.top : null,
          hostBottom: state.host ? state.host.style.bottom : null,
          hostPosition: state.host ? getComputedStyle(state.host).position : null,
          hostParent: state.host?.parentElement?.tagName || null,
          hostRect: state.host
            ? (() => {
                const rect = state.host.getBoundingClientRect();
                return {
                  top: rect.top,
                  bottom: rect.bottom,
                  height: rect.height,
                };
              })()
            : null,
          hostDisplay: state.host ? state.host.style.display : null,
          settingsOpen: !!state.ui?.settings.classList.contains("open"),
          settingsVoices: state.ui?.voice.querySelectorAll("option").length || 0,
          current: document.querySelectorAll(".edge-ra-current").length,
          scroller: (() => {
            const wordElement = range?.startContainer?.parentElement || null;
            const container = wordElement
              ? findScrollContainer(wordElement)
              : null;
            if (!container) {
              return {
                window: true,
                scrollTop: window.scrollY,
                top: 0,
                bottom: window.innerHeight,
              };
            }
            const box = container.getBoundingClientRect();
            return {
              window: false,
              id: container.id || container.className || container.tagName,
              scrollTop: container.scrollTop,
              top: box.top,
              bottom: box.bottom,
            };
          })(),
          wordRect: wordRect
            ? {
                left: wordRect.left,
                top: wordRect.top,
                right: wordRect.right,
                bottom: wordRect.bottom,
                width: wordRect.width,
                height: wordRect.height,
              }
            : null,
          spotlightRect: spotRect
            ? {
                left: spotRect.left,
                top: spotRect.top,
                right: spotRect.right,
                bottom: spotRect.bottom,
                width: spotRect.width,
                height: spotRect.height,
              }
            : null,
          spotlightStyle: state.spotlight
            ? {
                translate: state.spotlight.style.translate,
                scale: state.spotlight.style.scale,
                opacity: state.spotlight.style.opacity,
                transition: state.spotlight.style.transition,
                position: getComputedStyle(state.spotlight).position,
                cssTop: getComputedStyle(state.spotlight).top,
                cssLeft: getComputedStyle(state.spotlight).left,
              }
            : null,
        };
      },
    };
  }

  if (TEST_MODE && new URL(location.href).searchParams.has("sesliOkuAudio")) window.__sesliOkuTest.syntheticAudio(Number(new URL(location.href).searchParams.get("sesliOkuAudio")) || 150);

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "content") return false;

    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "LIBRARY_ACTION") {
      Promise.all([library.ready,globalThis.SesliOkuDocument?.ready]).then(() => experience.perform(message.action, message.args, requestAudio)).then(
        value => sendResponse({ ok: true, ...value }), error => sendResponse({ ok: false, error: error.message })
      );
      return true;
    }
    if (["START_PAGE", "START_SELECTION", "START_FROM_CURSOR"].includes(message.type) && (!library.isReady() || (globalThis.SesliOkuDocument && document.documentElement.dataset.bookReady!=="true"))) {
      Promise.all([library.ready,globalThis.SesliOkuDocument?.ready]).then(() => {
        if (message.type === "START_PAGE") return startPage(message.settings, { queueItemId: message.queueItemId });
        if (message.type === "START_SELECTION") return startSelection(message.settings, message.text);
        return startFromCursor(message.settings, message.fromPoint === true);
      }).then(started => sendResponse({ ok: true, started }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    try {
      if (message.type === "START_PAGE") { const started = startPage(message.settings, { queueItemId: message.queueItemId }); sendResponse({ ok: true, started: !!started }); return false; }
      else if (message.type === "START_SELECTION") {
        startSelection(message.settings, message.text);
      } else if (message.type === "START_FROM_CURSOR") {
        startFromCursor(message.settings, message.fromPoint === true);
      } else if (message.type === "SET_SLEEP_TIMER") configureSleepTimer(message.timer);
      else if (message.type === "TOGGLE") togglePlayback();
      else if (message.type === "STOP") stop(message.keepQueue);
      else if (message.type === "SET_PLAYBACK_RATE") {
        applyReadingSettings({ playbackRate: clamp(message.playbackRate, 0.5, 2) });
      } else {
        throw new Error(`Bilinmeyen mesaj: ${message.type}`);
      }
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  });
})();
