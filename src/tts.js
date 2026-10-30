/**
 * Microsoft Edge Read Aloud WebSocket client.
 *
 * Runs inside the extension's service worker, so the browser sends Edge's own
 * user agent and an extension origin — both required by the service. Audio is
 * returned as MP3 bytes together with word-boundary metadata.
 *
 * Protocol ported from rany2/edge-tts (GPL-3.0). See NOTICE.
 */

import {
  TRUSTED_CLIENT_TOKEN,
  SEC_MS_GEC_VERSION,
  generateSecMsGecV2,
} from "./drm.js";

const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const WSS_URL = `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICES_URL = `https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

export const DEFAULT_VOICE = "tr-TR-EmelNeural";
export const DEFAULT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const decoder = new TextDecoder();

function randomHex(bytes = 16) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function percent(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${Math.round(number)}%`;
}

function hertz(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${Math.round(number)}Hz`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Same format the native Edge client sends in X-Timestamp headers. */
function edgeTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${pad(now.getUTCDate())} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:` +
    `${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function configMessage() {
  return (
    `X-Timestamp:${edgeTimestamp()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: "false",
              wordBoundaryEnabled: "true",
            },
            outputFormat: DEFAULT_FORMAT,
          },
        },
      },
    }) +
    "\r\n"
  );
}

function appendMetadata(request, jsonText) {
  if (!jsonText) return;
  try {
    const payload = JSON.parse(jsonText);
    for (const item of payload.Metadata || []) {
      if (item?.Type === "WordBoundary" && item.Data) {
        request.boundaries.push({
          offset: item.Data.Offset,
          duration: item.Data.Duration,
          text: item.Data.text?.Text || "",
        });
      }
    }
  } catch {
    // A malformed metadata frame should not kill the utterance.
  }
}

class EdgeTtsClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.connecting = null;
    this.voice = DEFAULT_VOICE;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async ensureConnected() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const token = await generateSecMsGecV2();
      const url =
        `${WSS_URL}&Sec-MS-GEC=${token}` +
        `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
        `&ConnectionId=${randomHex()}`;

      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          try {
            socket.close();
          } catch {}
          reject(new Error("Microsoft ses servisine bağlanılamadı (zaman aşımı)."));
        }, 15000);

        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(
            new Error(
              "Microsoft ses servisi bağlantıyı reddetti. Token algoritması değişmiş olabilir."
            )
          );
        };
        const onClose = (event) => {
          cleanup();
          reject(
            new Error(
              `Microsoft ses servisi bağlantıyı kapattı (${event.code || "?"}).`
            )
          );
        };

        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      });

      socket.addEventListener("message", (event) => this.onMessage(event));
      socket.addEventListener("close", () => {
        if (this.ws === socket) this.onSocketClosed();
      });
      socket.addEventListener("error", () => {
        if (this.ws === socket) this.onSocketClosed();
      });

      this.ws = socket;
      socket.send(configMessage());
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  rejectPending(message) {
    for (const [, request] of this.pending) {
      request.reject(new Error(message));
    }
    this.pending.clear();
  }

  onSocketClosed() {
    this.ws = null;
    this.rejectPending("Ses bağlantısı kesildi.");
  }

  onMessage(event) {
    const isText = typeof event.data === "string";
    let head;
    let body = null;

    if (isText) {
      head = event.data;
    } else {
      const buffer = new Uint8Array(event.data);
      // Binary frames start with a two-byte big-endian header length.
      const headerLength = (buffer[0] << 8) | buffer[1];
      if (headerLength <= 0 || 2 + headerLength > buffer.length) return;
      head = decoder.decode(buffer.subarray(2, 2 + headerLength));
      body = buffer.subarray(2 + headerLength);
    }

    const requestId = /X-RequestId:([^\r\n]+)/.exec(head)?.[1];
    if (!requestId) return;
    const request = this.pending.get(requestId);
    if (!request) return;

    if (head.includes("Path:turn.start")) {
      request.audio = [];
      request.boundaries = [];
      return;
    }

    if (head.includes("Path:turn.end")) {
      this.pending.delete(requestId);
      const total = request.audio.reduce((sum, part) => sum + part.length, 0);
      const audio = new Uint8Array(total);
      let offset = 0;
      for (const part of request.audio) {
        audio.set(part, offset);
        offset += part.length;
      }
      request.resolve({ audio, boundaries: request.boundaries });
      return;
    }

    if (head.includes("Path:audio.metadata")) {
      if (isText) {
        const separator = head.indexOf("\r\n\r\n");
        if (separator >= 0) appendMetadata(request, head.slice(separator + 4));
      } else if (body) {
        appendMetadata(request, decoder.decode(body));
      }
      return;
    }

    if (isText) return;

    if (head.includes("Path:audio") && body) {
      request.audio.push(body);
    }
  }

  async speak(text, options = {}) {
    const voice = options.voice || DEFAULT_VOICE;
    const rate = percent(options.rate);
    const pitch = hertz(options.pitch);
    const volume = percent(options.volume);

    const requestId = randomHex();
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
      `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voice.slice(0, 5)}">` +
      `<voice name="${voice}">` +
      `<prosody pitch="${pitch}" rate="${rate}" volume="${volume}">` +
      escapeXml(text) +
      `</prosody></voice></speak>`;

    const message =
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${edgeTimestamp()}Z\r\n` +
      `Path:ssml\r\n\r\n${ssml}`;

    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Reconnect if the worker was suspended or the service closed the
        // socket between two paragraphs.
        if (!this.connected) {
          this.close();
          await this.ensureConnected();
        }

        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error("Ses üretimi zaman aşımına uğradı."));
          }, 60000);

          this.pending.set(requestId, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
            audio: [],
            boundaries: [],
          });

          try {
            this.ws.send(message);
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            reject(error);
          }
        });
      } catch (error) {
        lastError = error;
        this.close();
        // A token produced just before a five-minute window boundary can be
        // stale; regenerate once with the current clock.
        if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
      }
    }
    throw lastError;
  }

  close() {
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
    this.rejectPending("Ses bağlantısı kapatıldı.");
  }
}

export const tts = new EdgeTtsClient();
export async function listVoices() {
  const response = await fetch(VOICES_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Ses listesi alınamadı (${response.status}).`);
  const voices = await response.json();
  if (!Array.isArray(voices)) throw new Error("Ses listesi biçimi beklenmedik.");
  return voices;
}
