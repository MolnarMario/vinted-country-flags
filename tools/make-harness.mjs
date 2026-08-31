// Bundles the real content scripts, and the service worker behind them, so the
// whole thing can be run from a Vinted console with the chrome.* APIs shimmed.
// Emits two parts so the stable half can be cached in the page and only the
// file under test resent.
// Run: node tools/make-harness.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// The 27 markets plus the two markers. Any other country falls back to xx in
// the shim, which is what the extension does for a missing file anyway, so
// there is no reason to inline 250 flags into a console paste.
const NEEDED = ['ro', 'pl', 'hu', 'cz', 'sk', 'de', 'fr', 'it', 'es', 'pt',
                'nl', 'be', 'at', 'lt', 'lv', 'ee', 'gr', 'ie', 'fi', 'se', 'dk',
                'hr', 'si', 'lu', 'gb', 'us', 'au', 'eu', 'xx'];
const flags = {};
for (const cc of NEEDED) {
  flags[cc + '.svg'] = readFileSync(`flags/${cc}.svg`, 'utf8').trim().replace(/\s+/g, ' ');
}

// Drops whole-line comments and blank lines. Leaves trailing comments alone so
// no regex or string literal can be damaged.
const strip = (src) =>
  src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).join('\n');

// The shim has to serve two callers with different habits. The content scripts
// use the callback form of chrome.storage and talk to the worker over
// chrome.runtime.sendMessage; the worker uses the promise form and answers on
// chrome.runtime.onMessage. Both listeners live in one array and a message goes
// to the first that claims it, which is how Chrome does it too.
const shim = `window.__VCF_FLAGS=${JSON.stringify(flags)};
window.__VCF_LISTENERS=[];
window.__VCF_STORE={local:{},session:{}};
(()=>{
 const area=(name)=>({
   get:(keys,cb)=>{
     const bag=window.__VCF_STORE[name];
     let out={};
     if(typeof keys==='string'){out[keys]=bag[keys];}
     else if(Array.isArray(keys)){for(const k of keys)out[k]=bag[k];}
     else if(keys&&typeof keys==='object'){out={...keys};for(const k of Object.keys(keys))if(k in bag)out[k]=bag[k];}
     else out={...bag};
     if(cb){cb(out);return;}
     return Promise.resolve(out);
   },
   set:(obj,cb)=>{Object.assign(window.__VCF_STORE[name],obj);if(cb)cb();return Promise.resolve();},
 });
 window.chrome={
  runtime:{
   getURL:p=>{const n=p.split('/').pop();const s=window.__VCF_FLAGS[n]||window.__VCF_FLAGS['xx.svg'];
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);},
   onMessage:{addListener:f=>{window.__VCF_LISTENERS.push(f);}},
   sendMessage:(msg)=>new Promise((resolve,reject)=>{
    for(const l of window.__VCF_LISTENERS){let done=false;
     if(l(msg,null,(r)=>{done=true;resolve(r);}))return;
     if(done)return;}
    reject(new Error('no listener for '+JSON.stringify(msg)));}),
  },
  storage:{local:area('local'),session:area('session'),onChanged:{addListener:()=>{}}},
 };
})();
window.__VCF_STATS=()=>window.chrome.runtime.sendMessage({type:'vcf-stats'});`;

const css = strip(readFileSync('src/badge.css', 'utf8')).replace(/\s+/g, ' ');
const style = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();`;

// The worker is not an IIFE, so it goes in its own scope or its top level
// consts collide with the content scripts'.
const worker = `(()=>{${strip(readFileSync('src/worker.js', 'utf8'))}})();`;

const libs = [shim, style,
  strip(readFileSync('src/page-fetch.js', 'utf8')),
  worker,
  strip(readFileSync('src/countries.js', 'utf8')),
  strip(readFileSync('src/price-currency.js', 'utf8')),
  strip(readFileSync('src/throttle.js', 'utf8')),
  strip(readFileSync('src/store.js', 'utf8')),
  strip(readFileSync('src/catalog-query.js', 'utf8'))].join('\n');

const content = strip(readFileSync('src/content.js', 'utf8'));

const pack = (s) => gzipSync(Buffer.from(s), { level: 9 }).toString('base64');
writeFileSync('.harness-libs.b64', pack(libs));
writeFileSync('.harness-content.b64', pack(content));
console.log('libs b64', pack(libs).length, ' content b64', pack(content).length);
