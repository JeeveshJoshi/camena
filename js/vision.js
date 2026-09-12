/* vision.js — the on-device content-understanding pass.
   Turns image Files into gallery records: scene tags (MobileNet), a quality score,
   a perceptual hash, a focus point, EXIF date/GPS and a thumbnail.
   Everything runs in the browser; no photo is uploaded.

   Two structural decisions that keep this fast enough to be usable:

   1. INDEX / RENDER SPLIT. Indexing keeps only small features + a thumbnail for every
      photo — never a full-resolution decode. The original File is retained (a cheap
      reference to disk) and the big source image is decoded lazily, at reel-build
      time, for the handful of shots actually selected. This is what makes a 100-photo
      roll possible without the memory pressure that caused the historic blank-canvas bug.

   2. TWO-PASS INDEXING. Pass A computes cheap features (thumb, quality, hash, focus,
      EXIF) for every photo. Only the survivors — after quality + duplicate filtering —
      go through Pass B, the expensive MobileNet inference. On a big roll this avoids
      the majority of the inference cost. */
"use strict";

import { TAG_RULES, JUNK_RULES } from './catalog.js';

/* ---------------- Lazy CDN loading ---------------- */
/* TF.js + MobileNet + exifr load only when needed (not at page load), so first paint
   doesn't wait on them. SRI hashes are pinned; crossorigin="anonymous" makes jsdelivr
   return a CORS (non-opaque) response, which both lets SRI validate it and lets the
   service worker cache the real bytes. */
const CDN = {
  tf:       {src:'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
             sri:'sha384-vE8hbVJ4lezako5rlvE7bY0BVzWlFhZncPlckrqNwcUQpVtgbENTgZ8TBbnPjZre'},
  mobilenet:{src:'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js',
             sri:'sha384-oBAqwJ0tv9zzKlbIZyBhhXlEvU/PMrSMqDyOHlEZVC8xWHx4yPySuS7vRikRcYFq'},
  exifr:    {src:'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js',
             sri:'sha384-KrOocIA+lZcNUz2MDavnT/FuX+CbTREJihUi0bp8QUSwhE2AkGTNpv2b7yMbBkx5'}
};

/* MobileNet v1 @ alpha 0.5 is ~5MB of weights against ~14MB for v2 @ 1.0, and is
   markedly faster per image. Our tags are coarse (food / beach / dog), so the accuracy
   trade is worth it. Drop to alpha 0.25 (~2MB) if the model download is still the
   bottleneck on low-end devices; raise to {version:2, alpha:1.0} for best labels. */
const MODEL = {version:1, alpha:0.5};

function loadScript(src, integrity){
  return new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=src; s.async=true; s.crossOrigin='anonymous';
    if(integrity) s.integrity=integrity;
    s.onload=()=>res();
    s.onerror=()=>rej(new Error('load '+src));
    document.head.appendChild(s);
  });
}

let libsLoading=null;
function ensureLibs(){
  if(!libsLoading) libsLoading = (async()=>{
    const exifrP = loadScript(CDN.exifr.src, CDN.exifr.sri).catch(()=>{}); // EXIF is best-effort
    await loadScript(CDN.tf.src, CDN.tf.sri);
    await loadScript(CDN.mobilenet.src, CDN.mobilenet.sri); // depends on tf → load after
    await exifrP;
  })().catch(e=>{ libsLoading=null; throw e; });
  return libsLoading;
}

let model=null, modelLoading=null, modelWarm=false;

export async function ensureModel(){
  if(model) return model;
  if(!modelLoading) modelLoading = (async()=>{
    await ensureLibs();
    if(!window.mobilenet || !window.tf) throw new Error('libs');
    model = await mobilenet.load(MODEL);
    return model;
  })().catch(e=>{ modelLoading=null; throw e; });
  return modelLoading;
}

/* Kick off the whole cold start in the background and run one throwaway inference to
   force WebGL shader compilation. Called on idle after first paint and again when the
   user opens the file picker — by the time files come back this is usually done, so the
   model download is off the user's critical path entirely. Safe to call repeatedly. */
export function warmModel(){
  return (async()=>{
    try{
      await ensureModel();
      if(modelWarm) return true;
      const c = document.createElement('canvas'); c.width=c.height=224;
      const x = c.getContext('2d'); x.fillStyle='#888'; x.fillRect(0,0,224,224);
      await model.classify(c, 1);          // compiles shaders; result discarded
      c.width=c.height=1;
      modelWarm = true;
      return true;
    }catch(e){ return false; }
  })();
}

export function isModelReady(){ return !!model && modelWarm; }

/* ---------------- Decoding ---------------- */
/** Decode a URL into an <img>. Used by the demo path and as a decode fallback. */
export function loadImage(src){
  return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src; });
}

/* Decode a File, downscaled. createImageBitmap decodes OFF the main thread and can
   resize during decode, so a 12MP phone photo never materialises as a ~48MB bitmap on
   the UI thread — this is the single biggest per-image win. Falls back to an <img>
   where createImageBitmap (or its resize options) isn't available. */
async function decodeScaled(file, maxEdge){
  if(typeof createImageBitmap === 'function'){
    try{
      return await createImageBitmap(file, {resizeWidth:maxEdge, resizeQuality:'medium'});
    }catch(e){
      try{ return await createImageBitmap(file); }catch(e2){ /* fall through */ }
    }
  }
  const url = URL.createObjectURL(file);
  try{
    const img = await loadImage(url);
    img.__objectUrl = url;             // caller releases via releaseDecoded()
    return img;
  }catch(e){ URL.revokeObjectURL(url); throw e; }
}

const dims = d => ({w: d.width || d.naturalWidth, h: d.height || d.naturalHeight});

function releaseDecoded(d){
  if(!d) return;
  if(typeof d.close === 'function') d.close();          // ImageBitmap
  if(d.__objectUrl){ URL.revokeObjectURL(d.__objectUrl); d.__objectUrl = null; }
}

/* Draw a decoded source into a fresh w×h canvas, cover-cropped (centre). */
function coverCanvas(decoded, cw, ch){
  const c=document.createElement('canvas'); c.width=cw; c.height=ch;
  const x=c.getContext('2d', {willReadFrequently:true});
  const {w:iw, h:ih} = dims(decoded), ir=iw/ih, cr=cw/ch;
  let sw,sh,sx,sy;
  if(ir>cr){ sh=ih; sw=sh*cr; sx=(iw-sw)/2; sy=0; } else { sw=iw; sh=sw/cr; sx=0; sy=(ih-sh)/2; }
  x.drawImage(decoded, sx,sy,sw,sh, 0,0,cw,ch);
  return c;
}

/* ---------------- Cheap features (Pass A) ---------------- */

/* 64-bit dHash: compare each pixel to its right-hand neighbour on a 9×8 grayscale.
   Cheap, rotation-sensitive, and good enough to spot bursts and near-duplicates. */
function perceptualHash(decoded){
  const c=document.createElement('canvas'); c.width=9; c.height=8;
  const x=c.getContext('2d', {willReadFrequently:true});
  x.drawImage(decoded, 0,0, 9,8);
  const d=x.getImageData(0,0,9,8).data;
  const lum=i=>0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
  const bits=new Uint8Array(8);
  for(let row=0; row<8; row++){
    for(let col=0; col<8; col++){
      const i=(row*9+col)*4, j=(row*9+col+1)*4;
      if(lum(i) > lum(j)) bits[row] |= (1 << col);
    }
  }
  c.width=c.height=1;
  return bits;
}

/* Sharpness + contrast + exposure from a 64×64 grayscale, plus a detail centroid used
   later to anchor the Ken Burns crop on the busiest part of the frame (a cheap stand-in
   for real saliency; native gets Vision/ML Kit saliency + face rects instead). */
function analyse(decoded){
  const N=64;
  const c=coverCanvas(decoded, N, N);
  const x=c.getContext('2d', {willReadFrequently:true});
  const d=x.getImageData(0,0,N,N).data;
  const lum=i=>0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];

  let gradSum=0, gradN=0, meanSum=0, sqSum=0;
  let fx=0, fy=0, fw=0;
  for(let y=0;y<N;y++){
    for(let xx=0;xx<N;xx++){
      const i=(y*N+xx)*4, L=lum(i);
      meanSum+=L; sqSum+=L*L;
      if(y>0 && y<N-1 && xx>0 && xx<N-1){
        const g = Math.abs(lum(i+4)-lum(i-4)) + Math.abs(lum(i+N*4)-lum(i-N*4));
        gradSum+=g; gradN++;
        fx += xx*g; fy += y*g; fw += g;
      }
    }
  }
  c.width=c.height=1;

  const mean = meanSum/(N*N);
  const sd = Math.sqrt(Math.max(0, sqSum/(N*N) - mean*mean));
  const sharp    = Math.min((gradSum/Math.max(gradN,1))/28, 1);
  const contrast = Math.min(sd/60, 1);
  // Penalise crushed blacks / blown highlights.
  const expo = mean < 40 ? mean/40 : (mean > 215 ? (255-mean)/40 : 1);

  const quality = Math.max(0.05, Math.min(0.55*sharp + 0.25*contrast + 0.20*Math.min(expo,1), 0.99));
  const focus = fw > 0
    ? {x: Math.max(0.25, Math.min(0.75, (fx/fw)/N)), y: Math.max(0.25, Math.min(0.75, (fy/fw)/N))}
    : {x:0.5, y:0.5};
  return {quality, focus};
}

function toThumb(decoded, w){
  const {w:iw, h:ih} = dims(decoded);
  const h = Math.max(1, Math.round(w*(ih/iw)));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  c.getContext('2d').drawImage(decoded, 0,0, w,h);
  const url = c.toDataURL('image/jpeg', 0.7);
  c.width=c.height=1;
  return url;
}

/* Best-effort EXIF in a SINGLE parse (the previous two-call form parsed each file
   twice). Falls back to file.lastModified. */
async function readExif(file){
  let capturedAt = file.lastModified || Date.now(), lat, lng;
  try{
    if(window.exifr){
      const d = await exifr.parse(file, {
        tiff:true, exif:true, gps:true, ifd1:false, interop:false,
        pick:['DateTimeOriginal','CreateDate','latitude','longitude']
      }).catch(()=>null);
      if(d){
        const dt = d.DateTimeOriginal || d.CreateDate;
        if(dt) capturedAt = new Date(dt).getTime();
        if(typeof d.latitude === 'number'){ lat = d.latitude; lng = d.longitude; }
      }
    }
  }catch(e){}
  return {capturedAt, lat, lng};
}

/* ---------------- Tagging (Pass B) ---------------- */
function mapLabelsToTags(preds){
  const m = new Map();
  for(const p of preds){
    const name = (p.className||'').toLowerCase();
    for(const r of TAG_RULES){
      if(r.needles.some(n=>name.includes(n))){
        m.set(r.tag, Math.max(m.get(r.tag)||0, p.probability));
      }
    }
  }
  return [...m].map(([label,confidence])=>({label,confidence}));
}

const JUNK_MIN_PROB = 0.30;
function looksLikeJunk(preds){
  const top = preds[0];
  if(!top || top.probability < JUNK_MIN_PROB) return false;
  const name = (top.className||'').toLowerCase();
  return JUNK_RULES.some(n=>name.includes(n));
}

/* ---------------- Indexing ---------------- */

const INDEX_EDGE  = 320;   // long-ish edge used for cheap feature extraction
const SOURCE_EDGE = 1080;  // render resolution for selected shots
const POOL        = 3;     // concurrent decodes — bounded on purpose (see below)
const TAG_BUDGET  = 48;    // max photos sent through MobileNet

/* Pass A for one file. Decodes small, extracts features, releases everything. */
async function indexOne(file, idx){
  const decoded = await decodeScaled(file, INDEX_EDGE);
  try{
    const {w, h} = dims(decoded);
    const {quality, focus} = analyse(decoded);
    const hash = perceptualHash(decoded);
    const thumb = toThumb(decoded, 120);
    const exif = await readExif(file);
    return {
      id:'p'+idx, type:'photo', file,
      capturedAt:exif.capturedAt, lat:exif.lat, lng:exif.lng,
      w, h, aspect: w/h,
      quality, focus, hash, thumb,
      tags:[], topLabel:'…', topProb:0, junk:false,
      src:null                        // filled lazily, only if selected — see loadSourceImage
    };
  } finally { releaseDecoded(decoded); }
}

/* Run an async mapper over items with bounded concurrency. Bounded on purpose:
   unbounded parallelism spikes memory on low-end Android and risks resurrecting the
   blank-canvas bug, so we keep only a few decodes in flight. */
async function mapPool(items, limit, fn){
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async ()=>{
    while(true){
      const i = next++;
      if(i >= items.length) return;
      try{ out[i] = await fn(items[i], i); }catch(e){ out[i] = null; }
    }
  }));
  return out.filter(Boolean);
}

/* Index a list of Files into gallery records.
   onProgress({phase, done, total, label}) drives the UI; timings are returned for
   instrumentation so we can see where the time actually goes on a real device. */
export async function indexFiles(files, onProgress = ()=>{}){
  const t0 = performance.now();
  const timings = {};

  // --- model (usually already warm from warmModel()) ---
  onProgress({phase:'model', done:0, total:1, label:'Preparing the vision model…'});
  const tModel = performance.now();
  await ensureModel();
  timings.model = performance.now() - tModel;

  // --- Pass A: cheap features for everything ---
  const tA = performance.now();
  let doneA = 0;
  const records = await mapPool(files, POOL, async (file, i)=>{
    const rec = await indexOne(file, i);
    onProgress({phase:'index', done:++doneA, total:files.length, label:'Reading your photos'});
    return rec;
  });
  timings.passA = performance.now() - tA;
  timings.passAPer = records.length ? timings.passA/records.length : 0;

  // --- Choose who deserves inference: best quality first, capped ---
  const ranked = [...records].sort((a,b)=>b.quality-a.quality);
  const toTag = ranked.slice(0, TAG_BUDGET);

  // --- Pass B: MobileNet on the survivors only ---
  const tB = performance.now();
  let doneB = 0;
  for(const rec of toTag){
    try{
      const decoded = await decodeScaled(rec.file, 256);
      try{
        const sq = coverCanvas(decoded, 224, 224);
        const preds = await model.classify(sq, 5);
        sq.width = sq.height = 1;
        rec.tags = mapLabelsToTags(preds);
        rec.junk = looksLikeJunk(preds);
        rec.topLabel = preds[0] ? preds[0].className.split(',')[0] : '—';
        rec.topProb = preds[0] ? preds[0].probability : 0;
        // Nudge quality with the model's own confidence — a frame the classifier is
        // sure about is usually a clean, readable one.
        rec.quality = Math.min(0.99, rec.quality*0.85 + 0.15*Math.min(rec.topProb*1.2, 1));
      } finally { releaseDecoded(decoded); }
    }catch(e){ /* leave untagged; it simply won't match tag-based trends */ }
    onProgress({phase:'tag', done:++doneB, total:toTag.length, label:'Tagging the best ones'});
  }
  timings.passB = performance.now() - tB;
  timings.passBPer = toTag.length ? timings.passB/toTag.length : 0;
  timings.tagged = toTag.length;
  timings.total = performance.now() - t0;

  return {records, timings};
}

/* ---------------- Render-time source loading ---------------- */

/* Decode the full-quality source for ONE selected shot, lazily. Stored as a compact
   JPEG blob behind an <img>: per the bug history, a retained canvas keeps a large
   backing store that mobile browsers silently discard under memory pressure (→ black
   frames), whereas an <img> backed by a small blob is re-decodable and survives.
   Original aspect is kept so each output format can crop from the full frame. */
export async function loadSourceImage(rec){
  if(rec.src) return rec.src;
  if(!rec.file) return null;
  const decoded = await decodeScaled(rec.file, SOURCE_EDGE);
  try{
    const {w:iw, h:ih} = dims(decoded);
    const scale = Math.min(1, SOURCE_EDGE/Math.max(iw,ih));
    const w = Math.max(1,Math.round(iw*scale)), h = Math.max(1,Math.round(ih*scale));
    const c = document.createElement('canvas'); c.width=w; c.height=h;
    c.getContext('2d').drawImage(decoded, 0,0, w,h);
    const url = await new Promise(res=>{
      if(c.toBlob) c.toBlob(b=> res(b?URL.createObjectURL(b):c.toDataURL('image/jpeg',0.85)), 'image/jpeg', 0.85);
      else res(c.toDataURL('image/jpeg',0.85));
    });
    c.width=c.height=1;                // release the backing store immediately
    rec.src = await loadImage(url);
    return rec.src;
  } finally { releaseDecoded(decoded); }
}

/** Decode sources for a set of shots, bounded concurrency. */
export async function loadSources(recs){
  await mapPool(recs, 2, r=>loadSourceImage(r));
}
