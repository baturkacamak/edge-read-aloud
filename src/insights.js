/** Worker-owned listening totals and opt-in browser-account synchronization. */
(() => {
  if (globalThis.SesliOkuInsights) return;
  let writes = Promise.resolve();
  const serial = fn => { const task = writes.then(fn); writes = task.catch(() => {}); return task; };
  const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const defaults = () => ({ days: {}, weeklyGoal: 150 });
  async function stats(operation = {}) {
    return serial(async () => {
      const stored = await chrome.storage.local.get('listeningStats');
      const value = { ...defaults(), ...stored.listeningStats };
      if (operation.clear) value.days = {};
      if (operation.goal !== undefined) value.weeklyGoal = Math.max(0,Math.min(6000,Number(operation.goal)||0));
      if (operation.seconds || operation.completed) {
        const key = dayKey(new Date()); const day = value.days[key] || { seconds: 0, completed: [] };
        day.seconds += Math.max(0,Math.min(60,Number(operation.seconds)||0));
        if (operation.completed && /^https?:|^file:|^chrome-extension:/.test(operation.url || '')) { const pageId=await hash(new TextEncoder().encode(operation.url));day.completed = [...new Set([...day.completed,pageId])].slice(-300); }
        value.days[key] = day;
      }
      value.days = Object.fromEntries(Object.entries(value.days).sort().slice(-365));
      if (Object.keys(operation).length) await chrome.storage.local.set({listeningStats:value});
      const today = dayKey(new Date()); const monday = new Date(); monday.setDate(monday.getDate() - (monday.getDay()+6)%7); const start = dayKey(monday);
      const week = Object.entries(value.days).filter(([key])=>key>=start && key<=today).map(([,day])=>day);
      return {today:value.days[today]||{seconds:0,completed:[]},weekSeconds:week.reduce((n,d)=>n+d.seconds,0),weekCompleted:new Set(week.flatMap(d=>d.completed)).size,weeklyGoal:value.weeklyGoal,days:value.days};
    });
  }
  const prefix = 'sesliOku.sync.'; const alarm = 'sesli-oku-sync';
  let syncing = null; let applying = false;let lastPublishedHash=null;
  const fields = ['settings','readingProfiles','appearanceTheme','appearanceMode'];
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const bytesFrom = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  function encode(bytes) { let str=''; for(let i=0;i<bytes.length;i+=8192)str+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(str); }
  async function unpack(remote) {
    const head=remote[prefix+'head'];if(!head)return null;
    if(head.version!==1 || !Number.isInteger(head.parts) || head.parts<1 || head.parts>14)throw new Error('Eşitleme verisi tanınmıyor.');
    let text='';for(let i=0;i<head.parts;i++){const part=remote[prefix+i];if(typeof part!=='string')throw new Error('Eşitleme aktarımı tamamlanmadı; tekrar deneyin.');text+=part;}
    const bytes=bytesFrom(text);if(await hash(bytes)!==head.hash)throw new Error('Eşitleme aktarımı tamamlanmadı; tekrar deneyin.');
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));const reader=stream.getReader();let size=0;const parts=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>5*1024*1024){await reader.cancel();throw new Error('Eşitleme verisi çok büyük.');}parts.push(value);}
    const payload=JSON.parse(await new Blob(parts).text());
    // Reuse the same validation boundary as file backups.
    const parsed=globalThis.SesliOkuTools.validateBackup(payload.backup);
    return { ...payload, parsed };
  }
  async function synchronize() {
    if(syncing)return syncing;
    syncing=(async()=>{
      const config=(await chrome.storage.local.get('syncConfig')).syncConfig||{};
      if(!config.enabled)return {message:'Cihazlar arası eşitleme kapalı.'};
      try {
        await journalWrites;
        const rawRemote=await chrome.storage.sync.get(null);
        const remote=await unpack(rawRemote);
        const local=await chrome.storage.local.get(['readingLibrary','syncJournal',...fields]);
        const journal=local.syncJournal||{fields:{},removed:{}};journal.fields||={};journal.removed||={};journal.removedPages||={};
        if(remote){
          const incoming=remote.parsed.readingLibrary;
          for(const [id,stamp]of Object.entries(remote.removed||{}))journal.removed[id]=Math.max(journal.removed[id]||0,Number(stamp)||0);
          for(const [url,stamp]of Object.entries(remote.removedPages||{}))if(/^https?:/.test(url))journal.removedPages[url]=Math.max(journal.removedPages[url]||0,Number(stamp)||0);
          applying=true;try{await globalThis.SesliOkuLibrary.mutate({type:'syncMerge',pages:incoming.pages,bookmarks:incoming.bookmarks,removed:journal.removed,removedPages:journal.removedPages});}finally{applying=false;}
          const changes={};
          for(const key of fields)if(remote.fields?.[key]!==undefined&&(!Object.hasOwn(journal.fields,key)||remote.fields[key]>journal.fields[key])){changes[key]=remote.parsed[key];journal.fields[key]=remote.fields[key];}
          applying=true;try{await chrome.storage.local.set({...changes,syncJournal:journal});}finally{applying=false;}
        }
        for(const key of fields)journal.fields[key]??=1;
        await chrome.storage.local.set({syncJournal:journal});
        const backup=await globalThis.SesliOkuTools.backup();
        // Only portable web positions/bookmarks travel; site exclusions, queues, files and audio stay local.
        backup.library={pages:Object.fromEntries(Object.entries(backup.library.pages).filter(([url])=>/^https?:/.test(url)).map(([url,p])=>[url,{url,title:p.title,anchor:p.anchor,completed:p.completed,updated:p.updated}])),bookmarks:backup.library.bookmarks.filter(b=>/^https?:/.test(b.url))};
        backup.library.bookmarks=backup.library.bookmarks.map(item=>({...item,note:String(item.note||'').slice(0,3000),tags:SesliOkuLibrary.tags(item.tags)}));
        delete backup.created;
        backup.library.bookmarks.sort((a,b)=>a.id.localeCompare(b.id));
        const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
        const payload={backup,fields:journal.fields,removed:journal.removed,removedPages:journal.removedPages};
        const compressed=new Uint8Array(await new Response(new Blob([JSON.stringify(canonical(payload))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        const packed=encode(compressed);const count=Math.ceil(packed.length/7000);
        if(count>14)throw new Error('Eşitleme için 95 KB sınırı aşıldı. Yerel kayıtlar korundu; JSON yedeğini kullanabilirsiniz.');
        const values={};for(let i=0;i<14;i++)values[prefix+i]=i<count?packed.slice(i*7000,(i+1)*7000):'';
        values[prefix+'head']={version:1,parts:count,hash:await hash(compressed)};
        lastPublishedHash=values[prefix+'head'].hash;
        if(rawRemote[prefix+'head']?.hash!==lastPublishedHash)await chrome.storage.sync.set(values);
        await chrome.storage.local.set({syncConfig:{enabled:true,lastSync:Date.now(),error:''}});
        return {message:'Konumlar, yer imleri ve tercihler tarayıcı hesabıyla eşitlendi.'};
      } catch(error){await chrome.storage.local.set({syncConfig:{...config,error:error.message}});if(config.enabled)chrome.alarms.create(alarm,{delayInMinutes:5});throw error;}
    })().finally(()=>{syncing=null;});return syncing;
  }
  let journalWrites=Promise.resolve();
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='sync'&&changes[prefix+'head']?.newValue?.hash!==lastPublishedHash&&changes[prefix+'head'])chrome.alarms.create(alarm,{delayInMinutes:1});
    if(area!=='local'||applying)return;
    if(!fields.some(key=>changes[key])&&!changes.readingLibrary)return;
    journalWrites=journalWrites.then(async()=>{
      const stored=await chrome.storage.local.get(['syncJournal','syncConfig']);const journal=stored.syncJournal||{fields:{},removed:{}};journal.fields||={};journal.removed||={};journal.removedPages||={};const now=Date.now();
      for(const key of fields)if(changes[key])journal.fields[key]=Math.max(now,(Number(journal.fields[key])||0)+1);
      if(changes.readingLibrary){for(const [url,page]of Object.entries(changes.readingLibrary.oldValue?.pages||{}))if(!changes.readingLibrary.newValue?.pages?.[url]&&/^https?:/.test(url))journal.removedPages[url]=Math.max(now,(Number(page.updated)||0)+1);const old=changes.readingLibrary.oldValue?.bookmarks||[];const next=changes.readingLibrary.newValue?.bookmarks||[];for(const item of old)if(!next.some(b=>b.id===item.id))journal.removed[item.id]=Math.max(now,(Number(item.updated||item.created)||0)+1);}
      journal.removedPages=Object.fromEntries(Object.entries(journal.removedPages).sort((a,b)=>b[1]-a[1]).slice(0,500));
      journal.removed=Object.fromEntries(Object.entries(journal.removed).sort((a,b)=>b[1]-a[1]).slice(0,1000));
      await chrome.storage.local.set({syncJournal:journal});if(stored.syncConfig?.enabled&&!(await chrome.alarms.get(alarm)))chrome.alarms.create(alarm,{delayInMinutes:1});
    }).catch(()=>{});
  });
  chrome.alarms.onAlarm.addListener(value=>{if(value.name===alarm)synchronize().catch(()=>{});});
  async function configure(enabled){if(syncing)await syncing.catch(()=>{});await chrome.storage.local.set({syncConfig:{enabled:!!enabled}});if(enabled){const stored=await chrome.storage.local.get('syncJournal');if(!stored.syncJournal)await chrome.storage.local.set({syncJournal:{fields:{},removed:{}}});return synchronize();}await chrome.alarms.clear(alarm);return {message:'Eşitleme kapatıldı. Tarayıcı hesabındaki kopyayı ayrıca silebilirsiniz.'};}
  async function clearRemote(){await configure(false);const keys=Object.keys(await chrome.storage.sync.get(null)).filter(key=>key.startsWith(prefix));await chrome.storage.sync.remove(keys);return {message:'Bu uzantının hesaptaki eşitleme kopyası silindi. Yerel kayıtlar korundu.'};}
  globalThis.SesliOkuInsights={stats,synchronize,configure,clearRemote,unpack};
})();
