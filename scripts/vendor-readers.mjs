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
