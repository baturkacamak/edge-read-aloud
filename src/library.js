/** Local reading history, bookmarks, queue and text-to-speech source mapping. */
(() => {
  if (globalThis.SesliOkuLibrary) return;
  const worker = typeof document === "undefined";
  const empty = () => ({ pages: {}, bookmarks: [], queue: [], queueRunning: false, queueItemId: null, queueTabId: null, export: null });
  let data = empty();
  let loaded = false;
  let revision = 0;
  let writes = Promise.resolve();
  const listeners = new Set();
  function pageKey(url) {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error("Bu sayfa okuma kitaplığına eklenemiyor.");
    parsed.hash = ""; return parsed.href;
  }
  function queueUrl(url) {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Okuma listesi için http veya https adresi girin.");
    return parsed.href;
  }
  function clean(value) {
    const result = empty();
    if (!value || typeof value !== "object") return result;
    for (const [url, entry] of Object.entries(value.pages || {}).slice(-100)) {
      try { const key = pageKey(url); result.pages[key] = { ...entry, url: key, exclusions: Array.isArray(entry.exclusions) ? entry.exclusions.slice(0, 50) : [] }; } catch {}
    }
    result.bookmarks = Array.isArray(value.bookmarks) ? value.bookmarks.filter(item => item?.id && item.url && item.anchor).slice(-300) : [];
    result.queue = Array.isArray(value.queue) ? value.queue.filter(item => item?.id && /^https?:\/\//i.test(item.url)).slice(0, 50) : [];
    result.queueRunning = value.queueRunning === true;
    result.queueItemId = value.queueItemId || null;
    result.queueTabId = Number.isInteger(value.queueTabId) ? value.queueTabId : null;
    result.export = value.export || null;
    return result;
  }
  const notify = () => { for (const listener of listeners) listener(data); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.readingLibrary) { revision++; data = clean(changes.readingLibrary.newValue); notify(); }
  });
  const ready = chrome.storage.local.get("readingLibrary").then(stored => {
    if (!revision) data = clean(stored.readingLibrary);
    loaded = true; notify(); return data;
  });
  async function rpc(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ target: "background", type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "İşlem tamamlanamadı.");
    return response;
  }
  function mutate(operation) {
    if (!worker) return rpc("LIBRARY_MUTATE", { operation }).then(result => { data = clean(result.library); notify(); return data; });
    const task = writes.then(async () => {
      const stored = await chrome.storage.local.get("readingLibrary");
      const next = clean(stored.readingLibrary);
      const op = operation;
      if (op.type === "progress") {
        const url = pageKey(op.url); const old = next.pages[url] || {};
        next.pages[url] = { ...old, url, title: String(op.title || url).slice(0, 250), anchor: op.anchor, completed: !!op.completed, updated: Date.now() };
      } else if (op.type === "bookmark") {
        const url = pageKey(op.url);
        const duplicate = next.bookmarks.find(item => item.url === url && item.anchor.quote === op.anchor.quote && item.anchor.charOffset === op.anchor.charOffset);
        if (!duplicate) next.bookmarks.push({ id: crypto.randomUUID(), url, title: String(op.title || url).slice(0, 250), anchor: op.anchor, created: Date.now() });
        next.bookmarks = next.bookmarks.slice(-300);
      } else if (op.type === "bookmarkRemove") next.bookmarks = next.bookmarks.filter(item => item.id !== op.id);
      else if (op.type === "exclude") {
        const url = pageKey(op.url); const old = next.pages[url] || { url, title: op.title || url };
        const exclusions = [...(old.exclusions || [])].filter(item => item.selector !== op.selector);
        if (exclusions.length >= 50) throw new Error("Bu sayfada en fazla 50 alan hariç tutulabilir.");
        exclusions.push({ id: crypto.randomUUID(), selector: String(op.selector).slice(0, 1000), quote: String(op.quote || "").slice(0, 180) });
        next.pages[url] = { ...old, exclusions, updated: Date.now() };
      } else if (op.type === "excludeRemove") {
        const entry = next.pages[pageKey(op.url)]; if (entry) entry.exclusions = (entry.exclusions || []).filter(item => item.id !== op.id);
      } else if (op.type === "queueAdd") {
        const url = queueUrl(op.url);
        if (next.queue.length >= 50) throw new Error("Okuma listesine en fazla 50 yazı eklenebilir.");
        if (!next.queue.some(item => item.url === url && item.status !== "done")) next.queue.push({ id: crypto.randomUUID(), url, title: String(op.title || url).slice(0, 250), status: "pending" });
      } else if (op.type === "queueRemove") next.queue = next.queue.filter(item => item.id !== op.id);
      else if (op.type === "queueMove") {
        const from = next.queue.findIndex(item => item.id === op.id); const to = Math.max(0, Math.min(next.queue.length - 1, from + (op.direction < 0 ? -1 : 1)));
        if (from >= 0) { const [item] = next.queue.splice(from, 1); next.queue.splice(to, 0, item); }
      } else if (op.type === "queueStart") {
        next.queue = next.queue.map(item => ({ ...item, status: "pending", error: "" })); next.queueRunning = !!next.queue.length; next.queueItemId = null; next.queueTabId = null;
      } else if (op.type === "queueState") {
        if ("running" in op) next.queueRunning = !!op.running;
        if ("itemId" in op) next.queueItemId = op.itemId;
        if ("tabId" in op) next.queueTabId = op.tabId;
        if (op.id) { const item = next.queue.find(item => item.id === op.id); if (item) { item.status = op.status; item.error = String(op.error || "").slice(0, 250); } }
      } else if (op.type === "queueStop") {
        next.queueRunning = false; next.queueItemId = null; next.queueTabId = null;
        next.queue = next.queue.map(item => item.status === "reading" ? { ...item, status: "pending" } : item);
      } else if (op.type === "export") next.export = op.value;
      else if (op.type === "forget") delete next.pages[pageKey(op.url)];
      else throw new Error("Bilinmeyen kitaplık işlemi.");
      const pages = Object.entries(next.pages).sort((a, b) => (a[1].updated || 0) - (b[1].updated || 0)).slice(-100);
      next.pages = Object.fromEntries(pages);
      await chrome.storage.local.set({ readingLibrary: next }); data = next; notify(); return next;
    });
    writes = task.catch(() => {}); return task;
  }
  async function action(action, args = {}) {
    return rpc("LIBRARY_ACTION", { action, args });
  }
  function subscribe(listener) { listeners.add(listener); listener(data); return () => listeners.delete(listener); }
  function dictionary(text) {
    const rules = [];
    for (const line of String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      const split = line.indexOf("=");
      if (split <= 0 || !line.slice(split + 1).trim()) throw new Error("Her satırı sözcük = okunuş biçiminde yazın.");
      const from = line.slice(0, split).trim(); const to = line.slice(split + 1).trim();
      if (from.length > 100 || to.length > 200) throw new Error("Sözlükte bir sözcük 100, okunuş 200 karakteri aşamaz.");
      rules.push({ from, to });
      if (rules.length > 200) throw new Error("Sözlüğe en fazla 200 kayıt eklenebilir.");
    }
    return rules;
  }
  function pronounce(source, rules = []) {
    const valid = rules.filter(rule => rule?.from && rule?.to).sort((a, b) => b.from.length - a.from.length);
    const pattern = valid.length ? new RegExp(valid.map(rule => rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu") : null;
    let text = ""; const origins = []; let cursor = 0;
    const append = (value, start, end, replacement) => {
      text += value;
      for (let index = 0; index < value.length; index++) origins.push(replacement ? { start, end } : { start: start + index, end: start + index + 1 });
    };
    for (const match of pattern ? source.matchAll(pattern) : []) {
      const previous = source[match.index - 1] || ""; const following = source[match.index + match[0].length] || "";
      if ((/[\p{L}\p{N}]/u.test(match[0][0]) && /[\p{L}\p{N}]/u.test(previous)) ||
          (/[\p{L}\p{N}]/u.test(match[0].at(-1)) && /[\p{L}\p{N}]/u.test(following))) continue;
      const rule = valid.find(item => item.from.toLocaleLowerCase() === match[0].toLocaleLowerCase());
      if (!rule) continue;
      append(source.slice(cursor, match.index), cursor, match.index, false);
      append(rule.to, match.index, match.index + match[0].length, true); cursor = match.index + match[0].length;
    }
    append(source.slice(cursor), cursor, source.length, false);
    return { text, origins };
  }
  function mapBoundaries(spoken, boundaries) {
    let cursor = 0;
    return boundaries.map(boundary => {
      const word = String(boundary.text || "").trim(); if (!word) return null;
      let index = spoken.text.indexOf(word, cursor);
      if (index < 0) { const match = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(spoken.text.slice(cursor)); if (match) index = cursor + match.index; }
      if (index < 0) return null;
      cursor = index + word.length;
      const first = spoken.origins[index]; const last = spoken.origins[cursor - 1];
      return first && last ? { start: first.start, end: last.end } : null;
    });
  }
  function detectLanguage(text, explicit = "", fallback = "tr") {
    if (explicit) return explicit.toLowerCase().split(/[-_]/)[0];
    if (/\p{Script=Han}/u.test(text)) return /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text) ? "ja" : "zh";
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return "ja";
    if (/\p{Script=Hangul}/u.test(text)) return "ko";
    if (/\p{Script=Arabic}/u.test(text)) return "ar";
    if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
    const dictionaries = {
      tr: "ve bir bu için ile olan olarak değil daha gibi ancak kadar sonra çok da de", en: "the and is are was were for with this that from of to in you it not",
      de: "der die das und ist sind mit nicht ein eine auf für", fr: "le la les des et est pour une dans avec pas", es: "el los las una que del para con por pero como", it: "gli della che per una sono non con", pt: "uma não para com são dos das pelo",
    };
    const words = text.toLocaleLowerCase().match(/[\p{L}]+/gu) || [];
    let language = fallback.split("-")[0]; let best = 1;
    for (const [key, values] of Object.entries(dictionaries)) {
      const set = new Set(values.split(" ")); let score = words.filter(word => set.has(word)).length;
      if (key === "tr") score += (text.match(/[ğışİĞŞ]/g) || []).length * 2;
      if (score > best) { best = score; language = key; }
    }
    return language;
  }
  function stripMp3Tags(bytes) {
    let start = 0; let end = bytes.length;
    if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51 && bytes.length >= 10) {
      const size = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
      start = Math.min(end, 10 + size + (bytes[5] & 16 ? 10 : 0));
    }
    if (end - start >= 128 && bytes[end - 128] === 84 && bytes[end - 127] === 65 && bytes[end - 126] === 71) end -= 128;
    return bytes.slice(start, end);
  }
  function mount(root) {
    root.classList.add("reading-library");
    root.innerHTML = `<div class="library-current" role="status">Sayfa bilgisi alınıyor…</div>
      <div class="library-buttons"><button type="button" class="pref-button" data-library="resume">Kaldığım yerden devam et</button><button type="button" class="pref-button" data-library="bookmark">Yer imi ekle</button><button type="button" class="pref-button" data-library="focus">Odak görünümü</button><button type="button" class="pref-button" data-library="export">MP3 indir</button><button type="button" class="pref-button" data-library="cancelExport" hidden>İndirmeyi iptal et</button></div>
      <div class="library-export" role="status"></div>
      <details><summary>Yer imleri</summary><ul class="library-bookmarks"></ul></details>
      <details><summary>Okuma listesi</summary><div class="library-buttons"><button type="button" class="pref-button" data-library="queueCurrent">Bu sayfayı ekle</button><button type="button" class="pref-button" data-library="queueStart">Sırayı başlat</button><button type="button" class="pref-button" data-library="queueStop">Sırayı durdur</button></div><div class="library-url"><input type="url" placeholder="https://…" aria-label="Okuma listesine eklenecek adres"><button type="button" class="pref-button" data-library="queueAdd">Adresi ekle</button></div><ul class="library-queue"></ul></details>
      <details><summary>Okunmayacak alanlar</summary><button type="button" class="pref-button" data-library="pickExclude">Sayfadan alan seç</button><ul class="library-exclusions"></ul></details>
      <details><summary>Telaffuz sözlüğü</summary><label>Sözcük = okunuş<textarea rows="4" placeholder="OpenAI = Open ey ay\nTBMM = Türkiye Büyük Millet Meclisi" aria-label="Telaffuz sözlüğü"></textarea></label><button type="button" class="pref-button" data-library="dictionary">Sözlüğü kaydet</button></details>
      <div class="library-feedback" role="status"></div>`;
    let context = null;
    const feedback = text => { root.querySelector(".library-feedback").textContent = text; };
    const button = (label, actionName, args = {}) => { const node = document.createElement("button"); node.type = "button"; node.className = "pref-button"; node.textContent = label; node.dataset.library = actionName; node._libraryArgs = args; return node; };
    function refresh(value) {
      let key = ""; try { if (context?.url) key = pageKey(context.url); } catch {}
      const page = value.pages[key];
      root.querySelector(".library-current").textContent = page?.anchor && !page.completed ? `${context?.title || page.title} · kayıtlı konum var` : context?.title || "Bu sayfa için kayıtlı konum yok.";
      root.querySelector('[data-library="resume"]').disabled = !page?.anchor || page.completed;
      const bookmarks = root.querySelector(".library-bookmarks"); bookmarks.replaceChildren();
      for (const item of value.bookmarks) {
        const row = document.createElement("li"); const title = document.createElement("span"); title.textContent = `${item.title} — ${item.anchor.quote.slice(0, 80)}`;
        row.append(title, button("Aç", "bookmarkOpen", { id: item.id }), button("Sil", "bookmarkRemove", { id: item.id })); bookmarks.appendChild(row);
      }
      if (!bookmarks.children.length) bookmarks.textContent = "Henüz yer imi yok.";
      const queue = root.querySelector(".library-queue"); queue.replaceChildren();
      for (const item of value.queue) {
        const row = document.createElement("li"); const title = document.createElement("span"); title.textContent = `${item.status === "reading" ? "▶ " : item.status === "done" ? "✓ " : item.status === "error" ? "! " : ""}${item.title}`; title.title = item.error || item.url;
        row.append(title, button("↑", "queueMove", { id: item.id, direction: -1 }), button("↓", "queueMove", { id: item.id, direction: 1 }), button("Sil", "queueRemove", { id: item.id })); queue.appendChild(row);
      }
      if (!queue.children.length) queue.textContent = "Okuma listesi boş.";
      root.querySelector('[data-library="queueStop"]').disabled = !value.queueRunning;
      root.querySelector('[data-library="queueStart"]').disabled = !value.queue.length;
      const exclusions = root.querySelector(".library-exclusions"); exclusions.replaceChildren();
      for (const item of page?.exclusions || []) { const row = document.createElement("li"); const text = document.createElement("span"); text.textContent = item.quote || item.selector; row.append(text, button("Kaldır", "excludeRemove", { id: item.id, url: key })); exclusions.appendChild(row); }
      if (!exclusions.children.length) exclusions.textContent = "Bu sayfada hariç tutulan alan yok.";
      const job = value.export;
      root.querySelector(".library-export").textContent = job?.status === "working" ? `MP3 hazırlanıyor: %${job.percent}` : job?.status === "done" ? `İndirildi: ${job.filename}` : job?.status === "error" ? job.error : job?.status === "canceled" ? "İndirme iptal edildi." : "";
      root.querySelector('[data-library="export"]').disabled = job?.status === "working";
      root.querySelector('[data-library="cancelExport"]').hidden = job?.status !== "working";
    }
    const unsubscribe = subscribe(refresh);
    action("context").then(result => { context = result.context; refresh(data); }).catch(error => feedback(error.message));
    const unsubscribeSettings = globalThis.SesliOkuSettings.subscribe(settings => {
      if (document.activeElement !== root.querySelector("textarea") && root.getRootNode().activeElement !== root.querySelector("textarea")) root.querySelector("textarea").value = (settings.pronunciationRules || []).map(rule => `${rule.from} = ${rule.to}`).join("\n");
    });
    root.addEventListener("click", async event => {
      const target = event.target.closest("[data-library]"); if (!target || target.disabled) return;
      let name = target.dataset.library; const args = { ...(target._libraryArgs || {}) };
      try {
        if (name === "dictionary") { await globalThis.SesliOkuSettings.update({ pronunciationRules: dictionary(root.querySelector("textarea").value) }); feedback("Telaffuz sözlüğü kaydedildi."); return; }
        if (name === "queueAdd") { args.url = root.querySelector('input[type="url"]').value; name = "queueAddUrl"; }
        if (name === "queueCurrent") { args.url = context?.url; args.title = context?.title; name = "queueAddUrl"; }
        const result = await action(name, args); feedback(result.message || "İşlem tamamlandı.");
        if (name === "pickExclude" && location.protocol === "chrome-extension:") window.close();
      } catch (error) { feedback(error.message); }
    });
    return { dispose() { unsubscribe(); unsubscribeSettings(); } };
  }
  const css = `
    @layer base, themes, preferences, experience;
    @layer experience {
      .wrap .preferences { max-height: min(62vh, 540px); overflow-y: auto; overscroll-behavior: contain; }
      .reading-library { grid-column: 1 / -1; min-width: 0; font-size: 11px; }
      .library-current, .library-export, .library-feedback { margin-bottom: 7px; }
      .library-buttons, .library-url { display: flex; flex-wrap: wrap; gap: 5px; margin: 7px 0; }
      .reading-library details { margin-top: 10px; }
      .reading-library summary { cursor: pointer; }
      .reading-library ul { margin: 7px 0; padding: 0; list-style: none; }
      .reading-library li { display: flex; align-items: center; gap: 4px; margin: 5px 0; }
      .reading-library li > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .reading-library textarea, .reading-library input[type="url"] {
        box-sizing: border-box; width: 100%; min-width: 0; padding: 6px; border: 1px solid var(--border, #56604a);
        font: inherit; color: inherit; background: var(--panel, #242a24); border-radius: var(--theme-radius, 3px);
        user-select: text; -webkit-user-select: text;
      }
      .reading-library textarea { display: block; margin: 5px 0; resize: vertical; }
      .library-url input { flex: 1; }
      .playback-strip { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; max-width: 1120px; margin: 0 auto; padding: 5px 12px 8px; font-size: 11px; }
      .playback-strip button { display: grid; place-items: center; box-sizing: border-box; width: auto; height: 25px; min-height: 25px; padding: 0 7px; flex: none; font-size: 11px; border-radius: var(--theme-radius, 5px); background: var(--theme-button, #ffffff12); }
      .playback-strip input { flex: 1; min-width: 30px; width: 100%; }
      .playback-strip output { flex: none; font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .focus-reader { margin: 0 6px 8px; border: 1px solid var(--border, #56604a); background: var(--panel, #242a24); color: var(--text, #f7f7f5); }
      .focus-reader[hidden], .playback-strip [hidden] { display: none; }
      .focus-heading { display: flex; align-items: center; gap: 12px; padding: 10px 16px; font: inherit; border-bottom: 1px solid var(--border, #56604a); }
      .focus-heading h2 { flex: 1; min-width: 0; font: inherit; font-weight: 700; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .focus-heading button { width: auto; height: 25px; min-height: 25px; padding: 0 8px; font-size: 11px; }
      .focus-text { position: relative; max-height: 52vh; overflow-y: auto; padding: 20px max(18px, calc((100% - 760px) / 2)); font-family: Georgia, serif; font-size: var(--focus-font-size, 22px); line-height: 1.8; }
      .focus-text p { margin: 0 0 18px; padding: 8px 12px; border-left: 3px solid transparent; cursor: pointer; }
      .focus-text p.active { border-left-color: var(--focus-word-bg, #d9f27a); }
      .focus-text mark { background: var(--focus-word-bg, #d9f27a); color: var(--focus-word-text, #111); }
      .focus-reader[data-background="paper"] .focus-text { position: relative; background: #fbfaf4; color: #232720; }
      .focus-reader[data-background="dark"] .focus-text { position: relative; background: #1b1d1f; color: #ecefea; }
      .exclude-preview { position: fixed; inset: auto; margin: 0; padding: 0; pointer-events: none; box-sizing: border-box; border: 2px dashed #ee8c26; background: #ee8c2622; }
      @media (max-width: 460px) { .playback-strip { padding: 5px 4px; gap: 4px; } .playback-strip button { padding: 0 4px; } .playback-strip output { font-size: 9px; } }
    }
  `;
  globalThis.SesliOkuLibrary = Object.freeze({ ready, pageKey, queueUrl, mutate, css, action, subscribe, dictionary, pronounce, mapBoundaries, detectLanguage, stripMp3Tags, mount,
    current: () => data, isReady: () => loaded });
})();
