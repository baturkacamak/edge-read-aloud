import "./library.js";
import "./settings.js";
import "./vault.js";
import "./tools.js";
const library = globalThis.SesliOkuLibrary;
import { tts, listVoices } from "./tts.js";

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
  return globalThis.SesliOkuSettings.normalize(settings);
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
      files: ["src/themes.js", "src/library.js", "src/settings.js", "src/tools.js", "src/experience.js", "src/content.js"],
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
  await library.ready;
  const queueOwner = library.current().queueTabId;
  if (library.current().queueRunning) {
    await library.mutate({ type: "queueStop" }); await chrome.alarms.clear(QUEUE_ALARM);
    if (queueOwner && queueOwner !== tab.id) { try { await sendToTab(queueOwner, { target: "content", type: "STOP", keepQueue: true }); } catch {} }
  }
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

function initializeExtension() {
  createMenus();
  // Sleep timers belong to live playback sessions, not browser restarts.
  chrome.storage.local.remove("readingTimer").catch(() => {});
  library.mutate({ type: "queueStop" }).catch(() => {});
  library.mutate({ type: "export", value: null }).catch(() => {});
  globalThis.SesliOkuVault.list().then(books=>Promise.all(books.filter(book=>book.status==='working').map(book=>globalThis.SesliOkuVault.remove(book.id)))).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(initializeExtension);
chrome.runtime.onStartup.addListener(initializeExtension);

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
    chrome.storage.local.remove("readingTimer").catch(() => {});
  }
  if (library.current().queueTabId === tabId) library.mutate({ type: "queueStop" }).catch(() => {});
  if (library.current().export?.tabId === tabId) {const id=library.current().export.bookId;if(id)globalThis.SesliOkuVault.remove(id).catch(()=>{});library.mutate({ type: "export", value: { status: "canceled" } }).catch(() => {});}
  globalThis.SesliOkuVault.list().then(books=>Promise.all(books.filter(book=>book.status==='working'&&book.ownerTabId===tabId).map(book=>globalThis.SesliOkuVault.remove(book.id)))).catch(()=>{});
  queueStarted.delete(tabId);
});

const QUEUE_ALARM = "sesli-oku-queue-load";
let queueBusy = false;
const queueStarted = new Map();

async function advanceQueue() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    await library.ready;
    let value = library.current();
    if (!value.queueRunning) return;
    const next = value.queue.find(item => item.status === "pending");
    if (!next) { await library.mutate({ type: "queueStop" }); await chrome.alarms.clear(QUEUE_ALARM); return; }
    let tab = null;
    if (value.queueTabId) {
      try { tab = await chrome.tabs.get(value.queueTabId); } catch {}
    }
    queueStarted.delete(value.queueTabId);
    // Record the item before navigation, so content-ready messages can be
    // matched to the current URL rather than a previous document in the tab.
    await library.mutate({ type: "queueState", id: next.id, status: "loading", itemId: next.id, tabId: null });
    tab = tab ? await chrome.tabs.update(tab.id, { url: next.url, active: true }) : await chrome.tabs.create({ url: next.url, active: true });
    await library.mutate({ type: "queueState", tabId: tab.id });
    chrome.alarms.create(QUEUE_ALARM, { when: Date.now() + 60000 });
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") setTimeout(() => startQueuePage(tab.id), 0);
  } finally { queueBusy = false; }
}

async function startQueuePage(tabId) {
  await library.ready;
  const value = library.current(); const item = value.queue.find(entry => entry.id === value.queueItemId);
  if (!value.queueRunning || value.queueTabId !== tabId || !item || item.status !== "loading" || queueStarted.get(tabId) === item.id) return;
  queueStarted.set(tabId, item.id);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete") { queueStarted.delete(tabId); return; }
    const settings = await getSettings();
    if (!library.current().queueRunning || library.current().queueItemId !== item.id) return;
    readingTabId = tabId;
    const result = await sendToTab(tabId, { target: "content", type: "START_PAGE", settings, queueItemId: item.id });
    if (!library.current().queueRunning || library.current().queueItemId !== item.id) return;
    if (result?.started === false) throw new Error("Bu sayfada okunacak metin bulunamadı.");
    await library.mutate({ type: "queueState", id: item.id, status: "reading" });
    await chrome.alarms.clear(QUEUE_ALARM);
  } catch (error) {
    await library.mutate({ type: "queueState", id: item.id, status: "error", error: error.message });
    queueStarted.delete(tabId); await advanceQueue();
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") startQueuePage(tabId).catch(error => console.warn("[Sesli Oku]", error));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== QUEUE_ALARM) return;
  library.ready.then(async () => {
    const value = library.current();
    if (!value.queueRunning || !value.queueItemId) return;
    const item = value.queue.find(entry => entry.id === value.queueItemId);
    if (item?.status !== "loading") return;
    await library.mutate({ type: "queueState", id: item.id, status: "error", error: "Sayfa yükleme zaman aşımı." });
    queueStarted.delete(value.queueTabId); await advanceQueue();
  }).catch(error => console.warn("[Sesli Oku]", error));
});

async function senderTabId(sender) {
  if(sender?.tab?.id)return sender.tab.id;
  if(sender?.url?.startsWith(chrome.runtime.getURL('src/reader.html'))){const tabs=await chrome.tabs.query({});return tabs.find(tab=>tab.url===sender.url)?.id;}
  return undefined;
}
async function libraryAction(message, sender) {
  const { action, args = {} } = message;
  const tab = sender?.tab?.id ? sender.tab : await activeTab();
  const context = { url: sender?.tab?.id ? sender.url || tab?.url : tab?.url, title: tab?.title || "Sayfa" };
  if (action === "context") {
    if(context.url?.startsWith(chrome.runtime.getURL('src/reader.html'))){const id=new URL(context.url).searchParams.get('book');if(id){const book=await globalThis.SesliOkuVault.get(id);if(book?.kind==='audio')context.speech=book.settings;}}
    return { context };
  }
  if (action === 'backup') return {backup:await globalThis.SesliOkuTools.backup(),message:'Yedek indiriliyor.'};
  if (action === 'restore') { const owner=library.current().queueTabId;const parsed=globalThis.SesliOkuTools.validateBackup(args.backup);if(!parsed)throw new Error('Geçersiz yedek.');if(owner){try{await sendToTab(owner,{target:'content',type:'STOP'});}catch{}}return globalThis.SesliOkuTools.restore(args.backup); }
  if (action === 'siteSave') { await library.mutate({type:action,...args});return {message:'Bu sitenin ayarları kaydedildi.'}; }
  if (action === 'siteRemove' || action === 'itemEdit') { await library.mutate({type:action,...args});return {message:'Kitaplık güncellendi.'}; }
  if (action === 'vaultList') return {books:await globalThis.SesliOkuVault.list()};
  if (action === 'bookRemove') {await globalThis.SesliOkuVault.remove(args.id);return {message:'Yerel kayıt silindi.'};}
  if (action === 'openReader' || action === 'bookOpen') {await chrome.tabs.create({url:chrome.runtime.getURL('src/reader.html')+(args.id?'?book='+encodeURIComponent(args.id):''),active:true});return {message:'Belge okuyucusu açıldı.'};}
  if (action === "queueAddUrl") { await library.mutate({ type: "queueAdd", url: args.url, title: args.title }); return { message: "Okuma listesine eklendi." }; }
  if (action === "queueStart") {
    if (library.current().queueRunning) return { message: "Okuma sırası zaten çalışıyor." };
    await library.mutate({ type: "queueStart" }); await advanceQueue(); return { message: "Okuma sırası başlatıldı." };
  }
  if (action === "queueStop") {
    const owner = library.current().queueTabId;
    await library.mutate({ type: "queueStop" }); await chrome.alarms.clear(QUEUE_ALARM);
    if (owner) { try { await sendToTab(owner, { target: "content", type: "STOP" }); } catch {} }
    return { message: "Okuma sırası durduruldu." };
  }
  if (["queueMove", "queueRemove", "bookmarkRemove", "excludeRemove"].includes(action)) {
    const old = library.current();
    await library.mutate({ type: action, ...args });
    if (action === "queueRemove" && old.queueItemId === args.id && old.queueRunning) {
      if (old.queueTabId) { try { await sendToTab(old.queueTabId, { target: "content", type: "STOP", keepQueue: true }); } catch {} }
      await advanceQueue();
    }
    return { message: "Kitaplık güncellendi." };
  }
  if (action === "bookmarkOpen") {
    const item = library.current().bookmarks.find(entry => entry.id === args.id);
    if (!item) throw new Error("Yer imi bulunamadı.");
    if (context.url && library.pageKey(context.url) === library.pageKey(item.url) && tab?.id) return sendToTab(tab.id, { target: "content", type: "LIBRARY_ACTION", action: "resume", args: { anchor: item.anchor } });
    const created = await chrome.tabs.create({ url: item.url, active: true });
    await chrome.storage.session.set({ [`resume-${created.id}`]: item.anchor });
    const opened = await chrome.tabs.get(created.id);
    if (opened.status === "complete") { await chrome.storage.session.remove(`resume-${created.id}`); await sendToTab(created.id, { target: "content", type: "LIBRARY_ACTION", action: "resume", args: { anchor: item.anchor } }); }
    return { message: "Yer imi yeni sekmede açılıyor." };
  }
  if (action === "cancelExport" && library.current().export?.tabId) return sendToTab(library.current().export.tabId, { target: "content", type: "LIBRARY_ACTION", action, args });
  if (!tab?.id) throw new Error("Etkin sayfa bulunamadı.");
  return sendToTab(tab.id, { target: "content", type: "LIBRARY_ACTION", action, args });
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "LIBRARY_MUTATE": {
      const operation = message.operation;
      if (operation?.type === "export" && operation.value?.status === "working") operation.value.tabId = await senderTabId(sender);
      return { library: await library.mutate(operation) };
    }
    case "LIBRARY_ACTION": await library.ready; return libraryAction(message, sender);
    case "CONTENT_READY": {
      const tabId = sender?.tab?.id;
      if (tabId) {
        const key = `resume-${tabId}`; const stored = await chrome.storage.session.get(key);
        if (stored[key]) { await chrome.storage.session.remove(key); await sendToTab(tabId, { target: "content", type: "LIBRARY_ACTION", action: "resume", args: { anchor: stored[key] } }); }
        else await startQueuePage(tabId);
      }
      return {};
    }
    case "READING_FAILED":
    case "READING_FINISHED": {
      tts.close();
      const value = library.current();
      if (value.queueRunning && value.queueTabId === sender?.tab?.id && value.queueItemId === message.queueItemId) {
        await library.mutate({ type: "queueState", id: value.queueItemId, status: message.type === "READING_FAILED" ? "error" : "done", error: message.error, itemId: null });
        queueStarted.delete(sender.tab.id); await advanceQueue();
      }
      if (sender?.tab?.id === readingTabId) readingTabId = null;
      return {};
    }
    case 'VAULT_BEGIN': return {book:await globalThis.SesliOkuVault.begin({...message.value,ownerTabId:await senderTabId(sender)})};
    case 'VAULT_PART': await globalThis.SesliOkuVault.putPart(message.id,message.index,message.part);return {};
    case 'VAULT_FINISH': return await globalThis.SesliOkuVault.finish(message.id);
    case 'VAULT_REMOVE': await globalThis.SesliOkuVault.remove(message.id);return {};
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
      if (!message.keepQueue && library.current().queueTabId === sender?.tab?.id) { await library.mutate({ type: "queueStop" }); await chrome.alarms.clear(QUEUE_ALARM); }
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

    case "SET_SLEEP_TIMER": {
      const tabId = readingTabId || (await activeTab())?.id;
      if (!tabId) throw new Error("Önce okumayı başlatın.");
      return sendToTab(tabId, { target: "content", type: "SET_SLEEP_TIMER", timer: message.timer });
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
