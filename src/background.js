import { tts, listVoices, DEFAULT_VOICE } from "./tts.js";

const VOICES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let readingTabId = null;

/**
 * chrome.runtime messaging serializes payloads as JSON, so a Uint8Array would
 * arrive as a plain object. Base64 keeps audio transfer cheap enough.
 */
function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(offset, offset + chunkSize)
    );
  }
  return btoa(binary);
}

const FALLBACK_VOICES = [
  {
    Name: "Microsoft Server Speech Text to Speech Voice (tr-TR, EmelNeural)",
    ShortName: "tr-TR-EmelNeural",
    Gender: "Female",
    Locale: "tr-TR",
    FriendlyName: "Microsoft Emel Online (Natural) - Turkish (Turkey)",
  },
  {
    Name: "Microsoft Server Speech Text to Speech Voice (tr-TR, AhmetNeural)",
    ShortName: "tr-TR-AhmetNeural",
    Gender: "Male",
    Locale: "tr-TR",
    FriendlyName: "Microsoft Ahmet Online (Natural) - Turkish (Türkiye)",
  },
  {
    Name: "Microsoft Server Speech Text to Speech Voice (en-US, AvaNeural)",
    ShortName: "en-US-AvaNeural",
    Gender: "Female",
    Locale: "en-US",
    FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
  },
  {
    Name: "Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)",
    ShortName: "en-GB-RyanNeural",
    Gender: "Male",
    Locale: "en-GB",
    FriendlyName: "Microsoft Ryan Online (Natural) - English (United Kingdom)",
  },
];

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return {
    voice: settings?.voice || DEFAULT_VOICE,
    rate: settings?.rate ?? 0,
    pitch: settings?.pitch ?? 0,
    volume: settings?.volume ?? 0,
    playbackRate: settings?.playbackRate ?? 1,
    continueSelection: settings?.continueSelection !== false,
  };
}

async function getVoices() {
  const { voicesCache } = await chrome.storage.local.get("voicesCache");
  if (voicesCache?.voices?.length && Date.now() - voicesCache.at < VOICES_TTL_MS) {
    return { voices: voicesCache.voices, cached: true };
  }
  try {
    const voices = await listVoices();
    await chrome.storage.local.set({ voicesCache: { at: Date.now(), voices } });
    return { voices, cached: false };
  } catch (error) {
    if (voicesCache?.voices?.length) {
      return { voices: voicesCache.voices, cached: true, warning: error.message };
    }
    return { voices: FALLBACK_VOICES, cached: false, warning: error.message };
  }
}

async function activeTab() {
  let [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  return tab;
}

async function pingContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { target: "content", type: "PING" },
      { frameId: 0 }
    );
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function ensureContent(tabId) {
  if (await pingContent(tabId)) return true;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/themes.js", "src/content.js"],
    });
  } catch {
    return false;
  }
  // Give the freshly injected script a moment to register its listener.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await pingContent(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return false;
}

async function sendToTab(tabId, message) {
  if (!(await ensureContent(tabId))) {
    throw new Error("Bu sayfada çalıştırılamıyor. edge:// ve mağaza sayfalarında desteklenmez.");
  }
  const response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (response && response.ok === false) {
    throw new Error(response.error || "İşlem tamamlanamadı.");
  }
  return response;
}

async function startOnActiveTab(kind, extra = {}) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("Etkin sekme bulunamadı.");
  const settings = await getSettings();
  readingTabId = tab.id;
  return sendToTab(tab.id, {
    target: "content",
    type: kind,
    settings,
    ...extra,
  });
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "edge-ra-read-page",
      title: "Sayfayı sesli oku",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "edge-ra-read-selection",
      title: "Seçimi sesli oku",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "edge-ra-read-here",
      title: "Buradan sesli oku",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: "edge-ra-stop",
      title: "Sesli okumayı durdur",
      contexts: ["page", "selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "edge-ra-read-page" && tab?.id) {
    try {
      readingTabId = tab.id;
      await sendToTab(tab.id, {
        target: "content",
        type: "START_PAGE",
        settings: await getSettings(),
      });
    } catch (error) {
      console.warn("[Sesli Oku]", error);
    }
  } else if (info.menuItemId === "edge-ra-read-selection" && tab?.id) {
    try {
      readingTabId = tab.id;
      await sendToTab(tab.id, {
        target: "content",
        type: "START_SELECTION",
        settings: await getSettings(),
        text: info.selectionText || "",
      });
    } catch (error) {
      console.warn("[Sesli Oku]", error);
    }
  } else if (info.menuItemId === "edge-ra-read-here" && tab?.id) {
    try {
      readingTabId = tab.id;
      await sendToTab(tab.id, {
        target: "content",
        type: "START_FROM_CURSOR",
        fromPoint: true,
        settings: await getSettings(),
      });
    } catch (error) {
      console.warn("[Sesli Oku]", error);
    }
  } else if (info.menuItemId === "edge-ra-stop" && tab?.id) {
    try {
      await sendToTab(tab.id, { target: "content", type: "STOP" });
      tts.close();
    } catch (error) {
      console.warn("[Sesli Oku]", error);
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "read-page") {
      await startOnActiveTab("START_PAGE");
    } else if (command === "read-selection") {
      await startOnActiveTab("START_SELECTION");
    } else if (command === "read-here") {
      await startOnActiveTab("START_FROM_CURSOR");
    } else if (command === "toggle") {
      await startOnActiveTab("TOGGLE");
    } else if (command === "stop") {
      await startOnActiveTab("STOP");
      tts.close();
    }
  } catch (error) {
    console.warn("[Sesli Oku]", error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === readingTabId) {
    readingTabId = null;
    tts.close();
  }
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_VOICES":
      return getVoices();

    case "SPEAK": {
      const settings = message.settings || (await getSettings());
      const result = await tts.speak(message.text, settings);
      return {
        audio: toBase64(result.audio),
        boundaries: result.boundaries,
      };
    }

    case "STOP":
      if (sender?.tab?.id === readingTabId) readingTabId = null;
      tts.close();
      return { stopped: true };

    case "START_PAGE":
      return startOnActiveTab("START_PAGE");

    case "START_SELECTION":
      return startOnActiveTab("START_SELECTION");

    case "START_FROM_CURSOR":
      return startOnActiveTab("START_FROM_CURSOR", {
        fromPoint: message.fromPoint === true,
      });

    case "TOGGLE":
      return startOnActiveTab("TOGGLE");

    case "STOP_ACTIVE": {
      const tab = await activeTab();
      if (tab?.id) await sendToTab(tab.id, { target: "content", type: "STOP" });
      tts.close();
      return { stopped: true };
    }

    case "SET_PLAYBACK_RATE": {
      const tab = await activeTab();
      if (tab?.id) {
        await sendToTab(tab.id, {
          target: "content",
          type: "SET_PLAYBACK_RATE",
          playbackRate: message.playbackRate,
        });
      }
      return { ok: true };
    }

    default:
      throw new Error(`Bilinmeyen mesaj: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return false;
  handleMessage(message, sender).then(
    (data) => sendResponse({ ok: true, ...data }),
    (error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
  );
  return true;
});
