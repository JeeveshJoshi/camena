/* app.js — entry point. Owns app state (the gallery + threshold), orchestrates the
   pipeline (pick → index → match → feed → reel), renders the feed, and wires the UI.
   Loaded as an ES module: <script type="module" src="js/app.js">. */
"use strict";

import { $, show } from './dom.js';
import { TRENDS } from './catalog.js';
import { evaluate } from './matcher.js';
import { indexFiles, loadImage, warmModel, isModelReady } from './vision.js';
import { openReel, stopReel } from './reel.js';

/* The old 12-photo cap existed because every record retained a full-resolution decode.
   With the index/render split in vision.js (features + thumb only; sources decoded
   lazily for selected shots) a much larger roll is affordable. */
const MAX_FILES = 150;
const MAX_CELLS = 24;          // how many tagged thumbnails we show while indexing

/* App state: the indexed gallery and the current match threshold. */
let records = [];
let threshold = 0.45;
let lastTimings = null;

/* ---------------- Pipeline: pick → index → feed ---------------- */
async function processFiles(fileList){
  const files = [...fileList].filter(f=>f.type.startsWith('image/')).slice(0, MAX_FILES);
  if(!files.length){ return; }
  show('proc');
  $('procGrid').innerHTML=''; $('procErr').innerHTML=''; $('procSpin').style.display='block';
  $('procTiming').textContent='';
  $('pbar').style.width='0';
  $('pstat').textContent = isModelReady()
    ? `Reading ${files.length} photos…`
    : 'Preparing the vision model… (first time only)';

  let result;
  try{
    result = await indexFiles(files, onIndexProgress);
  }catch(e){
    $('procSpin').style.display='none';
    $('procErr').innerHTML='<div class="err">Couldn’t load the vision model — check your connection and reload, or use the demo from the start screen.</div>';
    return;
  }

  records = result.records;
  lastTimings = result.timings;
  renderCells(records);
  reportTimings(files.length, result.timings);

  $('pbar').style.width='100%';
  $('procSpin').style.display='none';

  if(!records.length){
    $('procErr').innerHTML='<div class="err">None of those images could be read. Try a few different photos.</div>';
    return;
  }
  resetThreshold();
  buildFeed();
  setTimeout(()=>show('feed'), 300);
}

/* Progress across the two indexing passes: model → cheap features → tagging. */
function onIndexProgress({phase, done, total, label}){
  if(phase==='model'){
    $('pstat').textContent = isModelReady() ? 'Reading your photos…' : 'Preparing the vision model… (first time only)';
    return;
  }
  const pct = phase==='index'
    ? (total ? (done/total)*60 : 0)                 // pass A owns 0–60%
    : 60 + (total ? (done/total)*35 : 0);           // pass B owns 60–95%
  $('pbar').style.width = pct.toFixed(1)+'%';
  $('pstat').innerHTML = `${label}… <span class="mono">${done} / ${total}</span>`;
}

function renderCells(recs){
  const grid = $('procGrid');
  grid.innerHTML = '';
  recs.slice(0, MAX_CELLS).forEach(rec=>{
    const div=document.createElement('div'); div.className='cell';
    div.innerHTML = `<img src="${rec.thumb}" alt=""><div class="lab">${rec.topLabel} · ${Math.round(rec.topProb*100)}%</div>`;
    grid.appendChild(div);
  });
  if(recs.length > MAX_CELLS){
    const more=document.createElement('div'); more.className='cell more-cell';
    more.textContent = `+${recs.length-MAX_CELLS}`;
    grid.appendChild(more);
  }
}

/* Instrumentation — so we can see where the time actually goes on a real device
   rather than guessing. Also parked on window for copy/paste from a phone console. */
function reportTimings(fileCount, t){
  const line = `${fileCount} photos · ${(t.total/1000).toFixed(1)}s total · `
             + `model ${(t.model/1000).toFixed(1)}s · `
             + `read ${(t.passA/1000).toFixed(1)}s (${Math.round(t.passAPer)}ms/img) · `
             + `tag ${(t.passB/1000).toFixed(1)}s (${Math.round(t.passBPer)}ms/img, ${t.tagged} imgs)`;
  $('procTiming').textContent = line;
  window.__camenaTimings = t;
  console.log('[camena] ' + line);
}

/* ---------------- Demo (no model / offline) ---------------- */
/* Gradient stand-ins for photos, so the feed and reel work with no model and no
   network. Deliberately larger than the trend minimums, and seeded with a few
   near-duplicates per scene so the dedupe + diversity selection is visible. */
function gradientReel(c1,c2,label){
  const c=document.createElement('canvas'); c.width=600; c.height=1067; const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,600,1067); g.addColorStop(0,c1); g.addColorStop(1,c2);
  x.fillStyle=g; x.fillRect(0,0,600,1067);
  x.fillStyle='rgba(255,255,255,.92)'; x.font='600 46px Hanken Grotesk, sans-serif'; x.textAlign='center';
  x.fillText(label, 300, 540); return c;
}

/* Cluster-based synthetic hashes: variants inside a cluster differ by only a couple of
   bits (→ treated as near-duplicates), different clusters are far apart. */
function demoHash(cluster, variant){
  const b=new Uint8Array(8);
  for(let i=0;i<8;i++) b[i] = (cluster*53 + i*97) & 0xff;
  for(let v=0; v<variant; v++) b[v%8] ^= (1 << (v%8));
  return b;
}

const DEMO = [
  {c:0, tags:['beach','ocean','sea'],       q:.92, col:['#37C6B0','#FF9A52'], l:'Goa shoreline'},
  {c:0, tags:['beach','ocean','sea'],       q:.88, col:['#35C2AE','#FF9750'], l:'Shoreline again'},
  {c:1, tags:['beach','sand','nature'],     q:.86, col:['#2FB6C8','#FFB36B'], l:'Sunset palms'},
  {c:2, tags:['beach','ocean','coast'],     q:.83, col:['#49A9D8','#FFD9A0'], l:'Low tide'},
  {c:3, tags:['beach','sand','sea'],        q:.81, col:['#7FD6C0','#FFC98A'], l:'Footprints'},
  {c:4, tags:['food','plate','meal'],       q:.89, col:['#E8654E','#F2B24A'], l:'Street food'},
  {c:4, tags:['food','plate','meal'],       q:.84, col:['#E56048','#F0AE45'], l:'Second plate'},
  {c:5, tags:['food','dish','meal'],        q:.87, col:['#D9553F','#FFC46B'], l:'Thali'},
  {c:6, tags:['food','plate','drink'],      q:.80, col:['#C94F52','#F6A96B'], l:'Late lunch'},
  {c:7, tags:['coffee','cup','drink'],      q:.85, col:['#7A4A2B','#E7C79B'], l:'Filter coffee'},
  {c:8, tags:['coffee','cup','espresso'],   q:.82, col:['#6B4126','#DDBE92'], l:'Espresso bar'},
  {c:9, tags:['coffee','drink','cup'],      q:.78, col:['#8A5734','#F0D6AE'], l:'Cold brew'},
  {c:10,tags:['pet','animal','dog'],        q:.90, col:['#9A6BD0','#E3C7F0'], l:'Good boy'},
  {c:10,tags:['pet','animal','dog'],        q:.85, col:['#9768CD','#E0C3EE'], l:'Still a good boy'},
  {c:11,tags:['pet','animal','cat'],        q:.87, col:['#8360C4','#D9BCEA'], l:'Rooftop cat'},
  {c:12,tags:['pet','dog','animal'],        q:.79, col:['#A87BD8','#EBD6F5'], l:'Beach dog'},
  {c:13,tags:['mountain','nature','snow'],  q:.88, col:['#6FA8DC','#E8F2FB'], l:'Manali'},
  {c:14,tags:['mountain','hill','sky'],     q:.84, col:['#5E96CC','#DCEBF8'], l:'Ridge line'},
  {c:15,tags:['mountain','nature','hill'],  q:.82, col:['#7FB4E2','#F0F6FC'], l:'Trailhead'},
  {c:16,tags:['mountain','snow','sky'],     q:.80, col:['#8CBEE8','#FFFFFF'], l:'Pass at dawn'},
];

function runDemo(){
  const seen = new Map();
  Promise.all(DEMO.map(async (d,i)=>{
    const variant = seen.get(d.c) || 0; seen.set(d.c, variant+1);
    const dataUrl = gradientReel(d.col[0], d.col[1], d.l).toDataURL('image/jpeg',0.8);
    const img = await loadImage(dataUrl);
    return {
      id:'d'+i, type:'photo', file:null,
      capturedAt: Date.now()-(i+1)*3*3600000,      // spread over a few days
      w:600, h:1067, aspect:600/1067,
      tags: d.tags.map(label=>({label, confidence:0.85})),
      quality: d.q, focus:{x:.5, y:.5}, hash: demoHash(d.c, variant),
      junk:false, thumb:dataUrl, src:img,
      topLabel:d.l, topProb:0.85
    };
  })).then(recs=>{
    records = recs;
    lastTimings = null;
    $('procTiming') && ($('procTiming').textContent='');
    resetThreshold();
    buildFeed(); show('feed');
  });
}

/* ---------------- Feed ---------------- */
function resetThreshold(){
  threshold=0.45; $('thresh').value='0.45'; $('tval').textContent='0.45';
}

function buildFeed(){
  const cards=$('cards'); cards.innerHTML=''; let builds=0;
  const tp=Math.round(threshold*100);
  TRENDS.forEach(t=>{
    const r=evaluate(t, records, threshold);
    if(r.mode==='build') builds++;
    const pct=Math.round(r.confidence*100);
    const thumbs = r.mode==='build'
      ? r.selected.slice(0,4).map(m=>`<img src="${m.thumb}" alt="">`).join('')
        + (r.k>4?`<span class="more">+${r.k-4}</span>`:'')
      : '';
    const statusTxt = r.mode==='build'
      ? `${r.k} shots · ${r.durationSec.toFixed(1)}s`
      : (r.distinctCount>0 ? `${r.distinctCount} distinct — need ${r.need}` : 'Capture this');
    const el=document.createElement('div');
    el.className='card '+r.mode;
    el.setAttribute('role','button');
    el.setAttribute('tabindex','0');
    el.setAttribute('aria-label', `${t.title}. ${r.mode==='build'?'Ready to build':'Advisor'}: ${statusTxt}.`);
    el.innerHTML=`
      <div class="ctop"><span class="chip">${t.chip}</span><span class="grow">${t.growth}%</span></div>
      <h3>${t.title}</h3>
      <div class="meter"><i style="width:${pct}%"></i><span class="tm" style="left:${tp}%"></span></div>
      <div class="crow">
        <span class="status">${r.mode==='build'?'✓':'●'} ${statusTxt} <span class="m">${pct}</span></span>
        <span class="thumbs">${thumbs}</span>
      </div>`;
    el.addEventListener('click', ()=>openReel(r));
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openReel(r); } });
    cards.appendChild(el);
  });
  $('fcount').textContent = `${builds} ready · ${TRENDS.length-builds} to shoot`;
}

/* ---------------- Wiring ---------------- */
$('pickBtn').onclick = ()=>{
  warmModel();                       // the file dialog is open for seconds — use them
  $('fileInput').click();
};
$('fileInput').onchange = e => { if(e.target.files && e.target.files.length) processFiles(e.target.files); };
$('demoBtn').onclick = runDemo;
$('restartBtn').onclick = ()=>{ stopReel(); $('fileInput').value=''; show('start'); };
$('backBtn').onclick = ()=>{ stopReel(); show('feed'); };
$('thresh').addEventListener('input', e=>{ threshold=parseFloat(e.target.value); $('tval').textContent=threshold.toFixed(2); buildFeed(); });

/* Decorative icons: hide every inline SVG from assistive tech (each sits next to a
   text label, so the icon itself carries no extra meaning). */
document.querySelectorAll('svg').forEach(s=>s.setAttribute('aria-hidden','true'));

/* Start the model download during the idle time right after first paint, so it's
   usually ready before the user has finished choosing photos. First paint itself
   still doesn't wait on it. */
(function(){
  const kick = ()=>warmModel();
  if('requestIdleCallback' in window) requestIdleCallback(kick, {timeout:3000});
  else setTimeout(kick, 1200);
})();

/* Installable: app icon + standalone launch when added to the home screen, plus the
   service worker for offline resilience. */
(function(){
  const icon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="116" fill="#181527"/><text x="256" y="352" font-family="sans-serif" font-size="320" font-weight="800" text-anchor="middle" fill="#FF4A23">C</text></svg>');
  const apple=document.createElement('link'); apple.rel='apple-touch-icon'; apple.href=icon; document.head.appendChild(apple);
  try{
    const manifest={name:'Camena',short_name:'Camena',display:'standalone',background_color:'#ECEAF3',theme_color:'#ECEAF3',start_url:'.',icons:[{src:icon,sizes:'512x512',type:'image/svg+xml',purpose:'any'}]};
    const link=document.createElement('link'); link.rel='manifest';
    link.href=URL.createObjectURL(new Blob([JSON.stringify(manifest)],{type:'application/manifest+json'}));
    document.head.appendChild(link);
  }catch(e){}
  // Served from a real origin (GitHub Pages) only — registration silently no-ops on file://.
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
  }
})();
