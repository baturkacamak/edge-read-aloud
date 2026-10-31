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
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { zipSync, strToU8 } from "fflate";

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

function makePdfFixture(paragraphs=['First PDF paragraph for reading aloud.','Second PDF paragraph for reading aloud.']) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for(const [index,text] of paragraphs.entries()){
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4+index*2} 0 R >>`);
    const stream=`BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');let pdf='%PDF-1.4\n';const offsets=[0];for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf);
}

async function main() {
  const fixture = await readFile(path.join(ROOT, "tests", "fixture.html"));
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/queue.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url.includes('empty=1') ? '<html><body></body></html>' : '<html lang="tr"><title>Sıra testi</title><body><article><p>Bu sıradaki yazının okunacak paragrafıdır ve ses tamamlanınca bir sonraki sayfaya geçilmelidir.</p></article></body></html>');
    } else if (req.url?.startsWith("/fixture.html")) {
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
    await evalIso("__sesliOkuTest.syntheticAudio(150)");

    const snapshot = () => evalIso("JSON.stringify(__sesliOkuTest.snapshot())").then(JSON.parse);

    async function checkAdvancedTools() {
      console.log('\n  Site profiles, study tools, backups and documents');
      await pageCdp.send('Page.bringToFront');
      await evalIso(`__sesliOkuTest.stop(); SesliOkuSettings.update({...SesliOkuSettings.defaults,autoFollow:false})`,true);
      await evalIso(`__sesliOkuTest.syntheticAudio(300);__sesliOkuTest.startBlocks(['#p1','#p2']);__sesliOkuTest.pause();__sesliOkuTest.toggleSettings(true);document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-tab="library"]').click()`);
      await evalIso(`__sesliOkuTest.libraryAction('bookmark')`,true);
      const bookmarkId=await evalIso(`SesliOkuLibrary.current().bookmarks.at(-1).id`);
      await evalIso(`SesliOkuLibrary.action('itemEdit',{collection:'bookmarks',id:${JSON.stringify(bookmarkId)},note:'Çalışma notu <img src=x onerror=alert(1)>',tags:'ders, tekrar, ders'})`,true);
      check('bookmark notes and deduplicated tags persist',await evalIso(`(()=>{const b=SesliOkuLibrary.current().bookmarks.find(b=>b.id===${JSON.stringify(bookmarkId)});return b.note.includes('Çalışma notu')&&b.tags.length===2;})()`));
      const filtered=await evalIso(`(()=>{const r=document.querySelector('#sesli-oku-host').shadowRoot;const q=r.querySelector('[type="search"]');q.value='çalışma notu';q.dispatchEvent(new Event('input',{bubbles:true}));return r.querySelectorAll('.library-bookmarks li').length===1&&!r.querySelector('.library-bookmarks img');})()`);
      check('library search finds notes and renders imported markup as text',filtered);
      await evalIso(`(()=>{const q=document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[type="search"]');q.value='bulunmayan etiket';q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      check('library search can filter out all bookmarks',await evalIso(`document.querySelector('#sesli-oku-host').shadowRoot.querySelectorAll('.library-bookmarks li').length===0`));
      await evalIso(`SesliOkuSettings.update({rate:15,focusFont:'sans',focusLineHeight:2.2,focusWidth:920,focusPadding:32})`,true);
      await evalIso(`__sesliOkuTest.libraryAction('focus')`,true);
      check('focus typography preferences apply to the reading surface',await evalIso(`(()=>{const f=document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.focus-text');const s=getComputedStyle(f);return s.fontFamily.includes('Arial')&&parseFloat(s.lineHeight)/parseFloat(s.fontSize)>2.19&&f.closest('.focus-reader').style.getPropertyValue('--focus-width')==='920px'&&parseFloat(s.paddingTop)===32;})()`));
      await evalIso(`__sesliOkuTest.libraryAction('focus')`,true);
      const origin = await evalIso(`new URL(location.href).origin`);
      const globalRate=await evalIso(`chrome.storage.local.get('settings').then(value=>value.settings.rate)`,true);
      await evalIso(`SesliOkuLibrary.action('siteSave',{url:location.href,settings:{...SesliOkuSettings.current(),rate:35},theme:'xp',colorMode:'dark'})`,true);
      await waitFor('site profile activates',()=>evalIso(`SesliOkuSettings.current().rate===35&&SesliOkuThemes.current()==='xp'&&SesliOkuThemes.mode()==='dark'`));
      await evalIso(`SesliOkuSettings.update({rate:40})`,true);
      check('site settings are editable without replacing global defaults',await evalIso(`chrome.storage.local.get('settings').then(value=>value.settings.rate===${globalRate} && SesliOkuLibrary.current().sites[${JSON.stringify(origin)}].settings.rate===40)`,true));
      const open=async(url,isolated=false)=>{
        const target=await json(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,{method:'PUT'});const client=await connectCDP(target.webSocketDebuggerUrl);const contexts=[];client.onEvent(event=>{if(event.method==='Runtime.executionContextCreated')contexts.push(event.params.context);});await client.send('Runtime.enable');await client.send('Page.bringToFront');let context;
        if(isolated)context=await waitFor('secondary isolated world',()=>contexts.find(c=>c.auxData?.type==='isolated'));
        const evaluate=async(expression,awaitPromise=true)=>{const result=await client.send('Runtime.evaluate',{expression,contextId:context?.id,awaitPromise,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
        await waitFor('secondary reader runtime',()=>evaluate(`typeof SesliOkuSettings==='object'&&typeof __sesliOkuTest==='object'`));
        return {client,evaluate,close:async()=>{client.close();await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);}};
      };
      const other=await open(`http://localhost:${serverPort}/fixture.html?sesliOkuTest=1`,true);
      try{check('another site keeps its own settings and theme',await other.evaluate(`SesliOkuSettings.current().rate===${globalRate}&&SesliOkuThemes.current()!=='xp'`));}finally{await other.close();}
      await pageCdp.send('Page.bringToFront');
      const backup=await evalIso(`SesliOkuLibrary.action('backup')`,true);
      check('backup includes custom site rules, notes, tags and focus preferences',backup.backup.format==='sesli-oku-backup'&&backup.backup.library.sites[origin].settings.rate===40&&backup.backup.library.bookmarks.some(b=>b.id===bookmarkId&&b.tags.includes('ders')));
      const invalid=await evalIso(`(async()=>{try{await SesliOkuLibrary.action('restore',{backup:{format:'bad'}});return false;}catch{return true;}})()`,true);
      check('invalid backups leave the current library intact',invalid&&await evalIso(`SesliOkuLibrary.current().bookmarks.some(b=>b.id===${JSON.stringify(bookmarkId)})`));
      await evalIso(`SesliOkuLibrary.action('siteRemove',{origin:${JSON.stringify(origin)}})`,true);
      await evalIso(`SesliOkuLibrary.action('bookmarkRemove',{id:${JSON.stringify(bookmarkId)}})`,true);
      await evalIso(`SesliOkuLibrary.action('restore',{backup:${JSON.stringify(backup.backup)}})`,true);
      check('backup restore recovers notes and the site profile',await evalIso(`SesliOkuLibrary.current().bookmarks.some(b=>b.id===${JSON.stringify(bookmarkId)})&&SesliOkuSettings.current().rate===40`));
      await evalIso(`SesliOkuLibrary.action('siteRemove',{origin:${JSON.stringify(origin)}})`,true);
      await evalIso(`__sesliOkuTest.stop();SesliOkuSettings.update({...SesliOkuSettings.defaults,autoFollow:false})`,true);
      await evalIso(`__sesliOkuTest.syntheticAudio(180);__sesliOkuTest.startBlocks(['#p1','#p2']);__sesliOkuTest.pause();__sesliOkuTest.libraryAction('repeat',{mode:'paragraph'})`,true);
      await waitFor('paragraph repeats',()=>evalIso(`__sesliOkuTest.snapshot().testPlayed.filter(part=>part.id==='p1').length>=3`));
      check('paragraph loop repeats before advancing to the next paragraph',(await snapshot()).index===0);
      check('repeat playback reuses prepared audio instead of synthesizing each pass',(await snapshot()).testRequests.length===2);
      await evalIso(`__sesliOkuTest.libraryAction('repeat',{mode:'off'})`,true);
      await waitFor('loop can complete normally',()=>evalIso(`!__sesliOkuTest.snapshot().playing`));
      check('turning repetition off allows reading to finish',(await snapshot()).index===2);
      await evalIso(`__sesliOkuTest.syntheticAudio(10000);__sesliOkuTest.startBlocks(['#p1','#p2'])`);
      await waitFor('audio for A-B loop',()=>evalIso(`__sesliOkuTest.experience().total>10`));
      await evalIso(`__sesliOkuTest.pause();__sesliOkuTest.seekTo(.15);__sesliOkuTest.libraryAction('repeat',{mode:'a'})`,true);
      await evalIso(`__sesliOkuTest.seekTo(.9);__sesliOkuTest.libraryAction('repeat',{mode:'b'});__sesliOkuTest.libraryAction('repeat',{mode:'ab'})`,true);
      await WAIT(1300);
      check('A-B loop stays between the marked points',await evalIso(`__sesliOkuTest.experience().loop?.mode==='ab'&&__sesliOkuTest.experience().local<1.1&&__sesliOkuTest.snapshot().index===0`));
      await evalIso(`__sesliOkuTest.libraryAction('repeat',{mode:'off'});__sesliOkuTest.libraryAction('repeat',{mode:'sentence-once'})`,true);
      check('sentence replay seeks to its sentence start',await evalIso(`__sesliOkuTest.snapshot().index===0&&!__sesliOkuTest.snapshot().paused`));
      await evalIso(`__sesliOkuTest.stop();__sesliOkuTest.syntheticAudio(220);__sesliOkuTest.startBlocks(['#p1','#p2']);__sesliOkuTest.pause();__sesliOkuTest.requestDelay(200);__sesliOkuTest.libraryAction('offlineSave')`,true);
      await waitFor('cancelable offline preparation',()=>evalIso(`SesliOkuLibrary.current().export?.status==='working'&&SesliOkuLibrary.current().export.kind==='offline'`));
      await evalIso(`__sesliOkuTest.libraryAction('cancelExport')`,true);await WAIT(450);
      check('canceling offline preparation removes partial audio',await evalIso(`SesliOkuLibrary.action('vaultList').then(value=>!value.books.some(book=>book.status==='working')&&SesliOkuLibrary.current().export.status==='canceled')`,true));
      await evalIso(`__sesliOkuTest.requestDelay(0);__sesliOkuTest.libraryAction('offlineSave')`,true);
      await waitFor('offline audio ready',()=>evalIso(`SesliOkuLibrary.current().export?.kind==='offline'&&SesliOkuLibrary.current().export.status==='done'`));
      const offlineId=await evalIso(`SesliOkuLibrary.current().export.id`);
      check('offline preparation creates a ready local audio book',await evalIso(`SesliOkuLibrary.action('vaultList').then(value=>value.books.some(book=>book.id===${JSON.stringify(offlineId)}&&book.parts===2&&book.size>0))`,true));
      await evalIso('__sesliOkuTest.stop()');
      const extensionId=await evalIso('chrome.runtime.id');
      const reader=await open(`chrome-extension://${extensionId}/src/reader.html?sesliOkuTest=1`);
      try{
        await waitFor('document APIs',()=>reader.evaluate(`typeof SesliOkuDocument.loadFile==='function'`));
        await reader.evaluate(`SesliOkuDocument.loadBook(${JSON.stringify(offlineId)})`);
        await reader.client.send('Network.enable');await reader.client.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
        await reader.evaluate(`window.__speechCalls=0;const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message,...args)=>{if(message.type==='SPEAK'){__speechCalls++;throw new Error('Offline TTS forbidden');}return originalSend(message,...args);};__sesliOkuTest.start()`);
        await waitFor('offline playback finishes',()=>reader.evaluate(`__sesliOkuTest.snapshot().index===2&&!__sesliOkuTest.snapshot().playing`));
        check('offline reading plays both stored parts without a synthesis request',await reader.evaluate(`__speechCalls===0`));
        check('offline voice controls show the stored voice and are disabled',await reader.evaluate(`__sesliOkuTest.snapshot().settings.voice===SesliOkuDocument.book.settings.voice&&document.querySelector('#sesli-oku-host').shadowRoot.querySelector('#sesli-oku-voice').disabled`));
        await reader.client.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
        const badPdf=Buffer.from('Not a PDF');const emptyPdf=makePdfFixture(['','']);
        const invalid=await reader.evaluate(`(async()=>{try{await SesliOkuDocument.loadFile(new File([Uint8Array.from(atob(${JSON.stringify(badPdf.toString('base64'))}),c=>c.charCodeAt(0))],'broken.pdf'));return false;}catch{return true;}})()`);
        check('malformed PDFs report an error without breaking the reader',invalid);
        const scanned=await reader.evaluate(`(async()=>{try{await SesliOkuDocument.loadFile(new File([Uint8Array.from(atob(${JSON.stringify(emptyPdf.toString('base64'))}),c=>c.charCodeAt(0))],'scan.pdf'));return false;}catch(error){return error.message.includes('OCR');}})()`);
        check('PDFs without a text layer explain the OCR limitation',scanned);
        const pdf=makePdfFixture();
        await reader.evaluate(`SesliOkuDocument.loadFile(new File([Uint8Array.from(atob(${JSON.stringify(pdf.toString('base64'))}),c=>c.charCodeAt(0))],'sample.pdf',{type:'application/pdf'}))`);
        check('PDF import extracts text from both pages',await reader.evaluate(`document.querySelector('#document-text').textContent.includes('First PDF paragraph')&&document.querySelector('#document-text').textContent.includes('Second PDF paragraph')&&document.querySelector('#document-section').options.length===2`));
        await reader.evaluate(`SesliOkuThemes.set('win95')`);await WAIT(350);await reader.evaluate(`document.querySelector('#document-section-trigger').click()`);
        check('document text stays selectable inside a themed reader window',await reader.evaluate(`getComputedStyle(document.querySelector('#document-text p')).userSelect==='text'`));
        check('document chapter selection shares the Windows scrollbar skin',await reader.evaluate(`getComputedStyle(document.querySelector('#document-section-listbox'),'::-webkit-scrollbar').width==='17px'&&document.querySelector('#document-section-listbox').matches(':popover-open')`));
        await reader.evaluate('SesliOkuSettings.closeDropdowns();SesliOkuThemes.set("modern")');
        const epub=zipSync({'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),'OPS/book.opf':strToU8('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Test book</dc:title></metadata><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>'),'OPS/one.xhtml':strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Last chapter</h1><p>Last chapter reading paragraph with sufficient text to be read aloud.</p></body></html>'),'OPS/two.xhtml':strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First chapter</h1><script>window.bookScriptExecuted=true;</script><p onclick="alert(1)">First chapter reading paragraph with safe text.</p></body></html>')});
        await reader.evaluate(`SesliOkuDocument.loadFile(new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(epub).toString('base64'))}),c=>c.charCodeAt(0))],'sample.epub',{type:'application/epub+zip'}))`);
        check('EPUB follows spine order and never inserts document scripts or handlers',await reader.evaluate(`(()=>{const a=document.querySelector('#document-text');return a.textContent.indexOf('First chapter')<a.textContent.indexOf('Last chapter')&&!a.querySelector('script,[onclick]')&&!window.bookScriptExecuted;})()`));
        await reader.evaluate(`__sesliOkuTest.syntheticAudio(120);__sesliOkuTest.start();__sesliOkuTest.pause();__sesliOkuTest.libraryAction('bookmark')`);
        const stableId=await reader.evaluate(`SesliOkuDocument.book.id`);
        const bookmark=await reader.evaluate(`SesliOkuLibrary.current().bookmarks.find(item=>item.url===location.href).id`);
        check('document positions and bookmarks use a persistent local book URL',typeof bookmark==='string'&&stableId.startsWith('document-'));
        if(process.env.ADVANCED_SCREENSHOT)writeFileSync('/tmp/advanced-reader.png',Buffer.from((await reader.client.send('Page.captureScreenshot')).data,'base64'));
      }finally{await reader.close();}
      await pageCdp.send('Page.bringToFront');
      await evalIso(`SesliOkuLibrary.action('bookRemove',{id:${JSON.stringify(offlineId)}})`,true);
      check('offline records can be removed from local storage',await evalIso(`SesliOkuLibrary.action('vaultList').then(value=>!value.books.some(book=>book.id===${JSON.stringify(offlineId)}))`,true));
      await evalIso(`SesliOkuSettings.update(SesliOkuSettings.defaults);SesliOkuThemes.set('modern');SesliOkuThemes.setMode('original')`,true);
    }
    if(process.env.ADVANCED_ONLY){await checkAdvancedTools();console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;return;}

    async function checkClickReading() {
      console.log('\n  Click to continue reading');
      await pageCdp.send('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
      await evalIso(`__sesliOkuTest.stop(); SesliOkuSettings.update({...SesliOkuSettings.defaults,autoFollow:false})`,true);
      await evalIso(`window.scrollTo(0,0);__sesliOkuTest.syntheticAudio(30000);__sesliOkuTest.startBlocks(['#p1','#p2','#p3'])`);
      await waitFor('initial audio before clicking',()=>evalIso(`__sesliOkuTest.snapshot().wordText==='Birinci'`));
      const wordPoint = async (selector,word,scroll=true) => {
        const point = await evalIso(`(() => {const p=document.querySelector(${JSON.stringify(selector)});${scroll?'p.scrollIntoView({block:"center",behavior:"instant"});':''} const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const at=n.data.indexOf(${JSON.stringify(word)});if(at<0)continue;const r=document.createRange();r.setStart(n,at+2);r.setEnd(n,at+3);const box=r.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};}})()`);
        if(!point)throw new Error(`No glyph for ${word}`);return point;
      };
      const mouse = (type,point,extra={})=>pageCdp.send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1,...extra});
      const clickAt = async point => {await mouse('mousePressed',point);await mouse('mouseReleased',point);};
      await clickAt(await wordPoint('#p2','buradan'));
      await waitFor('clicked word in another paragraph',()=>evalIso(`__sesliOkuTest.snapshot().wordText==='buradan'`));
      check('clicking another paragraph starts at the clicked word', (await snapshot()).index===1 && !(await snapshot()).paused);
      await evalIso('__sesliOkuTest.pause()');
      await clickAt(await wordPoint('#p1','kaydırma'));
      await waitFor('clicked word resumes paused reading',()=>evalIso(`__sesliOkuTest.snapshot().wordText==='kaydırma' && !__sesliOkuTest.snapshot().paused`));
      check('a text click resumes paused reading at an earlier word', (await snapshot()).index===0);
      await evalIso(`__sesliOkuTest.pause();__sesliOkuTest.toggleSettings(true)`);
      await WAIT(100);
      const point = await wordPoint('#p2','Okuma');
      await clickAt(point);
      await waitFor('click with settings expanded',()=>evalIso(`__sesliOkuTest.snapshot().wordText==='Okuma' && !__sesliOkuTest.snapshot().paused`));
      check('closing settings on mousedown preserves the original clicked word',await evalIso(`!document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.settings').classList.contains('open')`));
      await evalIso('__sesliOkuTest.pause()');
      const before = (await snapshot()).session;
      await evalIso(`(() => {const p=document.querySelector('#p2');for(const [tag,id] of [['button','click-button'],['a','click-link'],['span','click-edit'],['span','click-excluded']]){const node=document.createElement(tag);node.id=id;node.textContent='deneme kontrol metni';if(tag==='a')node.href='#click-test';if(id==='click-edit')node.contentEditable='true';if(id==='click-excluded')node.setAttribute('data-sesli-oku-excluded','');p.append(node);}})()`);
      for(const selector of ['#click-button','#click-link','#click-edit','#click-excluded'])await clickAt(await wordPoint(selector,'deneme'));
      check('links, buttons, editable and excluded content keep their own actions', (await snapshot()).session===before && (await snapshot()).paused);
      await evalIso(`for(const id of ['click-button','click-link','click-edit','click-excluded'])document.getElementById(id).remove();window.getSelection().removeAllRanges()`);
      const dragStart=await wordPoint('#p1','metin');const dragEnd=await wordPoint('#p1','kelime',false);
      await mouse('mouseMoved',dragStart,{button:'none'});await mouse('mousePressed',dragStart);await WAIT(80);await mouse('mouseMoved',dragEnd,{buttons:1});await WAIT(80);await mouse('mouseReleased',dragEnd);
      check('dragging to select text does not jump playback', (await snapshot()).session===before && (await snapshot()).paused);
      await evalIso(`document.addEventListener('mouseup',()=>{const node=document.querySelector('#p1').firstChild;const range=document.createRange();range.setStart(node,0);range.setEnd(node,7);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);},{once:true})`);
      await clickAt(await wordPoint('#p1','metin'));
      check('a click that selects text preserves the reading position', (await snapshot()).session===before && await evalIso(`window.getSelection().toString()==='Birinci'`));
      await evalIso('window.getSelection().removeAllRanges()');
      const blank=await evalIso(`(() => {const r=document.querySelector('#p1').getBoundingClientRect();return {x:r.right-2,y:r.bottom+10};})()`);
      await clickAt(blank);
      check('clicking paragraph spacing does not jump playback', (await snapshot()).session===before);
      await evalIso(`document.querySelector('#p2').addEventListener('click',event=>event.preventDefault(),{once:true})`);
      await clickAt(await wordPoint('#p2','buradan'));
      check('page controls can cancel their click without restarting speech', (await snapshot()).session===before);
      await evalIso('__sesliOkuTest.stop()');
      const stopped = (await snapshot()).session;
      await clickAt(await wordPoint('#p1','metin'));
      check('clicking text after stopping does not start an unsolicited reading', (await snapshot()).session===stopped && !(await snapshot()).playing);
      await evalIso('SesliOkuSettings.update(SesliOkuSettings.defaults)',true);
    }
    if (process.env.CLICKS_ONLY) {
      await checkClickReading();console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;return;
    }

    async function checkExperienceFeatures() {
      console.log("\n  Reading library and playback tools");
      await evalIso(`__sesliOkuTest.stop(); SesliOkuSettings.update({ ...SesliOkuSettings.defaults, autoFollow: false })`, true);
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await evalIso(`__sesliOkuTest.syntheticAudio(20000); __sesliOkuTest.startBlocks(["#p1", "#p2", "#p3"])`);
      await waitFor("playback timeline metadata", () => evalIso(`__sesliOkuTest.experience().total > 20`));
      await evalIso(`__sesliOkuTest.pause(); __sesliOkuTest.seekBy(10)`);
      let timeline = await evalIso(`__sesliOkuTest.experience()`);
      check("+10 seconds seeks in the current audio", timeline.local > 9.9 && timeline.local < 11);
      await evalIso(`__sesliOkuTest.seekBy(-10)`);
      check("-10 seconds seeks backwards", (await evalIso(`__sesliOkuTest.experience()`)).local < 1);
      await evalIso(`__sesliOkuTest.seekTo(22)`);
      check("seeking across paragraphs preserves pause", (await snapshot()).index === 1 && (await snapshot()).paused);
      await evalIso(`__sesliOkuTest.playback()`);
      await waitFor("seek reaches next audio", () => evalIso(`__sesliOkuTest.experience().local >= 1.9`));
      await evalIso(`__sesliOkuTest.pause(); __sesliOkuTest.savePosition()`);
      await waitFor("saved position", () => evalIso(`SesliOkuLibrary.current().pages[SesliOkuLibrary.pageKey(location.href)]?.anchor.seconds >= 1.9`));
      await evalIso(`__sesliOkuTest.libraryAction("bookmark")`, true);
      const position = await evalIso(`SesliOkuLibrary.current().pages[SesliOkuLibrary.pageKey(location.href)].anchor`);
      check("bookmark stores source text and audio position", await evalIso(`SesliOkuLibrary.current().bookmarks.some(item => item.anchor.quote === ${JSON.stringify(position.quote)} && item.anchor.seconds >= 1.9)`));
      await evalIso(`__sesliOkuTest.stop(); __sesliOkuTest.libraryAction("resume")`, true);
      await waitFor("saved position resumes", () => evalIso(`__sesliOkuTest.experience().local >= 1.9`));
      await evalIso(`__sesliOkuTest.pause()`);
      check("resume finds the saved paragraph in a fresh extraction", (await snapshot()).index > 0 && await evalIso(`document.querySelector('.edge-ra-current')?.textContent.startsWith(${JSON.stringify(position.quote)})`));
      await evalIso(`__sesliOkuTest.libraryAction("focus")`, true);
      check("focus view presents readable source paragraphs", await evalIso(`(() => { const r = document.querySelector('#sesli-oku-host').shadowRoot; return !r.querySelector('.focus-reader').hidden && r.querySelectorAll('.focus-text p').length > 2 && r.querySelector('.focus-text p.active'); })()`));
      await evalIso(`SesliOkuSettings.update({ focusFontSize: 28, focusBackground: "paper" })`, true);
      check("focus font and paper background update live", await evalIso(`(() => { const r = document.querySelector('#sesli-oku-host').shadowRoot; return getComputedStyle(r.querySelector('.focus-text')).fontSize === '28px' && r.querySelector('.focus-reader').dataset.background === 'paper'; })()`));
      const savedSkin = await evalIso(`({theme:SesliOkuThemes.current(),mode:SesliOkuThemes.mode()})`);
      for (const theme of ['modern','win95','win98','xp','win7']) {
        for (const mode of ['original','light','dark']) {
          await evalIso(`(async()=>{await SesliOkuThemes.set(${JSON.stringify(theme)});await SesliOkuThemes.setMode(${JSON.stringify(mode)});})()`,true);
          await WAIT(350);
          await pageCdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:15,y:15,button:'none'});
          const scrollSkin = await evalIso(`(() => {const r=document.querySelector('#sesli-oku-host').shadowRoot;const focus=r.querySelector('.focus-text');const list=r.querySelector('.pref-select-popup');const styles=node=>Object.fromEntries(['::-webkit-scrollbar','::-webkit-scrollbar-track','::-webkit-scrollbar-thumb','::-webkit-scrollbar-button'].map(part=>{const s=getComputedStyle(node,part);return [part,{width:s.width,color:s.backgroundColor,image:s.backgroundImage,shadow:s.boxShadow,display:s.display}];}));return {focus:styles(focus),list:styles(list),scrollable:focus.scrollHeight>focus.clientHeight};})()`);
          check(`${theme} ${mode} focus scrollbar follows its theme`,scrollSkin.scrollable && scrollSkin.focus['::-webkit-scrollbar'].width==='17px' && (theme==='modern' ? scrollSkin.focus['::-webkit-scrollbar-thumb'].shadow!=='none' : JSON.stringify(scrollSkin.focus)===JSON.stringify(scrollSkin.list)),JSON.stringify(scrollSkin));
          if(process.env.FEATURE_SCREENSHOT && mode!=='original')writeFileSync(`/tmp/focus-scroll-${theme}-${mode}.png`,Buffer.from((await pageCdp.send('Page.captureScreenshot')).data,'base64'));
        }
      }
      await evalIso(`(async()=>{await SesliOkuThemes.set('win95');await SesliOkuThemes.setMode('light');})()`,true);await WAIT(350);
      const arrow = await evalIso(`(() => {const f=document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.focus-text');f.scrollTop=0;const b=f.getBoundingClientRect();return {x:b.right-8,y:b.bottom-8};})()`);
      await pageCdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...arrow,button:'left',clickCount:1});
      await pageCdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...arrow,button:'left',clickCount:1});
      await waitFor('focus scrollbar arrow scrolls text',()=>evalIso(`document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.focus-text').scrollTop>0`));
      check('the themed focus scrollbar arrow actually scrolls',true);
      await evalIso(`(async()=>{await SesliOkuThemes.set(${JSON.stringify(savedSkin.theme)});await SesliOkuThemes.setMode(${JSON.stringify(savedSkin.mode)});})()`,true);await WAIT(350);
      if (process.env.FEATURE_SCREENSHOT) {
        writeFileSync('/tmp/sesli-focus.png', Buffer.from((await pageCdp.send('Page.captureScreenshot')).data, 'base64'));
        await evalIso(`__sesliOkuTest.libraryAction("focus"); __sesliOkuTest.toggleSettings(true); document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-tab="library"]').click(); SesliOkuThemes.set('xp')`, true);
        await WAIT(400);
        writeFileSync('/tmp/sesli-library.png', Buffer.from((await pageCdp.send('Page.captureScreenshot')).data, 'base64'));
      }
      await evalIso(`if (__sesliOkuTest.experience().focus) __sesliOkuTest.libraryAction("focus"); __sesliOkuTest.stop()`, true);
      const mapping = await evalIso(`(() => { const s = SesliOkuLibrary.pronounce('API ile APIler ve CPU.', [{ from:'API',to:'ey pi ay' }, { from:'CPU',to:'si pi yu' }]); return { text:s.text, ranges: SesliOkuLibrary.mapBoundaries(s, [{text:'ey'},{text:'pi'},{text:'ay'},{text:'ile'},{text:'APIler'},{text:'ve'},{text:'si'},{text:'pi'},{text:'yu'}]) }; })()`);
      check("pronunciation changes whole words and maps spoken words to original text", mapping.text === 'ey pi ay ile APIler ve si pi yu.' && mapping.ranges.slice(0,3).every(range => range.start === 0 && range.end === 3) && mapping.ranges[6].start === 18);
      await evalIso(`(() => { const a=document.createElement('p');a.id='feature-tr';a.lang='tr';a.textContent='API ile bu yazıyı ve yeni özellikleri sesli olarak okuyabilirsiniz.'; const b=document.createElement('p');b.id='feature-en';b.lang='en';b.textContent='The article is in English and this is the text for the new reading tools.'; (document.querySelector('#reader') || document.body).append(a,b); })()`);
      await evalIso(`SesliOkuSettings.update({ autoVoice: true, pronunciationRules: [{ from: "API", to: "ey pi ay" }] })`, true);
      await evalIso(`__sesliOkuTest.syntheticAudio(20000); __sesliOkuTest.startBlocks(['#feature-tr','#feature-en'])`);
      await waitFor("automatic voices and source highlight", () => evalIso(`__sesliOkuTest.snapshot().testRequests.length >= 2 && __sesliOkuTest.snapshot().wordText === "API"`));
      await evalIso(`__sesliOkuTest.pause()`);
      const requests = (await snapshot()).testRequests;
      check("automatic voice selects Turkish and English per paragraph", requests[0].settings.voice.startsWith('tr-TR-') && requests[1].settings.voice.startsWith('en-US-'));
      check("dictionary is applied before audio synthesis", requests[0].text.startsWith('ey pi ay ile'));
      check("pronunciation keeps source word highlighting aligned", (await snapshot()).wordText === 'API', JSON.stringify({ word: (await snapshot()).wordText, index: (await snapshot()).index, requests: (await snapshot()).testRequests.length }));
      await evalIso(`__sesliOkuTest.stop(); SesliOkuSettings.update({ autoVoice:false, pronunciationRules:[] })`, true);
      await evalIso(`__sesliOkuTest.syntheticAudio(20000); __sesliOkuTest.startBlocks(['#p1','#p2'])`);
      await waitFor('reading before excluding a future paragraph', () => evalIso(`__sesliOkuTest.snapshot().testPlayed.length > 0`));
      await evalIso(`__sesliOkuTest.pause(); __sesliOkuTest.libraryAction('pickExclude')`, true);
      await evalIso(`(() => { const p=document.querySelector('#p2'); p.dispatchEvent(new PointerEvent('pointermove',{bubbles:true})); p.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
      await waitFor("excluded source area", () => evalIso(`document.querySelector('#p2').hasAttribute('data-sesli-oku-excluded')`));
      check("excluding a future paragraph updates the active reading session", await evalIso(`!__sesliOkuTest.snapshot().chunks.some(chunk=>chunk.id==='p2')`));
      await evalIso(`(async()=>{ const url=SesliOkuLibrary.pageKey(location.href); const e=SesliOkuLibrary.current().pages[url].exclusions[0];await SesliOkuLibrary.mutate({type:'excludeRemove',url,id:e.id}); })()`, true);
      await waitFor("exclusion removed", () => evalIso(`!document.querySelector('#p2').hasAttribute('data-sesli-oku-excluded')`));
      check("excluded areas can be restored", true);
      await evalIso(`__sesliOkuTest.stop()`);
      await pageCdp.send('Page.setDownloadBehavior', { behavior:'allow', downloadPath: profile });
      const mp3 = readFileSync(path.join(ROOT,'tests','fixture.mp3')).toString('base64');
      await evalIso(`__sesliOkuTest.audioData(${JSON.stringify(mp3)}); __sesliOkuTest.startBlocks(['#p1','#p2','#p3']); __sesliOkuTest.pause(); __sesliOkuTest.libraryAction('export')`, true);
      await waitFor("MP3 download ready", () => evalIso(`SesliOkuLibrary.current().export?.status==='done'`));
      const decodedDuration = await evalIso(`(async()=>{ const b=__sesliOkuTest.experience().exportBlob; const c=new AudioContext();try{return (await c.decodeAudioData(await b.arrayBuffer())).duration;}finally{await c.close();} })()`, true);
      check("MP3 export combines all three paragraphs into decodable audio", decodedDuration > .85 && decodedDuration < 1.5, String(decodedDuration));
      const filename = await evalIso(`SesliOkuLibrary.current().export.filename`);
      await waitFor("MP3 exists on disk", () => existsSync(path.join(profile,filename)));
      check("MP3 is downloaded with the article filename", readFileSync(path.join(profile,filename)).length > 3000);
      check("MP3 export preserves paused playback", (await snapshot()).paused);
      await evalIso(`__sesliOkuTest.requestDelay(300); __sesliOkuTest.libraryAction('export')`, true);
      await waitFor('cancelable export',()=>evalIso(`SesliOkuLibrary.current().export?.status==='working'`));
      await evalIso(`__sesliOkuTest.libraryAction('cancelExport')`, true);
      await WAIT(400);
      check('canceling MP3 prevents a late completion', await evalIso(`SesliOkuLibrary.current().export.status==='canceled' && !__sesliOkuTest.experience().exporting`));
      await evalIso(`__sesliOkuTest.requestDelay(0); __sesliOkuTest.toggleSettings(true); document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-tab="library"]').click()`);
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['modern','win95','win98','xp','win7']) {
        await evalIso(`SesliOkuThemes.set(${JSON.stringify(theme)})`, true); await WAIT(350);
        check(`${theme} library and timeline fit a narrow viewport`, await evalIso(`(() => { const r=document.querySelector('#sesli-oku-host').shadowRoot; const p=r.querySelector('.preferences'); return p.scrollWidth<=p.clientWidth+1 && r.querySelector('.playback-strip').scrollWidth<=r.querySelector('.playback-strip').clientWidth+1 && p.getBoundingClientRect().bottom<=innerHeight+1; })()`));
      }
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await evalIso(`__sesliOkuTest.stop(); __sesliOkuTest.syntheticAudio(150)`);
      await evalIso(`(async()=>{ for(const item of SesliOkuLibrary.current().queue) await SesliOkuLibrary.mutate({type:'queueRemove',id:item.id}); })()`, true);
      await evalIso(`SesliOkuLibrary.action('queueAddUrl',{url:${JSON.stringify(`http://127.0.0.1:${serverPort}/queue.html?sesliOkuTest=1&sesliOkuAudio=150&empty=1`)},title:'Empty page'})`, true);
      for (let i=1;i<=2;i++) await evalIso(`SesliOkuLibrary.action('queueAddUrl',{url:${JSON.stringify(`http://127.0.0.1:${serverPort}/queue.html?sesliOkuTest=1&sesliOkuAudio=150&item=${i}`)},title:'Queue ${i}'})`, true);
      await evalIso(`SesliOkuLibrary.action('queueStart')`, true);
      await waitFor("queue finishes both pages", () => evalIso(`SesliOkuLibrary.current().queue.length===3 && SesliOkuLibrary.current().queue.filter(item=>item.status==='done').length===2 && !SesliOkuLibrary.current().queueRunning`), 12000);
      check("reading queue navigates and reads both pages to completion", true);
      check("queue skips an empty page and continues", await evalIso(`SesliOkuLibrary.current().queue[0].status==='error'`));
      check("queue progress remains available in the library", await evalIso(`Object.values(SesliOkuLibrary.current().pages).filter(page=>page.url.includes('/queue.html')).length===2`));
      await evalIso(`SesliOkuSettings.update(SesliOkuSettings.defaults)`, true);
    }

    if (process.env.FEATURES_ONLY) {
      await checkExperienceFeatures();
      console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
      return;
    }
    async function checkExpandedSettingsFollow() {
      console.log("\n  Follow with expanded settings");
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await evalIso(`SesliOkuSettings.update({ ...SesliOkuSettings.defaults, autoFollow: true, scrollBehavior: "instant" })`, true);
      await evalIso(`SesliOkuThemes.set("xp")`, true);
      await evalIso(`__sesliOkuTest.syntheticAudio(200); __sesliOkuTest.startBlocks(["#p1", "#p2"]); __sesliOkuTest.pause(); __sesliOkuTest.toggleSettings(true);
        document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-tab="appearance"]').click()`);
      await WAIT(400);
      for (const inner of [false, true]) {
        const samples = await evalIso(`(async () => {
          document.querySelector("#scroll-regression-box")?.remove();
          document.querySelector("#scroll-regression")?.remove();
          let box = null;
          const paragraph = document.createElement("p");
          paragraph.id = "scroll-regression";
          paragraph.style.cssText = "font:20px/30px Arial;width:600px;max-width:100%;margin:0;padding:0";
          paragraph.textContent = Array.from({ length: 90 }, (_, i) => "kelime" + i).join(" ");
          if (${inner}) {
            box = document.createElement("div"); box.id = "scroll-regression-box";
            box.style.cssText = "height:240px;overflow-y:auto;position:relative";
            const spacer = document.createElement("div"); spacer.style.height = "500px";
            const tail = document.createElement("div"); tail.style.height = "700px";
            box.append(spacer, paragraph, tail); document.body.prepend(box);
            window.scrollTo(0, 0); box.scrollTop = paragraph.offsetTop - 50;
          } else {
            document.body.appendChild(paragraph);
            const host = document.querySelector("#sesli-oku-host").getBoundingClientRect();
            window.scrollTo(0, window.scrollY + paragraph.getBoundingClientRect().top - host.bottom - 50);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          __sesliOkuTest.setFollow(true);
          const words = [...paragraph.textContent.matchAll(/\\S+/g)];
          const positions = [box ? box.scrollTop : window.scrollY];
          for (const word of words.slice(0, 5)) {
            __sesliOkuTest.showWord("#scroll-regression", word.index, word.index + word[0].length);
            await new Promise(resolve => setTimeout(resolve, 55));
            positions.push(box ? box.scrollTop : window.scrollY);
          }
          return positions;
        })()`, true);
        const deltas = samples.slice(1).map((value, index) => value - samples[index]).filter(delta => Math.abs(delta) > 2);
        check(`${inner ? "inner" : "window"} follow does not alternate scroll direction for consecutive words`,
          !deltas.some((delta, index) => index && delta * deltas[index - 1] < 0), JSON.stringify({ samples, deltas }));
        check(`${inner ? "inner" : "window"} follow leaves already visible words in place`,
          Math.max(...samples) - Math.min(...samples) <= 2, JSON.stringify(samples));
      }
      await evalIso(`(() => {
        document.querySelector("#scroll-regression-box")?.remove();
        const paragraph = document.createElement("p"); paragraph.id = "scroll-regression";
        paragraph.style.cssText = "font:20px/30px Arial;width:600px;max-width:100%;margin:0;padding:0";
        paragraph.textContent = Array.from({ length: 90 }, (_, i) => "kelime" + i).join(" ");
        document.body.appendChild(paragraph);
        const header = document.createElement("nav"); header.id = "scroll-regression-admin";
        header.style.cssText = "position:fixed;top:0;left:0;right:0;height:32px;background:#30343a;z-index:99999";
        document.body.prepend(header);
      })()`);
      await WAIT(120);
      const headerCase = await evalIso(`(async () => {
        const paragraph = document.querySelector("#scroll-regression");
        const host = document.querySelector("#sesli-oku-host").getBoundingClientRect();
        window.scrollTo(0, window.scrollY + paragraph.getBoundingClientRect().top - host.bottom - 10);
        await new Promise(resolve => setTimeout(resolve, 80));
        __sesliOkuTest.setFollow(true); __sesliOkuTest.showWord("#scroll-regression", 0, 7);
        await new Promise(resolve => setTimeout(resolve, 80));
        return { wordTop: paragraph.getBoundingClientRect().top,
          headerBottom: document.querySelector("#scroll-regression-admin").getBoundingClientRect().bottom };
      })()`, true);
      check("follow accounts for a fixed site header below expanded settings", headerCase.wordTop >= headerCase.headerBottom + 4, JSON.stringify(headerCase));
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 400, deviceScaleFactor: 1, mobile: false });
      await WAIT(150);
      const noRoom = await evalIso(`(async () => {
        const paragraph = document.querySelector("#scroll-regression");
        const before = window.scrollY;
        const words = [...paragraph.textContent.matchAll(/\\S+/g)].slice(0, 5);
        __sesliOkuTest.setFollow(true);
        for (const word of words) {
          __sesliOkuTest.showWord("#scroll-regression", word.index, word.index + word[0].length);
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        return { before, after: window.scrollY };
      })()`, true);
      check("follow stays still when expanded panels leave no room for a line", approx(noRoom.before, noRoom.after), JSON.stringify(noRoom));
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await evalIso(`SesliOkuSettings.update({ scrollBehavior: "smooth" })`, true);
      await WAIT(150);
      const smooth = await evalIso(`(async () => {
        const paragraph = document.querySelector("#scroll-regression");
        const panel = document.querySelector("#bottom-panel").getBoundingClientRect();
        window.scrollTo(0, window.scrollY + paragraph.getBoundingClientRect().top - panel.top - 40);
        await new Promise(resolve => setTimeout(resolve, 100));
        __sesliOkuTest.setFollow(true);
        const positions = [window.scrollY];
        const words = [...paragraph.textContent.matchAll(/\\S+/g)].slice(0, 5);
        for (const word of words) {
          __sesliOkuTest.showWord("#scroll-regression", word.index, word.index + word[0].length);
          await new Promise(resolve => setTimeout(resolve, 65));
          positions.push(window.scrollY);
        }
        await new Promise(resolve => setTimeout(resolve, 450)); positions.push(window.scrollY);
        return { positions, wordTop: paragraph.getBoundingClientRect().top, wordBottom: paragraph.getBoundingClientRect().top + 30,
          headerBottom: document.querySelector("#scroll-regression-admin").getBoundingClientRect().bottom,
          panelTop: document.querySelector("#bottom-panel").getBoundingClientRect().top };
      })()`, true);
      check("smooth follow advances without reversing on successive words", smooth.positions.every((position, index) => !index || position >= smooth.positions[index - 1] - 2) && smooth.positions.at(-1) > smooth.positions[0], JSON.stringify(smooth));
      check("smooth follow settles between the settings header and bottom panel", smooth.wordTop >= smooth.headerBottom + 4 && smooth.wordBottom <= smooth.panelTop - 4, JSON.stringify(smooth));
      await evalIso(`__sesliOkuTest.stop(); document.querySelector("#scroll-regression-box")?.remove(); document.querySelector("#scroll-regression")?.remove(); document.querySelector("#scroll-regression-admin")?.remove()`);
      await pageCdp.send("Emulation.clearDeviceMetricsOverride");
    }
    if (process.env.SCROLL_REGRESSION_ONLY) {
      await checkExpandedSettingsFollow();
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed) process.exitCode = 1;
      return;
    }

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
    await evalIso("__sesliOkuTest.syntheticAudio(150)");

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
      y: Math.max(state.hostRect.bottom,state.scroller.top)+40,
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
    async function checkColorModes() {
      console.log("\n  Light and dark appearance");
      await evalIso(`__sesliOkuTest.start(); __sesliOkuTest.pause(); __sesliOkuTest.toggleSettings(true); document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-tab="appearance"]').click()`);
      const before = await snapshot();
      const siteColor = await evalIso(`getComputedStyle(document.body).backgroundColor`);
      const inspect = expression => `(() => { const root=${expression};const select=root.querySelector('[data-setting="colorMode"]');const panel=root.querySelector('.pref-pane:not([hidden])');
        const paint=node=>{for(let current=node;current;current=current.parentElement){const style=getComputedStyle(current);const rgb=style.backgroundColor.match(/[\\d.]+/g)?.map(Number);if(rgb&&(rgb.length===3||rgb[3]>.8))return style.backgroundColor;const stops=style.backgroundImage.match(/rgba?\\([^)]+\\)/g);if(stops?.length)return stops.at(-1);}return 'rgb(255, 255, 255)';};
        const colors=[root,panel,select,root.querySelector('.settings')||root.querySelector('.actions'),root.querySelector('.status')||root].filter(Boolean).map(paint);
        return { mode:root.dataset.colorMode, colors, scheme:getComputedStyle(root).colorScheme, choice:select.value, aria:root.querySelector('[data-select-for="'+select.id+'"]').getAttribute('aria-label') }; })()`;
      for (const theme of ['win95','win98','xp','win7','modern']) {
        await evalIso(`SesliOkuThemes.set(${JSON.stringify(theme)})`,true);
        for (const mode of ['dark','light']) {
          await evalIso(`(() => { const select=document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-setting="colorMode"]');select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
          await waitFor(`${theme} ${mode} synchronizes popup`,()=>evalPopup(`document.body.dataset.colorMode===${JSON.stringify(mode)} && document.querySelector('#colorMode').value===${JSON.stringify(mode)}`));
          await WAIT(350);
          const player = await evalIso(inspect(`document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.wrap')`));
          await evalPopup(`document.querySelector('[data-tab="appearance"]').click()`);
          const popup = await evalPopup(inspect('document.body'));
          const dark = mode==='dark';
          const luminance = color => {const numbers=color.match(/[\d.]+/g).map(Number);return numbers[0]*.2126+numbers[1]*.7152+numbers[2]*.0722;};
          check(`${theme} ${mode} paints both surfaces and form fields`, [player,popup].every(result=>result.mode===mode && result.colors.every(color=>dark?luminance(color)<110:luminance(color)>150)) ,JSON.stringify({player,popup}));
          check(`${theme} ${mode} synchronizes its accessible selection`, player.choice===mode && popup.choice===mode && player.aria.includes(dark?'Koyu':'Açık') && popup.aria.includes(dark?'Koyu':'Açık'));
          const disclosure = expression => `(async()=>{const root=${expression};const detail=root.querySelector('.pref-profile-box');const label=detail.querySelector(':scope > summary');detail.open=false;
            const read=()=>({display:getComputedStyle(label).display,background:getComputedStyle(label).backgroundImage,before:getComputedStyle(label,'::before').backgroundImage,mask:getComputedStyle(label,'::before').maskImage,after:getComputedStyle(label,'::after').backgroundImage,beforeTransform:getComputedStyle(label,'::before').transform,afterTransform:getComputedStyle(label,'::after').transform});
            const closed=read();label.click();await new Promise(resolve=>setTimeout(resolve,160));const expanded=detail.open;const opened=read();label.click();return {closed,opened,expanded,collapsed:!detail.open};})()`;
          const disclosures=[await evalIso(disclosure(`document.querySelector('#sesli-oku-host').shadowRoot`),true),await evalPopup(disclosure('document'))];
          const disclosureValid = result => result.expanded&&result.collapsed&&(theme==='modern'?result.closed.display==='list-item':result.closed.display==='flex'&&(
            theme==='win95'||theme==='win98'?(result.closed.before.match(/linear-gradient/g)||[]).length===2&&(result.opened.before.match(/linear-gradient/g)||[]).length===1:
            theme==='xp'?result.closed.background!=='none'&&result.closed.after.includes('svg')&&result.opened.afterTransform!==result.closed.afterTransform:
            result.closed.mask.includes('svg')&&result.opened.beforeTransform!==result.closed.beforeTransform));
          check(`${theme} ${mode} disclosures use their skin and toggle in both surfaces`,disclosures.every(disclosureValid),JSON.stringify(disclosures));
          if(process.env.DISCLOSURE_SCREENSHOT){
            await evalIso(`(()=>{const r=document.querySelector('#sesli-oku-host').shadowRoot;r.querySelector('[data-tab="library"]').click();r.querySelector('.reading-library details').open=true;})()`);await WAIT(100);
            writeFileSync(`/tmp/disclosure-${theme}-${mode}.png`,Buffer.from((await pageCdp.send('Page.captureScreenshot')).data,'base64'));
            await evalIso(`(()=>{const r=document.querySelector('#sesli-oku-host').shadowRoot;r.querySelector('.reading-library details').open=false;r.querySelector('[data-tab="appearance"]').click();})()`);
          }
          if (dark) {
            await evalIso(`document.querySelector('#sesli-oku-host').shadowRoot.querySelector('#sesli-oku-colorMode-trigger').click()`);
            check(`${theme} dark dropdown uses a dark track and readable text`, await evalIso(`(() => { const root=document.querySelector('#sesli-oku-host').shadowRoot; const list=root.querySelector('#sesli-oku-colorMode-listbox');const style=getComputedStyle(list);return list.matches(':popover-open') && style.getPropertyValue('--drop-track').trim()==='#20272e' && style.color==='rgb(237, 240, 243)'; })()`));
            await evalIso(`SesliOkuSettings.closeDropdowns()`);
            if (process.env.COLOR_SCREENSHOT) writeFileSync(`/tmp/color-${theme}.png`,Buffer.from((await pageCdp.send('Page.captureScreenshot')).data,'base64'));
          }
        }
      }
      check('color mode preserves playback and site colors', (await snapshot()).session===before.session && (await snapshot()).paused===before.paused && siteColor===await evalIso(`getComputedStyle(document.body).backgroundColor`));
      const colorFade = await evalIso(`(async()=>{await SesliOkuThemes.setMode('dark');const r=document.querySelector('#sesli-oku-host').shadowRoot;const copy=r.querySelector('[data-theme-snapshot]');return !!copy&&copy.inert&&copy.dataset.colorMode==='light'&&r.querySelector('.wrap').dataset.colorMode==='dark';})()`,true);
      check('light and dark skins crossfade with an inert old layer',colorFade);
      await evalIso(`SesliOkuThemes.set('xp')`, true);
      await waitFor('saved dark color mode',()=>evalPopup(`document.body.dataset.colorMode==='dark'`));
      await popupCdp.send('Page.reload');
      await waitFor('dark mode after popup reload',()=>evalPopup(`document.body.dataset.colorMode==='dark' && document.body.dataset.theme==='xp' && document.querySelector('#colorMode')?.value==='dark'`));
      check('color mode survives reopening popup',true);
      await evalIso(`(()=>{const r=document.querySelector('#sesli-oku-host').shadowRoot;const detail=r.querySelector('.pref-profile-box');detail.open=false;detail.querySelector('summary').focus();})()`);
      await pageCdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});
      await pageCdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
      check('themed disclosures retain native keyboard activation',await evalIso(`document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.pref-profile-box').open`));
      await evalIso(`document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.pref-profile-box').open=false`);
      const profile = await evalIso(`SesliOkuSettings.saveProfile('Renk testi')`,true);
      await evalIso(`SesliOkuThemes.setMode('light')`,true);
      await evalIso(`SesliOkuSettings.applyProfile(${JSON.stringify(profile.id)})`,true);
      check('saved profiles restore color mode',await evalIso(`SesliOkuThemes.mode()==='dark'`));
      await evalIso(`SesliOkuSettings.removeProfile(${JSON.stringify(profile.id)})`,true);
      await evalIso(`(async()=>{ await SesliOkuThemes.setMode('light');await SesliOkuThemes.setMode('dark');await SesliOkuThemes.setMode('light'); })()`,true);
      await WAIT(400);
      check('rapid color switches remove obsolete snapshots',await evalIso(`(() => {const r=document.querySelector('#sesli-oku-host').shadowRoot;return r.querySelector('.wrap').dataset.colorMode==='light'&&!r.querySelector('[data-theme-snapshot],[data-theme-transition]');})()`));
      await evalIso(`chrome.storage.local.set({appearanceMode:'invalid-mode'})`,true);
      await waitFor('invalid mode normalizes',()=>evalPopup(`document.body.dataset.colorMode==='original'`));
      check('unknown color modes restore the original appearance',true);
      await evalIso(`SesliOkuThemes.set('modern');SesliOkuThemes.setMode('original')`,true);
      await WAIT(400);
      await evalIso(`__sesliOkuTest.stop()`);
    }
    if (process.env.COLORS_ONLY) {
      await checkColorModes();
      console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exitCode=1;
      return;
    }
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
      check(`${theme} preserves the reading session and pause state`, themed.session === beforeTheme.session && themed.paused === beforeTheme.paused && themed.index === beforeTheme.index && themed.follow === beforeTheme.follow, JSON.stringify({ before: beforeTheme, after: themed }));
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
      if (theme !== "modern") {
        const checkboxState = expression => `(() => {
          const input = ${expression};
          const style = getComputedStyle(input);
          const mark = getComputedStyle(input, "::after");
          return style.appearance === "none" && style.opacity === "1" &&
            mark.content !== "none" && mark.backgroundImage.startsWith('url("data:image/svg+xml,');
        })()`;
        check(`${theme} paints themed checkboxes in both popup and player`,
          await evalIso(checkboxState(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-continueSelection")`)) &&
          await evalPopup(checkboxState(`document.querySelector("#continueSelection")`)));
        await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-continueSelection").closest("label").click()`);
        await waitFor(`${theme} checkbox label clears its setting`, () => evalIso(`!SesliOkuSettings.current().continueSelection`));
        await waitFor(`${theme} checkbox syncs to popup`, () => evalPopup(`!document.querySelector("#continueSelection").checked`));
        const unchecked = await evalIso(`getComputedStyle(document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-continueSelection"), "::after").content === "none"`);
        await evalPopup(`document.querySelector("#continueSelection").closest("label").click()`);
        await waitFor(`${theme} popup checkbox syncs back`, () => evalIso(`SesliOkuSettings.current().continueSelection && document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-continueSelection").checked`));
        check(`${theme} checkbox labels toggle and synchronize without losing native behavior`, unchecked && await evalPopup(`document.querySelector("#continueSelection").checked`));
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
      const fillVoices = expression => `(() => {
        const select = ${expression};
        const group = document.createElement("optgroup"); group.label = "Türkçe (Türkiye)";
        for (let index = 0; index < 85; index++) {
          const option = document.createElement("option");
          option.value = index === 0 ? "tr-TR-EmelNeural" : "test-voice-" + index;
          option.textContent = index === 0 ? "Emel · Kadın" : "Deneme sesi " + String(index).padStart(2, "0");
          group.appendChild(option);
        }
        select.replaceChildren(group); select.value = "tr-TR-EmelNeural";
      })()`;
      await evalIso(fillVoices(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice")`));
      await evalPopup(fillVoices(`document.querySelector("#voice")`));
      await WAIT(30);
      for (const [surface, evaluate, client, expression] of [
        ["player", evalIso, pageCdp, `document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice")`],
        ["popup", evalPopup, popupCdp, `document.querySelector("#voice")`],
      ]) {
        const beforeMenu = await snapshot();
        const openMenu = await evaluate(`(() => {
          const select = ${expression}; const wrapper = select.parentElement;
          wrapper.querySelector(".pref-select-trigger").click();
          const list = wrapper.querySelector(".pref-select-popup");
          const rect = list.getBoundingClientRect();
          const opening=list.getAnimations()[0];
          const scrollbar = getComputedStyle(list, "::-webkit-scrollbar");
          const thumb = getComputedStyle(list, "::-webkit-scrollbar-thumb");
          list.scrollTop = list.scrollHeight;
          return { motion:opening?{duration:opening.effect.getTiming().duration,easing:opening.effect.getTiming().easing,frames:opening.effect.getKeyframes()}:null, open: list.matches(":popover-open"), scrollbarWidth: scrollbar.width,
            thumb: thumb.backgroundImage !== "none" || thumb.backgroundColor !== "rgba(0, 0, 0, 0)",
            scrollable: list.scrollHeight > list.clientHeight && list.scrollTop > 0,
            inView: rect.top >= 3 && rect.bottom <= window.innerHeight - 3,
            groups: list.querySelectorAll('[role="group"]').length };
        })()`);
        check(`${theme} ${surface} opens a scrollable themed voice list`, openMenu.open && openMenu.scrollbarWidth === "17px" && openMenu.thumb && openMenu.scrollable && openMenu.inView && openMenu.groups === 1, JSON.stringify(openMenu));
        const policy = theme==='win95' ? !openMenu.motion : theme==='modern' ?
          openMenu.motion?.duration===120&&String(openMenu.motion.frames[0].opacity)==='0'&&!openMenu.motion.frames[0].clipPath :
          openMenu.motion?.duration===200&&openMenu.motion.easing==='linear'&&openMenu.motion.frames[0].clipPath?.includes('100%');
        check(`${theme} ${surface} follows its own opening policy`,policy,JSON.stringify(openMenu.motion));
        await WAIT(60);
        if (surface === "player") check(`${theme} dropdown scrolling leaves reading follow and page position intact`, (await snapshot()).follow === beforeMenu.follow && approx((await snapshot()).scrollY, beforeMenu.scrollY));
        if (process.env.SCREENSHOT_DIR) {
          const { writeFileSync } = await import("node:fs");
          const shot = await client.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(process.env.SCREENSHOT_DIR, `${theme}-voice-menu-${surface}.png`), Buffer.from(shot.data, "base64"));
        }
        await evaluate(`(${expression}).parentElement.querySelector(".pref-select-trigger").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      }
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
    console.log('\n  Dropdown opening motion');
    await evalIso(`SesliOkuThemes.set('win7')`,true);await WAIT(350);
    const dropdownProbe = `(document.querySelector('#sesli-oku-host').shadowRoot.querySelector('#sesli-oku-voice').parentElement)`;
    for(const [height,side] of [[350,'above'],[1000,'below']]){
      await pageCdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height,deviceScaleFactor:1,mobile:false});
      await evalIso(`__sesliOkuTest.toggleSettings(true);document.querySelector('#sesli-oku-host').shadowRoot.querySelector('[data-tab="reading"]').click();document.querySelector('#sesli-oku-host').shadowRoot.querySelector('.preferences').scrollTop=0`);
      await WAIT(60);
      const reveal=await evalIso(`(()=>{const w=${dropdownProbe};w.querySelector('button').click();const l=w.querySelector('.pref-select-popup');const a=l.getAnimations()[0];return {side:l.dataset.openSide,frames:a?.effect.getKeyframes().map(frame=>frame.clipPath),duration:a?.effect.getTiming().duration,transform:getComputedStyle(l).transform};})()`);
      check(`${side} dropdown reveals from its anchor without scaling text`,reveal.side===side&&reveal.duration===200&&reveal.frames?.[0].includes('100%')&&reveal.frames[0].startsWith('inset(100%')===(side==='above')&&reveal.transform==='none',JSON.stringify(reveal));
      await WAIT(260);
      check(`${side} opening removes its clipping after completion`,await evalIso(`(()=>{const l=${dropdownProbe}.querySelector('.pref-select-popup');return l.matches(':popover-open')&&l.getAnimations().length===0&&getComputedStyle(l).clipPath==='none';})()`));
      await evalIso(`${dropdownProbe}.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    }
    const reopened=await evalIso(`(async()=>{const w=${dropdownProbe};const trigger=w.querySelector('button');const list=w.querySelector('.pref-select-popup');trigger.click();const old=list.getAnimations()[0];trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const canceled=old?.playState==='idle'&&!list.matches(':popover-open');trigger.click();const fresh=list.getAnimations()[0];await new Promise(resolve=>setTimeout(resolve,260));const valid=canceled&&fresh&&fresh!==old&&list.matches(':popover-open')&&list.getAnimations().length===0;trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return valid;})()`,true);
    check('rapid close and reopen cancels the old animation safely',reopened);
    await pageCdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await WAIT(60);
    check('reduced motion opens dropdowns instantly',await evalIso(`(()=>{const w=${dropdownProbe};w.querySelector('button').click();const l=w.querySelector('.pref-select-popup');const valid=l.matches(':popover-open')&&l.getAnimations().length===0;w.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return valid;})()`));
    await pageCdp.send('Emulation.setEmulatedMedia',{features:[]});await WAIT(60);
    await evalIso(`${dropdownProbe}.querySelector('button').click()`);
    await pageCdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await WAIT(60);
    check('enabling reduced motion completes an open dropdown without hiding it',await evalIso(`(()=>{const l=${dropdownProbe}.querySelector('.pref-select-popup');return l.matches(':popover-open')&&l.getAnimations().length===0&&getComputedStyle(l).clipPath==='none';})()`));
    await evalIso(`${dropdownProbe}.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await pageCdp.send('Emulation.setEmulatedMedia',{features:[]});await pageCdp.send('Emulation.clearDeviceMetricsOverride');
    await evalIso(`SesliOkuThemes.set('modern')`,true);await WAIT(350);

    console.log("\n  Themed dropdown interactions");
    await evalIso(`(() => {
      const select = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice");
      select.options[1].disabled = true;
    })()`);
    await WAIT(20);
    const keyboardSelection = await evalIso(`(() => {
      const select = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice");
      const trigger = select.parentElement.querySelector(".pref-select-trigger");
      for (const key of ["ArrowDown", "ArrowDown", "Enter"]) trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      return { value: select.value, open: select.parentElement.querySelector(".pref-select-popup").matches(":popover-open") };
    })()`);
    await waitFor("dropdown selection updates voice", () => evalIso(`SesliOkuSettings.current().voice === "test-voice-2"`));
    check("keyboard selection skips disabled voices and commits through existing settings", keyboardSelection.value === "test-voice-2" && !keyboardSelection.open);
    const canceled = await evalIso(`(() => {
      const select = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice");
      const trigger = select.parentElement.querySelector(".pref-select-trigger");
      for (const key of ["ArrowDown", "End", "Escape"]) trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      return select.value === "test-voice-2" && trigger.getAttribute("aria-expanded") === "false";
    })()`);
    check("Escape cancels a pending dropdown selection", canceled);
    await evalIso(`(() => {
      const select = document.querySelector("#sesli-oku-host").shadowRoot.querySelector("#sesli-oku-voice");
      const trigger = select.parentElement.querySelector(".pref-select-trigger");
      for (const key of ["e", "m"]) trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    })()`);
    await waitFor("voice type-ahead selection", () => evalIso(`SesliOkuSettings.current().voice === "tr-TR-EmelNeural"`));
    check("typing searches the voice options", true);
    await evalIso(`(() => {
      const root = document.querySelector("#sesli-oku-host").shadowRoot;
      root.querySelector(".pref-profile-box").open = true;
      root.querySelector('[data-select-for="sesli-oku-profile"]').click();
      root.querySelector("#sesli-oku-profile-listbox [data-option-index='1']").click();
    })()`);
    check("profile dropdown commits inside its label without reopening", await evalIso(`(() => {
      const root = document.querySelector("#sesli-oku-host").shadowRoot;
      return root.querySelector("#sesli-oku-profile").value === "study" && !root.querySelector(".pref-select-popup:popover-open");
    })()`));
    await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".pref-profile-box").open = false`);
    await WAIT(100);

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

    console.log("\n  Reading preferences and profiles");
    await evalIso("__sesliOkuTest.syntheticAudio(120)");
    await evalIso(`SesliOkuSettings.update({ ...SesliOkuSettings.defaults, autoFollow: false })`, true);
    await evalIso(`__sesliOkuTest.startBlocks(["#p1", "#p2"]); __sesliOkuTest.pause(); __sesliOkuTest.toggleSettings(true)`);
    const pausedSettingsSession = (await snapshot()).session;
    for (const tab of ["reading", "appearance", "behavior"]) {
      await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-tab="${tab}"]').click()`);
      check(`${tab} property page is the only visible panel`, await evalIso(`(() => {
        const root = document.querySelector("#sesli-oku-host").shadowRoot;
        return root.querySelectorAll('.pref-pane:not([hidden])').length === 1 &&
          root.querySelector('.pref-tab[aria-selected="true"]').dataset.tab === "${tab}";
      })()`));
    }
    await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-tab="appearance"]').click()`);
    for (const mode of ["both", "word", "paragraph", "off"]) {
      await evalIso(`SesliOkuSettings.update({ highlightMode: "${mode}" })`, true);
      await evalIso(`__sesliOkuTest.showWord("#p1", 0, 7)`);
      await WAIT(250);
      const styles = await evalIso(`(() => {
        const paragraph = getComputedStyle(document.querySelector(".edge-ra-current"));
        const glow = getComputedStyle(document.querySelector("#sesli-oku-spotlight"));
        return { paragraph: paragraph.backgroundColor !== "rgba(0, 0, 0, 0)", glow: Number(glow.opacity) > 0 };
      })()`);
      check(`${mode} highlight mode controls paragraph and word glow`, styles.paragraph === ["both", "paragraph"].includes(mode) && styles.glow === ["both", "word"].includes(mode), JSON.stringify(styles));
    }
    await evalIso(`SesliOkuSettings.update({ highlightMode: "both", highlightColor: "#ff6600", highlightOpacity: 50, glowIntensity: 0 })`, true);
    await WAIT(250);
    check("custom highlight color, opacity and disabled glow apply live", await evalIso(`(() => {
      const paragraph = getComputedStyle(document.querySelector(".edge-ra-current"));
      const glow = getComputedStyle(document.querySelector("#sesli-oku-spotlight"));
      return paragraph.backgroundColor === "rgba(255, 102, 0, 0.5)" && Number(glow.opacity) === 0 && glow.boxShadow === "none";
    })()`));
    check("appearance settings do not restart audio", (await snapshot()).session === pausedSettingsSession);
    // Give scrolling tests a real visible reading area. The expanded panel
    // and fixture's composer cover the whole small default viewport.
    await evalIso("__sesliOkuTest.toggleSettings(false)");
    await WAIT(100);
    const scrollWithoutFollow = (await snapshot()).scrollY;
    await evalIso(`__sesliOkuTest.showWord("#p10", 0, 6)`);
    await WAIT(100);
    check("disabled auto follow keeps the user's page position", (await snapshot()).follow === false && approx((await snapshot()).scrollY, scrollWithoutFollow));
    await evalIso(`SesliOkuSettings.update({ scrollBehavior: "instant" })`, true);
    const scrollModes = await evalIso(`(() => {
      const modes = []; const original = window.scrollBy;
      window.scrollBy = options => { modes.push(options.behavior); original.call(window, options); };
      __sesliOkuTest.resume(); window.scrollBy = original;
      return modes;
    })()`);
    check("instant scrolling reaches the actual scroll API", scrollModes.includes("instant"), JSON.stringify(scrollModes));
    await evalIso(`SesliOkuSettings.update({ autoFollow: false, continueSelection: false, pitch: 15 })`, true);
    check("pitch changes reach speech requests and preserve pause", (await snapshot()).paused && (await snapshot()).settings.pitch === 15);
    await waitFor("pitch request", async () => (await snapshot()).testRequests.some(request => request.settings.pitch === 15));
    await waitFor("popup settings sync", () => evalPopup(`document.querySelector("#pitch").value === "15" && !document.querySelector("#continueSelection").checked`));
    check("toolbar preferences synchronize to popup", await evalPopup(`document.querySelector("#pitch").value === "15"`));
    await evalPopup(`(() => {
      const input = document.querySelector("#volume"); input.value = "-15";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor("popup settings reach reading tab", async () => (await snapshot()).settings.volume === -15);
    check("popup preferences synchronize back without losing other settings", (await snapshot()).settings.pitch === 15 && !(await snapshot()).settings.continueSelection);
    await evalIso(`(() => {
      __sesliOkuTest.toggleSettings(true);
      const root = document.querySelector("#sesli-oku-host").shadowRoot;
      root.querySelector(".pref-profile-box").open = true;
      root.querySelector(".pref-editor").open = true;
      root.querySelector("#sesli-oku-profile-name").value = "Deneme profili";
      root.querySelector('[data-profile="save"]').click();
    })()`);
    await waitFor("profile saved through the panel", () => evalIso(`SesliOkuSettings.profiles().some(profile => profile.name === "Deneme profili")`));
    await evalIso(`SesliOkuSettings.update({ pitch: 0, highlightColor: "theme", volume: 0 })`, true);
    await evalIso(`SesliOkuThemes.set("xp")`, true);
    await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-profile="apply"]').click()`);
    await waitFor("saved profile applied through panel", async () => (await snapshot()).settings.pitch === 15 && (await snapshot()).theme === "win7");
    check("saved profiles restore voice, reading and appearance preferences", (await snapshot()).settings.pitch === 15 && (await snapshot()).settings.volume === -15 && (await snapshot()).settings.highlightColor === "#ff6600" && (await snapshot()).theme === "win7");
    await evalIso(`SesliOkuSettings.applyProfile("study")`, true);
    check("study preset applies slower reading and paragraph pauses", (await snapshot()).settings.rate === -10 && (await snapshot()).settings.paragraphDelay === 1000);
    await evalIso(`SesliOkuSettings.applyProfile("night")`, true);
    check("night preset applies quieter voice and gentler highlighting", (await snapshot()).settings.volume === -20 && (await snapshot()).settings.highlightMode === "word" && (await snapshot()).theme === "modern");
    await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-profile="delete"]').click()`);
    await waitFor("profile deleted through panel", () => evalIso(`!SesliOkuSettings.profiles().some(profile => profile.name === "Deneme profili")`));
    await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector(".pref-profile-box").open = false`);
    check("saved profiles can be deleted", await evalIso(`!SesliOkuSettings.profiles().some(profile => profile.name === "Deneme profili")`));
    check("settings normalize invalid storage values", await evalIso(`(() => {
      const value = SesliOkuSettings.normalize({ pitch: 1000, paragraphDelay: -50, highlightColor: "red; color: white", highlightMode: "invalid", glowIntensity: 200 });
      return value.pitch === 50 && value.paragraphDelay === 0 && value.highlightColor === "theme" && value.highlightMode === "both" && value.glowIntensity === 100;
    })()`));
    if (process.env.SCREENSHOT_DIR) {
      await evalIso("__sesliOkuTest.toggleSettings(true)");
      const { writeFileSync } = await import("node:fs");
      for (const tab of ["reading", "appearance", "behavior"]) {
        await evalIso(`document.querySelector("#sesli-oku-host").shadowRoot.querySelector('[data-tab="${tab}"]').click()`);
        await evalPopup(`document.querySelector('[data-tab="${tab}"]').click()`);
        await WAIT(150);
        for (const [label, client] of [["toolbar", pageCdp], ["popup", popupCdp]]) {
          const shot = await client.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(process.env.SCREENSHOT_DIR, `preferences-${tab}-${label}.png`), Buffer.from(shot.data, "base64"));
        }
      }
    }
    await evalIso("__sesliOkuTest.stop()");
    await evalIso(`SesliOkuSettings.update({ ...SesliOkuSettings.defaults, paragraphDelay: 500, autoFollow: false })`, true);
    await evalIso(`__sesliOkuTest.syntheticAudio(120); __sesliOkuTest.startBlocks(["#p1", "#p2"])`);
    await waitFor("paragraph gap", async () => (await snapshot()).gapWaiting);
    await evalIso("__sesliOkuTest.pause()");
    await WAIT(650);
    check("paragraph wait pauses with playback", (await snapshot()).testPlayed.length === 1 && (await snapshot()).gapWaiting);
    await evalIso("__sesliOkuTest.playback()");
    await waitFor("next paragraph after gap", async () => (await snapshot()).testPlayed.length === 2);
    let played = (await snapshot()).testPlayed;
    check("paragraphs are separated by the configured pause", played[1].at - played[0].at >= 600, JSON.stringify(played));
    await evalIso("__sesliOkuTest.stop()");
    await evalIso(`SesliOkuSettings.update({ paragraphDelay: 0 })`, true);
    await evalIso(`(() => {
      const paragraph = document.createElement("p"); paragraph.id = "long-paragraph";
      paragraph.textContent = "Uzun paragrafın birden çok ses parçasına bölünmesi gerekir. ".repeat(42);
      document.body.appendChild(paragraph);
      __sesliOkuTest.syntheticAudio(150);
      __sesliOkuTest.startBlocks(["#long-paragraph", "#p2"]);
      __sesliOkuTest.timer({ mode: "paragraph" });
    })()`);
    const longChunkCount = (await snapshot()).total - 1;
    await waitFor("sleep at paragraph end", async () => !(await snapshot()).playing);
    played = (await snapshot()).testPlayed;
    check("paragraph timer waits for all chunks of the paragraph", played.length === longChunkCount && played.every(item => item.id === "long-paragraph") && (await snapshot()).status === "Paragraf tamamlandı", JSON.stringify({ longChunkCount, played }));
    await evalIso(`__sesliOkuTest.syntheticAudio(150); __sesliOkuTest.startBlocks(["#p1", "#p2"]); __sesliOkuTest.pause(); __sesliOkuTest.deadline(650)`);
    const sleepDeadline = (await snapshot()).sleepTimer.deadline;
    await evalIso(`SesliOkuSettings.update({ pitch: 20 })`, true);
    check("changing a voice setting does not reset sleep deadline", (await snapshot()).sleepTimer.deadline === sleepDeadline && (await snapshot()).paused);
    await waitFor("deadline stops paused audio", async () => !(await snapshot()).playing);
    check("time-based sleep stops even while paused", (await snapshot()).sleepTimer === null && (await snapshot()).status === "Zamanlayıcı: okuma durduruldu");
    await evalIso(`chrome.runtime.sendMessage({ target: "background", type: "START_PAGE" })`, true);
    await evalIso("__sesliOkuTest.pause()");
    await evalPopup(`(() => {
      document.querySelector('[data-tab="behavior"]').click();
      document.querySelector("#sleep-mode").value = "custom";
      document.querySelector("#sleep-mode").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#sleep-minutes").value = "5";
      document.querySelector("[data-timer]").click();
    })()`);
    await waitFor("popup configures sleep timer", async () => !!(await snapshot()).sleepTimer?.deadline);
    check("popup timer controls the active reading tab", (await snapshot()).sleepTimer.deadline > Date.now() + 290000);
    const previousDeadline = (await snapshot()).sleepTimer.deadline;
    check("invalid duration leaves the active timer intact", await evalIso(`(() => { try { __sesliOkuTest.timer({ mode: "custom", minutes: -1 }); return false; } catch { return true; } })()`) && (await snapshot()).sleepTimer.deadline === previousDeadline);
    await evalIso("__sesliOkuTest.timer({ mode: 'off' })");
    check("timer can be canceled without stopping reading", (await snapshot()).sleepTimer === null && (await snapshot()).playing);
    await evalIso("__sesliOkuTest.stop()");
    await evalIso(`SesliOkuSettings.update(SesliOkuSettings.defaults)`, true);
    await popupCdp.send("Page.reload");
    await waitFor("preferences after popup reload", () => evalPopup(`typeof SesliOkuSettings === "object" && document.querySelector("#pitch")?.value === "0"`));
    check("new preferences survive reloading popup", await evalPopup(`document.querySelector("#glowIntensity").value === "60" && document.querySelector("#autoFollow").checked`));

    await checkClickReading();
    await checkColorModes();
    await checkExpandedSettingsFollow();
    await checkExperienceFeatures();
    await checkAdvancedTools();

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
