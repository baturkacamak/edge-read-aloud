/** Extension-owned IndexedDB: document text and audio never enter sync storage. */
(() => {
  if (globalThis.SesliOkuVault) return;
  const LIMIT = 250 * 1024 * 1024;
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('sesli-oku-vault', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', { keyPath: 'id' });
      request.result.createObjectStore('parts', { keyPath: ['bookId', 'index'] });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  async function transaction(stores, mode, operation) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode); let value;
      tx.oncomplete = () => resolve(value); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Yerel kitaplık işlemi tamamlanamadı. Kayıt kapatılmış veya 250 MB sınırı aşılmış olabilir.'));
      operation(tx, result => { value = result; });
    });
  }
  const get = id => transaction(['books'], 'readonly', (tx, done) => { tx.objectStore('books').get(id).onsuccess = event => done(event.target.result); });
  const list = () => transaction(['books'], 'readonly', (tx, done) => { tx.objectStore('books').getAll().onsuccess = event => done(event.target.result.map(({ chunks, ...metadata }) => metadata)); });
  const put = book => transaction(['books'], 'readwrite', (tx, done) => {
    const store=tx.objectStore('books');store.getAll().onsuccess=event=>{
      const used=event.target.result.filter(item=>item.id!==book.id).reduce((sum,item)=>sum+(item.size||0),0);
      if(used+(book.size||0)>LIMIT){tx.abort();return;}store.put(book);done(book);
    };
  });
  const remove = id => transaction(['books','parts'], 'readwrite', tx => { tx.objectStore('books').delete(id); tx.objectStore('parts').delete(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER])); });
  const getPart = (id, index) => transaction(['parts'], 'readonly', (tx, done) => { tx.objectStore('parts').get([id,index]).onsuccess = event => done(event.target.result); });
  async function begin(value) {
    if (!Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > 5000) throw new Error('Geçersiz veya çok uzun okuma metni.');
    const book = { id: crypto.randomUUID(), title: String(value.title || 'Yazı').slice(0,250), url: String(value.url || ''),
      chunks: value.chunks.map(chunk => ({ text: String(chunk.text).slice(0,5000), heading: String(chunk.heading || '').slice(0,250) })),
      settings: value.settings, ownerTabId:value.ownerTabId, created: Date.now(), kind: value.kind === 'document' ? 'document' : 'audio', status: value.kind === 'document' ? 'ready' : 'working', size: 0, parts: 0 };
    await put(book); return book;
  }
  const putPart = async (id, index, part) => {
    if(typeof part.audio!=='string'||part.audio.length>20*1024*1024)throw new Error('Geçersiz ses parçası.');
    await transaction(['books','parts'], 'readwrite', tx => {
      const store=tx.objectStore('books');store.getAll().onsuccess=event=>{
        const books=event.target.result;const book=books.find(item=>item.id===id);const size=Math.ceil(part.audio.length*.75);
        if(!book||book.status!=='working'||index!==book.parts||index>=book.chunks.length||books.reduce((sum,item)=>sum+(item.size||0),0)+size>LIMIT){tx.abort();return;}
        tx.objectStore('parts').put({bookId:id,index,audio:part.audio,boundaries:part.boundaries||[],sourceOffsets:part.sourceOffsets||[]});store.put({...book,size:book.size+size,parts:book.parts+1});
      };
    });
  };
  async function finish(id) { await transaction(['books'],'readwrite',(tx,done)=>{const store=tx.objectStore('books');store.get(id).onsuccess=event=>{const book=event.target.result;if(!book||book.parts!==book.chunks.length){tx.abort();return;}store.put({...book,status:'ready'});done({id});};});return {id}; }
  globalThis.SesliOkuVault = { get,list,put,remove,getPart,begin,putPart,finish };
})();
