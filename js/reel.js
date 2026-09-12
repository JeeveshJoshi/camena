/* reel.js — the reel screen: a beat-gridded canvas edit, format switching, the advisor
   view, and best-effort video export.

   What makes this read as an edit rather than a slideshow:
     - durations come from the matcher's beat grid (whole beats of the suggested
       sound's tempo), so cuts land musically once the user adds that sound in Instagram
     - motion varies per shot (push / pull / pan, eased) instead of one identical zoom
     - the crop is anchored on each photo's detail centroid, not blindly centred
     - transitions are hard cuts by default; cross-fades only between similar shots
     - one consistent grade across every shot so mixed camera-roll photos cohere
     - photos that would lose too much to a 9:16 crop get a blurred-fill background

   Nothing audio is ever baked into the export — the sound stays a hint. */
"use strict";

import { $, show, toast } from './dom.js';
import { loadSources } from './vision.js';

/* Preview resolution. Export re-renders at EXPORT_SCALE× this (see recordReel) so the
   preview stays smooth on low-end devices while the saved file is full resolution. */
const FORMATS = {
  reel:  {label:'Reel',  ratio:'9:16', w:540, h:960, css:'9/16'},
  story: {label:'Story', ratio:'9:16', w:540, h:960, css:'9/16'},
  post:  {label:'Post',  ratio:'4:5',  w:540, h:675, css:'4/5'}
};
const EXPORT_SCALE = 2;          // 540×960 preview → 1080×1920 export
const FADE_SEC     = 0.28;       // cross-fade length, when a fade is used at all
const GRADE        = 'contrast(1.06) saturate(1.12) brightness(1.02)';
const BLUR_FILL_AT = 0.45;       // crop away more than this fraction → blurred fill
const TITLE_BEATS  = 2;

let reelRAF=null, currentFmt='reel', current=null, showTitle=true;
const bgCache = new Map();       // `${recId}|${W}x${H}` → blurred background canvas

/** Stop any in-flight playback. */
export function stopReel(){ cancelAnimationFrame(reelRAF); }

/* ---------------- small helpers ---------------- */
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const smoothstep = p => p*p*(3-2*p);

function seedFrom(str){
  let h=2166136261;
  for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h>>>0;
}

/* Deterministic per-shot camera move, so replays are identical but no two adjacent
   shots move the same way. 0 push-in, 1 pull-out, 2 pan right, 3 pan left. */
function motionFor(rec, i){
  const s = seedFrom((rec.id||'x') + '|' + i);
  return { kind: s % 4, amp: 0.05 + ((s>>3) % 4)*0.015 };
}

/* ---------------- drawing ---------------- */

/* Precompute a blurred cover-crop to sit behind photos that don't suit the target
   aspect. Done once per shot per size — blurring every frame would be far too slow. */
function blurBackground(img, W, H, key){
  const hit = bgCache.get(key);
  if(hit) return hit;
  const c = document.createElement('canvas'); c.width=W; c.height=H;
  const x = c.getContext('2d');
  const iw=img.naturalWidth, ih=img.naturalHeight, targetR=W/H;
  let cw,ch;
  if(iw/ih > targetR){ ch=ih; cw=ch*targetR; } else { cw=iw; ch=cw/targetR; }
  x.filter = 'blur(26px) brightness(0.72) saturate(1.1)';
  x.drawImage(img, (iw-cw)/2,(ih-ch)/2,cw,ch, -W*0.06,-H*0.06, W*1.12,H*1.12);
  x.filter = 'none';
  bgCache.set(key, c);
  return c;
}

/* Draw one shot at progress p (0..1), already eased by the caller. */
function drawShot(ctx, rec, motion, p, W, H, alpha){
  const img = rec && rec.src;
  if(!img || !img.complete || !img.naturalWidth){
    ctx.globalAlpha = alpha; ctx.fillStyle = '#2A2637'; ctx.fillRect(0,0,W,H); ctx.globalAlpha = 1;
    return;
  }
  const iw=img.naturalWidth, ih=img.naturalHeight, targetR=W/H;

  // Base cover-crop rectangle for this aspect.
  let cw,ch;
  if(iw/ih > targetR){ ch=ih; cw=ch*targetR; } else { cw=iw; ch=cw/targetR; }
  const lost = 1 - (cw*ch)/(iw*ih);

  // Camera move.
  let scale = 1, panX = 0;
  if(motion.kind===0)      scale = 1 + motion.amp*p;
  else if(motion.kind===1) scale = 1 + motion.amp*(1-p);
  else { scale = 1 + motion.amp*0.5; panX = (motion.kind===2 ? -1 : 1) * (1 - 2*p); }

  const sw = cw/scale, sh = ch/scale;

  // Anchor on the photo's detail centroid rather than dead centre, so subjects
  // don't get cropped out of a 9:16 frame.
  const f = rec.focus || {x:.5, y:.5};
  let cx = f.x*iw + panX*(iw-sw)*0.28;
  let cy = f.y*ih;
  const sx = clamp(cx - sw/2, 0, Math.max(0, iw-sw));
  const sy = clamp(cy - sh/2, 0, Math.max(0, ih-sh));

  ctx.globalAlpha = alpha;
  if(lost > BLUR_FILL_AT){
    // Too much would be thrown away: letterbox onto a blurred version of itself.
    ctx.drawImage(blurBackground(img, W, H, (rec.id||'x')+'|'+W+'x'+H), 0, 0, W, H);
    const fit = Math.min(W/iw, H/ih) * scale;
    const dw = iw*fit, dh = ih*fit;
    ctx.filter = GRADE;
    ctx.drawImage(img, (W-dw)/2, (H-dh)/2, dw, dh);
    ctx.filter = 'none';
  } else {
    ctx.filter = GRADE;
    ctx.drawImage(img, sx,sy,sw,sh, 0,0,W,H);
    ctx.filter = 'none';
  }
  ctx.globalAlpha = 1;
}

/* Opening hook card: the trend title over a blurred still of the opener. */
function drawTitle(ctx, rec, title, p, W, H, alpha){
  ctx.globalAlpha = alpha;
  const img = rec && rec.src;
  if(img && img.complete && img.naturalWidth){
    ctx.drawImage(blurBackground(img, W, H, (rec.id||'x')+'|'+W+'x'+H), 0,0, W,H);
  } else { ctx.fillStyle='#181527'; ctx.fillRect(0,0,W,H); }
  ctx.fillStyle = 'rgba(14,12,24,0.28)'; ctx.fillRect(0,0,W,H);

  const pad = W*0.11;
  const size = Math.round(W*0.105);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px "Bricolage Grotesque", system-ui, sans-serif`;

  // Wrap the title to the frame width.
  const words = String(title||'').split(/\s+/);
  const lines = []; let line = '';
  for(const w of words){
    const test = line ? line+' '+w : w;
    if(ctx.measureText(test).width > W-pad*2 && line){ lines.push(line); line = w; }
    else line = test;
  }
  if(line) lines.push(line);

  const lh = size*1.16;
  // Slight rise as it plays, so the card isn't static.
  const yStart = H/2 - (lines.length-1)*lh/2 - (1-p)*H*0.012;
  lines.forEach((l,i)=> ctx.fillText(l, pad, yStart + i*lh));

  ctx.globalAlpha = 1;
}

/* ---------------- timeline ---------------- */

/* Flatten the matcher's paced shots into an absolute timeline, optionally preceded by
   a title card. Durations already sit on the beat grid. */
function buildTimeline(shots, bpm){
  const items = [];
  let t = 0;
  if(showTitle && shots.length){
    const dur = TITLE_BEATS*(60/bpm);
    items.push({type:'title', rec:shots[0].rec, start:0, dur});
    t += dur;
  }
  shots.forEach((s,i)=>{
    items.push({type:'shot', rec:s.rec, motion:motionFor(s.rec,i), transition:s.transition, start:t, dur:s.seconds});
    t += s.seconds;
  });
  return {items, total:t};
}

function playTimeline(){
  const canvas = $('reelCanvas');
  if(!canvas || !current || !current.timeline || !current.timeline.items.length) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const {items, total} = current.timeline;
  cancelAnimationFrame(reelRAF);

  const paint = (el)=>{
    let idx = 0;
    for(let i=0;i<items.length;i++){ if(el >= items[i].start) idx = i; }
    const it = items[idx];
    const local = clamp(el - it.start, 0, it.dur);
    const p = smoothstep(clamp(local/it.dur, 0, 1));

    ctx.clearRect(0,0,W,H);

    // Cross-fade only where the matcher asked for one (visually similar neighbours).
    const prev = idx>0 ? items[idx-1] : null;
    const fading = it.type==='shot' && it.transition==='fade' && prev && local < FADE_SEC;
    if(fading){
      if(prev.type==='title') drawTitle(ctx, prev.rec, current.trend.title, 1, W, H, 1);
      else drawShot(ctx, prev.rec, prev.motion, 1, W, H, 1);
      const a = local/FADE_SEC;
      if(it.type==='title') drawTitle(ctx, it.rec, current.trend.title, p, W, H, a);
      else drawShot(ctx, it.rec, it.motion, p, W, H, a);
    } else {
      if(it.type==='title') drawTitle(ctx, it.rec, current.trend.title, p, W, H, 1);
      else drawShot(ctx, it.rec, it.motion, p, W, H, 1);
    }
  };

  // Paint frame zero synchronously so the stage is never blank, even if rAF is throttled.
  paint(0);

  const start = performance.now();
  function frame(now){
    let el = (now-start)/1000;
    if(el >= total){ paint(total); const rp=$('replay'); if(rp) rp.classList.add('on'); return; }
    paint(el);
    reelRAF = requestAnimationFrame(frame);
  }
  reelRAF = requestAnimationFrame(frame);
}

/* ---------------- screens ---------------- */

/** Entry point from the feed. `r` is the matcher's evaluation result. */
export async function openReel(r){
  cancelAnimationFrame(reelRAF);
  show('reel');
  if(r.mode==='advisor'){ current=null; renderAdvisor(r); return; }

  currentFmt = 'reel';
  current = {trend:r.trend, shots:r.shots, bpm:r.bpm, durationSec:r.durationSec};
  renderBuild(r);

  // Sources are decoded lazily — only the selected shots, only now.
  const stage = $('stage');
  if(stage) stage.classList.add('loading');
  try{ await loadSources(r.selected); }
  catch(e){ /* drawShot falls back to a flat colour for anything missing */ }
  if(stage) stage.classList.remove('loading');

  current.timeline = buildTimeline(current.shots, current.bpm);
  playTimeline();
}

function renderBuild(r){
  const t=r.trend, f=FORMATS[currentFmt], canSave=canRecord();
  const fmtHtml = Object.keys(FORMATS).map(k=>{
    const ff=FORMATS[k];
    return `<div class="fmt${k===currentFmt?' on':''}" data-fmt="${k}" role="button" tabindex="0" aria-pressed="${k===currentFmt}" aria-label="${ff.label} format, ${ff.ratio}">${ff.label}<span>${ff.ratio}</span></div>`;
  }).join('');
  const secs = (r.durationSec||0).toFixed(1);

  $('reelBody').innerHTML = `
    <div class="reel-h">${t.title}</div>
    <div class="stage" id="stage" style="aspect-ratio:${f.css}">
      <canvas id="reelCanvas" width="${f.w}" height="${f.h}"></canvas>
      <div class="stageload"></div>
      <div class="replay" id="replay"><button id="replayBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.3 2.6L3 8"/><path d="M3 3v5h5"/></svg> Play again</button></div>
    </div>
    <div class="rmeta">
      <div class="seclbl">${r.k} shots · ${secs}s · cut to ${r.bpm} bpm</div>
      <div class="editnote">Chosen from ${r.distinctCount} distinct shots (${r.poolCount} matched, duplicates merged)</div>
      <div class="fmts" id="fmts">${fmtHtml}</div>
      <div class="seclbl">Options</div>
      <div class="fmts"><div class="fmt${showTitle?' on':''}" id="titleToggle" role="button" tabindex="0" aria-pressed="${showTitle}">Title card<span>${showTitle?'on':'off'}</span></div></div>
      <div class="seclbl">Add this sound in Instagram</div>
      <div class="sound"><div class="i">♪</div><div><b>${t.sound.name}</b><small>${t.sound.uses} · ${r.bpm} bpm — cuts are on the beat, so it lines up when you add it after export</small></div></div>
      <button class="save" id="saveBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        ${canSave ? 'Save reel (beta)' : 'To save: screen-record the playback'}
      </button>
    </div>`;

  $('replayBtn').onclick = ()=>{ $('replay').classList.remove('on'); playTimeline(); };
  $('saveBtn').onclick = ()=> canSave
    ? recordReel()
    : toast('This browser can’t export video — screen-record the playback');

  const titleEl = $('titleToggle');
  const toggleTitle = ()=>{
    showTitle = !showTitle;
    titleEl.classList.toggle('on', showTitle);
    titleEl.setAttribute('aria-pressed', showTitle);
    titleEl.querySelector('span').textContent = showTitle ? 'on' : 'off';
    current.timeline = buildTimeline(current.shots, current.bpm);
    $('replay').classList.remove('on');
    playTimeline();
  };
  titleEl.addEventListener('click', toggleTitle);
  titleEl.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleTitle(); } });

  // Format switching: resize the canvas + stage, then replay at the new crop.
  $('fmts').querySelectorAll('.fmt').forEach(el=>{
    const switchTo = ()=>{
      const k = el.getAttribute('data-fmt');
      if(k===currentFmt) return;
      currentFmt = k;
      const nf = FORMATS[k], cv = $('reelCanvas');
      cv.width = nf.w; cv.height = nf.h;
      $('stage').style.aspectRatio = nf.css;
      $('fmts').querySelectorAll('.fmt').forEach(x=>{
        const on = x===el; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on);
      });
      $('replay').classList.remove('on');
      playTimeline();
    };
    el.addEventListener('click', switchTo);
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); switchTo(); } });
  });
}

function renderAdvisor(r){
  const t=r.trend;
  const why = r.distinctCount>0
    ? `You’ve got ${r.distinctCount} distinct shots that fit, but this needs ${r.need}. A few more and it’ll build.`
    : `Not in your photos yet — this one you go out and capture.`;
  $('reelBody').innerHTML = `
    <div class="reel-h">${t.title}</div>
    <p style="font-size:13.5px;color:var(--ink-2);line-height:1.5;margin:0 0 16px">${why}</p>
    <div class="adv">
      <div class="t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> How to shoot it</div>
      <ul>${t.capture.map(c=>`<li>${c}</li>`).join('')}</ul>
    </div>
    <div class="seclbl">Pair it with</div>
    <div class="sound"><div class="i">♪</div><div><b>${t.sound.name}</b><small>${t.sound.uses} · save it now, build once you’ve filmed</small></div></div>`;
}

/* ---------------- Best-effort save ---------------- */
const REC_MIMES = ['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
function pickMime(){
  if(!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  return REC_MIMES.find(m=>MediaRecorder.isTypeSupported(m)) || null;
}
function canRecord(){
  try{
    const c=document.createElement('canvas');
    return !!(c.captureStream && pickMime());
  }catch(e){ return false; }
}

/* Export at EXPORT_SCALE× the preview size. The canvas is resized BEFORE captureStream
   is created, so the recording is full resolution while the preview stays cheap. */
function recordReel(){
  try{
    const canvas=$('reelCanvas'); if(!canvas || !current) return;
    const mime=pickMime(); if(!mime) return toast('This browser can’t export video — screen-record instead');
    const ext = mime.indexOf('mp4')>-1 ? 'mp4' : 'webm';
    const f = FORMATS[currentFmt];
    const restore = ()=>{ canvas.width=f.w; canvas.height=f.h; playTimeline(); };

    cancelAnimationFrame(reelRAF);
    canvas.width = f.w*EXPORT_SCALE; canvas.height = f.h*EXPORT_SCALE;

    const stream=canvas.captureStream(30);
    const rec=new MediaRecorder(stream,{mimeType:mime}); const chunks=[];
    rec.ondataavailable=e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    rec.onstop=()=>{
      restore();
      if(!chunks.length) return toast('Export came out empty — screen-record instead');
      const blob=new Blob(chunks,{type:mime.split(';')[0]});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download='camena-reel.'+ext;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      toast(`Saved camena-reel.${ext} · ${canvas.width}×${canvas.height}`);
    };
    $('replay') && $('replay').classList.remove('on');
    rec.start(100);
    playTimeline();
    const ms = (current.timeline ? current.timeline.total : 8)*1000 + 500;
    setTimeout(()=>{ try{ if(rec.state!=='inactive') rec.stop(); }catch(e){} }, ms);
    toast('Recording the reel…');
  }catch(e){ toast('Couldn’t record here — screen-record instead'); }
}
