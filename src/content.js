/**
 * Sesli Oku — content script.
 *
 * Extracts readable blocks, turns them into paragraph-sized chunks, asks the
 * service worker for audio, and plays it with a small shadow-DOM player.
 */

(() => {
  if (window.__sesliOkuLoaded) return;
  window.__sesliOkuLoaded = true;

  const MAX_CHUNK_CHARS = 900;
  const CANDIDATE_SELECTOR =
    "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, figcaption, div, section";
  const SKIP_SELECTOR =
    "nav, aside, footer, form, button, select, textarea, script, style, noscript, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], [role='button'], " +
    "[role='menu'], [role='dialog'], [role='complementary'], [aria-hidden='true'], " +
    "[contenteditable='true'], .sidebar, .widget-area, " +
    "[class~='sidebar'], [id~='sidebar']";

  const DEFAULT_SETTINGS = {
    voice: "tr-TR-EmelNeural",
    rate: 0,
    pitch: 0,
    volume: 0,
    playbackRate: 1,
    continueSelection: true,
  };

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
    highlighted: null,
    host: null,
    ui: null,
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
  };

  let lastPoint = null;
  let lastCaretRange = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function normalizeSettings(settings = {}) {
    return {
      voice: settings.voice || DEFAULT_SETTINGS.voice,
      rate: clamp(settings.rate, -50, 100),
      pitch: clamp(settings.pitch, -50, 50),
      volume: clamp(settings.volume, -100, 100),
      playbackRate: clamp(settings.playbackRate || 1, 0.5, 2),
      continueSelection: settings.continueSelection !== false,
    };
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
      if (!/[0-9A-Za-zÇĞİÖŞÜçğıöşü]/.test(innerText)) continue;

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
      const text = map?.text || innerText;
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
      for (const part of splitText(block.text)) {
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
    const response = await chrome.runtime.sendMessage({
      target: "background",
      ...message,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Arka plan servisi yanıt vermedi.");
    }
    return response;
  }

  async function requestAudio(text) {
    const response = await sendToBackground({
      type: "SPEAK",
      text,
      settings: state.settings,
    });
    return {
      audio: fromBase64(response.audio),
      boundaries: response.boundaries || [],
    };
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function audioFor(index) {
    if (state.cache.has(index)) return state.cache.get(index);
    const promise = requestAudio(state.chunks[index].text);
    state.cache.set(index, promise);
    return promise;
  }

  function prefetch(index) {
    if (index >= state.chunks.length || state.cache.has(index)) return;
    const promise = requestAudio(state.chunks[index].text);
    state.cache.set(index, promise);
    promise.catch(() => state.cache.delete(index));
  }

  // ---------------------------------------------------------------- player UI

  function buildUi() {
    if (state.host) return state.ui;

    const host = document.createElement("div");
    host.id = "sesli-oku-host";
    host.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; left: 50%; " +
      "bottom: 20px; transform: translateX(-50%); pointer-events: none;";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #f7f7f5;
          pointer-events: auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          max-width: min(92vw, 560px);
        }
        .bar {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 7px 9px;
          background: rgba(17, 20, 19, .92);
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 999px;
          box-shadow: 0 10px 30px rgba(0,0,0,.35);
          backdrop-filter: blur(12px);
        }
        button {
          all: unset;
          box-sizing: border-box;
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          cursor: pointer;
          color: #f7f7f5;
          font-size: 15px;
          transition: background .15s ease, color .15s ease;
        }
        button:hover { background: rgba(255,255,255,.12); }
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
      </style>
      <div class="wrap">
        <div class="bar">
          <button data-act="prev" title="Önceki paragraf">⏮</button>
          <button data-act="toggle" class="primary" title="Oynat / duraklat">▶</button>
          <button data-act="next" title="Sonraki paragraf">⏭</button>
          <span class="divider"></span>
          <span class="status">Hazır</span>
          <button data-act="follow" class="follow" title="Okumaya dön">Okumaya dön</button>
          <span class="divider"></span>
          <button data-act="speed" class="speed" title="Oynatma hızı">1.0×</button>
          <button data-act="close" class="close" title="Durdur ve kapat">✕</button>
        </div>
      </div>`;

    const ui = {
      status: shadow.querySelector(".status"),
      toggle: shadow.querySelector("[data-act='toggle']"),
      speed: shadow.querySelector("[data-act='speed']"),
      follow: shadow.querySelector("[data-act='follow']"),
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
      else if (action === "close") stop();
    });

    document.documentElement.appendChild(host);
    state.host = host;
    state.ui = ui;
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
        state.host.style.display = "none";
      }
    }, delay);
  }

  function updateUi() {
    if (!state.ui) return;
    if (state.host) state.host.style.display = "block";

    const ui = state.ui;
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
    "script, style, noscript, template, [aria-hidden='true']";

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
    if (state.spotlight?.isConnected) return state.spotlight;
    const element = document.createElement("div");
    element.id = "sesli-oku-spotlight";
    document.documentElement.appendChild(element);
    state.spotlight = element;
    return element;
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
    if (wordElement && wordElement !== state.spotlightThemeElement) {
      state.spotlightThemeElement = wordElement;
      state.spotlightDark = isDarkBackground(wordElement);
      element.dataset.theme = state.spotlightDark ? "dark" : "light";
    }

    const docTop = rect.top + window.scrollY;
    const docLeft = rect.left + window.scrollX;
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
      !state.followReading &&
      state.playing &&
      performance.now() - state.lastManualScrollAt > 900 &&
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight
    ) {
      state.followReading = true;
      updateUi();
    }

    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // Scroll slightly ahead of the animation and place the box at the final
    // viewport position while the page glides there. This prevents the scroll
    // handler from interrupting the arrival animation.
    const topMargin = 96;
    const bottomMargin = 120;
    let target = rect;
    if (
      !snap &&
      autoScroll &&
      state.followReading &&
      range !== state.spotlightScrollRange
    ) {
      state.spotlightScrollRange = range;
      let delta = 0;
      if (rect.top < topMargin) {
        delta = rect.top - topMargin;
      } else if (rect.bottom > window.innerHeight - bottomMargin) {
        delta = rect.bottom - (window.innerHeight - bottomMargin);
      }
      if (delta) {
        state.autoScrollUntil = performance.now() + 2000;
        window.scrollBy({
          top: delta,
          behavior: reduceMotion ? "auto" : "smooth",
        });
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

    if (reduceMotion || snap) {
      // Scrolling and reduced-motion mode must not animate the box.
      element.style.transition = "none";
      setSpotlightGeometry(element, target, padX, padY, 0, 1);
      element.style.opacity = "1";
      requestAnimationFrame(() => {
        if (state.spotlight === element) element.style.transition = "";
      });
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
    if (state.spotlight) state.spotlight.style.opacity = "0";
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

  function onScroll() {
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
    state.followReading = true;
    state.lastManualScrollAt = 0;
    state.autoScrollUntil = performance.now() + 2000;
    updateUi();

    const range = state.spotlightRange;
    if (!range) return;

    const rect = range.getBoundingClientRect();
    const topMargin = 96;
    const bottomMargin = 120;
    let delta = 0;
    if (rect.top < topMargin) {
      delta = rect.top - topMargin;
    } else if (rect.bottom > window.innerHeight - bottomMargin) {
      delta = rect.bottom - (window.innerHeight - bottomMargin);
    }

    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (delta) {
      window.scrollBy({
        top: delta,
        behavior: reduceMotion ? "auto" : "smooth",
      });
      setTimeout(
        () => {
          if (state.spotlightRange === range) {
            showSpotlight(range, true, false);
          }
        },
        reduceMotion ? 0 : 350
      );
    } else {
      showSpotlight(range, true, false);
    }
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

  function buildWordRanges(chunk, boundaries) {
    if (!supportsWordHighlight() || !chunk?.el || !boundaries?.length) {
      return null;
    }

    const map = chunk.map || buildTextMap(chunk.el);
    if (!map) return null;

    const chunkText = chunk.text || "";
    let base = typeof chunk.offset === "number" ? chunk.offset : -1;
    if (
      base < 0 ||
      map.text.slice(base, base + chunkText.length) !== chunkText
    ) {
      base = map.text.indexOf(chunkText);
    }

    // If the exact chunk cannot be located, at least anchor to its first word
    // so the rest of the paragraph can still be highlighted word by word.
    let haystack = chunkText;
    if (base < 0) {
      const firstWord = (boundaries[0]?.text || "").trim();
      const found = firstWord ? findWord(map.text, firstWord) : null;
      if (!found) return null;
      base = found.index;
      haystack = map.text.slice(base);
    }

    const ranges = [];
    let cursor = 0;
    for (const boundary of boundaries) {
      const word = (boundary.text || "").trim();
      if (!word) {
        ranges.push(null);
        continue;
      }
      const found = findWord(haystack, word, cursor);
      if (!found) {
        ranges.push(null);
        continue;
      }
      cursor = found.index + found.length;

      const start = base + found.index;
      const end = start + found.length;
      const first = map.positions[start];
      const last = map.positions[end - 1];
      if (!first || !last) {
        ranges.push(null);
        continue;
      }
      try {
        const range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset + 1);
        ranges.push(range);
      } catch {
        ranges.push(null);
      }
    }
    return ranges;
  }

  // ---------------------------------------------------------------- playback

  function playResult(result, session, chunk) {
    return new Promise((resolve) => {
      if (session !== state.session) return resolve();

      const blob = new Blob([result.audio], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      const boundaries = result.boundaries || [];
      const wordRanges = buildWordRanges(chunk, boundaries);
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
      state.audios.add(audio);

      const onTimeUpdate = () => {
        if (!boundaries.length) return;
        const ticks = audio.currentTime * 1e7;
        while (
          boundaryIndex + 1 < boundaries.length &&
          boundaries[boundaryIndex + 1].offset <= ticks
        ) {
          boundaryIndex++;
        }

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
        URL.revokeObjectURL(url);
        state.audios.delete(audio);
        if (session === state.session) clearWordHighlight();
        resolve(value?.blocked ? { blocked: true } : {});
      };

      audio.onended = finish;
      audio.onerror = finish;
      audio.ontimeupdate = onTimeUpdate;
      audio.playbackRate = state.settings.playbackRate;

      audio.src = url;
      onTimeUpdate();
      audio.play().catch((error) => {
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
        if (session !== state.session) {
          audio.pause();
          finish();
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
        state.playing = false;
        state.paused = false;
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
        updateUi();
        return;
      }
      state.index++;
    }

    if (session === state.session) {
      state.playing = false;
      state.paused = false;
      clearHighlight();
      updateUi();
      hideUiSoon(2200);
      sendToBackground({ type: "STOP" }).catch(() => {});
    }
  }

  function startSession(index) {
    state.session++;
    for (const audio of state.audios) audio.pause();
    if (state.audio) {
      state.audio.removeAttribute("src");
      state.audio.load();
    }
    const session = state.session;
    state.index = index;
    state.playing = true;
    state.paused = false;
    state.followReading = true;
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
    if (state.audio) {
      if (state.paused) state.audio.pause();
      else state.audio.play().catch(() => {});
    }
    updateUi();
  }

  function skip(direction) {
    if (!state.chunks.length) return;
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
    state.settings.playbackRate = next;
    if (state.audio) state.audio.playbackRate = next;
    updateUi();
  }

  function stop() {
    state.session++;
    state.playing = false;
    state.paused = false;
    state.followReading = true;
    state.lastManualScrollAt = 0;
    state.index = 0;
    state.chunks = [];
    state.cache.clear();
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
    hideUiSoon(600);
    sendToBackground({ type: "STOP" }).catch(() => {});
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
    state.settings = normalizeSettings(settings);
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

  function startPage(settings) {
    state.settings = normalizeSettings(settings);
    const blocks = collectBlocks();
    const chunks = buildChunks(blocks);
    if (!chunks.length) {
      state.chunks = [];
      state.playing = false;
      showUi();
      setStatus("Okunacak metin bulunamadı", true);
      hideUiSoon(3500);
      return;
    }
    state.chunks = chunks;
    startSession(0);
  }

  function startSelection(settings, providedText) {
    state.settings = normalizeSettings(settings);

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







  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "content") return false;

    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    try {
      if (message.type === "START_PAGE") startPage(message.settings);
      else if (message.type === "START_SELECTION") {
        startSelection(message.settings, message.text);
      } else if (message.type === "START_FROM_CURSOR") {
        startFromCursor(message.settings, message.fromPoint === true);
      } else if (message.type === "TOGGLE") togglePlayback();
      else if (message.type === "STOP") stop();
      else if (message.type === "SET_PLAYBACK_RATE") {
        state.settings.playbackRate = clamp(message.playbackRate, 0.5, 2);
        if (state.audio) state.audio.playbackRate = state.settings.playbackRate;
        updateUi();
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
