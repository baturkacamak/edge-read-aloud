const themes = globalThis.SesliOkuThemes;
const preferences = globalThis.SesliOkuSettings;
const themeStyle = document.createElement("style");
themeStyle.textContent = themes.css + preferences.css + globalThis.SesliOkuLibrary.css;
document.head.appendChild(themeStyle);
const settingsUi = preferences.mount(document.getElementById("preferences"), {
  onTimer: timer => callBackground("SET_SLEEP_TIMER", { timer }),
});
themes.subscribe(theme => themes.apply(document.body, theme));
const elements = {
  voice: settingsUi.voice,
  readPage: document.getElementById("read-page"),
  readSelection: document.getElementById("read-selection"),
  readHere: document.getElementById("read-here"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
};
let settings = preferences.current();
preferences.subscribe(value => { settings = value; });

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
  settingsUi.renderVoiceChoices(voices);
}

async function start(type) {
  elements.readPage.disabled = true;
  elements.readSelection.disabled = true;
  elements.readHere.disabled = true;
  setStatus("Başlatılıyor…");
  try {
    await preferences.ready;
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
  await preferences.ready;

  try {
    const { voices, warning } = await callBackground("GET_VOICES");
    renderVoices(voices);
    if (warning) setStatus("Ses listesi alınamadı, temel liste kullanılıyor.", true);
  } catch (error) {
    setStatus(error.message, true);
  }
}

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
