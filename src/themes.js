/** Shared, locally bundled theme adapters for popup and shadow-DOM controls.
 * Keep application classes stable; only the root's data-theme changes.
 * Classic control borders and the bundled pixel font derive from 98.css
 * (Jordan Scales, MIT; see src/vendor/98.css/LICENSE). No remote assets.
 */
(() => {
  if (globalThis.SesliOkuThemes) return;
  const choices = Object.freeze([
    { id: "modern", label: "Modern" },
    { id: "win95", label: "Windows 95" },
    { id: "win98", label: "Windows 98" },
    { id: "xp", label: "Windows XP" },
    { id: "win7", label: "Windows 7" },
  ]);
  const normalize = value => choices.some(choice => choice.id === value) ? value : "modern";
  let current = "modern";
  let hydrated = false;
  const listeners = new Set();
  const publish = value => {
    current = normalize(value);
    if (current === "win95" || current === "win98") loadClassicFonts();
    for (const listener of listeners) listener(current);
  };
  // Subscribe before reading storage, so another window's changes are not lost.
  let storageRevision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.appearanceTheme) {
      storageRevision++;
      hydrated = true;
      publish(changes.appearanceTheme.newValue);
    }
  });
  const ready = chrome.storage.local.get("appearanceTheme").then(stored => {
    if (!storageRevision) publish(stored.appearanceTheme);
    hydrated = true;
    return current;
  }).catch(() => { hydrated = true; return current; });

  let classicFontsReady = null;
  function loadClassicFonts() {
    classicFontsReady ||= Promise.all([
      ["ms_sans_serif.woff2", "400"],
      ["ms_sans_serif_bold.woff2", "700"],
    ].map(async ([file, weight]) => {
      const response = await fetch(chrome.runtime.getURL(`src/vendor/98.css/${file}`));
      if (!response.ok) throw new Error("Klasik tema yazı tipi yüklenemedi.");
      // ArrayBuffer also works on sites that restrict font URLs via CSP.
      const face = new FontFace("Sesli Oku Classic", await response.arrayBuffer(), { weight });
      document.fonts.add(await face.load());
    })).catch(error => {
      console.warn("[Sesli Oku]", error);
    });
    return classicFontsReady;
  }

  const transitions = new WeakMap();
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const activeTransitions = new Set();
  motionQuery.addEventListener("change", event => {
    if (event.matches) for (const finish of [...activeTransitions]) finish();
  });

  function finishTransition(root) {
    transitions.get(root)?.();
  }

  function apply(root, value, container = root) {
    if (!root) return;
    const theme = normalize(value);
    if (root.dataset.theme === theme) return;
    const oldRect = container.getBoundingClientRect();
    finishTransition(root);
    if (!hydrated || !root.isConnected || !oldRect.height || motionQuery.matches ||
        document.visibilityState !== "visible" || typeof root.animate !== "function") {
      root.dataset.theme = theme;
      return;
    }

    // Crossfade actual old/new skins, including gradients, fonts and different
    // layouts. CSS color transitions alone cannot interpolate these changes.
    const snapshot = root.cloneNode(true);
    snapshot.setAttribute("data-theme-snapshot", "");
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.inert = true;
    snapshot.removeAttribute("id");
    for (const node of snapshot.querySelectorAll("[id]")) node.removeAttribute("id");
    for (const node of snapshot.querySelectorAll("script")) node.remove();
    const controls = root.querySelectorAll("input, select");
    snapshot.querySelectorAll("input, select").forEach((node, index) => {
      node.value = controls[index].value;
      if (node instanceof HTMLInputElement) node.checked = controls[index].checked;
    });
    const body = root === document.body;
    snapshot.style.setProperty("position", body ? "fixed" : "absolute");
    snapshot.style.setProperty("inset", body ? `${oldRect.top}px auto auto ${oldRect.left}px` : "0 0 auto");
    snapshot.style.setProperty("width", `${root.getBoundingClientRect().width}px`);
    snapshot.style.setProperty("margin", "0");
    snapshot.style.setProperty("pointer-events", "none");
    snapshot.style.setProperty("z-index", "2147483647");
    snapshot.style.setProperty("animation", "none");
    snapshot.style.setProperty("transition", "none");
    const overflow = container.style.getPropertyValue("overflow");
    const overflowPriority = container.style.getPropertyPriority("overflow");
    root.dataset.theme = theme;
    const newHeight = container.getBoundingClientRect().height;
    // Popup snapshots are siblings so the new body's theme selectors cannot
    // style the old copy. Toolbar snapshots stay inside its isolated root.
    (body ? document.documentElement : root.parentNode).appendChild(snapshot);
    container.style.setProperty("overflow", "hidden");
    const timing = { duration: 320, easing: "cubic-bezier(.22, 1, .36, 1)" };
    const animations = [
      snapshot.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-3px)" }], timing),
      root.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], timing),
      container.animate([{ height: `${oldRect.height}px` }, { height: `${newHeight}px` }], timing),
    ];
    root.setAttribute("data-theme-transition", "");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const animation of animations) animation.cancel();
      snapshot.remove();
      root.removeAttribute("data-theme-transition");
      if (overflow) container.style.setProperty("overflow", overflow, overflowPriority);
      else container.style.removeProperty("overflow");
      transitions.delete(root);
      activeTransitions.delete(finish);
    };
    transitions.set(root, finish);
    activeTransitions.add(finish);
    Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
  }

  const css = `
    @layer base, themes;
    @layer themes {
    /* Native-style chrome: labels and button captions cannot be selected.
       This shared stylesheet only runs in the popup or toolbar shadow root. */
    [data-theme], [data-theme] * {
      -webkit-user-select: none;
      user-select: none;
    }
    [data-theme] { cursor: default; }
    [data-theme]:where(:not([data-theme="modern"])) {
      color-scheme: light;
      --bg: #c0c0c0; --panel: #fff; --text: #111; --muted: #414141;
      --border: #808080; --accent: #000080; --accent-text: #fff;
      --accent-hover: #0000a0; --danger: #a00000;
      --theme-font: Tahoma, "Liberation Sans", Arial, sans-serif;
      --theme-radius: 0px; --theme-title: #000080; --theme-title-text: #fff;
      --theme-button: #c0c0c0; --theme-button-hover: #d0d0d0;
      --theme-button-border: #808080;
      --theme-raised: inset 1px 1px #fff, inset -1px -1px #404040, inset 2px 2px #dfdfdf, inset -2px -2px #808080;
      --theme-pressed: inset 1px 1px #404040, inset -1px -1px #fff, inset 2px 2px #808080;
      font-family: var(--theme-font);
      color: var(--text);
      background: var(--bg);
    }
    [data-theme="win98"] {
      --theme-title: linear-gradient(90deg, #000080, #1084d0);
    }
    [data-theme="xp"] {
      --bg: #ece9d8; --panel: #fff; --text: #172441; --muted: #4d5362;
      --border: #7f9db9; --accent: #245edb; --accent-hover: #1648b7;
      --theme-radius: 4px;
      --theme-title: linear-gradient(#4095ff 0%, #0864e5 12%, #0054e3 75%, #0241b5 100%);
      --theme-button: linear-gradient(#fff, #f1f1e7 85%, #d8d4bf);
      --theme-button-hover: linear-gradient(#fff, #fff5d2 85%, #e9c165);
      --theme-button-border: #003c74;
      --theme-raised: inset 0 0 0 1px #fff, 0 1px 1px #b4b0a0;
      --theme-pressed: inset 1px 2px 3px #a6a496;
    }
    [data-theme="win7"] {
      --bg: #eaf1f8; --panel: #fff; --text: #152c45; --muted: #40576b;
      --border: #8da6bc; --accent: #246b9c; --accent-hover: #164d79;
      --theme-font: "Segoe UI", "Liberation Sans", Arial, sans-serif;
      --theme-radius: 4px;
      --theme-title: linear-gradient(115deg, #ffffffaa, #d5edff66 35%, #87b5d288 70%, #ffffff99);
      --theme-title-text: #153448;
      --theme-button: linear-gradient(#fff 0%, #f1f5f9 48%, #e1e8f0 49%, #d5dfeb);
      --theme-button-hover: linear-gradient(#f5fcff, #d7efff 48%, #b8dff6 49%, #dcf3ff);
      --theme-button-border: #7c909f;
      --theme-raised: inset 0 0 0 1px #ffffffdd, 0 1px 2px #536b8026;
      --theme-pressed: inset 0 1px 4px #53799588;
    }
    /* Shared controls: no package-specific HTML or class swapping. */
    [data-theme]:where(:not([data-theme="modern"])) button {
      border: 1px solid var(--theme-button-border);
      border-radius: var(--theme-radius);
      color: var(--text);
      background: var(--theme-button);
      box-shadow: var(--theme-raised);
      font-family: var(--theme-font);
      text-shadow: none;
      transition: none;
    }
    [data-theme]:where(:not([data-theme="modern"])) button:hover {
      background: var(--theme-button-hover);
      color: var(--text);
    }
    [data-theme]:where(:not([data-theme="modern"])) button:active {
      box-shadow: var(--theme-pressed);
      transform: none;
    }
    [data-theme]:where(:not([data-theme="modern"])) :is(button, select, input):focus-visible {
      outline: 1px dotted var(--text); outline-offset: -4px;
    }
    [data-theme]:where(:not([data-theme="modern"])) select {
      background: var(--panel); color: var(--text); border: 1px solid var(--border);
      border-radius: var(--theme-radius); box-shadow: inset 1px 1px 1px #0003;
      font-family: var(--theme-font);
    }
    [data-theme]:where(:not([data-theme="modern"])) :is(option, optgroup) { background: #fff; color: #111; }
    [data-theme]:where(:not([data-theme="modern"])) input { accent-color: var(--accent); }
    [data-theme]:where(:not([data-theme="modern"])) input[type="range"] {
      appearance: none; background: transparent; height: 24px; cursor: pointer;
    }
    [data-theme]:where(:not([data-theme="modern"])) input[type="range"]::-webkit-slider-runnable-track {
      height: 5px; background: #b4b4b4; border: 1px solid #808080;
      box-shadow: 1px 1px #fff;
    }
    [data-theme]:where(:not([data-theme="modern"])) input[type="range"]::-webkit-slider-thumb {
      appearance: none; width: 13px; height: 22px; margin-top: -9px;
      border: 1px solid var(--theme-button-border); border-radius: var(--theme-radius);
      background: var(--theme-button); box-shadow: var(--theme-raised);
    }
    [data-theme="xp"] input[type="range"]::-webkit-slider-thumb {
      background: linear-gradient(90deg, #f6f4ec, #dfddce); border: 1px solid #176d19;
      border-bottom: 4px solid #38a73a; border-radius: 3px;
    }
    [data-theme="win7"] input[type="range"]::-webkit-slider-thumb {
      background: linear-gradient(90deg, #e5f6ff, #9bd2f2); border-color: #397ba4;
    }
    /* Toolbar adapters live inside its shadow root. */
    .wrap[data-theme]:where(:not([data-theme="modern"])) {
      border-bottom: 2px solid var(--border); box-shadow: 0 2px 6px #0002;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .brand {
      background: var(--theme-title); color: var(--theme-title-text);
      padding: 6px 10px; align-self: stretch; align-items: center;
      border-radius: var(--theme-radius); min-width: 112px;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .brand :is(svg, small) { color: inherit; }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .brand small { opacity: .88; }
    .wrap[data-theme]:where(:not([data-theme="modern"])) :is(.status, .field label, .label-row output) { color: var(--text); }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .error { color: var(--danger); }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .divider {
      background: var(--border); box-shadow: 1px 0 #fff;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .settings { border-top-color: var(--border); }
    .wrap[data-theme]:where(:not([data-theme="modern"])) button.follow { color: var(--text); }
    .wrap[data-theme="xp"] button.primary {
      background: linear-gradient(#74cc6c, #329a30 50%, #23851f 51%, #42a938);
      color: #fff; border-color: #1e681b; box-shadow: inset 0 0 0 1px #ffffff80;
    }
    .wrap[data-theme="xp"] button.close {
      background: linear-gradient(#f1a386, #d94623 50%, #c62e13 51%, #e76e46);
      color: #fff; border-color: #96351d;
    }
    .wrap[data-theme="win7"] {
      background: linear-gradient(110deg, #d9edfaf2, #b5d0e8f2 55%, #e6f4fff2);
      backdrop-filter: blur(16px);
    }
    .wrap[data-theme="win7"] .brand { text-shadow: 0 0 6px #fff, 0 0 12px #fff; }
    .wrap[data-theme="win7"] button.close {
      background: linear-gradient(#f6b5a6, #bd432d 50%, #a52813 51%, #df8166);
      color: white; border-color: #914230;
    }
    /* Popup adapters use exactly the same palette and control definitions. */
    body[data-theme]:where(:not([data-theme="modern"])) { padding: 12px; border: 2px solid var(--border); }
    body[data-theme]:where(:not([data-theme="modern"])) header {
      padding: 9px; margin: -8px -8px 16px;
      background: var(--theme-title); color: var(--theme-title-text);
      border-radius: var(--theme-radius) var(--theme-radius) 0 0;
    }
    body[data-theme]:where(:not([data-theme="modern"])) header p { color: inherit; opacity: .9; }
    body[data-theme]:where(:not([data-theme="modern"])) .logo {
      background: transparent; color: inherit; border-radius: 0;
    }
    body[data-theme]:where(:not([data-theme="modern"])) button.primary { font-weight: 700; }
    body[data-theme]:where(:not([data-theme="modern"])) kbd {
      border-radius: var(--theme-radius); background: var(--theme-button); box-shadow: var(--theme-raised);
    }
    body[data-theme]:where(:not([data-theme="modern"])) button.link { padding: 4px 7px; text-decoration: none; }
    body[data-theme="win7"] header { box-shadow: inset 0 0 0 1px #ffffffb3; }
    /* Luna and Aero use window chrome, a full title row, and a separate
       compact command row. They do not inherit the modern brand tile layout. */
    :is(body, .wrap)[data-theme="xp"] {
      --theme-font: Tahoma, "Trebuchet MS", "Liberation Sans", Arial, sans-serif;
      --era-title-height: 29px; --era-control-height: 25px;
      --era-title-size: 13px; --era-control-size: 11px;
      --theme-button-hover: linear-gradient(#fffdf5, #fff1d1 85%, #edc774);
      font-size: 11px; line-height: 1.4;
    }
    :is(body, .wrap)[data-theme="win7"] {
      --era-title-height: 32px; --era-control-height: 27px;
      --era-title-size: 12px; --era-control-size: 12px;
      font-size: 12px; line-height: 1.4;
    }
    :is([data-theme="xp"], [data-theme="win7"]) :is(button, select, input, label, output, .status) {
      font-family: var(--theme-font); font-size: var(--era-control-size); letter-spacing: 0;
    }
    :is([data-theme="xp"], [data-theme="win7"]) button {
      min-height: var(--era-control-height); height: var(--era-control-height);
      border-radius: 3px; padding: 0 9px;
    }
    :is([data-theme="xp"], [data-theme="win7"]) select {
      appearance: none; height: 23px; min-height: 23px; padding: 2px 25px 2px 5px;
      border-radius: 0; box-shadow: inset 1px 1px #0000000d;
      background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='17' height='19'%3E%3Crect x='.5' y='.5' width='16' height='18' rx='2' fill='%23e4edfb' stroke='%237f9db9'/%3E%3Cpath d='m5 8 3.5 3L12 8' fill='none' stroke='%233663a2' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 1px center;
    }
    [data-theme="xp"] select:hover { border-color: #3366aa; }
    [data-theme="win7"] select {
      height: 25px; min-height: 25px; border-radius: 2px;
      background: linear-gradient(45deg, transparent 50%, #263d50 50%) calc(100% - 10px) 10px / 4px 4px no-repeat,
        linear-gradient(135deg, #263d50 50%, transparent 50%) calc(100% - 6px) 10px / 4px 4px no-repeat,
        linear-gradient(#fff, #f5f8fb);
    }
    [data-theme="win7"] select:hover { border-color: #3c7fb1; }
    :is([data-theme="xp"], [data-theme="win7"]) input[type="range"]::-webkit-slider-runnable-track {
      height: 4px; border: 1px solid #aca899; border-radius: 2px;
      background: #e7e4d7; box-shadow: 0 1px #fff;
    }
    [data-theme="xp"] input[type="range"]::-webkit-slider-thumb {
      width: 12px; height: 21px; margin-top: -9px;
      background: linear-gradient(90deg, #fcfcfa, #e6e4d6);
      border: 1px solid #7f9db9; border-top: 3px solid #70c267; border-bottom: 3px solid #369531;
      border-radius: 3px; box-shadow: inset 1px 0 #fff;
    }
    [data-theme="win7"] input[type="range"]::-webkit-slider-runnable-track {
      border-color: #aeb8bf; background: #dde5ec; height: 5px;
    }
    [data-theme="win7"] input[type="range"]::-webkit-slider-thumb {
      width: 12px; height: 21px; margin-top: -9px;
      background: linear-gradient(90deg, #f4fbff, #c1e6fb 49%, #9bcde9 50%, #daeffc);
      border-color: #648aa4; border-radius: 3px; box-shadow: inset 0 0 0 1px #ffffffad;
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) {
      animation: none; box-sizing: border-box;
    }
    .wrap[data-theme="xp"] {
      padding: 3px; border: 3px solid #0054e3; border-top: 0;
      border-radius: 8px 8px 0 0; background: var(--bg);
      box-shadow: inset 1px 0 #6aa0ff, inset -1px 0 #003caa, 0 2px 5px #0003;
    }
    .wrap[data-theme="win7"] {
      padding: 5px; border: 1px solid #64849a; border-radius: 6px 6px 0 0;
      background: linear-gradient(120deg, #e7f5ffe6, #abc8e3eb 50%, #e0f0fbe6);
      box-shadow: inset 0 0 0 1px #ffffffb3, 0 2px 6px #0003;
      backdrop-filter: blur(16px) saturate(125%);
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .bar {
      display: grid; grid-template-columns: max-content 1px minmax(24px, 1fr) max-content max-content;
      width: 100%; max-width: none; min-height: 0; margin: 0; padding: 0;
      gap: 7px 8px; position: relative;
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .brand {
      grid-column: 1 / -1; grid-row: 1; min-width: 0; width: 100%;
      height: var(--era-title-height); margin: 0; box-sizing: border-box;
      padding: 3px 36px 3px 5px; gap: 5px; align-self: auto;
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .brand small { display: none; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .brand strong {
      font-family: var(--theme-font); font-size: var(--era-title-size); letter-spacing: 0;
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .brand svg { width: 16px; height: 16px; }
    .wrap[data-theme="xp"] .brand {
      border-radius: 6px 6px 0 0; box-shadow: inset 0 1px #6da5ff;
    }
    .wrap[data-theme="xp"] .brand strong { font-weight: 700; text-shadow: 1px 1px #00338a; }
    .wrap[data-theme="win7"] .brand {
      background: transparent; border-radius: 0; padding-right: 50px;
      text-shadow: 0 0 4px #fff, 0 0 10px #fff, 0 0 16px #fff;
    }
    .wrap[data-theme="win7"] .brand strong { font-weight: 400; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .transport { grid-row: 2; grid-column: 1; gap: 3px; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .divider { grid-row: 2; grid-column: 2; height: 22px; margin: 0; align-self: center; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .status {
      grid-row: 2; grid-column: 3; min-width: 0; text-align: left; padding: 4px 6px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .wrap[data-theme="xp"] .status { border: 1px solid #c7c4b4; box-shadow: inset 1px 1px #f8f7f0; }
    .wrap[data-theme="win7"] .status { border: 1px solid #a6bacb; border-radius: 2px; background: #f7fbff8c; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .follow { grid-row: 2; grid-column: 4; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .actions { grid-row: 2; grid-column: 5; margin: 0; gap: 4px; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) :is(.transport button, button.icon) {
      width: 27px; height: var(--era-control-height); padding: 0;
    }
    .wrap[data-theme="xp"] button.primary { width: 30px; }
    .wrap[data-theme="win7"] button.primary {
      width: 30px; background: linear-gradient(#fff, #cfeafd 48%, #93c9ea 49%, #d2edfc);
      border-color: #5786a3; color: #154768;
    }
    .wrap[data-theme="xp"] button.primary:hover { background: linear-gradient(#95e98d, #43ad3b 50%, #329c29 51%, #5dc449); color: #fff; }
    .wrap[data-theme="win7"] button.primary:hover { background: linear-gradient(#fff, #a9e4ff 48%, #60b4e8 49%, #cff3ff); }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) button.close {
      position: absolute; padding: 0; font: 700 16px/1 Arial, sans-serif;
      color: #fff; text-shadow: 0 1px #80301b;
    }
    .wrap[data-theme="xp"] button.close {
      top: 2px; right: 3px; width: 25px; height: 25px; min-height: 25px;
      border-radius: 3px; border-color: #fff; box-shadow: inset 0 0 0 1px #e47f65;
    }
    .wrap[data-theme="xp"] button.close:hover { background: linear-gradient(#ffb39d, #e65d37 50%, #d73918 51%, #f58d68); color: #fff; }
    .wrap[data-theme="win7"] button.close {
      top: -5px; right: 1px; width: 43px; height: 20px; min-height: 20px;
      border-radius: 0 0 4px 4px; border-color: #7e493d;
      box-shadow: inset 0 0 0 1px #ffffff8c, 0 1px 2px #44556666;
    }
    .wrap[data-theme="win7"] button.close:hover { background: linear-gradient(#ffbba7, #e77755 50%, #c3401b 51%, #f4aa7b); box-shadow: 0 0 8px #ed7649, inset 0 0 0 1px #fff9; color: #fff; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .settings {
      max-width: none; margin: 8px 0 0; padding: 10px 8px 8px; gap: 16px;
      border: 1px solid #c3c0b3; border-radius: 0;
    }
    .wrap[data-theme="xp"] .settings { background: #f5f3e9; box-shadow: inset 1px 1px #fff; }
    .wrap[data-theme="win7"] .settings { background: #f7fafd; border-color: #a4b8c9; box-shadow: inset 0 0 0 1px #fff; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .field label { margin-bottom: 4px; }
    body[data-theme="xp"] {
      padding: 12px; border: 3px solid #0054e3; border-top-width: 0; border-radius: 8px 8px 0 0;
      box-shadow: inset 1px 0 #6aa0ff, inset -1px 0 #003caa;
    }
    body[data-theme="xp"] header {
      min-height: 29px; box-sizing: border-box; padding: 4px 6px; gap: 5px;
      margin: 0 0 12px; position: relative;
      margin-top: -12px; margin-left: -9px; margin-right: -9px;
      border-radius: 5px 5px 0 0; box-shadow: inset 0 1px #6da5ff;
    }
    body[data-theme="xp"] h1 { font: 700 13px/1.4 var(--theme-font); text-shadow: 1px 1px #00338a; letter-spacing: 0; }
    body:is([data-theme="xp"], [data-theme="win7"]) header p { display: none; }
    body:is([data-theme="xp"], [data-theme="win7"]) .logo { width: 18px; height: 18px; }
    body:is([data-theme="xp"], [data-theme="win7"]) .logo svg { width: 16px; height: 16px; }
    body:is([data-theme="xp"], [data-theme="win7"]) .field { margin-bottom: 12px; }
    body[data-theme="xp"] :is(.field label, button.primary) { font-weight: 400; }
    body[data-theme="xp"] button.primary { outline: 1px solid #003c74; outline-offset: -3px; box-shadow: inset 0 0 0 1px #fff, inset 0 0 0 3px #c4d7f9; }
    body[data-theme="win7"] {
      padding: 10px; border: 1px solid #64849a; border-radius: 6px 6px 0 0;
      box-shadow: inset 0 0 0 1px #ffffffc2;
    }
    body[data-theme="win7"] header {
      min-height: 32px; box-sizing: border-box; padding: 4px 6px; margin: -5px -5px 10px; gap: 5px;
      background: var(--theme-title); box-shadow: none; border-radius: 0;
    }
    body[data-theme="win7"] h1 { font: 400 12px/1.4 var(--theme-font); letter-spacing: 0; text-shadow: 0 0 4px #fff, 0 0 10px #fff; }
    body[data-theme="win7"] .actions { padding: 8px; background: #f7fafd; border: 1px solid #adbfce; margin-bottom: 12px; }
    body:is([data-theme="xp"], [data-theme="win7"]) .field label { font-weight: 400; }
    body:is([data-theme="xp"], [data-theme="win7"]) .check { font-size: var(--era-control-size); }
    body:is([data-theme="xp"], [data-theme="win7"]) .check input {
      appearance: none; width: 13px; height: 13px; border: 1px solid #7f9db9; border-radius: 1px;
      background: linear-gradient(135deg, #dce4e9, #fff 70%); box-shadow: inset 0 0 0 1px #fff;
    }
    body:is([data-theme="xp"], [data-theme="win7"]) .check input:checked::after {
      content: ""; display: block; width: 6px; height: 3px; margin: 2px 0 0 2px;
      border-left: 2px solid #218b21; border-bottom: 2px solid #218b21; transform: rotate(-45deg);
    }
    body[data-theme="win7"] .check input { border-color: #7c8d9a; background: linear-gradient(135deg, #e5ebf0, #fff); }
    body[data-theme="win7"] .check input:checked::after { border-color: #245b7f; }
    @media (max-width: 460px) {
      .wrap:is([data-theme="xp"], [data-theme="win7"]) .bar { gap: 6px 4px; }
      .wrap:is([data-theme="xp"], [data-theme="win7"]) .brand { flex-basis: auto; }
      .wrap:is([data-theme="xp"], [data-theme="win7"]) .follow { padding: 0 5px; font-size: 10px; }
    }
    /* Classic windows have a full title strip and a compact toolbar beneath.
       Explicit geometry prevents the modern layout from leaking into the skin. */
    :is(body, .wrap):is([data-theme="win95"], [data-theme="win98"]) {
      --theme-font: "Sesli Oku Classic", "MS Sans Serif", Arial, sans-serif;
      --theme-button-hover: #c0c0c0;
      --theme-raised: inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf;
      --theme-field: inset -1px -1px #fff, inset 1px 1px #808080, inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
      --theme-window: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff;
      font-size: 11px; line-height: 1.4;
      -webkit-font-smoothing: none;
    }
    :is([data-theme="win95"], [data-theme="win98"]) :is(button, select, input, label, output, .status) {
      font-family: var(--theme-font); font-size: 11px; letter-spacing: 0;
    }
    :is([data-theme="win95"], [data-theme="win98"]) button {
      border: 0; border-radius: 0; height: 23px; min-height: 23px;
      box-shadow: var(--theme-raised); padding: 0 8px;
    }
    :is([data-theme="win95"], [data-theme="win98"]) select {
      appearance: none; border: 0; border-radius: 0; height: 21px; min-height: 21px;
      padding: 2px 25px 2px 4px; box-shadow: var(--theme-field);
      background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='17'%3E%3Cpath fill='%23c0c0c0' d='M0 0h16v17H0z'/%3E%3Cpath fill='none' stroke='%23fff' d='M0 16V0h15'/%3E%3Cpath fill='none' stroke='%230a0a0a' d='M0 16h15V0'/%3E%3Cpath fill='none' stroke='%23808080' d='M1 15h13V1'/%3E%3Cpath d='m4 6 4 4 4-4z'/%3E%3C/svg%3E") no-repeat right 2px top 2px;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) {
      padding: 3px; border: 0; box-shadow: var(--theme-window);
      animation: none;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .bar {
      display: grid; grid-template-columns: max-content 2px minmax(30px, 1fr) max-content max-content;
      width: 100%; max-width: none; padding: 0; margin: 0; min-height: 0;
      gap: 5px 6px; position: relative;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .brand {
      grid-column: 1 / -1; grid-row: 1; margin: 0; min-width: 0; min-height: 20px;
      box-sizing: border-box; padding: 2px 27px 2px 3px; gap: 4px;
      border-radius: 0; align-self: auto;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .brand strong { font-size: 11px; font-weight: 700; letter-spacing: 0; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .brand small { display: none; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .brand svg { width: 14px; height: 14px; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .transport { grid-row: 2; grid-column: 1; gap: 2px; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .divider { grid-row: 2; grid-column: 2; height: 22px; margin: 0; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .status {
      grid-row: 2; grid-column: 3; min-width: 0; text-align: left;
      padding: 3px 5px; box-shadow: inset 1px 1px #808080, inset -1px -1px #dfdfdf;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .follow { grid-row: 2; grid-column: 4; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .actions { grid-row: 2; grid-column: 5; margin: 0; gap: 3px; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) :is(.transport button, button.primary, button.icon) { width: 25px; height: 23px; padding: 0; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) button.speed { padding: 0 6px; }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) button.close {
      position: absolute; right: 2px; top: 3px; width: 16px; height: 14px; min-height: 14px;
      padding: 0; font: bold 11px/1 Arial, sans-serif; color: #000;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .settings {
      max-width: none; padding: 8px 5px 5px; margin: 6px 0 0;
      border-top: 2px groove #fff; gap: 12px;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .field label { margin-bottom: 3px; }
    body:is([data-theme="win95"], [data-theme="win98"]) {
      border: 0; padding: 10px; box-shadow: var(--theme-window);
    }
    body:is([data-theme="win95"], [data-theme="win98"]) header {
      min-height: 20px; gap: 4px; margin: -7px -7px 12px; padding: 2px 4px;
      border-radius: 0;
    }
    body:is([data-theme="win95"], [data-theme="win98"]) :is(header p, .logo svg path:last-child) { display: none; }
    body:is([data-theme="win95"], [data-theme="win98"]) .logo { width: 16px; height: 16px; }
    body:is([data-theme="win95"], [data-theme="win98"]) .logo svg { width: 14px; height: 14px; }
    body:is([data-theme="win95"], [data-theme="win98"]) h1 { font: 700 11px/1.4 var(--theme-font); letter-spacing: 0; }
    body:is([data-theme="win95"], [data-theme="win98"]) .field { margin-bottom: 10px; }
    body:is([data-theme="win95"], [data-theme="win98"]) :is(.field label, button.primary) { font-weight: 400; }
    body:is([data-theme="win95"], [data-theme="win98"]) .check input {
      appearance: none; width: 13px; height: 13px; background: #fff; box-shadow: var(--theme-field);
    }
    body:is([data-theme="win95"], [data-theme="win98"]) .check input:checked::after {
      content: ""; display: block; width: 6px; height: 3px; margin: 3px 0 0 3px;
      border-left: 2px solid #000; border-bottom: 2px solid #000; transform: rotate(-45deg);
    }
    @media (max-width: 460px) {
      .wrap:is([data-theme="win95"], [data-theme="win98"]) .bar { gap: 5px 4px; }
      .wrap:is([data-theme="win95"], [data-theme="win98"]) .brand { flex-basis: auto; }
    }
    /* Center the transport independently of status text and secondary tools.
       Equal side columns keep the play button on the viewport's center line. */
    .wrap[data-theme]:where(:not([data-theme="modern"])) .bar {
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .transport {
      grid-column: 2; grid-row: 2; justify-self: center; align-items: center;
      gap: 5px; margin: 4px 0;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .divider { display: none; }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .status {
      grid-column: 1; grid-row: 2; justify-self: start;
      box-sizing: border-box; width: min(160px, 100%); min-width: 0;
      margin-left: 4px; max-width: calc(100% - 4px); align-self: center;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .player-tools {
      grid-column: 3; grid-row: 2; margin: 0; padding-right: 4px;
      display: flex; justify-content: flex-end; align-items: center;
      flex-wrap: wrap; gap: 5px 8px; box-sizing: border-box; min-width: 0;
    }
    .wrap[data-theme]:where(:not([data-theme="modern"])) .actions { margin: 0; flex: none; }
    .wrap[data-theme]:where(:not([data-theme="modern"])) button.follow { flex: none; }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .transport button {
      width: 32px; height: 30px; min-height: 30px; font-size: 15px;
    }
    .wrap:is([data-theme="xp"], [data-theme="win7"]) .transport button.primary {
      width: 42px; height: 36px; min-height: 36px; font-size: 18px;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .transport button {
      width: 28px; height: 26px; min-height: 26px;
    }
    .wrap:is([data-theme="win95"], [data-theme="win98"]) .transport button.primary {
      width: 34px; height: 28px; min-height: 28px;
    }
    @media (max-width: 640px) {
      .wrap[data-theme]:where(:not([data-theme="modern"])) .player-tools { gap: 4px; }
      .wrap[data-theme]:where(:not([data-theme="modern"])) .player-tools .actions { order: 0; }
      .wrap[data-theme]:where(:not([data-theme="modern"])) .player-tools .follow { order: 1; padding: 0 5px; font-size: 10px; }
    }
    @media (forced-colors: active) {
      [data-theme]:where(:not([data-theme="modern"])) button { border: 1px solid ButtonText; }
    }
    }
  `;
  function fillSelect(select) {
    select.replaceChildren(...choices.map(({ id, label }) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      return option;
    }));
    select.value = current;
  }
  globalThis.SesliOkuThemes = Object.freeze({
    choices, css, ready, normalize, apply, finishTransition,
    current: () => current,
    fillSelect,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async set(value) {
      const theme = normalize(value);
      await chrome.storage.local.set({ appearanceTheme: theme });
      publish(theme);
      return theme;
    },
  });
})();
