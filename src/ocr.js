/** All code and Turkish/English OCR models are bundled; no document upload. */
(() => {
  function abortable(task,signal){
    if(signal.aborted)return Promise.reject(new DOMException('Belge açma iptal edildi.','AbortError'));
    return new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('Belge açma iptal edildi.','AbortError'));signal.addEventListener('abort',abort,{once:true});Promise.resolve(task).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  }
  async function create(language,signal,report){
    const base=chrome.runtime.getURL('src/vendor/tesseract/');
    const labels={'loading tesseract core':'Motor yükleniyor','initializing tesseract':'Motor hazırlanıyor','loading language traineddata':'Dil dosyaları hazırlanıyor','initializing api':'Tanıma hazırlanıyor','recognizing text':'Metin tanınıyor'};
    const pending=Tesseract.createWorker(['tur','eng','tur+eng'].includes(language)?language:'tur+eng',1,{workerPath:base+'worker.min.js',corePath:base+'core',langPath:base+'lang',workerBlobURL:false,cacheMethod:'none',logger:message=>{if(!signal.aborted)report(`OCR · ${labels[message.status]||'Metin hazırlanıyor'} · %${Math.round((message.progress||0)*100)}`);}});
    pending.then(worker=>{if(signal.aborted)worker.terminate();},()=>{});
    const worker=await abortable(pending,signal);
    const abort=()=>worker.terminate();signal.addEventListener('abort',abort,{once:true});
    await abortable(worker.setParameters({tessedit_pageseg_mode:'3'}),signal);
    return {async recognize(image){const result=await abortable(worker.recognize(image),signal);return result.data.text;},async close(){signal.removeEventListener('abort',abort);await worker.terminate();}};
  }
  globalThis.SesliOkuOcr={create,abortable};
})();
