/** Reading controls and page-local reading tools; no site HTML is copied. */
(() => {
  if (globalThis.SesliOkuExperience) return;
  function create({ state, prepareChunks, startSession, showUi, updateUi, setStatus, toggleSettings, renderHighlightStyle, sendToBackground, stop, togglePlayback, skip, previewWord }) {
    const library = globalThis.SesliOkuLibrary;
    const preferences = globalThis.SesliOkuSettings;
    const runtime = { durations: new Map(), chunks: null, audioIndex: -1, pending: null, lastSave: 0, wordOffset: 0,
      focus: false, focusFollow: true, focusRows: [], exportToken: 0, exporting: false, exportBlob: null, excludeKey: "", excluded: new Set(), picker: null, exportResume: null, offlineId: null, loop: null, a: null, b: null };
    let mediaOwned=false;let previousMetadata=null;
    let listened=0;let tickAt=performance.now();let lastFlush=performance.now();
    function listeningTick() {
      const now=performance.now();const seconds=Math.min(1,Math.max(0,(now-tickAt)/1000));tickAt=now;
      if(state.playing&&!state.paused&&state.audio&&!state.audio.paused&&!state.audio.ended&&state.audio.readyState>=2&&!runtime.exporting)listened+=seconds;
      if(now-lastFlush>15000)flushListening();
    }
    function flushListening(completed=false) {
      const seconds=listened;listened=0;lastFlush=performance.now();
      if(seconds||completed)library.action('stats',{seconds,completed,url:page().url}).catch(()=>{});
    }
    const mediaActions={play:()=>{if(!state.playing||state.paused)togglePlayback();},pause:()=>{if(state.playing&&!state.paused)togglePlayback();},stop:()=>stop(),previoustrack:()=>skip(-1),nexttrack:()=>skip(1),seekbackward:event=>seekBy(-(event.seekOffset||10)),seekforward:event=>seekBy(event.seekOffset||10),seekto:event=>{if(Number.isFinite(event.seekTime))seekTo(event.seekTime);}};
    function updateMedia() {
      const media=navigator.mediaSession;if(!media)return;
      if(state.playing&&!mediaOwned){previousMetadata=media.metadata;mediaOwned=true;try{media.metadata=new MediaMetadata({title:document.title||'Sesli Oku',artist:'Sesli Oku'});}catch{}for(const [name,handler]of Object.entries(mediaActions))try{media.setActionHandler(name,handler);}catch{}}
      if(!mediaOwned)return;
      media.playbackState=state.playing?(state.paused?'paused':'playing'):'none';
      const value=timeline();try{if(state.playing&&value.total>0)media.setPositionState({duration:value.total,position:Math.min(value.total,value.elapsed),playbackRate:state.settings.playbackRate});else media.setPositionState();}catch{}
      if(!state.playing){for(const name of Object.keys(mediaActions))try{media.setActionHandler(name,null);}catch{}media.metadata=previousMetadata;mediaOwned=false;}
    }
    function sectionsFor(chunks) {
      const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h=>h.textContent.trim()&&!h.closest('#sesli-oku-host,[data-sesli-oku-excluded],nav,aside,header,footer')&&h.getClientRects().length);
      const result=[];let previous=null;
      for(const [index,chunk]of chunks.entries()){
        let heading=null;const scope=chunk.el?.closest('article,main')||document.body;
        for(const h of headings)if(chunk.el&&scope.contains(h)&&(h===chunk.el||h.contains(chunk.el)||h.compareDocumentPosition(chunk.el)&Node.DOCUMENT_POSITION_FOLLOWING))heading=h;
        if(!result.length||heading!==previous){result.push({index,end:index+1,title:heading?.textContent.trim().slice(0,180)||'Başlangıç',level:heading?Number(heading.tagName[1]):1});previous=heading;}else result.at(-1).end=index+1;
      }
      return result;
    }
    let sectionChunks=[];let sectionRows=[];
    function refreshSections(fullPage=false) {
      const list=root?.querySelector('.reading-sections-list');if(!list)return;
      sectionChunks=!fullPage&&state.chunks.length?state.chunks:prepareChunks();sectionRows=sectionsFor(sectionChunks);list.replaceChildren();
      for(const [index,item]of sectionRows.entries()){
        const row=document.createElement('div');row.className='library-buttons';
        const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=true;check.dataset.section=String(index);label.className='pref-check';const title=document.createElement('span');title.textContent=item.title;label.append(check,title);
        const button=document.createElement('button');button.type='button';button.textContent='Buradan oku';button.addEventListener('click',()=>{state.chunks=sectionChunks;runtime.loop=null;startSession(item.index);});row.append(label,button);list.append(row);
      }
      if(!sectionRows.length)list.textContent='Bu sayfada okunabilir bölüm bulunamadı.';
    }
    function readSections(){
      const selected=[...root.querySelectorAll('[data-section]:checked')].map(input=>sectionRows[Number(input.dataset.section)]);
      if(!selected.length){setStatus('En az bir bölüm seçin.',true);return;}
      state.chunks=selected.flatMap(item=>sectionChunks.slice(item.index,item.end));runtime.loop=null;startSession(0);setStatus('Seçili bölümler okunuyor');
    }
    let scrub=null;let scrubFrame=null;const wordTimings=new Map();
    let root = null; let strip = null; let reader = null; let focusText = null;
    const page = () => ({ url: library.pageKey(location.href), title: document.title || location.hostname });
    const time = seconds => { const value = Math.max(0, Math.round(seconds || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; };
    function duration(index) {
      return runtime.durations.get(index) || Math.max(1, (state.chunks[index]?.text.match(/\S+/g)?.length || 0) / (3 * Math.max(.5, 1 + state.settings.rate / 100)));
    }
    function timeline() {
      const values = state.chunks.map((chunk, index) => duration(index));
      const total = values.reduce((sum, value) => sum + value, 0);
      const local = runtime.audioIndex === state.index && Number.isFinite(state.audio?.currentTime) ? state.audio.currentTime : runtime.pending?.seconds || 0;
      const elapsed = Math.min(total, values.slice(0, state.index).reduce((sum, value) => sum + value, 0) + local);
      return { total, elapsed, local, remaining: Math.max(0, (total - elapsed) / state.settings.playbackRate), estimated: runtime.durations.size < state.chunks.length };
    }
    function updateProgress() {
      updateMedia();
      if (!strip) return;
      const value = scrub?.preview ? {...timeline(),total:scrub.total,elapsed:scrub.preview.elapsed,remaining:(scrub.total-scrub.preview.elapsed)/state.settings.playbackRate,estimated:scrub.preview.estimated} : timeline(); const slider = strip.querySelector("input");
      if (!slider._scrubbing) slider.value = String(value.total ? Math.round(value.elapsed / value.total * 1000) : 0);
      slider.disabled = !state.chunks.length;
      slider.setAttribute("aria-valuetext", `${scrub?.preview?.estimated?"Yaklaşık · ":""}${scrub?.preview?state.chunks[scrub.preview.index].text.slice(scrub.preview.range.start,scrub.preview.range.end)+" · ":""}%${value.total ? Math.round(value.elapsed / value.total * 100) : 0}, kalan ${time(value.remaining)}`);
      strip.querySelector("output").textContent = `${value.estimated ? "~" : ""}${time(value.remaining)} kalan`;
      for (const button of strip.querySelectorAll("[data-seek]")) button.disabled = !state.chunks.length;
    }
    function anchor() {
      const chunk = state.chunks[Math.min(state.index, state.chunks.length - 1)];
      if (!chunk) return null;
      const cursor=runtime.pending?.charOffset ?? runtime.wordOffset;
      return { target:chunk.text.slice(cursor,cursor+80),before:chunk.text.slice(Math.max(0,cursor-100),cursor),after:chunk.text.slice(cursor+80,cursor+180),quote: chunk.text.slice(0, 220), selector: chunk.el ? elementPath(chunk.el) : "", offset: chunk.offset || 0,
        charOffset: runtime.pending?.charOffset ?? runtime.wordOffset, seconds: timeline().local, index: Math.min(state.index, state.chunks.length - 1) };
    }
    function save(force = false, completed = false) {
      if(scrub)return;
      if(force)flushListening(completed);
      if (!state.settings.rememberPosition || !state.chunks.length || (!force && Date.now() - runtime.lastSave < 5000)) return;
      completed ||= state.index >= state.chunks.length;
      const value = anchor(); if (!value) return;
      runtime.lastSave = Date.now();
      library.mutate({ type: "progress", ...page(), anchor: value, completed }).catch(() => {});
    }
    function elementPath(element) {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
      const parts = [];
      for (let node = element; node && node !== document.body && parts.length < 9; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const tag = node.localName; const siblings = [...node.parentElement?.children || []].filter(item => item.localName === tag);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      return parts.join(" > ");
    }
    function beforeSession(index, options = {}) {
      cancelScrub(false);
      if (runtime.chunks !== state.chunks) { runtime.chunks = state.chunks; runtime.durations.clear(); wordTimings.clear(); runtime.loop=null; runtime.a=null; runtime.b=null; buildFocus(); }
      runtime.audioIndex = -1; runtime.wordOffset = options.anchor?.charOffset || 0;
      runtime.pending = options.anchor || (options.seek !== undefined ? { seconds: options.seek } : null);
      runtime.focusFollow = true; repeatStatus();updateProgress(); markFocus(index);
    }
    function metadata(audio, result) {
      wordTimings.set(state.index,{boundaries:result.boundaries||[],ranges:result.sourceOffsets||[],duration:audio.duration});
      if (Number.isFinite(audio.duration) && audio.duration > 0) runtime.durations.set(state.index, audio.duration);
      if (runtime.pending) {
        const point = runtime.pending; let offset = point.seconds || 0;
        if (point.charOffset > 0) {
          const index = result.sourceOffsets?.findIndex(range => range && range.end > point.charOffset);
          // Land just inside the word: decoder time quantization can otherwise
          // leave currentTime a fraction before its boundary (the prior word).
          if (index >= 0) offset = (result.boundaries[index]?.offset || 0) / 1e7 + .001;
        }
        audio.currentTime = Math.max(0, Math.min(Math.max(0, audio.duration - .05), offset)); runtime.pending = null;
      }
      updateProgress(); save(true);
    }
    function audioStarted() { runtime.audioIndex = state.index; }
    function spokenWord(result, index) {
      const range = result.sourceOffsets?.[index];
      if (range) { runtime.wordOffset = range.start; markFocus(state.index, range); }
      updateProgress(); save();
    }
    function pointFor(index, seconds, span) {
      const chunk=state.chunks[index];const timing=wordTimings.get(index);
      if(timing?.boundaries.length){
        let at=0;while(at+1<timing.boundaries.length&&timing.boundaries[at+1].offset/1e7<=seconds)at++;
        for(let candidate=at;candidate>=0;candidate--)if(timing.ranges[candidate])return {index,seconds,range:timing.ranges[candidate],estimated:false};
      }
      const words=[...chunk.text.matchAll(/\S+/gu)];const word=words[Math.min(words.length-1,Math.floor(Math.max(0,Math.min(.999999,seconds/Math.max(.001,span)))*words.length))];
      return {index,seconds,range:word?{start:word.index,end:word.index+word[0].length}:{start:0,end:chunk.text.length},estimated:true};
    }
    function beginScrub(){
      if(scrub||!state.chunks.length)return;
      const durations=state.chunks.map((_,index)=>duration(index));
      scrub={durations,total:durations.reduce((sum,n)=>sum+n,0),paused:state.paused,playing:state.playing,session:state.session,follow:state.followReading,status:state.ui?.status.textContent,preview:null};
      strip.querySelector('input')._scrubbing=true;
      state.paused=true;state.audio?.pause();runtime.focusFollow=true;updateUi();
    }
    function showScrub(){
      scrubFrame=null;if(!scrub||scrub.session!==state.session)return;
      let elapsed=scrub.total*Number(strip.querySelector('input').value)/1000;
      elapsed=Math.max(0,Math.min(Math.max(0,scrub.total-.05),elapsed));let seconds=elapsed,index=0;
      while(index<state.chunks.length-1&&seconds>=scrub.durations[index]){seconds-=scrub.durations[index];index++;}
      const point=pointFor(index,seconds,scrub.durations[index]);point.elapsed=elapsed;scrub.preview=point;
      previewWord(index,point.range);markFocus(index,point.range);updateProgress();
      const word=state.chunks[index].text.slice(point.range.start,point.range.end);
      setStatus(`Önizleme · ${index+1}/${state.chunks.length} · ${point.estimated?'Yaklaşık · ':''}${word}`);
    }
    function previewScrub(){beginScrub();if(scrub&&scrubFrame===null)scrubFrame=requestAnimationFrame(showScrub);}
    function clearScrub(){if(scrubFrame!==null)cancelAnimationFrame(scrubFrame);scrubFrame=null;const saved=scrub;scrub=null;if(strip)strip.querySelector('input')._scrubbing=false;return saved;}
    function commitScrub(){
      if(!scrub){seekTo(timeline().total*Number(strip.querySelector('input').value)/1000);return;}
      if(scrubFrame!==null)cancelAnimationFrame(scrubFrame);showScrub();const saved=clearScrub();const point=saved.preview;if(!point||saved.session!==state.session)return;
      runtime.loop=null;startSession(point.index,{anchor:{charOffset:point.range.start,seconds:point.range.start?point.seconds:0},paused:saved.paused});previewWord(point.index,point.range);markFocus(point.index,point.range);
    }
    function cancelScrub(restore=true){
      if(!scrub)return;const saved=clearScrub();if(!restore||saved.session!==state.session)return;
      state.paused=saved.paused;state.followReading=saved.follow;
      const index=Math.min(state.index,state.chunks.length-1);const text=state.chunks[index]?.text;
      if(text){const word=[...text.matchAll(/\S+/gu)].find(word=>word.index+word[0].length>runtime.wordOffset);if(word){const range={start:word.index,end:word.index+word[0].length};previewWord(index,range);markFocus(index,range);}}
      if(saved.playing&&!saved.paused)state.audio?.play().catch(()=>{});setStatus(saved.status||'Duraklatıldı');updateUi();
    }
    function seekTo(seconds) {
      cancelScrub(true);
      if (!state.chunks.length) return;
      runtime.loop=null;
      const value = timeline(); let target = Math.max(0, Math.min(Math.max(0, value.total - .05), seconds)); let index = 0;
      while (index < state.chunks.length - 1 && target >= duration(index)) { target -= duration(index); index++; }
      const paused = state.paused;
      if (index === state.index && state.audio && runtime.audioIndex === index && Number.isFinite(state.audio.duration)) {
        state.audio.currentTime = Math.min(Math.max(0, state.audio.duration - .05), target); updateProgress(); save(true);
      } else startSession(index, { seek: target, paused });
    }
    function seekBy(seconds) { seekTo(timeline().elapsed + seconds * state.settings.playbackRate); }
    async function resume(value) {
      await Promise.all([library.ready, preferences.ready]);
      state.queueItemId = null;
      value ||= library.current().pages[page().url]?.anchor;
      if (!value) throw new Error("Bu sayfa için kayıtlı okuma konumu yok.");
      const chunks = prepareChunks(); const point = library.resolveAnchor(value, chunks);
      state.chunks = chunks; startSession(point.index, { anchor: point.anchor });
      if(point.repaired)setStatus('Yazıdaki değişikliklere göre kayıtlı konum bulundu.');
    }
    async function bookmark() {
      if (!state.chunks.length) throw new Error("Önce okumayı başlatın.");
      await library.mutate({ type: "bookmark", ...page(), anchor: anchor() });
      return { message: "Yer imi kaydedildi." };
    }
    function buildFocus() {
      if (!focusText) return;
      focusText.replaceChildren(); runtime.focusRows = state.chunks.map((chunk, index) => {
        const paragraph = document.createElement("p"); paragraph.textContent = chunk.text; paragraph.dataset.focusChunk = String(index); paragraph.tabIndex = 0;
        paragraph.setAttribute("aria-label", `Paragraf ${index + 1}: buradan okumak için Enter`); focusText.appendChild(paragraph); return paragraph;
      });
    }
    function focusSettings() {
      if (!reader) return;
      reader.dataset.background = state.settings.focusBackground;
      reader.style.setProperty("--focus-font-size", `${state.settings.focusFontSize}px`);
      reader.style.setProperty('--focus-font',({serif:'Georgia, serif',sans:'Arial, sans-serif',mono:'monospace'})[state.settings.focusFont]);
      reader.style.setProperty('--focus-line-height',state.settings.focusLineHeight);
      reader.style.setProperty('--focus-width',`${state.settings.focusWidth}px`);
      reader.style.setProperty('--focus-padding',`${state.settings.focusPadding}px`);
      const hex = preferences.highlightColorFor(state.settings, globalThis.SesliOkuThemes.current());
      const values = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
      reader.style.setProperty("--focus-word-bg", hex); reader.style.setProperty("--focus-word-text", values[0] * .299 + values[1] * .587 + values[2] * .114 > 150 ? "#111" : "#fff");
    }
    function markFocus(index, range) {
      if (!runtime.focus || !focusText) return;
      for (const paragraph of runtime.focusRows) paragraph.classList.toggle("active", paragraph.dataset.focusChunk === String(index));
      const paragraph = runtime.focusRows[index]; const text = state.chunks[index]?.text;
      if (!paragraph || !text) return;
      if (range) {
        const mark = document.createElement("mark"); mark.textContent = text.slice(range.start, range.end);
        paragraph.replaceChildren(document.createTextNode(text.slice(0, range.start)), mark, document.createTextNode(text.slice(range.end)));
      }
      if (state.settings.autoFollow && runtime.focusFollow) {
        const top = paragraph.offsetTop;
        if (top < focusText.scrollTop || top + paragraph.offsetHeight > focusText.scrollTop + focusText.clientHeight) focusText.scrollTo({ top: Math.max(0, top - 30), behavior: state.settings.scrollBehavior === "instant" || matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      }
    }
    function toggleFocus(force) {
      if (!state.chunks.length) { state.chunks = prepareChunks(); state.index = 0; runtime.chunks = state.chunks; }
      if (!state.chunks.length) throw new Error("Bu sayfada okunacak metin bulunamadı.");
      showUi(); runtime.focus = typeof force === "boolean" ? force : !runtime.focus;
      if (runtime.focus) { toggleSettings(false); buildFocus(); }
      reader.hidden = !runtime.focus; focusSettings(); markFocus(state.index); renderHighlightStyle();
    }
    function applyExclusions(value) {
      const entry = value.pages[page().url]; const items = [...(value.sites[library.siteOrigin(location.href)]?.exclusions || []),...(entry?.exclusions || [])];
      const signature = JSON.stringify(items); if (runtime.excludeKey === signature) return;
      runtime.excludeKey = signature;
      for (const element of runtime.excluded) element.removeAttribute("data-sesli-oku-excluded"); runtime.excluded.clear();
      for (const item of items) {
        let element = null; try { element = document.querySelector(item.selector); } catch {}
        if (!element && item.quote) element = [...document.querySelectorAll("p, li, section, aside, nav")].find(node => node.textContent.replace(/\s+/g, " ").trim().startsWith(item.quote));
        if (element && element !== document.body && element !== document.documentElement) { element.setAttribute("data-sesli-oku-excluded", ""); runtime.excluded.add(element); }
      }
      const current = state.chunks[state.index];
      if (current?.el && state.playing) {
        const paused = state.paused; const point = anchor(); const chunks = prepareChunks();
        if (!chunks.length) { stop(); return; }
        let index = chunks.findIndex(chunk => chunk.el === current.el && chunk.text === current.text);
        const unchanged = index >= 0;
        if (index < 0) index = chunks.findIndex(chunk => current.el.compareDocumentPosition(chunk.el) & Node.DOCUMENT_POSITION_FOLLOWING);
        state.chunks = chunks;
        startSession(Math.max(0, index), { paused, anchor: unchanged ? point : null });
      }
    }
    function pickExclude() {
      showUi(); toggleSettings(false); runtime.picker?.();
      const preview = document.createElement("div"); preview.className = "exclude-preview"; preview.setAttribute("popover", "manual"); root.appendChild(preview);
      let candidate = null;
      const move = event => {
        if (!(event.target instanceof Element) || event.target.closest("#sesli-oku-host")) return;
        candidate = event.target.closest("p, li, aside, nav, section, article, div");
        if (!candidate || [document.body, document.documentElement].includes(candidate)) return;
        const rect = candidate.getBoundingClientRect();
        preview.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        if (!preview.matches(":popover-open")) preview.showPopover();
      };
      const cleanup = () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); preview.remove(); runtime.picker = null; };
      const click = event => {
        if (event.target instanceof Element && event.target.closest("#sesli-oku-host")) return;
        move(event); event.preventDefault(); event.stopImmediatePropagation();
        if (!candidate) return;
        const selected = candidate; cleanup();
        library.mutate({ type: "exclude", ...page(), selector: elementPath(selected), quote: selected.innerText?.replace(/\s+/g, " ").trim().slice(0, 180) || "" }).then(() => setStatus("Alan okuma dışında bırakıldı")).catch(error => setStatus(error.message, true));
      };
      const key = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cleanup(); setStatus("Alan seçimi iptal edildi"); } };
      document.addEventListener("pointermove", move, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key, true);
      runtime.picker = cleanup; setStatus("Hariç tutulacak alana tıklayın · Esc iptal");
    }
    function pointTime(point, result, audio) {
      if (point.end) return audio.duration;
      if (point.charOffset !== undefined) {
        const index=result.sourceOffsets?.findIndex(range=>range && range.end>point.charOffset);
        if(index>=0)return result.boundaries[index].offset/1e7;
      }
      return point.seconds||0;
    }
    function sentenceBounds() {
      const index=Math.min(state.index,state.chunks.length-1);const text=state.chunks[index]?.text;
      if(!text)throw new Error('Önce okumayı başlatın.');
      const cursor=runtime.wordOffset;let start=0,end=text.length;
      for(const match of text.matchAll(/[.!?…]["'”’)]*\s+/gu)){const next=match.index+match[0].length;if(next<=cursor)start=next;else{end=next;break;}}
      return {a:{index,charOffset:start},b:{index,charOffset:end,end:end===text.length}};
    }
    function paragraphBounds() {
      const index=Math.min(state.index,state.chunks.length-1);const current=state.chunks[index];if(!current)throw new Error('Önce okumayı başlatın.');
      let first=index,last=index;
      if(current.el){while(first>0&&state.chunks[first-1].el===current.el)first--;while(last+1<state.chunks.length&&state.chunks[last+1].el===current.el)last++;}
      return {a:{index:first,seconds:0},b:{index:last,end:true}};
    }
    function repeatStatus() {
      const controls=root?.querySelector('.repeat-controls');if(!controls)return;
      const names={sentence:'Cümle döngüsü',paragraph:'Paragraf döngüsü',ab:'A–B döngüsü'};
      controls.querySelector('output').textContent=[runtime.loop?names[runtime.loop.mode]:'Döngü kapalı',runtime.a?`A: ${runtime.a.index+1}. parça ${time(runtime.a.seconds)}`:'',runtime.b?`B: ${runtime.b.index+1}. parça ${time(runtime.b.seconds)}`:''].filter(Boolean).join(' · ');
      for(const button of controls.querySelectorAll('[data-repeat]'))if(['sentence','paragraph','ab'].includes(button.dataset.repeat))button.setAttribute('aria-pressed',String(runtime.loop?.mode===button.dataset.repeat));
    }
    function repeatAction(name) {
      if(name==='off'){runtime.loop=null;repeatStatus();setStatus('Döngü kapatıldı');return;}
      if(!state.chunks.length)throw new Error('Önce okumayı başlatın.');
      if(name==='a'||name==='b'){
        if(!state.audio||!Number.isFinite(state.audio.duration))throw new Error('Sesin başlamasını bekleyin.');
        runtime[name]={index:state.index,seconds:state.audio.currentTime};repeatStatus();setStatus(`${name.toUpperCase()} noktası: ${state.index+1}. parça · ${time(state.audio.currentTime)}`);return;
      }
      const bounds=name.startsWith('sentence')?sentenceBounds():name.startsWith('paragraph')?paragraphBounds():{a:runtime.a,b:runtime.b};
      if(!bounds.a||!bounds.b||bounds.a.index>bounds.b.index||(bounds.a.index===bounds.b.index&&(bounds.b.seconds||0)<=(bounds.a.seconds||0)&&name==='ab'))throw new Error('Önce A, ardından daha ileride bir B noktası işaretleyin.');
      runtime.loop=name.endsWith('once')?null:{...bounds,mode:name};
      startSession(bounds.a.index,{anchor:bounds.a});
      repeatStatus();setStatus(runtime.loop?'Döngü etkin · kapatmak için Tekrar menüsünü kullanın':'Bölüm yeniden okunuyor');
    }
    function loopTick(audio,result) {
      const loop=runtime.loop;if(!loop||state.index!==loop.b.index||loop.b.end||audio.currentTime+.015<pointTime(loop.b,result,audio))return false;
      if(loop.a.index===state.index){audio.currentTime=pointTime(loop.a,result,audio);return true;}
      startSession(loop.a.index,{anchor:loop.a});return true;
    }
    function nextRepeat(index) { const loop=runtime.loop;return loop && index>=loop.b.index ? loop.a : null; }
    function mount(shadow) {
      root = shadow; strip = document.createElement("div"); strip.className = "playback-strip";
      strip.innerHTML = '<button data-seek="-10" title="10 saniye geri">−10 sn</button><input type="range" min="0" max="1000" step="1" value="0" aria-label="Okuma ilerlemesi"><button data-seek="10" title="10 saniye ileri">+10 sn</button><output aria-live="off">~0:00 kalan</output><button data-experience="bookmark" title="Yer imi ekle" aria-label="Yer imi ekle">★</button><button data-experience="focus" title="Odak görünümü">Odak</button><button data-experience="sections" title="Okunacak bölümleri seç">Bölümler</button>';
      shadow.querySelector(".bar").after(strip);
      const repeat=document.createElement('details');repeat.className='repeat-controls';repeat.innerHTML='<summary>Tekrar / A–B döngüsü</summary><output role="status"></output><div class="library-buttons"><button data-repeat="sentence-once">Cümleyi tekrar oku</button><button data-repeat="paragraph-once">Paragrafı tekrar oku</button><button data-repeat="sentence">Cümle döngüsü</button><button data-repeat="paragraph">Paragraf döngüsü</button><button data-repeat="a">A işaretle</button><button data-repeat="b">B işaretle</button><button data-repeat="ab">A–B döngüsü</button><button data-repeat="off">Döngüyü kapat</button></div>';
      strip.after(repeat);repeat.addEventListener('click',event=>{const button=event.target.closest('[data-repeat]');if(button){try{repeatAction(button.dataset.repeat);}catch(error){setStatus(error.message,true);}}});
      const sections=document.createElement('details');sections.className='reading-sections preferences';sections.innerHTML='<summary>Bölümler / seçerek oku</summary><div class="reading-sections-list"></div><div class="library-buttons"><button type="button" data-read-sections>Seçili bölümleri oku</button><button type="button" data-refresh-sections>Başlıkları yenile</button></div>';
      root.querySelector('[data-library-panel="records"]').prepend(sections);sections.addEventListener('toggle',()=>{if(sections.open)refreshSections();});sections.querySelector('[data-read-sections]').addEventListener('click',readSections);sections.querySelector('[data-refresh-sections]').addEventListener('click',()=>refreshSections(true));
      reader = document.createElement("section"); reader.className = "focus-reader"; reader.hidden = true; reader.setAttribute("aria-label", "Odak okuma görünümü");
      reader.innerHTML = '<div class="focus-heading"><h2></h2><button type="button" data-close-focus>Odaktan çık</button></div><div class="focus-text"></div>';
      strip.after(reader); reader.querySelector("h2").textContent = document.title; focusText = reader.querySelector(".focus-text");
      strip.addEventListener("click", event => { const button = event.target.closest("button"); if (!button) return; if (button.dataset.seek) seekBy(Number(button.dataset.seek)); if (button.dataset.experience === "bookmark") bookmark().then(result => setStatus(result.message)).catch(error => setStatus(error.message, true)); if(button.dataset.experience==='sections'){toggleSettings(true);state.ui.preferences.activateTab('library');root.querySelector('.reading-library').dispatchEvent(new CustomEvent('library-activate',{detail:'records'}));sections.open=true;refreshSections();} if (button.dataset.experience === "focus") { try { toggleFocus(); } catch (error) { setStatus(error.message, true); } } });
      const slider = strip.querySelector("input");slider.addEventListener('input',previewScrub);slider.addEventListener('change',commitScrub);
      slider.addEventListener('pointercancel',()=>cancelScrub(true));slider.addEventListener('blur',()=>cancelScrub(true));
      slider.addEventListener('keydown',event=>{if(event.key==='Escape'&&scrub){event.preventDefault();event.stopPropagation();cancelScrub(true);}});
      reader.querySelector("[data-close-focus]").addEventListener("click", () => toggleFocus(false));
      const fromFocus = event => { const paragraph = event.target.closest("[data-focus-chunk]"); if (paragraph) startSession(Number(paragraph.dataset.focusChunk)); };
      focusText.addEventListener("click", fromFocus); focusText.addEventListener("keydown", event => { if (event.key === "Enter") fromFocus(event); });
      focusText.addEventListener("wheel", () => { runtime.focusFollow = false; }, { passive: true });
      focusText.addEventListener("touchmove", () => { runtime.focusFollow = false; }, { passive: true });
      repeatStatus();focusSettings(); updateProgress();
    }
    async function exportAudio(requestAudio, offline = false) {
      if (runtime.exporting) throw new Error("Bir indirme zaten hazırlanıyor.");
      const chunks = (state.chunks.length ? state.chunks : prepareChunks()).map(chunk => ({ ...chunk }));
      if (!chunks.length) throw new Error("İndirilecek metin bulunamadı.");
      const settings = structuredClone(state.settings); const token = ++runtime.exportToken; const session = state.session;
      const resumeAfter = state.playing && !state.paused;
      if (resumeAfter) { state.paused = true; state.audio?.pause(); updateUi(); }
      runtime.exporting = true; runtime.exportResume = { resumeAfter, session };
      const filename = `${(document.title || "sesli-oku").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120)}.mp3`;
      let offlineId=null;
      try {
        const parts = [];
        if(offline){const response=await sendToBackground({type:'VAULT_BEGIN',value:{...page(),chunks:chunks.map(chunk=>({text:chunk.text})),settings}});offlineId=response.book.id;runtime.offlineId=offlineId;}
        await library.mutate({ type: "export", value: { status: "working", percent: 0, filename, kind: offline ? "offline" : "mp3", bookId: offlineId } });
        for (let index = 0; index < chunks.length; index++) {
          if (token !== runtime.exportToken) return;
          const result = await requestAudio(chunks[index].text, chunks[index], settings);
          if (token !== runtime.exportToken) return;
          if(offline){let binary='';for(let pos=0;pos<result.audio.length;pos+=0x8000)binary+=String.fromCharCode(...result.audio.subarray(pos,pos+0x8000));await sendToBackground({type:'VAULT_PART',id:offlineId,index,part:{audio:btoa(binary),boundaries:result.boundaries,sourceOffsets:result.sourceOffsets}});}
          else parts.push(library.stripMp3Tags(result.audio));
          await library.mutate({ type: "export", value: { status: "working", percent: Math.round((index + 1) / chunks.length * 100), filename, kind: offline ? "offline" : "mp3", bookId: offlineId } });
        }
        if (token !== runtime.exportToken) return;
        if(offline){await sendToBackground({type:'VAULT_FINISH',id:offlineId});if(token!==runtime.exportToken)return;await library.mutate({type:'export',value:{status:'done',kind:'offline',id:offlineId,percent:100,filename:document.title}});offlineId=null;runtime.offlineId=null;return;}
        const blob = new Blob(parts, { type: "audio/mpeg" }); runtime.exportBlob = blob;
        const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename;
        document.documentElement.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        await library.mutate({ type: "export", value: { status: "done", percent: 100, filename } });
      } catch (error) {
        if (token === runtime.exportToken) await library.mutate({ type: "export", value: { status: "error", error: error.message } });
      } finally {
        if(offlineId)sendToBackground({type:'VAULT_REMOVE',id:offlineId}).catch(()=>{});
        if (token === runtime.exportToken) { runtime.exporting = false; restoreExportPlayback(); }
      }
    }
    function restoreExportPlayback() {
      const saved = runtime.exportResume; runtime.exportResume = null;
      if (saved?.resumeAfter && state.playing && state.session === saved.session) { state.paused = false; state.audio?.play().catch(() => {}); updateUi(); }
    }
    function cancelExport() { if(runtime.offlineId){sendToBackground({type:'VAULT_REMOVE',id:runtime.offlineId}).catch(()=>{});runtime.offlineId=null;} runtime.exportToken++; runtime.exporting = false; restoreExportPlayback(); library.mutate({ type: "export", value: { status: "canceled" } }).catch(() => {}); }
    async function perform(action, args, requestAudio) {
      if (action === "resume") { await resume(args?.anchor); return { message: "Kayıtlı konumdan devam ediliyor." }; }
      if (action === "bookmark") return bookmark();
      if (action === "focus") { toggleFocus(); return { message: "Odak görünümü değiştirildi." }; }
      if (action === "pickExclude") { pickExclude(); return { message: "Sayfada hariç tutulacak alana tıklayın." }; }
      if(action==='offlineSave'){exportAudio(requestAudio,true).catch(error=>setStatus(error.message,true));return {message:'Çevrimdışı ses hazırlanıyor; ilerleme kitaplıkta gösterilecek.'};}
      if(action==='repeat'){repeatAction(args?.mode);return {message:'Tekrar ayarı uygulandı.'};}
      if (action === "export") { exportAudio(requestAudio).catch(error => setStatus(error.message, true)); return { message: "MP3 hazırlanıyor; ilerleme kitaplıkta gösterilecek." }; }
      if (action === "cancelExport") { cancelExport(); return { message: "İndirme iptal edildi." }; }
      throw new Error("Bilinmeyen okuma aracı.");
    }
    function initialize() {
      library.subscribe(value => { try { applyExclusions(value); } catch {} });
      setInterval(listeningTick,250);
      window.addEventListener('blur',()=>cancelScrub(true));
      window.addEventListener("pagehide", () => {listeningTick();flushListening();save(true);});
      document.addEventListener("visibilitychange", () => { if (document.hidden) save(true); });
    }
    function stopped() { cancelScrub(false);listeningTick();flushListening(); runtime.loop=null; runtime.a=null; runtime.b=null;repeatStatus(); save(true); cancelExportIfActive(); runtime.picker?.(); if (reader) { runtime.focus = false; reader.hidden = true; renderHighlightStyle(); } }
    function cancelExportIfActive() { if (runtime.exporting) cancelExport(); }
    return { mount, initialize, scrubbing:()=>!!scrub, timeline, seekTo, seekBy, loopTick, nextRepeat, clearRepeat() {runtime.loop=null;repeatStatus();}, beforeSession, audioStarted, metadata, spokenWord, save, perform, stopped, updateProgress,
      invalidate() { runtime.durations.clear();wordTimings.clear(); focusSettings(); }, focusOpen: () => runtime.focus,
      resumeFocus() { runtime.focusFollow = true; markFocus(state.index); },
      debug: () => ({ scrub:scrub?.preview?{...scrub.preview}:null, sections:sectionRows,mediaOwned, ...timeline(), loop: runtime.loop, a:runtime.a,b:runtime.b, focus: runtime.focus, exporting: runtime.exporting, exportBlob: runtime.exportBlob, exclusions: [...runtime.excluded].map(element => element.id || elementPath(element)) }) };
  }
  globalThis.SesliOkuExperience = Object.freeze({ create });
})();
