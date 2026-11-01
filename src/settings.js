/** Shared settings schema, storage and Windows-style property pages. */
(() => {
  if (globalThis.SesliOkuSettings) return;
  const defaults = Object.freeze({
    voice: "tr-TR-EmelNeural", rate: 0, pitch: 0, volume: 0,
    playbackRate: 1, continueSelection: true,
    highlightMode: "both", highlightColor: "theme", highlightOpacity: 35,
    glowIntensity: 60, autoFollow: true, scrollBehavior: "smooth", paragraphDelay: 0,
    rememberPosition: true, autoVoice: false, turkishVoice: "tr-TR-EmelNeural", englishVoice: "en-US-AvaNeural",
    pronunciationRules: [], focusFontSize: 22, focusBackground: "theme",
    focusFont: "serif", focusLineHeight: 1.8, focusWidth: 760, focusPadding: 20,
  });
  const number = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function normalize(value = {}) {
    value = value && typeof value === "object" ? value : {};
    return {
      voice: typeof value.voice === "string" && value.voice ? value.voice : defaults.voice,
      rate: number(value.rate ?? 0, 0, -50, 100),
      pitch: number(value.pitch ?? 0, 0, -50, 50),
      volume: number(value.volume ?? 0, 0, -50, 50),
      playbackRate: number(value.playbackRate ?? 1, 1, .5, 2),
      continueSelection: value.continueSelection !== false,
      highlightMode: ["both", "word", "paragraph", "off"].includes(value.highlightMode) ? value.highlightMode : "both",
      highlightColor: /^#[0-9a-f]{6}$/i.test(value.highlightColor) ? value.highlightColor : "theme",
      highlightOpacity: number(value.highlightOpacity ?? 35, 35, 0, 100),
      glowIntensity: number(value.glowIntensity ?? 60, 60, 0, 100),
      autoFollow: value.autoFollow !== false,
      scrollBehavior: value.scrollBehavior === "instant" ? "instant" : "smooth",
      paragraphDelay: number(value.paragraphDelay ?? 0, 0, 0, 3000),
      rememberPosition: value.rememberPosition !== false,
      autoVoice: value.autoVoice === true,
      turkishVoice: typeof value.turkishVoice === "string" && value.turkishVoice ? value.turkishVoice : defaults.turkishVoice,
      englishVoice: typeof value.englishVoice === "string" && value.englishVoice ? value.englishVoice : defaults.englishVoice,
      pronunciationRules: Array.isArray(value.pronunciationRules) ? value.pronunciationRules.filter(rule => typeof rule?.from === "string" && rule.from.trim() && typeof rule.to === "string" && rule.to.trim()).slice(0, 200).map(rule => ({ from: rule.from.slice(0, 100), to: rule.to.slice(0, 200) })) : [],
      focusFontSize: number(value.focusFontSize ?? 22, 22, 16, 36),
      focusBackground: ["paper", "dark"].includes(value.focusBackground) ? value.focusBackground : "theme",
      focusFont: ['sans','mono'].includes(value.focusFont) ? value.focusFont : 'serif',
      focusLineHeight: number(value.focusLineHeight ?? 1.8, 1.8, 1.2, 2.6),
      focusWidth: number(value.focusWidth ?? 760, 760, 400, 1200),
      focusPadding: number(value.focusPadding ?? 20, 20, 8, 60),
    };
  }
  function highlightColorFor(value, theme) {
    if (value.highlightColor !== "theme") return value.highlightColor;
    return theme === "xp" ? "#245edb" : theme === "win7" ? "#246b9c" : theme === "modern" ? "#d9f27a" : "#000080";
  }
  const presets = [
    { id: "article", name: "Makale", settings: { rate: 0, pitch: 0, volume: 0, playbackRate: 1, highlightMode: "both", highlightColor: "theme", highlightOpacity: 35, glowIntensity: 60, autoFollow: true, scrollBehavior: "smooth", paragraphDelay: 350 } },
    { id: "study", name: "Ders", settings: { rate: -10, pitch: 0, volume: 0, playbackRate: 1, highlightMode: "both", highlightColor: "#f5d76e", highlightOpacity: 45, glowIntensity: 30, autoFollow: true, scrollBehavior: "smooth", paragraphDelay: 1000 } },
    { id: "night", name: "Gece", theme: "modern", settings: { rate: -15, pitch: -5, volume: -20, playbackRate: 1, highlightMode: "word", highlightColor: "#91b9ff", highlightOpacity: 25, glowIntensity: 10, autoFollow: true, scrollBehavior: "smooth", paragraphDelay: 700 } },
  ];
  let baseSettings = normalize();
  let settings = baseSettings;
  let contextUrl = ''; let siteSignature = '';let contextSpeech=null;
  const speechKeys=['voice','rate','pitch','volume','autoVoice','turkishVoice','englishVoice','pronunciationRules'];
  const recordedSpeech=()=>contextSpeech||(globalThis.SesliOkuDocument?.book?.kind==='audio'?globalThis.SesliOkuDocument.book.settings:null);
  function forPage(base, url = contextUrl) { const rule=globalThis.SesliOkuLibrary?.current().sites?.[globalThis.SesliOkuLibrary.siteOrigin(url)];const value=normalize({...base,...rule?.settings});const recorded=recordedSpeech();if(recorded)for(const key of speechKeys)value[key]=recorded[key]??defaults[key];return value; }
  function setContext(url, speech = null) {
    contextSpeech=speech;contextUrl = url || ''; settings = forPage(baseSettings);
    const origin=globalThis.SesliOkuLibrary?.siteOrigin(contextUrl); const rule=globalThis.SesliOkuLibrary?.current().sites?.[origin];
    globalThis.SesliOkuThemes?.setSite(origin,rule); notify();
  }
  let profiles = [];
  let timer = null;
  const revisions = { settings: 0, profiles: 0, timer: 0 };
  let writes = Promise.resolve();
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(settings, profiles, timer); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) { revisions.settings++; baseSettings = normalize(changes.settings.newValue); settings = forPage(baseSettings); }
    if (changes.readingProfiles) { revisions.profiles++; profiles = cleanProfiles(changes.readingProfiles.newValue); }
    if (changes.readingTimer) { revisions.timer++; timer = changes.readingTimer.newValue || null; }
    if (changes.settings || changes.readingProfiles || changes.readingTimer) notify();
  });
  function cleanProfiles(values) {
    return Array.isArray(values) ? values.filter(p => p && typeof p.id === "string" && typeof p.name === "string")
      .slice(0, 20).map(p => ({ id: p.id, name: p.name.slice(0, 40), settings: normalize(p.settings), theme: p.theme, colorMode: ["light", "dark"].includes(p.colorMode) ? p.colorMode : "original" })) : [];
  }
  const ready = chrome.storage.local.get(["settings", "readingProfiles", "readingTimer"]).then(stored => {
    if (!revisions.settings) { baseSettings = normalize(stored.settings); settings = forPage(baseSettings); }
    if (!revisions.profiles) profiles = cleanProfiles(stored.readingProfiles);
    if (!revisions.timer) timer = stored.readingTimer || null;
    notify();
    return settings;
  });
  function enqueue(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }
  function update(patch) {
    return enqueue(async () => {
      const origin=globalThis.SesliOkuLibrary?.siteOrigin(contextUrl);
      if (globalThis.SesliOkuLibrary?.current().sites?.[origin]) {
        const next=normalize({...settings,...patch});await globalThis.SesliOkuLibrary.mutate({type:'sitePatch',origin,patch:{settings:next}});settings=next;notify();return next;
      }
      const stored = await chrome.storage.local.get("settings");
      const next = normalize({ ...stored.settings, ...patch });
      await chrome.storage.local.set({ settings: next });
      baseSettings = next; settings = forPage(next);
      notify();
      return next;
    });
  }
  async function saveProfile(name) {
    const label = String(name || "").trim().slice(0, 40);
    if (!label) throw new Error("Profil için bir ad yazın.");
    return enqueue(async () => {
      const stored = await chrome.storage.local.get(["settings", "readingProfiles", "appearanceTheme", "appearanceMode"]);
      const list = cleanProfiles(stored.readingProfiles);
      const existing = list.find(p => p.name === label);
      const profile = { id: existing?.id || `saved-${crypto.randomUUID()}`, name: label, settings: normalize(settings), theme: globalThis.SesliOkuThemes?.current() || stored.appearanceTheme || "modern", colorMode: globalThis.SesliOkuThemes?.mode() || stored.appearanceMode || "original" };
      const next = [...list.filter(p => p.id !== profile.id), profile];
      if (next.length > 20) throw new Error("En fazla 20 profil kaydedebilirsiniz.");
      await chrome.storage.local.set({ readingProfiles: next });
      profiles = next; notify(); return profile;
    });
  }
  async function removeProfile(id) {
    return enqueue(async () => {
      const stored = await chrome.storage.local.get("readingProfiles");
      profiles = cleanProfiles(stored.readingProfiles).filter(p => p.id !== id);
      await chrome.storage.local.set({ readingProfiles: profiles }); notify();
    });
  }
  async function applyProfile(id) {
    const stored = await chrome.storage.local.get("readingProfiles");
    const profile = [...presets, ...cleanProfiles(stored.readingProfiles)].find(p => p.id === id);
    if (!profile) throw new Error("Profil bulunamadı.");
    await update(profile.settings);
    if (profile.theme) await globalThis.SesliOkuThemes.set(profile.theme);
    await globalThis.SesliOkuThemes.setMode(profile.colorMode);
  }
  // Native <select> popups use browser/OS scrollbars outside our style tree.
  // Keep each select as the data model and draw an accessible top-layer list.
  let activeDropdown = null;
  function closeDropdowns() { activeDropdown?.close(); }
  function enhanceSelect(select) {
    const wrapper = document.createElement("div"); wrapper.className = "pref-select-wrap";
    const trigger = document.createElement("button"); trigger.type = "button";
    trigger.className = "pref-select-trigger"; trigger.id = `${select.id}-trigger`;
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false"); trigger.dataset.selectFor = select.id;
    const list = document.createElement("div"); list.className = "pref-select-popup";
    list.id = `${select.id}-listbox`; list.setAttribute("popover", "auto"); list.setAttribute("role", "listbox");
    trigger.setAttribute("aria-controls", list.id);
    const labels = [...select.labels];
    const label = select.getAttribute("aria-label") || labels.map(node => [...node.childNodes]
      .filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(" ").trim()).join(" ") || "Seçim";
    list.setAttribute("aria-label", label);
    select.before(wrapper); wrapper.append(select, trigger, list);
    const originalTabIndex = select.getAttribute("tabindex");
    select.tabIndex = -1; select.setAttribute("aria-hidden", "true"); select.classList.add("pref-native-select");
    let open = false;
    let activeIndex = -1;
    let buffer = "";
    let lastTyped = 0;
    let rows = new Map();
    let opening = null;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    function finishOpening() { const animation=opening;opening=null;animation?.cancel(); }
    function animateOpening() {
      finishOpening();
      if(motion.matches||typeof list.animate!=='function')return;
      const style=getComputedStyle(list);
      const effect=style.getPropertyValue('--drop-open-effect').trim();
      const duration=parseFloat(style.getPropertyValue('--drop-open-duration'));
      if(effect==='none'||!Number.isFinite(duration)||duration<=0)return;
      const initial=list.dataset.openSide==='above'?'inset(100% 0 0 0)':'inset(0 0 100% 0)';
      const frames=effect==='slide'?[{clipPath:initial},{clipPath:'inset(0 0 0 0)'}]:
        effect==='fade'?[{opacity:0,transform:`translateY(${list.dataset.openSide==='above'?3:-3}px)`},{opacity:1,transform:'none'}]:null;
      if(!frames)return;
      const easing=style.getPropertyValue('--drop-open-easing').trim()||'linear';
      const animation=list.animate(frames,{duration,easing});
      opening=animation;
      animation.finished.then(()=>{if(opening===animation)finishOpening();},()=>{});
    }
    const onMotionChange=event=>{if(event.matches)finishOpening();};
    motion.addEventListener('change',onMotionChange);
    const enabled = () => [...select.options].map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled && !option.hidden && !option.closest("optgroup")?.disabled && !option.closest("optgroup")?.hidden);
    function close(restoreFocus = false) {
      finishOpening();
      if (list.matches(":popover-open")) list.hidePopover();
      open = false; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
      if (activeDropdown === controller) activeDropdown = null;
      if (restoreFocus && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    function highlight(index, scroll = true) {
      if (!rows.has(index) || rows.get(index).getAttribute("aria-disabled") === "true") return;
      activeIndex = index;
      for (const [key, row] of rows) { row.classList.toggle("active", key === index); row.setAttribute("aria-selected", String(key === index)); }
      trigger.setAttribute("aria-activedescendant", rows.get(index).id);
      if (scroll) rows.get(index).scrollIntoView({ block: "nearest", behavior: "instant" });
    }
    function render() {
      rows = new Map();
      const optionIndexes = new Map([...select.options].map((option, index) => [option, index]));
      function optionRow(option, parent, grouped) {
        if (option.hidden) return;
        const index = optionIndexes.get(option);
        const row = document.createElement("div"); row.className = "pref-select-option";
        if (grouped) row.classList.add("grouped");
        row.id = `${list.id}-option-${index}`; row.dataset.optionIndex = String(index);
        row.setAttribute("role", "option"); row.textContent = option.label; row.title = option.label;
        row.setAttribute("aria-disabled", String(option.disabled || !!option.closest("optgroup")?.disabled));
        rows.set(index, row); parent.appendChild(row);
      }
      const fragment = document.createDocumentFragment();
      for (const child of select.children) {
        if (child.tagName === "OPTGROUP") {
          if (child.hidden) continue;
          const group = document.createElement("div"); group.setAttribute("role", "group"); group.setAttribute("aria-label", child.label);
          const heading = document.createElement("div"); heading.className = "pref-select-group";
          heading.setAttribute("aria-hidden", "true"); heading.textContent = child.label; group.appendChild(heading);
          for (const option of child.children) if (option.tagName === "OPTION") optionRow(option, group, true);
          fragment.appendChild(group);
        } else if (child.tagName === "OPTION") optionRow(child, fragment, false);
      }
      list.replaceChildren(fragment);
      const selected = enabled().some(item => item.index === select.selectedIndex) ? select.selectedIndex : enabled()[0]?.index;
      if (selected !== undefined) highlight(selected, false);
    }
    function position() {
      if(open)finishOpening();
      const rect = select.getBoundingClientRect();
      const context = document.createElement("canvas").getContext("2d");
      if (context) context.font = getComputedStyle(select).font;
      const textWidth = Math.max(0, ...[...select.options].map(option => context?.measureText(option.label).width || 0));
      const width = Math.min(window.innerWidth - 16, Math.max(rect.width, Math.min(520, textWidth + 44)));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const useBelow = below >= 140 || below >= above;
      list.dataset.openSide=useBelow?'below':'above';
      const maxHeight = Math.max(24, Math.min(300, useBelow ? below : above));
      list.style.width = `${width}px`; list.style.maxHeight = `${maxHeight}px`;
      list.style.left = `${left}px`; list.style.top = `${rect.bottom}px`;
      const height = list.getBoundingClientRect().height;
      list.style.top = `${Math.max(4, Math.min(window.innerHeight - height - 4, useBelow ? rect.bottom : rect.top - height))}px`;
    }
    function show() {
      if (trigger.disabled || !select.getClientRects().length) return;
      if (activeDropdown !== controller) closeDropdowns();
      buffer = ""; lastTyped = 0;
      render(); list.showPopover(); position(); open = true; activeDropdown = controller;
      trigger.setAttribute("aria-expanded", "true"); trigger.focus({ preventScroll: true });
      highlight(activeIndex);
      animateOpening();
    }
    function commit(index = activeIndex, restoreFocus = true) {
      if (!enabled().some(item => item.index === index)) { close(restoreFocus); return; }
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      close(restoreFocus); sync();
      if (changed) { select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    function sync() {
      const text = select.selectedOptions[0]?.label || "";
      trigger.setAttribute("aria-label", `${label}: ${text}`); trigger.textContent = text;
      trigger.disabled = select.disabled || !enabled().length;
      if (trigger.disabled) close();
      else if (open) { render(); position(); highlight(activeIndex); }
    }
    trigger.addEventListener("click", () => open ? close() : show());
    trigger.addEventListener("keydown", event => {
      const key = event.key;
      if (key === "Tab") { if (open) commit(activeIndex, false); return; }
      if (key === "Escape") { if (open) { event.preventDefault(); close(true); } return; }
      if (["Enter", " ", "F4"].includes(key) || (event.altKey && ["ArrowDown", "ArrowUp"].includes(key))) {
        event.preventDefault(); open ? commit() : show(); return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(key)) {
        event.preventDefault();
        const wasOpen = open; if (!open) show();
        const choices = enabled(); let current = choices.findIndex(item => item.index === activeIndex);
        if (key === "Home") current = 0;
        else if (key === "End") current = choices.length - 1;
        else if (wasOpen) current = Math.max(0, Math.min(choices.length - 1, current + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : key === "PageDown" ? 10 : -10)));
        if (choices[current]) highlight(choices[current].index); return;
      }
      if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const now = performance.now(); buffer = now - lastTyped > 700 ? key : buffer + key; lastTyped = now;
        const normalizeText = value => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
        const query = normalizeText([...buffer].every(char => char === buffer[0]) ? key : buffer);
        const choices = enabled(); const start = choices.findIndex(item => item.index === (open ? activeIndex : select.selectedIndex));
        for (let offset = query.length > 1 ? 0 : 1; offset <= choices.length; offset++) {
          const item = choices[(Math.max(0, start) + offset) % choices.length];
          if (item && normalizeText(item.option.label).startsWith(query)) { if (open) highlight(item.index); else commit(item.index, false); break; }
        }
      }
    });
    list.addEventListener("pointermove", event => {
      const row = event.target.closest("[data-option-index]"); if (row) highlight(Number(row.dataset.optionIndex), false);
    });
    list.addEventListener("pointerdown", event => { if (event.target.closest("[data-option-index]")) event.preventDefault(); });
    list.addEventListener("click", event => {
      // Profile selects are nested in a label. Prevent label activation from
      // reopening the list after an option has already been committed.
      event.preventDefault();
      const row = event.target.closest("[data-option-index]"); if (row && row.getAttribute("aria-disabled") !== "true") commit(Number(row.dataset.optionIndex));
    });
    list.addEventListener('beforetoggle',event=>{if(event.newState==='closed')finishOpening();});
    list.addEventListener("toggle", () => {
      if (!list.matches(":popover-open")) { open = false; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant"); if (activeDropdown === controller) activeDropdown = null; }
    });
    const onNativeFocus = () => trigger.focus({ preventScroll: true });
    const onNativeClick = event => { event.preventDefault(); show(); };
    select.addEventListener("focus", onNativeFocus); select.addEventListener("click", onNativeClick); select.addEventListener("change", sync);
    const onLabelClick = event => { if (!wrapper.contains(event.target)) { event.preventDefault(); trigger.focus({ preventScroll: true }); } };
    for (const label of labels) label.addEventListener("click", onLabelClick);
    const onScroll = event => { if (open && event.target !== list && !list.contains(event.target)) close(); };
    const onResize = () => { if (open) close(); };
    document.addEventListener("scroll", onScroll, true); window.addEventListener("resize", onResize);
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "label", "hidden"] });
    const controller = { sync, close, dispose() {
      close(); motion.removeEventListener('change',onMotionChange);observer.disconnect(); document.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onResize);
      select.removeEventListener("focus", onNativeFocus); select.removeEventListener("click", onNativeClick); select.removeEventListener("change", sync);
      for (const label of labels) label.removeEventListener("click", onLabelClick);
      select.removeAttribute("aria-hidden"); select.classList.remove("pref-native-select");
      if (originalTabIndex === null) select.removeAttribute("tabindex"); else select.setAttribute("tabindex", originalTabIndex);
      wrapper.replaceWith(select);
    } };
    sync(); return controller;
  }

  const css = `
    @layer base, themes, preferences;
    @layer preferences {
      .settings.open { display: block; }
      .preferences { font: inherit; color: inherit; min-width: 0; }
      .pref-profile-box { margin-bottom: 10px; font-size: 11px; }
      .pref-profile-box > summary { cursor: pointer; margin-bottom: 7px; }
      .pref-profiles { display: flex; align-items: end; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
      .pref-profiles > label { flex: 1; min-width: 100px; font-size: 11px; }
      .pref-profiles select { margin-top: 4px; }
      .preferences .pref-button, .preferences .pref-tab {
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; width: auto; min-height: 26px; height: auto; padding: 5px 10px;
        font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer;
        color: inherit; border: 1px solid var(--border, #56604a); border-radius: var(--theme-radius, 5px);
        background: var(--theme-button, #ffffff12); box-shadow: var(--theme-raised, none);
      }
      .preferences button:disabled { opacity: .45; cursor: default; }
      .pref-editor { margin-bottom: 12px; font-size: 11px; }
      .pref-editor summary { cursor: pointer; }
      .pref-save { display: flex; gap: 6px; margin-top: 7px; }
      .preferences input[type="text"] {
        min-width: 0; flex: 1; box-sizing: border-box; padding: 5px 7px; border: 1px solid var(--border, #56604a);
        background: var(--panel, #242a24); color: inherit; border-radius: var(--theme-radius, 3px); font: inherit;
        user-select: text; -webkit-user-select: text;
      }
      .library-panel { box-sizing: border-box; padding: 12px; border: 1px solid var(--border, #56604a); background: var(--panel, transparent); }
      .pref-tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--border, #56604a); margin-bottom: 12px; }
      .preferences .pref-tab { border-radius: var(--theme-radius, 5px) var(--theme-radius, 5px) 0 0; }
      .preferences .pref-tab[aria-selected="true"] { font-weight: 700; border-bottom-color: transparent; background: var(--panel, #ffffff1c); }
      .pref-pane { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 14px 20px; }
      .preferences [hidden] { display: none !important; }
      .preferences .field { min-width: 0; margin: 0; }
      .preferences .field > label { display: block; margin-bottom: 5px; font-size: 11px; }
      .preferences .label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; gap: 6px; }
      .preferences .label-row label { margin: 0; }
      .preferences output { font-size: 11px; white-space: nowrap; }
      .preferences select { width: 100%; box-sizing: border-box; margin: 0; }
      .preferences select:focus, .preferences select:focus-visible {
        outline: none;
        outline-offset: 0;
      }
      .preferences .pref-check { display: flex; align-items: center; gap: 7px; font-size: 11px; }
      .preferences .field > label.pref-check { display: flex; margin-top: 6px; }
      .preferences input[type="checkbox"] { width: 13px; height: 13px; flex: none; margin: 0; accent-color: var(--accent, #d9f27a); }
      .preferences .pref-select-wrap { position: relative; display: block; width: 100%; min-width: 0; }
      .preferences select.pref-native-select { display: block; pointer-events: none; }
      .preferences select.pref-native-select:disabled { opacity: .55; }
      .preferences button.pref-select-trigger {
        all: unset; position: absolute; inset: 0; display: block; box-sizing: border-box;
        width: 100%; height: 100%; min-height: 0; opacity: 0; cursor: default; outline: none;
      }
      .preferences .pref-select-popup {
        --drop-open-effect: none; --drop-open-duration: 0ms; --drop-open-easing: linear;
        --drop-track: #e4e7df; --drop-thumb: #7b8970;
        --drop-button: #d6ddcc; --drop-shadow: inset 0 0 0 1px #9aa38f;
        position: fixed; inset: auto; margin: 0; padding: 2px;
        box-sizing: border-box; min-width: 0; max-width: calc(100vw - 16px);
        overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
        border: 1px solid var(--border, #56604a); border-radius: var(--theme-radius, 5px);
        color: var(--text, #f7f7f5); background: var(--panel, #242a24);
        font-family: var(--theme-font, system-ui); font-size: 12px; line-height: 20px;
        text-align: left; user-select: none; -webkit-user-select: none;
        box-shadow: 0 3px 8px #0004; cursor: default; color-scheme: light;
      }
      .preferences .pref-select-popup::backdrop { background: transparent; }
      /* Each historical skin has an explicit policy; source notes and the
         distinction between documented effects and chosen timings live in
         docs/dropdown-motion.md. XP and 7 both document slide-open, not fade. */
      [data-theme="modern"] .preferences .pref-select-popup {
        --drop-open-effect: fade; --drop-open-duration: 120ms; --drop-open-easing: cubic-bezier(.2, 0, .2, 1);
      }
      [data-theme="win95"] .preferences .pref-select-popup {
        --drop-open-effect: none; --drop-open-duration: 0ms; --drop-open-easing: linear;
      }
      [data-theme="win98"] .preferences .pref-select-popup {
        --drop-open-effect: slide; --drop-open-duration: 200ms; --drop-open-easing: linear;
      }
      [data-theme="xp"] .preferences .pref-select-popup {
        --drop-open-effect: slide; --drop-open-duration: 200ms; --drop-open-easing: linear;
      }
      [data-theme="win7"] .preferences .pref-select-popup {
        --drop-open-effect: slide; --drop-open-duration: 200ms; --drop-open-easing: linear;
      }
      @media (prefers-reduced-motion: reduce) { [data-theme] .preferences .pref-select-popup { --drop-open-duration: 0ms; } }
      .preferences .pref-select-option { box-sizing: border-box; min-height: 22px; padding: 1px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .preferences .pref-select-option.grouped { padding-left: 18px; }
      .preferences .pref-select-group { font-weight: 700; padding: 3px 5px 0; color: var(--muted, #b9bdb6); white-space: nowrap; }
      .preferences .pref-select-option.active { background: var(--accent, #d9f27a); color: var(--accent-text, #14180f); }
      .preferences .pref-select-option[aria-disabled="true"] { color: #808080; }
      .focus-text {
        --drop-track: var(--bg, #242a24); --drop-thumb: var(--muted, #7b8970);
        --drop-button: var(--theme-button, var(--bg, #30372c)); --drop-shadow: var(--theme-raised, inset 0 0 0 1px #9aa38f);
      }
      :is([data-theme="win95"], [data-theme="win98"]) :is(.preferences .pref-select-popup, .focus-text) {
        --drop-track: repeating-conic-gradient(#fff 0 25%, #c0c0c0 0 50%) 0 / 2px 2px;
        --drop-thumb: #c0c0c0; --drop-button: #c0c0c0;
        --drop-shadow: var(--theme-raised);
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences .pref-select-popup {
        border-radius: 0; border-color: #000;
        font-size: 11px; line-height: 16px; padding: 1px; box-shadow: 1px 1px #808080;
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences .pref-select-option { min-height: 18px; }
      [data-theme="xp"] :is(.preferences .pref-select-popup, .focus-text) {
        --drop-track: linear-gradient(90deg, #f3f1e8, #fff);
        --drop-thumb: linear-gradient(90deg, #c8d8fa, #b7cbf0);
        --drop-button: #c5d5f5; --drop-shadow: inset 0 0 0 1px #fff, inset 0 0 0 2px #95ade4;
      }
      [data-theme="xp"] .preferences .pref-select-popup {
        border-color: #7f9db9; border-radius: 0; font-size: 11px;
      }
      [data-theme="win7"] :is(.preferences .pref-select-popup, .focus-text) {
        --drop-track: linear-gradient(90deg, #e5e5e5, #f2f2f2);
        --drop-thumb: linear-gradient(90deg, #f5f5f5, #d4d4d4);
        --drop-button: #ededed; --drop-shadow: inset 0 0 0 1px #fff, inset 0 0 0 2px #aaa;
      }
      [data-theme="win7"] .preferences .pref-select-popup {
        border-color: #828790; border-radius: 0;
      }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar { width: 17px; height: 17px; }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-track { background: var(--drop-track); }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-thumb { min-height: 24px; background: var(--drop-thumb); box-shadow: var(--drop-shadow); }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button {
        display: block; height: 17px; width: 17px; background-color: var(--drop-button);
        box-shadow: var(--drop-shadow); background-position: center; background-repeat: no-repeat;
      }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button:vertical:decrement {
        background-image: var(--scroll-up, url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='4'%3E%3Cpath d='M3 0h1v1h1v1h1v1h1v1H0V3h1V2h1V1h1z' fill='%23334150'/%3E%3C/svg%3E"));
      }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button:vertical:increment {
        background-image: var(--scroll-down, url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='4'%3E%3Cpath d='M0 0h7v1H6v1H5v1H4v1H3V3H2V2H1V1H0z' fill='%23334150'/%3E%3C/svg%3E"));
      }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button:vertical:start:increment,
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button:vertical:end:decrement { display: none; }
      [data-theme="xp"] :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-thumb:hover { background: linear-gradient(90deg, #d5e2fb, #a9c3f0); }
      [data-theme="win7"] :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-thumb:hover { background: linear-gradient(90deg, #d9f1fc, #9fd1ef); }
      :is(.preferences .pref-select-popup, .focus-text)::-webkit-scrollbar-button:active { box-shadow: var(--theme-pressed, inset 0 0 2px #0005); }
      @media (forced-colors: active) {
        .preferences .pref-select-popup { background: Canvas; color: CanvasText; border-color: CanvasText; }
        .preferences .pref-select-option.active { background: Highlight; color: HighlightText; }
      }
      /* Paint the semantic checkbox itself, so nested .pref-check labels work
         identically in the popup and the player's shadow root. */
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"] {
        appearance: none; -webkit-appearance: none; position: relative;
        display: inline-block; box-sizing: border-box; width: 13px; height: 13px;
        min-width: 13px; padding: 0; border: 0; border-radius: 0;
        background: #fff; box-shadow: var(--theme-field); cursor: default;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]::after {
        content: none; position: absolute; pointer-events: none;
        background-repeat: no-repeat; background-size: 100% 100%;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]:checked::after {
        content: ""; left: 3px; top: 3px; width: 7px; height: 7px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='7' viewBox='0 0 7 7' shape-rendering='crispEdges'%3E%3Cpath d='M7 0H6v1H5v1H4v1H3v1H2V3H1V2H0v3h1v1h1v1h1V6h1V5h1V4h1V3h1V0z'/%3E%3C/svg%3E");
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences input[type="checkbox"]:active:not(:disabled) { background: #c0c0c0; }
      [data-theme="xp"] .preferences input[type="checkbox"] {
        border: 1px solid #1d5281; border-radius: 0; box-shadow: none;
        background: linear-gradient(135deg, #dcdcd7, #fff);
      }
      [data-theme="xp"] .preferences input[type="checkbox"]:checked::after {
        left: 0; top: 0; width: 11px; height: 11px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 11 11' shape-rendering='crispEdges'%3E%3Cpath d='M2 5 4 7 9 2' fill='none' stroke='%2322a122' stroke-width='2'/%3E%3C/svg%3E");
      }
      [data-theme="xp"] .preferences .pref-check:hover input[type="checkbox"]:not(:disabled):not(:active) {
        box-shadow: inset -2px -2px #f8b636, inset 2px 2px #fedf9c;
      }
      [data-theme="xp"] .preferences input[type="checkbox"]:active:not(:disabled) {
        background: linear-gradient(135deg, #b0b0a7, #e3e1d2);
      }
      [data-theme="win7"] .preferences input[type="checkbox"] {
        background: #f6f6f6; border: 1px solid #8e8f8f; border-radius: 0;
        box-shadow: inset 0 0 0 1px #f4f4f4, inset 1px 1px 0 1px #aeaeae,
          inset -1px -1px 0 1px #ddd, inset 3px 3px 6px #ccc;
      }
      [data-theme="win7"] .preferences input[type="checkbox"]:checked::after {
        left: 0; top: 0; width: 11px; height: 11px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 11 11'%3E%3Cpath d='m2 5.5 2.5 2.5L9 2.5' fill='none' stroke='%234a5f97' stroke-width='1.8'/%3E%3C/svg%3E");
      }
      [data-theme="win7"] .preferences .pref-check:hover input[type="checkbox"]:not(:disabled) {
        background: #e9f7fe; border-color: #3c7fb1;
        box-shadow: inset 0 0 0 1px #def9fa, inset 1px 1px 0 1px #79c6f9,
          inset -1px -1px 0 1px #c6e9fc, inset 3px 3px 6px #b1dffd;
      }
      [data-theme="win7"] .preferences input[type="checkbox"]:active:not(:disabled) { background: #cce4f5; }
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]:disabled {
        background: var(--bg); border-color: #b1b1b1; cursor: default;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]:disabled::after { filter: grayscale(1); opacity: .55; }
      [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]:focus-visible { outline: none; }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-check:has(input:focus-visible) > span {
        outline: 1px dotted var(--text); outline-offset: 1px;
      }
      @media (forced-colors: active) {
        [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"] {
          appearance: auto; -webkit-appearance: auto; box-shadow: none;
        }
        [data-theme]:where(:not([data-theme="modern"])) .preferences input[type="checkbox"]:checked::after { content: none; }
      }
      .preferences input[type="color"] { width: 100%; height: 26px; padding: 1px; border: 1px solid var(--border, #56604a); background: transparent; }
      .preferences input[type="number"] { width: 65px; box-sizing: border-box; padding: 4px; font: inherit; color: inherit; background: var(--panel, #242a24); border: 1px solid var(--border, #56604a); }
      .pref-timer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .pref-timer-status { font-size: 11px; margin-top: 6px; }
      .pref-feedback { min-height: 15px; font-size: 11px; margin-top: 8px; }
      .sleep-status { font-size: 10px; white-space: nowrap; }
      body .pref-pane { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      body .pref-pane .pref-wide { grid-column: 1 / -1; }
      body .pref-tabs { margin-bottom: 12px; }
      body .preferences { max-height: 360px; overflow-y: auto; padding: 1px 3px 1px 1px; }
      /* Native property-sheet tabs share a surface with their content page.
         Keep these separate from the push-button chrome used by actions. */
      [data-theme]:where(:not([data-theme="modern"])) .preferences {
        --pref-page: #fff;
        --pref-tab: linear-gradient(#f2f2f2, #dfdfdf);
        --pref-tab-border: #898c95;
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences {
        --pref-page: #c0c0c0; --pref-tab: #c0c0c0; --pref-tab-border: #808080;
      }
      [data-theme="xp"] .preferences {
        --pref-page: #fcfcfe; --pref-tab: linear-gradient(#faf9f6, #e9e6d7);
        --pref-tab-border: #919b9c;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tabs {
        position: relative; z-index: 1; align-items: flex-end;
        gap: 0; min-height: 28px; padding-left: 4px; margin-bottom: 0; border: 0;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab {
        position: relative; box-sizing: border-box; height: 24px; min-height: 24px;
        padding: 3px 10px; margin: 0 0 -1px; border: 1px solid var(--pref-tab-border);
        border-radius: 3px 3px 0 0; background: var(--pref-tab); color: var(--text);
        font-weight: 400; line-height: 1.3; box-shadow: none; cursor: default;
        transform: none;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab + .pref-tab { margin-left: -1px; }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab:active { box-shadow: none; transform: none; }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab[aria-selected="true"] {
        z-index: 2; height: 27px; min-height: 27px; margin-left: -2px; margin-right: -2px;
        padding: 4px 12px 5px; background: var(--pref-page);
        border-bottom-color: var(--pref-page); font-weight: 400;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab[aria-selected="true"]::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 3px;
        background: var(--pref-page); pointer-events: none;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences :is(.pref-pane, .library-panel) {
        position: relative; z-index: 0; box-sizing: border-box; min-width: 0;
        padding: 14px 12px; border: 1px solid var(--pref-tab-border);
        background: var(--pref-page);
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences .pref-tab {
        border-top-color: #fff; border-left-color: #fff; border-right-color: #404040;
        border-radius: 2px 2px 0 0;
        box-shadow: inset 1px 1px #dfdfdf, inset -1px 0 #808080;
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences .pref-tab[aria-selected="true"] {
        box-shadow: inset 1px 1px #dfdfdf, inset -1px 0 #808080;
      }
      :is([data-theme="win95"], [data-theme="win98"]) .preferences :is(.pref-pane, .library-panel) {
        border: 0; box-shadow: var(--theme-window);
      }
      [data-theme="xp"] .preferences .pref-tab[aria-selected="true"] {
        border-top-color: #e68b2c; box-shadow: inset 0 2px #ffc73c;
      }
      [data-theme="xp"] .preferences .pref-tab:not([aria-selected="true"]):hover {
        border-top-color: #e68b2c; box-shadow: inset 0 2px #ffc73c;
      }
      [data-theme="win7"] .preferences .pref-tab:not([aria-selected="true"]):hover {
        background: linear-gradient(#eaf6fd, #d2eaf6); border-color: #7eb4ea;
      }
      [data-theme]:where(:not([data-theme="modern"])) .preferences .pref-tab:focus-visible {
        outline: 1px dotted var(--text); outline-offset: -5px;
      }
      @media (max-width: 1100px) { .wrap .pref-pane { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      @media (max-width: 640px) { .wrap .pref-pane { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 420px) { .wrap .pref-pane { grid-template-columns: 1fr; } }
    }
  `;
  function mount(container, { prefix = "", onTimer = async () => {}, onLayout = () => {} } = {}) {
    const id = key => `${prefix}${key}`;
    const select = (key, label, options) => `<div class="field"><label for="${id(key)}">${label}</label><select id="${id(key)}" data-setting="${key}">${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}</select></div>`;
    const range = (key, label, min, max, step) => `<div class="field"><div class="label-row"><label for="${id(key)}">${label}</label><output id="${id(key)}-value"></output></div><input id="${id(key)}" data-setting="${key}" type="range" min="${min}" max="${max}" step="${step}"></div>`;
    const check = (key, label) => `<label class="pref-check"><input id="${id(key)}" data-setting="${key}" type="checkbox"><span>${label}</span></label>`;
    container.innerHTML = `<div class="preferences">
      <details class="pref-profile-box"><summary>Profiller</summary><div class="pref-profiles"><label for="${id("profile")}">Hazır / kayıtlı profil<select id="${id("profile")}"></select></label><button type="button" class="pref-button" data-profile="apply">Uygula</button><button type="button" class="pref-button" data-profile="delete">Sil</button></div>
      <details class="pref-editor"><summary>Bu ayarları profil olarak kaydet</summary><div class="pref-save"><input id="${id("profile-name")}" type="text" maxlength="40" placeholder="Profil adı" aria-label="Profil adı"><button type="button" class="pref-button" data-profile="save">Kaydet</button></div></details></details>
      <div class="pref-tabs" role="tablist" aria-label="Ayar grupları">${[["reading", "Okuma"], ["appearance", "Görünüm"], ["behavior", "Davranış"], ["library", "Kitaplık"]].map(([key, text], index) => `<button type="button" class="pref-tab" role="tab" id="${id(`tab-${key}`)}" data-tab="${key}" aria-controls="${id(`pane-${key}`)}" aria-selected="${!index}" tabindex="${index ? -1 : 0}">${text}</button>`).join("")}</div>
      <section class="pref-pane" role="tabpanel" id="${id("pane-reading")}" aria-labelledby="${id("tab-reading")}">
        ${select("voice", "Ses", [[defaults.voice, "Emel · Türkçe"]])}
        ${range("rate", "Okuma hızı", -50, 100, 5)}${range("pitch", "Ses perdesi", -50, 50, 5)}${range("volume", "Ses düzeyi", -50, 50, 5)}
        ${select("playbackRate", "Oynatma hızı", [[.5, "0.5×"], [.75, "0.75×"], [1, "1.0×"], [1.25, "1.25×"], [1.5, "1.5×"], [1.75, "1.75×"], [2, "2.0×"]])}
        ${check("continueSelection", "Seçimden sonra devam et")}
        ${check("autoVoice", "Dile göre otomatik ses seç")}
        ${select("turkishVoice", "Otomatik · Türkçe sesi", [[defaults.turkishVoice, "Emel · Türkçe"]])}
        ${select("englishVoice", "Otomatik · İngilizce sesi", [[defaults.englishVoice, "Ava · İngilizce"]])}
      </section>
      <section class="pref-pane" role="tabpanel" id="${id("pane-appearance")}" aria-labelledby="${id("tab-appearance")}" hidden>
        ${select("theme", "Görünüm · Tema", [])}
        ${select("colorMode", "Açık / koyu görünüm", [["original", "Özgün görünüm"], ["light", "Açık"], ["dark", "Koyu"]])}
        ${select("highlightMode", "Vurgu biçimi", [["both", "Kelime ve paragraf"], ["word", "Yalnızca kelime"], ["paragraph", "Yalnızca paragraf"], ["off", "Kapalı"]])}
        <div class="field"><label for="${id("highlightColor")}">Özel vurgu rengi</label><input id="${id("highlightColor")}" data-setting="highlightColor" type="color"><label class="pref-check"><input id="${id("theme-color")}" type="checkbox"><span>Tema rengini kullan</span></label></div>
        ${range("highlightOpacity", "Vurgu yoğunluğu", 0, 100, 5)}${range("glowIntensity", "Işık halkası yoğunluğu", 0, 100, 5)}
        ${range("focusFontSize", "Odak görünümü · Yazı boyutu", 16, 36, 1)}
        ${select("focusFont", "Odak · Yazı tipi", [["serif", "Serif"], ["sans", "Sans serif"], ["mono", "Eş aralıklı"]])}
        ${range("focusLineHeight", "Odak · Satır aralığı", 1.2, 2.6, .1)}
        ${range("focusWidth", "Odak · Metin genişliği", 400, 1200, 40)}${range("focusPadding", "Odak · Kenar boşluğu", 8, 60, 2)}
        ${select("focusBackground", "Odak görünümü · Arka plan", [["theme", "Temaya göre"], ["paper", "Kâğıt"], ["dark", "Koyu"]])}
      </section>
      <section class="pref-pane" role="tabpanel" id="${id("pane-behavior")}" aria-labelledby="${id("tab-behavior")}" hidden>
        ${check("autoFollow", "Okunan metni otomatik takip et")}
        ${check("rememberPosition", "Okuma konumumu yerel olarak hatırla")}
        ${select("scrollBehavior", "Kaydırma", [["smooth", "Yumuşak"], ["instant", "Anında"]])}
        ${range("paragraphDelay", "Paragraflar arası bekleme", 0, 3000, 100)}
        <div class="field pref-wide"><label for="${id("sleep-mode")}">Uyku zamanlayıcısı</label><div class="pref-timer"><select id="${id("sleep-mode")}"><option value="off">Kapalı</option><option value="paragraph">Bu paragraf bitince</option><option value="10">10 dakika</option><option value="20">20 dakika</option><option value="30">30 dakika</option><option value="60">60 dakika</option><option value="custom">Özel süre</option></select><input id="${id("sleep-minutes")}" type="number" min="1" max="180" value="15" aria-label="Dakika" hidden><button type="button" class="pref-button" data-timer>Uygula</button></div><div class="pref-timer-status" role="status">Zamanlayıcı kapalı</div></div>
      </section>
      <section class="pref-pane" role="tabpanel" id="${id("pane-library")}" aria-labelledby="${id("tab-library")}" hidden><div class="library-mount"></div></section>
      <div class="pref-feedback" role="status"></div>
    </div>`;
    const root = container.querySelector(".preferences");
    const byId = key => root.querySelector(`[id="${id(key)}"]`);
    const dropdowns = [];
    const elements = Object.fromEntries([...Object.keys(defaults), "theme", "colorMode"].map(key => [key, byId(key)]));
    const feedback = (text, error = false) => { root.querySelector(".pref-feedback").textContent = text; root.querySelector(".pref-feedback").style.color = error ? "var(--danger, #ff9d8c)" : ""; };
    const report = operation => Promise.resolve(operation).catch(error => feedback(error.message, true));
    const profileSelect = byId("profile");
    const refreshProfiles = () => {
      const previous = profileSelect.value;
      profileSelect.replaceChildren(...[...presets, ...profiles].map(profile => { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; return option; }));
      if ([...profileSelect.options].some(option => option.value === previous)) profileSelect.value = previous;
      root.querySelector('[data-profile="delete"]').disabled = !profiles.some(p => p.id === profileSelect.value);
    };
    function sync(value) {
      for (const [key, element] of Object.entries(elements)) {
        if (!element || ["theme", "colorMode"].includes(key)) continue;
        if(speechKeys.includes(key))element.disabled=!!recordedSpeech();
        if (element.type === "checkbox") element.checked = value[key];
        else if (["voice", "turkishVoice", "englishVoice"].includes(key)) {
          if (![...element.options].some(option => option.value === value[key])) { const option = document.createElement("option"); option.value = value[key]; option.textContent = value[key]; element.appendChild(option); }
          element.value = value[key];
        } else if (key === "highlightColor") element.value = highlightColorFor(value, globalThis.SesliOkuThemes.current());
        else element.value = String(value[key]);
        const output = byId(`${key}-value`);
        if (output) output.textContent = ["focusFontSize", "focusWidth", "focusPadding"].includes(key) ? `${value[key]} px` : key === "focusLineHeight" ? `${Number(value[key]).toFixed(1)}×` : key === "paragraphDelay" ? `${(value[key] / 1000).toFixed(1)} sn` : key === "pitch" ? `${value[key] > 0 ? "+" : ""}${value[key]} Hz` : `${["rate", "volume"].includes(key) && value[key] > 0 ? "+" : ""}${value[key]}%`;
      }
      byId("theme-color").checked = value.highlightColor === "theme";
      elements.highlightColor.disabled = value.highlightColor === "theme";
      refreshProfiles();
      for (const dropdown of dropdowns) dropdown.sync();
    }
    function syncTimer(value) {
      const text = !value || value.mode === "off" ? "Zamanlayıcı kapalı" : value.mode === "paragraph" ? "Bu paragrafın sonunda duracak" : `Kalan: ${Math.max(0, Math.ceil((value.deadline - Date.now()) / 60000))} dakika`;
      root.querySelector(".pref-timer-status").textContent = text;
    }
    let timerValue = timer;
    const unsubscribe = subscribe((value, list, activeTimer) => { sync(value); timerValue = activeTimer; syncTimer(activeTimer); });
    const timerInterval = setInterval(() => { if (timerValue?.deadline) syncTimer(timerValue); }, 1000);
    root.addEventListener("input", event => {
      const key = event.target.dataset.setting;
      if (event.target.type === "range") {
        const value = { ...settings, [key]: Number(event.target.value) };
        const output = byId(`${key}-value`);
        output.textContent = ["focusFontSize", "focusWidth", "focusPadding"].includes(key) ? `${value[key]} px` : key === "focusLineHeight" ? `${Number(value[key]).toFixed(1)}×` : key === "paragraphDelay" ? `${(value[key] / 1000).toFixed(1)} sn` : key === "pitch" ? `${value[key]} Hz` : `${value[key]}%`;
      }
    });
    root.addEventListener("change", event => {
      const element = event.target;
      const key = element.dataset.setting;
      if (key === "theme") report(globalThis.SesliOkuThemes.set(element.value));
      else if (key === "colorMode") report(globalThis.SesliOkuThemes.setMode(element.value));
      else if (key) report(update({ [key]: element.type === "checkbox" ? element.checked : ["range", "number"].includes(element.type) || key === "playbackRate" ? Number(element.value) : element.value }));
      else if (element === byId("theme-color")) report(update({ highlightColor: element.checked ? "theme" : elements.highlightColor.value }));
      else if (element === byId("sleep-mode")) { byId("sleep-minutes").hidden = element.value !== "custom"; onLayout(); }
      else if (element === profileSelect) refreshProfiles();
    });
    function activateTab(key) {
      closeDropdowns();
      for (const button of root.querySelectorAll("[data-tab]")) {
        const selected = button.dataset.tab === key;
        button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
        byId(`pane-${button.dataset.tab}`).hidden = !selected;
      }
      onLayout();
    }
    root.addEventListener("keydown", event => {
      if (!event.target.matches("[data-tab]") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...root.querySelectorAll("[data-tab]")];
      const index = tabs.indexOf(event.target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      activateTab(tabs[next].dataset.tab); tabs[next].focus();
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.tab) activateTab(button.dataset.tab);
      if (button.hasAttribute("data-timer")) report(Promise.resolve().then(() => onTimer({ mode: byId("sleep-mode").value, minutes: number(byId("sleep-minutes").value, 15, 1, 180) })));
      if (button.dataset.profile === "apply") report(applyProfile(profileSelect.value).then(() => feedback("Profil uygulandı.")));
      if (button.dataset.profile === "save") report(saveProfile(byId("profile-name").value).then(profile => { profileSelect.value = profile.id; refreshProfiles(); feedback("Profil kaydedildi."); }));
      if (button.dataset.profile === "delete") report(removeProfile(profileSelect.value).then(() => feedback("Profil silindi.")));
    });
    for (const details of root.querySelectorAll("details")) details.addEventListener("toggle", onLayout);
    const themeApi = globalThis.SesliOkuThemes;
    themeApi.fillSelect(elements.theme);
    const unsubscribeTheme = themeApi.subscribe(theme => {
      closeDropdowns();
      elements.theme.value = theme;
      elements.colorMode.value = themeApi.mode();
      for (const dropdown of dropdowns) dropdown.sync();
      if (settings.highlightColor === "theme") elements.highlightColor.value = highlightColorFor(settings, theme);
    });
    root.addEventListener('library-group-change',onLayout);
    const libraryUi = globalThis.SesliOkuLibrary.mount(root.querySelector(".library-mount"));
    function renderVoiceChoices(voices) {
      for (const [key, locale] of [["turkishVoice", "tr-"], ["englishVoice", "en-"]]) {
        const select = elements[key]; const previous = settings[key];
        select.replaceChildren(...voices.filter(voice => voice.Locale?.startsWith(locale)).map(voice => {
          const option = document.createElement("option"); option.value = voice.ShortName;
          option.textContent = voice.ShortName.replace(/Neural$/, ""); return option;
        }));
        if (![...select.options].some(option => option.value === previous)) { const option = document.createElement("option"); option.value = previous; option.textContent = previous; select.appendChild(option); }
        select.value = previous;
      }
    }
    for (const select of root.querySelectorAll("select")) dropdowns.push(enhanceSelect(select));
    return { ...elements, closeDropdowns, renderVoiceChoices, rateValue: byId("rate-value"), volumeValue: byId("volume-value"), root, sync, syncTimer, activateTab,
      dispose() { root.removeEventListener('library-group-change',onLayout);unsubscribe(); unsubscribeTheme(); libraryUi.dispose(); clearInterval(timerInterval); for (const dropdown of dropdowns) dropdown.dispose(); } };
  }
  function subscribe(listener) { listeners.add(listener); listener(settings, profiles, timer); return () => listeners.delete(listener); }
  globalThis.SesliOkuLibrary?.subscribe(value=>{const signature=JSON.stringify(value.sites||{});if(signature!==siteSignature){siteSignature=signature;setContext(contextUrl,contextSpeech);}});
  globalThis.SesliOkuSettings = Object.freeze({ forPage, setContext, enhanceSelect, defaults, normalize, ready, update, subscribe, mount, css, highlightColorFor, closeDropdowns,
    current: () => settings, profiles: () => [...presets, ...profiles], saveProfile, removeProfile, applyProfile });
})();
