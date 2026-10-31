import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=chrome.runtime.getURL('src/vendor/pdfjs/pdf.worker.min.mjs');
const api=globalThis.SesliOkuDocument;
const vault=globalThis.SesliOkuVault;
const library=globalThis.SesliOkuLibrary;
const preferences=globalThis.SesliOkuSettings;
const article=document.getElementById('document-text');const status=document.getElementById('reader-status');const read=document.getElementById('read-document');const resume=document.getElementById('resume-document');const sections=document.getElementById('document-section');
sections.parentElement.classList.add('preferences');
const sectionDropdown=preferences.enhanceSelect(sections);
let generation=0;
const report=text=>{status.textContent=text;};
function appendText(chunks,value,heading=''){let first=true;while(value.length){let end=Math.min(value.length,4000);if(end<value.length){const gap=value.lastIndexOf(' ',end);if(gap>2000)end=gap;}const text=value.slice(0,end).trim();if(text)chunks.push({text,heading:first?heading:''});first=false;value=value.slice(end).trimStart();}}
const clean=text=>String(text||'').replace(/\s+/g,' ').trim();
const xml=text=>{const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('EPUB içindeki XML okunamıyor.');return doc;};
function resolvePath(base,href){const url=new URL(href,'https://book.invalid/'+base);if(url.origin!=='https://book.invalid')throw new Error('EPUB uzak dosya içeremez.');return decodeURIComponent(url.pathname.slice(1));}
async function epub(bytes){
  let total=0,count=0;
  const files=fflate.unzipSync(bytes,{filter(file){if(++count>3000)throw new Error('EPUB çok fazla dosya içeriyor.');if(!/\.(xml|opf|xhtml|html|htm)$/i.test(file.name))return false;if(file.originalSize>2*1024*1024||(total+=file.originalSize)>20*1024*1024)throw new Error('EPUB metni 20 MB sınırını aşıyor.');return true;}});
  const text=path=>{if(!files[path])throw new Error('EPUB dosyası eksik: '+path);return new TextDecoder().decode(files[path]);};
  if(files['META-INF/encryption.xml']){const encrypted=xml(text('META-INF/encryption.xml'));if([...encrypted.getElementsByTagNameNS('*','EncryptionMethod')].some(node=>!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(node.getAttribute('Algorithm'))))throw new Error('Şifreli/DRM korumalı EPUB desteklenmiyor.');}
  const container=xml(text('META-INF/container.xml'));const opfPath=container.getElementsByTagNameNS('*','rootfile')[0]?.getAttribute('full-path');if(!opfPath)throw new Error('EPUB kitap tanımı bulunamadı.');
  const opf=xml(text(opfPath));const title=clean(opf.getElementsByTagNameNS('*','title')[0]?.textContent)||'EPUB';
  const manifest=new Map([...opf.getElementsByTagNameNS('*','item')].map(item=>[item.getAttribute('id'),item]));const chunks=[];
  for(const [chapterIndex,ref] of [...opf.getElementsByTagNameNS('*','itemref')].entries()){
    if(ref.getAttribute('linear')==='no')continue;const item=manifest.get(ref.getAttribute('idref'));if(!item)throw new Error('EPUB bölüm sırası eksik.');
    const source=xml(text(resolvePath(opfPath,item.getAttribute('href'))));
    source.querySelectorAll('script,style,nav,form,svg,math,iframe,object,embed,head').forEach(node=>node.remove());
    const title=clean(source.querySelector('h1,h2,title')?.textContent)||`Bölüm ${chapterIndex+1}`;
    const blocks=[...source.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote')].filter(node=>!node.querySelector('p,li,blockquote'));
    const values=blocks.map(node=>clean(node.textContent)).filter(Boolean);if(!values.length){const body=source.getElementsByTagNameNS('*','body')[0];if(body)values.push(clean(body.textContent));}
    if(values.length>1&&values[0]===title)values.shift();
    for(const [index,value] of values.entries())appendText(chunks,value,index===0?title:'');
    if(chunks.length>5000)throw new Error('EPUB çok fazla metin bölümü içeriyor (en fazla 5000).');
  }
  if(!chunks.length)throw new Error('EPUB içinde okunabilir metin yok.');return {title,chunks};
}
async function pdf(bytes,token){
  const task=pdfjs.getDocument({data:bytes,isEvalSupported:false,useWasm:false,disableFontFace:true,cMapUrl:chrome.runtime.getURL('src/vendor/pdfjs/cmaps/'),cMapPacked:true,standardFontDataUrl:chrome.runtime.getURL('src/vendor/pdfjs/standard_fonts/')});
  task.onPassword=update=>{const form=document.getElementById('pdf-password');form.hidden=false;form.onsubmit=event=>{event.preventDefault();const input=form.querySelector('input');update(input.value);input.value='';form.hidden=true;};document.getElementById('password-cancel').onclick=()=>{task.destroy();form.hidden=true;};};
  let doc;try{doc=await task.promise;
    if(doc.numPages>1000)throw new Error('PDF en fazla 1000 sayfa olabilir.');const chunks=[];let characters=0;
    for(let page=1;page<=doc.numPages;page++){
      if(token!==generation)throw new Error('Belge açma iptal edildi.');report(`PDF metni hazırlanıyor: ${page}/${doc.numPages}`);
      const data=await(await doc.getPage(page)).getTextContent();const lines=[];let current='',previousY=null;
      for(const item of data.items){if(!('str'in item))continue;const y=item.transform[5];if(previousY!==null&&Math.abs(y-previousY)>3&&current){lines.push(clean(current));current='';}current+=item.str+(item.hasEOL?'\n':' ');previousY=y;if(item.hasEOL&&current){lines.push(clean(current));current='';}}
      if(current)lines.push(clean(current));const text=clean(lines.join(' '));characters+=text.length;if(characters>5_000_000)throw new Error('PDF metni çok uzun.');
      appendText(chunks,text,`Sayfa ${page}`);
    }
    if(!chunks.length)throw new Error('PDF metin katmanı içermiyor. Taranmış sayfalar için OCR gerekir.');
    const metadata=await doc.getMetadata().catch(()=>null);return {title:clean(metadata?.info?.Title)||'PDF',chunks};
  }finally{if(doc)await doc.destroy();else await task.destroy();document.getElementById('pdf-password').hidden=true;}
}
async function render(book){
  if(book.status!=='ready')throw new Error('Bu kayıt henüz hazırlanıyor.');
  if(api.book)await chrome.runtime.sendMessage({target:'background',type:'STOP_ACTIVE'});
  api.book=book;article.replaceChildren();sections.replaceChildren();let label='Başlangıç';
  for(const [index,chunk] of book.chunks.entries()){
    if(chunk.heading){label=chunk.heading;const heading=document.createElement('h2');heading.textContent=label;article.append(heading);}
    const paragraph=document.createElement('p');paragraph.id=`book-paragraph-${index}`;paragraph.textContent=chunk.text;paragraph.dataset.bookPart=String(index);article.append(paragraph);
    if(chunk.heading||index===0){const option=document.createElement('option');option.value=paragraph.id;option.textContent=label;sections.append(option);}
  }
  document.title=book.title;history.replaceState(null,'',`?book=${encodeURIComponent(book.id)}${new URL(location.href).searchParams.has('sesliOkuTest')?'&sesliOkuTest=1':''}`);
  preferences.setContext(location.href);document.documentElement.dataset.bookReady='true';api.resolve();read.disabled=false;sections.disabled=false;sectionDropdown.sync();
  const entry=library.current().pages[library.pageKey(location.href)];resume.disabled=!entry?.anchor||entry.completed;
  report(book.kind==='audio'?'Çevrimdışı kayıt hazır. Ses, perde ve telaffuz hazırlama anındaki ayarlardadır; oynatma hızı değiştirilebilir.':`${book.title} · ${book.chunks.length} metin bölümü · Sesli okumada internet kullanılır.`);
}
async function loadFile(file){
  if(!file) return;if(file.size>50*1024*1024)throw new Error('Dosya en fazla 50 MB olabilir.');const token=++generation;read.disabled=true;resume.disabled=true;if(api.book)await chrome.runtime.sendMessage({target:'background',type:'STOP_ACTIVE'});if(document.documentElement.dataset.bookReady==='true'){const pending=Promise.withResolvers();api.ready=pending.promise;api.resolve=pending.resolve;}document.documentElement.dataset.bookReady='false';report('Belge açılıyor…');
  const bytes=new Uint8Array(await file.arrayBuffer());const hash=await crypto.subtle.digest('SHA-256',bytes);const id='document-'+[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');const cached=await vault.get(id);if(cached){await render(cached);return;}
  const extension=file.name.split('.').pop().toLowerCase();if(!['pdf','epub'].includes(extension))throw new Error('PDF veya EPUB seçin.');
  const parsed=extension==='pdf'?await pdf(bytes,token):await epub(bytes);if(token!==generation)return;
  const title=parsed.title==='PDF'||parsed.title==='EPUB'?file.name.replace(/\.[^.]+$/,''):parsed.title;
  const book={id,title,chunks:parsed.chunks,created:Date.now(),kind:'document',format:extension,status:'ready',size:parsed.chunks.reduce((size,chunk)=>size+chunk.text.length*2,0)};
  await vault.put(book);await render(book);
}
api.loadFile=loadFile;api.loadBook=async id=>{const book=await vault.get(id);if(!book)throw new Error('Yerel kayıt bulunamadı; özgün belgeyi yeniden içe aktarın.');await render(book);};
api.audioFor=async(text,chunk)=>{
  const paragraph=chunk?.el?.closest('[data-book-part]');if(!paragraph)throw new Error('Bu bölüm için çevrimdışı ses yok.');const index=Number(paragraph.dataset.bookPart);const part=await vault.getPart(api.book.id,index);if(!part)throw new Error('Yerel ses parçası eksik.');
  const bytes=Uint8Array.from(atob(part.audio),char=>char.charCodeAt(0));return {audio:bytes,boundaries:part.boundaries,sourceOffsets:part.sourceOffsets,voice:api.book.settings?.voice};
};
document.getElementById('document-file').addEventListener('change',event=>loadFile(event.target.files[0]).catch(error=>{report(error.message);if(api.book){read.disabled=false;document.documentElement.dataset.bookReady='true';api.resolve();}}));
read.addEventListener('click',async()=>{const result=await chrome.runtime.sendMessage({target:'background',type:'START_PAGE'});if(!result.ok)report(result.error);});
resume.addEventListener('click',()=>library.action('resume').catch(error=>report(error.message)));
sections.addEventListener('change',()=>document.getElementById(sections.value)?.scrollIntoView({block:'center',behavior:'smooth'}));
const themeStyle=document.createElement('style');themeStyle.textContent=SesliOkuThemes.css+preferences.css;document.head.append(themeStyle);SesliOkuThemes.subscribe(theme=>{document.body.dataset.theme=theme;document.body.dataset.colorMode=SesliOkuThemes.mode();});
preferences.subscribe(value=>{article.style.setProperty('--document-size',value.focusFontSize+'px');article.style.setProperty('--document-width',value.focusWidth+'px');article.style.setProperty('--document-line',value.focusLineHeight);article.style.setProperty('--document-padding',value.focusPadding+'px');article.style.setProperty('--document-font',({serif:'Georgia, serif',sans:'Arial, sans-serif',mono:'monospace'})[value.focusFont]);});
library.subscribe(value=>{if(api.book){const entry=value.pages[library.pageKey(location.href)];resume.disabled=!entry?.anchor||entry.completed;}});
await Promise.all([library.ready,preferences.ready]);const id=new URL(location.href).searchParams.get('book');if(id)api.loadBook(id).catch(error=>report(error.message));
