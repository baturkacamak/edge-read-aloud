/**
 * Integration tests for the Sesli Oku content script.
 *
 * Requirements:
 *   - Microsoft Edge installed as `microsoft-edge` (or EDGE_BIN set)
 *   - `npm install` once (only dev dependency: ws)
 *
 * Run:
 *   npm test
 *
 * The test launches a throwaway Edge profile with the extension loaded, serves
 * tests/fixture.html and drives the content script through its isolated-world
 * test hook. No network or Microsoft service is required for the assertions.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = process.env.EDGE_BIN || "microsoft-edge";
const SERVER_TIMEOUT = 25000;
const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${details ? ` — ${details}` : ""}`);
    console.log(`  ✗ ${name}${details ? ` — ${details}` : ""}`);
  }
}

function approx(actual, expected, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance;
}

async function waitFor(label, fn, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Retry while the page/extension is still booting.
    }
    await WAIT(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function connectCDP(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    const listeners = [];

    ws.on("open", () => {
      resolve({
        send(method, params = {}) {
          const id = ++nextId;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        onEvent(fn) {
          listeners.push(fn);
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(JSON.stringify(message.error)));
        else res(message.result);
      } else {
        listeners.forEach((fn) => fn(message));
      }
    });

    ws.on("error", reject);
  });
}

async function json(url, options) {
  const response = await fetch(url, options);
  return response.json();
}

async function findDevToolsPort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").split("\n");
      if (port) return Number(port);
    }
    await WAIT(100);
  }
  throw new Error("Edge did not expose a DevTools port");
}

async function main() {
  const fixture = await readFile(path.join(ROOT, "tests", "fixture.html"));
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/fixture.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixture);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;
  const fixtureUrl = `http://127.0.0.1:${serverPort}/fixture.html?sesliOkuTest=1`;

  const profile = mkdtempSync(path.join(tmpdir(), "sesli-oku-test-"));
  let edge;
  let pageCdp;
  let pageTarget;
  let popupCdp;
  let popupTarget;

  try {
    edge = spawn(
      EDGE,
      [
        "--headless=new",
        "--disable-gpu",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        `--user-data-dir=${profile}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    edge.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const port = await findDevToolsPort(profile);
    await waitFor("DevTools HTTP endpoint", async () => {
      try {
        await json(`http://127.0.0.1:${port}/json/version`);
        return true;
      } catch {
        return false;
      }
    }, SERVER_TIMEOUT);

    const target = await json(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(fixtureUrl)}`,
      { method: "PUT" }
    );
    pageTarget = target;

    await WAIT(1500);
    pageCdp = await connectCDP(target.webSocketDebuggerUrl);
    const contexts = [];
    pageCdp.onEvent((message) => {
      if (message.method === "Runtime.executionContextCreated") {
        contexts.push(message.params.context);
      }
    });
    await pageCdp.send("Runtime.enable");

    let activeContext = await waitFor(
      "extension isolated world",
      () => contexts.find((context) => context.auxData?.type === "isolated"),
      8000
    );

    const evalIso = async (expression, awaitPromise = false) => {
      const result = await pageCdp.send("Runtime.evaluate", {
        contextId: activeContext.id,
        expression,
        awaitPromise,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text
        );
      }
      return result.result.value;
    };

    await waitFor("content test hook", async () =>
      evalIso("typeof window.__sesliOkuTest === 'object'")
    );

    const snapshot = () => evalIso("JSON.stringify(__sesliOkuTest.snapshot())").then(JSON.parse);

    console.log("\nSesli Oku integration tests\n");

    // Simulate leftovers from a previous extension version: an old host and
    // an old fixed spotlight element are still in the DOM.
    await pageCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const host = document.createElement("div");
        host.id = "sesli-oku-host";
        host.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;";
        document.documentElement.appendChild(host);
        const spot = document.createElement("div");
        spot.id = "sesli-oku-spotlight";
        spot.style.cssText = "position:fixed;left:20px;top:20px;width:80px;height:24px;opacity:1;background:#d9f27a;";
        document.documentElement.appendChild(spot);
      })()`,
    });

    await evalIso(
      `__sesliOkuTest.start({ voice: "tr-TR-EmelNeural", rate: 0, volume: 0, pitch: 0 })`
    );
    await waitFor("player UI", async () => (await snapshot()).hosts >= 1);
    await evalIso("__sesliOkuTest.pause()");
    await waitFor("test word", async () =>
      evalIso(`__sesliOkuTest.showWord("#p2", 0, 6)`)
    );
    await WAIT(400);

    let state = await snapshot();
    check("stale host removed", state.hosts === 1, `hosts=${state.hosts}`);
    check(
      "stale spotlight removed",
      state.spotlights === 1,
      `spotlights=${state.spotlights}`
    );

    // The toolbar stays fixed while a separate root offset reserves its space.
    const normalContentTop = await evalIso(`(() => {
      const node = document.querySelector("h1");
      return node ? node.getBoundingClientRect().top + window.scrollY : null;
    })()`);
    check(
      "top bar is fixed above the document body",
      state.hostParent === "HTML" && state.hostPosition === "fixed",
      `parent=${state.hostParent} position=${state.hostPosition}`
    );
    check(
      "page starts below the top bar",
      normalContentTop != null &&
        !!state.hostRect &&
        normalContentTop >= state.hostRect.height - 1,
      JSON.stringify({ contentTop: normalContentTop, host: state.hostRect })
    );

    await evalIso("window.scrollTo(0, 300)");
    await WAIT(300);
    state = await snapshot();
    check(
      "top bar stays at the viewport top while the page scrolls",
      !!state.hostRect && approx(state.hostRect.top, 0),
      JSON.stringify(state.hostRect)
    );
    // WordPress reserves an HTML margin for its own fixed admin bar. Our
    // controls must remain above both, including transformed page roots.
    await evalIso(`(() => {
      document.documentElement.style.marginTop = "32px";
      document.documentElement.style.transform = "translateX(0px)";
      const header = document.createElement("nav");
      header.id = "test-admin-bar";
      header.style.cssText = "position:fixed;top:0!important;left:0;right:0;height:32px;background:#30343a;z-index:2147483647";
      document.body.prepend(header);
    })()`);
    await WAIT(250);
    check("toolbar paints in the top layer above HTML", await evalIso(`(() => {
      const host = document.querySelector("#sesli-oku-host");
      return host.matches(":popover-open") && Math.abs(host.getBoundingClientRect().top) < 1;
    })()`));
    await evalIso(`document.documentElement.style.removeProperty("transform")`);
    check("site fixed admin bar shifts below the toolbar", await evalIso(`(() => {
      const host = document.querySelector("#sesli-oku-host").getBoundingClientRect();
      const admin = document.querySelector("#test-admin-bar").getBoundingClientRect();
      return admin.top >= host.bottom - 1;
    })()`));
    await evalIso(`document.querySelector("#test-admin-bar").remove(); document.documentElement.style.removeProperty("margin-top"); document.documentElement.style.removeProperty("transform")`);
    await WAIT(150);
    await evalIso("window.scrollTo(0, 0)");
    await WAIT(300);
    if (process.env.SCREENSHOT_DIR) {
      const shot = await pageCdp.send("Page.captureScreenshot", {
        format: "png",
      });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.SCREENSHOT_DIR, "normal-top.png"),
        Buffer.from(shot.data, "base64")
      );
    }

    // A second stale overlay injected mid-session must not survive the next
    // word update.
    await pageCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const spot = document.createElement("div");
        spot.id = "sesli-oku-spotlight";
        spot.style.cssText = "position:fixed;left:300px;top:300px;width:60px;height:20px;opacity:1;background:#d9f27a;";
        document.documentElement.appendChild(spot);
      })()`,
    });
    await evalIso(`__sesliOkuTest.showWord("#p3", 0, 6)`);
    await WAIT(400);
    state = await snapshot();
    check(
      "mid-session duplicate spotlight removed",
      state.spotlights === 1,
      `spotlights=${state.spotlights}`
    );
    check("single paragraph highlight", state.current === 1, `current=${state.current}`);

    // Alignment: the spotlight is a padded box around the word. Disable
    // auto-follow so headless smooth scrolling cannot move the target rect
    // while the assertion runs.
    await evalIso("__sesliOkuTest.setFollow(false)");
    await evalIso(`__sesliOkuTest.showWord("#p2", 0, 6)`);
    await WAIT(400);
    state = await snapshot();
    const aligned =
      state.wordRect &&
      state.spotlightRect &&
      approx(state.spotlightRect.left, state.wordRect.left - 7, 3) &&
      approx(state.spotlightRect.top, state.wordRect.top - 5, 3) &&
      approx(state.spotlightRect.width, state.wordRect.width + 14, 3) &&
      approx(state.spotlightRect.height, state.wordRect.height + 10, 3);
    check("spotlight aligned to current word", !!aligned, JSON.stringify({
      word: state.wordRect,
      spotlight: state.spotlightRect,
      style: state.spotlightStyle,
    }));

    // A real mouse wheel should pause following and keep the overlay glued.
    await evalIso("__sesliOkuTest.setFollow(true)");
    const beforeScroll = await snapshot();
    await pageCdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 360,
      y: 420,
      deltaX: 0,
      deltaY: 700,
      modifiers: 0,
      pointerType: "mouse",
    });
    await WAIT(500);
    state = await snapshot();
    check(
      "wheel pauses follow",
      state.follow === false,
      `follow=${state.follow}`
    );
    check(
      "resume control appears",
      state.followVisible === true,
      `visible=${state.followVisible}`
    );
    check(
      "wheel changes scroll position",
      state.scrollY > beforeScroll.scrollY,
      `before=${beforeScroll.scrollY} after=${state.scrollY}`
    );
    check(
      "one spotlight after scrolling",
      state.spotlights === 1,
      `spotlights=${state.spotlights}`
    );

    const scrollAfterWheel = state.scrollY;
    await evalIso(`__sesliOkuTest.showWord("#p7", 0, 6)`);
    await WAIT(40);
    state = await snapshot();
    check(
      "paused follow does not yank scroll",
      approx(state.scrollY, scrollAfterWheel, 4),
      `before=${scrollAfterWheel} after=${state.scrollY}`
    );
    check(
      "new word does not create a second glow",
      state.spotlights === 1,
      `spotlights=${state.spotlights}`
    );
    const pausedAligned =
      state.wordRect &&
      state.spotlightRect &&
      approx(state.spotlightRect.left, state.wordRect.left - 7, 3) &&
      approx(state.spotlightRect.top, state.wordRect.top - 5, 3);
    check(
      "paused scroll keeps glow on the current word",
      !!pausedAligned,
      JSON.stringify({ word: state.wordRect, spotlight: state.spotlightRect, style: state.spotlightStyle })
    );

    // Resume must restore following and hide the resume control.
    await evalIso("__sesliOkuTest.resume()");
    await WAIT(900);
    state = await snapshot();
    check("resume restores follow", state.follow === true, `follow=${state.follow}`);
    check(
      "resume hides control",
      state.followVisible === false,
      `visible=${state.followVisible}`
    );

    // The common real-world case: reading continues while the user has
    // scrolled far away, then taps "Okumaya dön". The page must travel back to
    // the word that is being spoken, not stay where the user left it.
    await evalIso("__sesliOkuTest.setFollow(true)");
    await pageCdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 360,
      y: 420,
      deltaX: 0,
      deltaY: 4000,
      modifiers: 0,
      pointerType: "mouse",
    });
    await WAIT(600);
    state = await snapshot();
    check(
      "wheel scrolled far from the reading position",
      state.follow === false && state.scrollY > 400,
      `follow=${state.follow} scrollY=${state.scrollY}`
    );

    // The spoken word is far above the viewport when the user taps resume.
    await evalIso(`__sesliOkuTest.showWord("#p3", 0, 6)`);
    await WAIT(200);
    const beforeResume = await snapshot();
    await evalIso("__sesliOkuTest.resume()");
    await WAIT(800);
    state = await snapshot();
    const panelTop = state.innerHeight - 196;
    const anchor = Math.max(108, Math.round(state.innerHeight * 0.32));
    check(
      "resume re-centers the spoken word",
      !!(
        state.wordRect &&
        approx(state.wordRect.top, anchor, 32) &&
        state.wordRect.bottom <= panelTop
      ),
      JSON.stringify({
        before: beforeResume.scrollY,
        after: state.scrollY,
        anchor,
        panelTop,
        word: state.wordRect,
      })
    );

    // Reading keeps advancing while the user is away.
    await evalIso(`(() => {
      const ids = ["#p4", "#p5", "#p6", "#p7", "#p8", "#p9"];
      let turn = 0;
      window.__readingTimer = setInterval(() => {
        __sesliOkuTest.showWord(ids[turn % ids.length], 0, 6);
        turn++;
      }, 320);
      __sesliOkuTest.showWord(ids[0], 0, 6);
    })()`);
    await WAIT(1900);
    await evalIso("clearInterval(window.__readingTimer)");
    state = await snapshot();

    // The fixture has a fixed 180px bottom panel (like Gemini's composer).
    // The spoken word must stay above it, not merely above window.innerHeight.
    const safeBottom = state.innerHeight - 196;
    const wordInView =
      state.wordRect &&
      state.wordRect.top >= 0 &&
      state.wordRect.bottom <= safeBottom;
    check(
      "resume scrolls back to the spoken word",
      !!wordInView,
      JSON.stringify({
        before: beforeResume.scrollY,
        after: state.scrollY,
        safeBottom,
        innerHeight: state.innerHeight,
        word: state.wordRect,
      })
    );
    check(
      "resume keeps the glow on the spoken word",
      !!(
        wordInView &&
        state.spotlightRect &&
        approx(state.spotlightRect.left, state.wordRect.left - 7, 3) &&
        approx(state.spotlightRect.top, state.wordRect.top - 5, 3)
      ),
      JSON.stringify({ word: state.wordRect, spotlight: state.spotlightRect })
    );

    // ------------------------------------------------- inner scroll container
    // Gemini-style apps keep the article in their own overflow container and
    // never scroll the window. window.scrollBy() is a no-op there.
    console.log("\n  Inner scroll container");
    const contextCount = contexts.length;
    await pageCdp.send("Page.navigate", { url: `${fixtureUrl}&inner=1` });
    activeContext = await waitFor(
      "isolated world after navigation",
      () =>
        contexts
          .slice(contextCount)
          .find((context) => context.auxData?.type === "isolated"),
      10000
    );
    await waitFor("test hook after navigation", async () =>
      evalIso("typeof window.__sesliOkuTest === 'object'")
    );

    await evalIso(
      `__sesliOkuTest.start({ voice: "tr-TR-EmelNeural", rate: 0, volume: 0, pitch: 0 })`
    );
    await waitFor("inner player UI", async () => (await snapshot()).hosts >= 1);
    await evalIso("__sesliOkuTest.pause()");
    await evalIso(`__sesliOkuTest.showWord("#p1", 0, 6)`);
    await WAIT(400);

    state = await snapshot();
    check(
      "inner layout uses a scroll container",
      state.scroller && state.scroller.window === false &&
        state.scroller.id === "reader",
      JSON.stringify(state.scroller)
    );

    await pageCdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 360,
      y: 150,
      deltaX: 0,
      deltaY: 500,
      modifiers: 0,
      pointerType: "mouse",
    });
    await WAIT(500);
    state = await snapshot();
    check(
      "wheel scrolls the inner container",
      state.scroller.scrollTop > 0,
      `scrollTop=${state.scroller.scrollTop}`
    );
    check(
      "inner wheel pauses follow",
      state.follow === false,
      `follow=${state.follow}`
    );

    // Put the spoken word above the inner viewport, then resume.
    await evalIso(`__sesliOkuTest.showWord("#p2", 0, 6)`);
    await WAIT(200);
    const innerBefore = await snapshot();
    await evalIso("__sesliOkuTest.resume()");
    await WAIT(900);
    state = await snapshot();
    const innerLimit = Math.min(state.scroller.bottom, state.innerHeight - 196);
    check(
      "resume scrolls the inner container",
      state.scroller.scrollTop < innerBefore.scroller.scrollTop,
      `before=${innerBefore.scroller.scrollTop} after=${state.scroller.scrollTop}`
    );
    check(
      "inner word is visible above the panel",
      !!(
        state.wordRect &&
        state.wordRect.top >= state.scroller.top &&
        state.wordRect.bottom <= innerLimit
      ),
      JSON.stringify({
        word: state.wordRect,
        scroller: state.scroller,
        innerLimit,
      })
    );

    // Auto-follow must move the container as reading advances.
    await evalIso(`(() => {
      const ids = ["#p6", "#p7", "#p8", "#p9"];
      let turn = 0;
      window.__readingTimer = setInterval(() => {
        __sesliOkuTest.showWord(ids[turn % ids.length], 0, 6);
        turn++;
      }, 320);
    })()`);
    const containerStart = state.scroller.scrollTop;
    await WAIT(1900);
    await evalIso("clearInterval(window.__readingTimer)");
    state = await snapshot();
    check(
      "inner container follows the reading",
      state.scroller.scrollTop > containerStart,
      `before=${containerStart} after=${state.scroller.scrollTop}`
    );
    check(
      "inner followed word stays above the panel",
      !!(
        state.wordRect &&
        state.wordRect.top >= state.scroller.top &&
        state.wordRect.bottom <=
          Math.min(state.scroller.bottom, state.innerHeight - 196)
      ),
      JSON.stringify({ word: state.wordRect, scroller: state.scroller })
    );

    // ------------------------------------------------------ top player layout
    // A fixed top-layer toolbar reserves space above the site's root content.
    console.log("\n  Top player layout");
    await evalIso(`(() => {
      const header = document.createElement("nav");
      header.id = "test-fixed-header";
      header.style.cssText = "position:fixed;top:0px!important;left:0;right:0;height:32px;background:#30343a";
      document.body.prepend(header);
    })()`);
    await WAIT(150);
    state = await snapshot();
    check(
      "player is a fixed top bar",
      state.hostPosition === "fixed" &&
        state.hostParent === "HTML",
      `position=${state.hostPosition} parent=${state.hostParent}`
    );
    check(
      "player has a real layout height",
      !!state.hostRect && state.hostRect.height > 40,
      JSON.stringify(state.hostRect)
    );
    const playerHeight = state.hostRect.height;
    const contentTop = await evalIso(`(() => {
      const node = document.querySelector("#reader") || document.querySelector("h1");
      return node ? node.getBoundingClientRect().top : null;
    })()`);
    check(
      "page content starts below the player",
      !!state.hostRect &&
        contentTop != null &&
        contentTop >= state.hostRect.bottom - 1,
      JSON.stringify({ contentTop, host: state.hostRect })
    );

    await evalIso("__sesliOkuTest.toggleSettings(true)");
    await WAIT(150);
    state = await snapshot();
    check(
      "settings panel opens from the player",
      state.settingsOpen === true,
      `open=${state.settingsOpen}`
    );
    const expandedContentTop = await evalIso(`document.querySelector("#reader").getBoundingClientRect().top`);
    check(
      "settings push the page down instead of covering it",
      state.hostRect.height > playerHeight + 40 &&
        approx(expandedContentTop - contentTop, state.hostRect.height - playerHeight),
      JSON.stringify({ contentTop, expandedContentTop, playerHeight, expandedHeight: state.hostRect.height })
    );
    check(
      "toolbar spans the viewport",
      await evalIso(`Math.abs(document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".wrap").getBoundingClientRect().width - document.documentElement.clientWidth) < 2`)
    );
    check("fixed site headers follow the expanded toolbar height", await evalIso(`(() => {
      const host = document.querySelector("#sesli-oku-host").getBoundingClientRect();
      return Math.abs(document.querySelector("#test-fixed-header").getBoundingClientRect().top - host.bottom) < 2;
    })()`));
    check(
      "settings panel includes a voice picker",
      state.settingsVoices >= 1,
      `options=${state.settingsVoices}`
    );
    if (process.env.SCREENSHOT_DIR) {
      const shot = await pageCdp.send("Page.captureScreenshot", {
        format: "png",
      });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.SCREENSHOT_DIR, "player-settings.png"),
        Buffer.from(shot.data, "base64")
      );
    }
    await evalIso("__sesliOkuTest.toggleSettings(false)");
    await WAIT(100);
    state = await snapshot();
    check(
      "settings panel closes",
      state.settingsOpen === false,
      `open=${state.settingsOpen}`
    );

    check(
      "closing settings returns the page to its previous position",
      approx(await evalIso(`document.querySelector("#reader").getBoundingClientRect().top`), contentTop)
    );

    if (process.env.SCREENSHOT_DIR) {
      const shot = await pageCdp.send("Page.captureScreenshot", {
        format: "png",
      });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.SCREENSHOT_DIR, "top-player.png"),
        Buffer.from(shot.data, "base64")
      );
    }

    // The controls and inline settings must still fit a phone-width viewport.
    await pageCdp.send("Emulation.setDeviceMetricsOverride", {
      width: 360, height: 780, deviceScaleFactor: 1, mobile: false,
    });
    await evalIso("__sesliOkuTest.setFollow(false); __sesliOkuTest.toggleSettings(true)");
    await WAIT(250);
    check(
      "narrow toolbar and settings fit the viewport",
      await evalIso(`(() => {
        const root = document.querySelector("#sesli-oku-host").shadowRoot;
        return [".wrap", ".bar", ".settings", "select", ".follow"].every(selector => {
          const element = root.querySelector(selector);
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1 &&
            element.scrollWidth <= element.clientWidth + 1;
        });
      })()`)
    );
    if (process.env.SCREENSHOT_DIR) {
      const shot = await pageCdp.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(process.env.SCREENSHOT_DIR, "narrow-player.png"), Buffer.from(shot.data, "base64"));
    }
    await evalIso("__sesliOkuTest.toggleSettings(false)");
    await pageCdp.send("Emulation.clearDeviceMetricsOverride");
    await WAIT(150);

    // ------------------------------------------------------ appearance themes
    console.log("\n  Appearance themes");
    const extensionId = await evalIso("chrome.runtime.id");
    await evalIso(`chrome.storage.local.set({ voicesCache: { at: Date.now(), voices: [{ ShortName: "tr-TR-EmelNeural", Locale: "tr-TR", Gender: "Female" }] } })`, true);
    popupTarget = await json(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/src/popup.html`)}`,
      { method: "PUT" }
    );
    popupCdp = await connectCDP(popupTarget.webSocketDebuggerUrl);
    await popupCdp.send("Emulation.setDeviceMetricsOverride", {
      width: 360, height: 700, deviceScaleFactor: 1, mobile: false,
    });
    await pageCdp.send("Page.bringToFront");
    const evalPopup = async expression => {
      const result = await popupCdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor("popup theme controls", () => evalPopup(`document.querySelector("#theme")?.options.length === 5`));
    check("popup and toolbar offer all five themes", await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-theme").options.length === 5`));
    const beforeTheme = await snapshot();
    const sitePanelColor = await evalIso(`getComputedStyle(document.querySelector("#bottom-panel")).backgroundColor`);
    for (const theme of ["win95", "win98", "xp", "win7", "modern"]) {
      await evalIso(`(() => {
        const select = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-theme");
        select.value = ${JSON.stringify(theme)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(`${theme} applies to toolbar`, () => evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".wrap").dataset.theme === ${JSON.stringify(theme)}`));
      await waitFor(`${theme} syncs to popup`, () => evalPopup(`document.body.dataset.theme === ${JSON.stringify(theme)} && document.querySelector("#theme").value === ${JSON.stringify(theme)}`));
      await WAIT(100);
      const themed = await snapshot();
      check(`${theme} preserves the reading session and pause state`, themed.session === beforeTheme.session && themed.paused === beforeTheme.paused && themed.index === beforeTheme.index && themed.follow === beforeTheme.follow);
      check(`${theme} keeps the toolbar fixed and page below it`, approx(themed.hostRect.top, 0) && await evalIso(`document.querySelector("#reader").getBoundingClientRect().top >= document.querySelector("#sesli-oku-host").getBoundingClientRect().bottom - 1`));
      check(`${theme} leaves site controls unthemed`, sitePanelColor === await evalIso(`getComputedStyle(document.querySelector("#bottom-panel")).backgroundColor`));
      if (theme !== "modern") {
        const expected = { win95: "rgb(192, 192, 192)", win98: "rgb(192, 192, 192)", xp: "rgb(236, 233, 216)", win7: "rgb(234, 241, 248)" }[theme];
        check(`${theme} applies its palette to both surfaces`,
          await evalIso(`getComputedStyle(document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".wrap")).getPropertyValue("--bg").trim() === ${JSON.stringify({ win95: "#c0c0c0", win98: "#c0c0c0", xp: "#ece9d8", win7: "#eaf1f8" }[theme])}`) &&
          await evalPopup(`getComputedStyle(document.body).backgroundColor === ${JSON.stringify(expected)}`));
      }
      if (theme !== "modern") {
        check(`${theme} centers player controls and keeps status compact`, await evalIso(`(() => {
          const root = document.querySelector("#sesli-oku-host").shadowRoot;
          const bar = root.querySelector(".bar").getBoundingClientRect();
          const transport = root.querySelector(".transport").getBoundingClientRect();
          const status = root.querySelector(".status").getBoundingClientRect();
          return Math.abs((transport.left + transport.right) / 2 - (bar.left + bar.right) / 2) < 2 &&
            status.width <= 161 && status.right <= transport.left;
        })()`));
      }
      if (theme === "win95" || theme === "win98") {
        await waitFor("classic pixel fonts", () => evalIso(`Array.from(document.fonts).filter(face => face.family === "Sesli Oku Classic" && face.status === "loaded").length === 2`));
        await waitFor("popup classic pixel fonts", () => evalPopup(`Array.from(document.fonts).filter(face => face.family === "Sesli Oku Classic" && face.status === "loaded").length === 2`));
        check(`${theme} uses the bundled classic font on both surfaces`, true);
        check(`${theme} uses a full title strip with compact controls`, await evalIso(`(() => {
          const root = document.querySelector("#sesli-oku-host").shadowRoot;
          const bar = root.querySelector(".bar").getBoundingClientRect();
          const title = root.querySelector(".brand").getBoundingClientRect();
          const close = root.querySelector("button.close").getBoundingClientRect();
          const button = getComputedStyle(root.querySelector("button.primary"));
          return Math.abs(bar.width - title.width) < 2 && close.top >= title.top && close.bottom <= title.bottom &&
            button.height === "28px" && button.borderRadius === "0px" && button.fontSize === "11px";
        })()`));
      }
      if (theme === "xp" || theme === "win7") {
        check(`${theme} has full window chrome with controls beneath the title`, await evalIso(`(() => {
          const root = document.querySelector("#sesli-oku-host").shadowRoot;
          const bar = root.querySelector(".bar").getBoundingClientRect();
          const title = root.querySelector(".brand").getBoundingClientRect();
          const transport = root.querySelector(".transport").getBoundingClientRect();
          const close = root.querySelector("button.close").getBoundingClientRect();
          const host = document.querySelector("#sesli-oku-host").getBoundingClientRect();
          return Math.abs(bar.width - title.width) < 2 && transport.top >= title.bottom &&
            close.top >= host.top && close.bottom <= title.bottom && close.right <= title.right + 1;
        })()`));
        check(`${theme} popup title and controls use compact era dimensions`, await evalPopup(`(() => {
          const header = document.querySelector("header").getBoundingClientRect();
          const logo = document.querySelector(".logo").getBoundingClientRect();
          const title = getComputedStyle(document.querySelector("h1"));
          const select = document.querySelector("#theme").getBoundingClientRect();
          return header.height <= 34 && logo.height === 18 && parseFloat(title.fontSize) <= 13 && select.height <= 25;
        })()`));
        check(`${theme} close control keeps its title-bar shape`, await evalIso(`(() => {
          const root = document.querySelector("#sesli-oku-host").shadowRoot;
          const close = getComputedStyle(root.querySelector("button.close"));
          return close.position === "absolute" && close.width === ${JSON.stringify(theme === "xp" ? "25px" : "43px")} &&
            close.height === ${JSON.stringify(theme === "xp" ? "25px" : "20px")};
        })()`));
      }
      if (theme === "win95") {
        await evalIso(`(() => {
          const style = document.createElement("style");
          style.id = "test-base-conflict";
          style.textContent = '@layer base { .wrap[data-theme="win95"] .bar .transport button.primary { background: magenta; border-radius: 999px; height: 99px; } }';
          document.querySelector("#sesli-oku-host").shadowRoot.appendChild(style);
        })()`);
        check("theme layer wins over more specific modern base rules", await evalIso(`(() => {
          const button = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("button.primary");
          const style = getComputedStyle(button);
          return style.backgroundColor === "rgb(192, 192, 192)" && style.borderRadius === "0px" && style.height === "28px";
        })()`));
        await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#test-base-conflict").remove()`);
      }
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
      await evalIso("__sesliOkuTest.toggleSettings(true)");
      await WAIT(100);
      check(`${theme} controls fit a narrow viewport`, await evalIso(`(() => {
        const root = document.querySelector("#sesli-oku-host").shadowRoot;
        return [...root.querySelectorAll(".bar, .settings, select, button")].every(element => {
          if (!element.getClientRects().length) return true;
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1;
        });
      })()`));
      await pageCdp.send("Emulation.clearDeviceMetricsOverride");
      await WAIT(100);
      if (process.env.SCREENSHOT_DIR) {
        await evalIso("__sesliOkuTest.toggleSettings(true)");
        await WAIT(100);
        const { writeFileSync } = await import("node:fs");
        for (const [label, client] of [["toolbar", pageCdp], ["popup", popupCdp]]) {
          const shot = await client.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(process.env.SCREENSHOT_DIR, `${theme}-${label}.png`), Buffer.from(shot.data, "base64"));
        }
      }
    }
    console.log("\n  Theme transitions");
    await WAIT(400);
    const beforeFade = await snapshot();
    const fadeResult = await evalIso(`(async () => {
      const host = document.querySelector("#sesli-oku-host");
      const root = host.shadowRoot;
      const before = host.getBoundingClientRect().height;
      await SesliOkuThemes.set("win95");
      const copy = root.querySelector("[data-theme-snapshot]");
      const safe = !!copy && copy.inert && copy.getAttribute("aria-hidden") === "true" &&
        !copy.querySelector("[id]") && getComputedStyle(copy).pointerEvents === "none";
      await new Promise(resolve => setTimeout(resolve, 70));
      const middle = host.getBoundingClientRect().height;
      const fading = parseFloat(getComputedStyle(root.querySelector(".wrap")).opacity);
      await new Promise(resolve => setTimeout(resolve, 350));
      return { before, middle, after: host.getBoundingClientRect().height, fading, safe,
        copies: root.querySelectorAll("[data-theme-snapshot]").length,
        overflow: host.style.overflow,
        active: root.querySelector(".wrap").hasAttribute("data-theme-transition") };
    })()`, true);
    check("theme skins crossfade without duplicate interactive controls", fadeResult.safe && fadeResult.fading > 0 && fadeResult.fading < 1, JSON.stringify(fadeResult));
    check("toolbar height interpolates between the old and new themes", Math.abs(fadeResult.before - fadeResult.after) > 5 &&
      fadeResult.middle > Math.min(fadeResult.before, fadeResult.after) &&
      fadeResult.middle < Math.max(fadeResult.before, fadeResult.after), JSON.stringify(fadeResult));
    check("completed transition restores scrolling and removes its snapshot", fadeResult.copies === 0 && !fadeResult.active && fadeResult.overflow === "auto", JSON.stringify(fadeResult));
    check("theme animation preserves playback state", (await snapshot()).session === beforeFade.session && (await snapshot()).paused === beforeFade.paused);
    await evalIso(`(async () => {
      await SesliOkuThemes.set("xp");
      await SesliOkuThemes.set("win7");
      await SesliOkuThemes.set("modern");
    })()`, true);
    await WAIT(400);
    check("rapid theme switches settle on the last selection without leftover layers", await evalIso(`(() => {
      const host = document.querySelector("#sesli-oku-host");
      return host.shadowRoot.querySelector(".wrap").dataset.theme === "modern" &&
        !host.shadowRoot.querySelector("[data-theme-snapshot], [data-theme-transition]") && host.style.overflow === "auto";
    })()`));
    await pageCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evalIso(`SesliOkuThemes.set("xp")`, true);
    check("reduced motion applies themes without animation", await evalIso(`(() => {
      const root = document.querySelector("#sesli-oku-host").shadowRoot;
      return root.querySelector(".wrap").dataset.theme === "xp" && !root.querySelector("[data-theme-snapshot], [data-theme-transition]");
    })()`));
    await pageCdp.send("Emulation.setEmulatedMedia", { features: [] });
    await evalIso(`SesliOkuThemes.set("win7")`, true);
    await pageCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await WAIT(60);
    check("enabling reduced motion finishes an active animation cleanly", await evalIso(`!document.querySelector("#sesli-oku-host").shadowRoot.querySelector("[data-theme-snapshot], [data-theme-transition]")`));
    await pageCdp.send("Emulation.setEmulatedMedia", { features: [] });
    await popupCdp.send("Page.bringToFront");
    await evalPopup(`SesliOkuThemes.set("modern")`);
    await WAIT(400);
    await evalPopup(`SesliOkuThemes.set("win95")`);
    check("popup uses the same theme crossfade", await evalPopup(`!!document.querySelector("body[data-theme-transition]") && !!document.querySelector("[data-theme-snapshot]")`));
    await WAIT(400);
    check("popup transition removes snapshots and restores natural height", await evalPopup(`!document.querySelector("[data-theme-snapshot], [data-theme-transition]") && !document.body.style.overflow`));
    await pageCdp.send("Page.bringToFront");

    await evalPopup(`(() => { const select = document.querySelector("#theme"); select.value = "xp"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor("popup theme syncs back to toolbar", async () => (await snapshot()).theme === "xp");
    check("popup changes apply to the active toolbar", (await snapshot()).theme === "xp");
    await popupCdp.send("Page.reload");
    await waitFor("persisted theme after reopening popup", () => evalPopup(`document.body?.dataset.theme === "xp" && document.querySelector("#theme")?.value === "xp"`));
    check("theme survives reopening popup", await evalPopup(`document.body.dataset.theme === "xp"`));
    await evalIso(`chrome.storage.local.set({ appearanceTheme: "unknown-theme" })`, true);
    await waitFor("invalid theme falls back", async () => (await snapshot()).theme === "modern");
    check("unknown saved themes fall back to modern", await evalPopup(`document.body.dataset.theme === "modern"`));
    await evalIso(`chrome.storage.local.set({ appearanceTheme: "modern" })`, true);
    await evalIso("__sesliOkuTest.toggleSettings(false)");
    await WAIT(150);

    // ------------------------------------------------------ stop cleanup
    // Closing the player must remove every trace of the reading state, even
    // when a leftover overlay from an older content-script instance exists.
    console.log("\n  Stop cleanup");
    await evalIso(`__sesliOkuTest.showWord("#p8", 0, 6)`);
    await WAIT(200);
    state = await snapshot();
    check(
      "glow is visible before stopping",
      state.visibleSpotlights === 1,
      `visible=${state.visibleSpotlights}`
    );

    await evalIso("__sesliOkuTest.stop()");
    await WAIT(900);
    state = await snapshot();
    check(
      "stop hides the glow",
      state.visibleSpotlights === 0,
      `visible=${state.visibleSpotlights}`
    );
    check(
      "stop clears the paragraph highlight",
      state.current === 0,
      `current=${state.current}`
    );
    check(
      "stop removes the top bar and its space",
      state.hostDisplay === "none" && state.hostRect.height === 0,
      JSON.stringify({ display: state.hostDisplay, host: state.hostRect })
    );
    check("stop restores the site's original fixed header style", await evalIso(`(() => {
      const header = document.querySelector("#test-fixed-header");
      return header.style.top === "0px" && header.style.getPropertyPriority("top") === "important" &&
        !header.hasAttribute("data-sesli-oku-header") && !document.querySelector("#sesli-oku-layout");
    })()`));
    const contentTopAfterStop = await evalIso(`(() => {
      const node = document.querySelector("#reader") || document.querySelector("h1");
      return node ? node.getBoundingClientRect().top : null;
    })()`);
    check(
      "page moves back up after stopping",
      contentTopAfterStop != null &&
        contentTop != null &&
        contentTop - contentTopAfterStop >= playerHeight - 2,
      JSON.stringify({
        before: contentTop,
        after: contentTopAfterStop,
        playerHeight,
      })
    );

    await evalIso("__sesliOkuTest.start(); __sesliOkuTest.pause()");
    await WAIT(250);
    state = await snapshot();
    check(
      "starting again restores one toolbar and its layout space",
      state.hosts === 1 && state.hostDisplay === "block" && approx(state.hostRect.height, playerHeight)
    );
    await evalIso("__sesliOkuTest.stop()");
    await WAIT(900);

    // Simulate an orphaned overlay like the one an older extension version
    // can leave behind after an update.
    await evalIso(`__sesliOkuTest.showWord("#p9", 0, 6)`);
    await pageCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const spot = document.createElement("div");
        spot.id = "sesli-oku-spotlight";
        spot.style.cssText = "position:fixed;left:300px;top:300px;width:60px;height:20px;opacity:1;background:#d9f27a;";
        document.documentElement.appendChild(spot);
      })()`,
    });
    await WAIT(200);
    await evalIso("__sesliOkuTest.stop()");
    await WAIT(400);
    state = await snapshot();
    check(
      "stop hides orphaned overlays too",
      state.visibleSpotlights === 0,
      `visible=${state.visibleSpotlights} spotlights=${state.spotlights}`
    );

    if (process.env.SCREENSHOT_DIR) {
      const shot = await pageCdp.send("Page.captureScreenshot", {
        format: "png",
      });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.SCREENSHOT_DIR, "resumed.png"),
        Buffer.from(shot.data, "base64")
      );
    }

    await evalIso(`chrome.storage.local.set({ appearanceTheme: "win7" })`, true);
    const reloadContextCount = contexts.length;
    await pageCdp.send("Page.navigate", { url: `${fixtureUrl}&themeReload=1` });
    activeContext = await waitFor("isolated world for persisted theme", () => contexts.slice(reloadContextCount).find(context => context.auxData?.type === "isolated"));
    await waitFor("reloaded theme test hook", () => evalIso("typeof window.__sesliOkuTest === 'object'"));
    await evalIso("__sesliOkuTest.start(); __sesliOkuTest.pause()");
    await waitFor("saved theme on new page", async () => (await snapshot()).theme === "win7");
    check("saved theme applies after page reload", await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".wrap").dataset.theme === "win7"`));
    await evalIso("__sesliOkuTest.stop()");

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nFailures:");
      failures.forEach((failure) => console.log(`  - ${failure}`));
      process.exitCode = 1;
    }
  } finally {
    try {
      popupCdp?.close();
      pageCdp?.close();
    } catch {}
    if (pageTarget) {
      try {
        await fetch(`http://127.0.0.1:${await findDevToolsPort(profile)}/json/close/${pageTarget.id}`);
      } catch {}
    }
    edge?.kill("SIGTERM");
    server.close();
    await WAIT(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error(`\nTest harness error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
