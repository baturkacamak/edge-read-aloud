// Reproduce the local reader assets after npm ci; no CDN is used at runtime.
import { mkdir, copyFile, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pdf=path.join(root,'node_modules/pdfjs-dist');const zip=path.join(root,'node_modules/fflate');
for(const [directory,version] of [[pdf,'5.5.207'],[zip,'0.8.3']]){
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  if(pkg.version!==version)throw new Error(`Review reader compatibility and NOTICE before vendoring ${pkg.name} ${pkg.version}`);
}
const target=path.join(root,'src/vendor/pdfjs');await mkdir(target,{recursive:true});
for(const file of ['pdf.min.mjs','pdf.worker.min.mjs'])await copyFile(path.join(pdf,'legacy/build',file),path.join(target,file));
await copyFile(path.join(pdf,'LICENSE'),path.join(target,'LICENSE'));
for(const directory of ['cmaps','standard_fonts'])await cp(path.join(pdf,directory),path.join(target,directory),{recursive:true});
await mkdir(path.join(root,'src/vendor/fflate'),{recursive:true});
await copyFile(path.join(zip,'umd/index.js'),path.join(root,'src/vendor/fflate/fflate.js'));
await copyFile(path.join(zip,'LICENSE'),path.join(root,'src/vendor/fflate/LICENSE'));
console.log('Bundled PDF.js legacy reader and fflate with licenses.');
const ocr=path.join(root,'src/vendor/tesseract');await mkdir(ocr,{recursive:true});
for(const [name,version]of [['tesseract.js','7.0.0'],['tesseract.js-core','7.0.0'],['@tesseract.js-data/eng','1.0.0'],['@tesseract.js-data/tur','1.0.0']]){
  const pkg=JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'),'utf8'));if(pkg.version!==version)throw new Error(`Review OCR compatibility before vendoring ${name} ${pkg.version}`);
}
for(const file of ['tesseract.min.js','worker.min.js'])await copyFile(path.join(root,'node_modules/tesseract.js/dist',file),path.join(ocr,file));
for(const file of ['tesseract.min.js.LICENSE.txt','worker.min.js.LICENSE.txt'])await copyFile(path.join(root,'node_modules/tesseract.js/dist',file),path.join(ocr,file));
await copyFile(path.join(root,'node_modules/tesseract.js/LICENSE.md'),path.join(ocr,'LICENSE'));
const core=path.join(root,'node_modules/tesseract.js-core');await mkdir(path.join(ocr,'core'),{recursive:true});
for(const name of ['tesseract-core-lstm','tesseract-core-simd-lstm','tesseract-core-relaxedsimd-lstm'])for(const suffix of ['.wasm.js'])await copyFile(path.join(core,name+suffix),path.join(ocr,'core',name+suffix));
await copyFile(path.join(core,'LICENSE'),path.join(ocr,'core/LICENSE'));
await mkdir(path.join(ocr,'lang'),{recursive:true});
for(const language of ['eng','tur'])await copyFile(path.join(root,'node_modules/@tesseract.js-data',language,'4.0.0_best_int',language+'.traineddata.gz'),path.join(ocr,'lang',language+'.traineddata.gz'));
console.log('Bundled Tesseract OCR, LSTM cores and Turkish/English language models.');

await copyFile(path.join(ocr,'LICENSE'),path.join(ocr,'lang/LICENSE'));
