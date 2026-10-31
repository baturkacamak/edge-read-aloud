const themes = globalThis.SesliOkuThemes;
const themeStyle = document.createElement("style");
themeStyle.textContent = themes.css;
document.head.appendChild(themeStyle);
const themeSelect = document.getElementById("theme");
themes.fillSelect(themeSelect);
themes.subscribe(theme => {
  themes.apply(document.body, theme);
  themeSelect.value = theme;
});
themeSelect.addEventListener("change", async () => {
  try {
    await themes.set(themeSelect.value);
  } catch (error) {
    themeSelect.value = themes.current();
    setStatus(error.message, true);
  }
});

const DEFAULT_SETTINGS = {
  voice: "tr-TR-EmelNeural",
  rate: 0,
  pitch: 0,
  volume: 0,
  playbackRate: 1,
  continueSelection: true,
};

const elements = {
  voice: document.getElementById("voice"),
  rate: document.getElementById("rate"),
  volume: document.getElementById("volume"),
  rateValue: document.getElementById("rate-value"),
  volumeValue: document.getElementById("volume-value"),
  readPage: document.getElementById("read-page"),
  readSelection: document.getElementById("read-selection"),
  readHere: document.getElementById("read-here"),
  stop: document.getElementById("stop"),
  continueSelection: document.getElementById("continue-selection"),
  status: document.getElementById("status"),
};

let settings = { ...DEFAULT_SETTINGS };

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
  const gender = voice.Gender === "Female" ? "Kadın" : voice.Gender === "Male" ? "Erkek" : "";
  return gender ? `${name} · ${gender}` : name;
}

function setStatus(text, isError = false) {
  elements.status.textContent = text || "";
  elements.status.classList.toggle("error", isError);
}

async function callBackground(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type,
    ...payload,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "İşlem tamamlanamadı.");
  }
  return response;
}

function renderVoices(voices) {
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

  elements.voice.innerHTML = "";
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
    elements.voice.appendChild(group);
  }

  const exists = voices.some((voice) => voice.ShortName === settings.voice);
  if (!exists) {
    const option = document.createElement("option");
    option.value = settings.voice;
    option.textContent = settings.voice;
    elements.voice.appendChild(option);
  }
  elements.voice.value = settings.voice;
}

function updateOutputs() {
  const rate = Number(elements.rate.value);
  const volume = Number(elements.volume.value);
  elements.rateValue.textContent = `${rate > 0 ? "+" : ""}${rate}%`;
  elements.volumeValue.textContent = `${volume > 0 ? "+" : ""}${volume}%`;
}

async function saveSettings() {
  settings = {
    ...settings,
    voice: elements.voice.value || DEFAULT_SETTINGS.voice,
    rate: Number(elements.rate.value),
    volume: Number(elements.volume.value),
    continueSelection: elements.continueSelection.checked,
  };
  await chrome.storage.local.set({ settings });
}

async function start(type) {
  elements.readPage.disabled = true;
  elements.readSelection.disabled = true;
  elements.readHere.disabled = true;
  setStatus("Başlatılıyor…");
  try {
    await saveSettings();
    await callBackground(type);
    setStatus("Başladı");
    setTimeout(() => window.close(), 220);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.readPage.disabled = false;
    elements.readSelection.disabled = false;
    elements.readHere.disabled = false;
  }
}

async function init() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  elements.rate.value = String(settings.rate ?? 0);
  elements.volume.value = String(settings.volume ?? 0);
  elements.continueSelection.checked = settings.continueSelection !== false;
  updateOutputs();

  try {
    const { voices, warning } = await callBackground("GET_VOICES");
    renderVoices(voices);
    if (warning) setStatus("Ses listesi alınamadı, temel liste kullanılıyor.", true);
  } catch (error) {
    setStatus(error.message, true);
  }
}

elements.rate.addEventListener("input", () => {
  updateOutputs();
  saveSettings();
});

elements.volume.addEventListener("input", () => {
  updateOutputs();
  saveSettings();
});

elements.voice.addEventListener("change", saveSettings);
elements.continueSelection.addEventListener("change", saveSettings);

elements.readPage.addEventListener("click", () => start("START_PAGE"));
elements.readSelection.addEventListener("click", () => start("START_SELECTION"));
elements.readHere.addEventListener("click", () => start("START_FROM_CURSOR"));

elements.stop.addEventListener("click", async () => {
  try {
    await callBackground("STOP_ACTIVE");
    setStatus("Durduruldu");
  } catch (error) {
    setStatus(error.message, true);
  }
});

init();
