// Define readiness before the shared content script receives start/resume RPCs.
if (!Promise.withResolvers) Promise.withResolvers = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const readingReady=Promise.withResolvers();
globalThis.SesliOkuDocument={ready:readingReady.promise,resolve:readingReady.resolve,book:null};
