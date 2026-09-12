/* matcher.js — the core matcher. Pure logic, no DOM, no I/O.
   Given a trend and an already-indexed gallery, it curates an EDIT: which shots,
   how many, in what order, and how long each is held. This is the piece that ports
   (near-verbatim) into the native app, so it depends on nothing browser-specific.

   A gallery record is expected to look like:
     { id, tags:[{label,confidence}], quality:0..1, capturedAt:epochMs,
       hash:Uint8Array(8), junk:bool, aspect:number, ... }

   Pipeline (see CLAUDE.md):
     filter → collapse near-duplicates → decide k → select k (diversity-aware)
            → order into an edit → assign beat-grid durations
*/
"use strict";

/* Confidence weights. Sum to 1.0. */
const W = {relevance:.38, quality:.22, recency:.14, supply:.18, diversity:.08};

/* Selection weights for the greedy diversity pass (MMR). */
const S = {quality:.45, relevance:.25, recency:.10, penalty:.20};

const QUALITY_FLOOR   = 0.35;  // absolute minimum to appear in a reel at all
const DUP_HARD        = 8;     // hamming distance ≤ this ⇒ duplicate regardless of time
const DUP_SOFT        = 12;    // ≤ this AND close in time ⇒ duplicate
const DUP_WINDOW_MS   = 90e3;  // "close in time" for burst detection
const MID_BEATS       = 2;     // nominal beats per middle shot
const HERO_BEATS      = 4;     // opener / closer hold
const FADE_SIMILARITY = 0.72;  // above this, cross-fade instead of hard-cutting

const avg = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- Scoring primitives ---------------- */

/* Fraction of a trend's keywords present in a record's tags. */
function tagOverlap(tags, keys){
  if(!keys.length) return 0;
  const set = new Set(tags.map(t=>t.label));
  return keys.filter(k=>set.has(k)).length / keys.length;
}

/* Prototype relevance is tag-overlap only. Geographic (place) matching — reverse-
   geocoding a photo's GPS to a place label and matching it against a trend's location —
   is a native-app feature that needs an offline gazetteer (see native-spike-spec.md §3,
   §4.3). lat/lng are captured on each record for that future pass but not scored here. */
function relevance(m, t){
  if(t.type === 'format') return m.quality;   // format trends don't care about subject
  return Math.min(tagOverlap(m.tags, t.keywords), 1);
}

/* Linear decay to 0 over ~180 days. */
function recency(ts, now){ return Math.max(0, 1-((now-ts)/86400000)/180); }

/* ---------------- Similarity (drives dedupe, diversity and transitions) ---------------- */

/* Hamming distance between two 64-bit perceptual hashes. */
function hamming(a, b){
  if(!a || !b) return 64;
  let d=0;
  for(let i=0;i<8;i++){ let x = a[i]^b[i]; while(x){ x &= x-1; d++; } }
  return d;
}

function jaccard(aTags, bTags){
  const A = new Set(aTags.map(t=>t.label)), B = new Set(bTags.map(t=>t.label));
  if(!A.size && !B.size) return 0;
  let inter=0; A.forEach(x=>{ if(B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

/* 0..1 — how alike two shots look/feel. Blends pixels, time and subject. */
function similarity(a, b){
  const visual = 1 - hamming(a.hash, b.hash)/64;
  const dt = Math.abs((a.capturedAt||0) - (b.capturedAt||0));
  const temporal = 1 - clamp(dt/(6*3600e3), 0, 1);   // decays over ~6h
  const subject = jaccard(a.tags||[], b.tags||[]);
  return clamp(0.60*visual + 0.25*temporal + 0.15*subject, 0, 1);
}

/* ---------------- Stage 1–2: filter + collapse duplicates ---------------- */

/* With a big pool we can afford to be picky: keep roughly the better half.
   With a small one, fall back to the absolute floor so we don't starve the edit. */
function qualityGate(pool){
  if(pool.length < 12) return pool.filter(m => m.quality >= QUALITY_FLOOR*0.8);
  const sorted = pool.map(m=>m.quality).sort((a,b)=>a-b);
  const p40 = sorted[Math.floor(sorted.length*0.40)];
  const bar = Math.max(QUALITY_FLOOR, p40);
  return pool.filter(m => m.quality >= bar);
}

/* Collapse bursts / near-identical frames, keeping the best of each cluster.
   This is what stops a 100-photo trip roll producing three identical sunsets. */
function dedupe(pool){
  const byQuality = [...pool].sort((a,b)=>b.quality-a.quality);
  const kept = [];
  for(const m of byQuality){
    const dup = kept.some(k=>{
      const h = hamming(m.hash, k.hash);
      if(h <= DUP_HARD) return true;
      const dt = Math.abs((m.capturedAt||0)-(k.capturedAt||0));
      return h <= DUP_SOFT && dt <= DUP_WINDOW_MS;
    });
    if(!dup) kept.push(m);
  }
  return kept;
}

/* ---------------- Stage 4: diversity-aware selection (greedy MMR) ---------------- */

function baseScore(m, t, now){
  return S.quality*m.quality + S.relevance*relevance(m,t) + S.recency*recency(m.capturedAt, now);
}

function selectDiverse(pool, t, k, now){
  const remaining = [...pool];
  const chosen = [];
  while(chosen.length < k && remaining.length){
    let bestIdx = 0, bestVal = -Infinity;
    for(let i=0;i<remaining.length;i++){
      const m = remaining[i];
      let penalty = 0;
      for(const c of chosen) penalty = Math.max(penalty, similarity(m, c));
      const val = baseScore(m,t,now) - S.penalty*penalty;
      if(val > bestVal){ bestVal = val; bestIdx = i; }
    }
    chosen.push(remaining.splice(bestIdx,1)[0]);
  }
  return chosen;
}

/* Marginal-value stop: drop a weak tail rather than padding the reel to hit a target.
   A tight 8-shot reel beats a padded 15. Never trims below minShots. */
function trimWeakTail(chosen, t, now, minShots){
  if(chosen.length <= minShots) return chosen;
  const scores = chosen.map(m=>baseScore(m,t,now));
  const sorted = [...scores].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  const floor = median * 0.62;
  let end = chosen.length;
  while(end > minShots && scores[end-1] < floor) end--;
  return chosen.slice(0, end);
}

/* ---------------- Stage 5: order into an edit ---------------- */

/* Strong opener, strong closer, chronological middle with a de-clumping pass so
   visually similar shots never sit next to each other. Chronological keeps a trip
   reading as a story; the de-clump keeps it from looking repetitive. */
function orderShots(chosen, t, now){
  if(chosen.length <= 2) return chosen;
  const ranked = [...chosen].sort((a,b)=>
    (0.7*b.quality + 0.3*relevance(b,t)) - (0.7*a.quality + 0.3*relevance(a,t)));
  const opener = ranked[0], closer = ranked[1];

  const middle = chosen.filter(m=>m!==opener && m!==closer)
                       .sort((a,b)=>(a.capturedAt||0)-(b.capturedAt||0));

  // De-clump: if two neighbours are too alike, swap the later one further down.
  for(let i=1;i<middle.length;i++){
    if(similarity(middle[i-1], middle[i]) > 0.78){
      let swap = -1;
      for(let j=i+1;j<middle.length;j++){
        if(similarity(middle[i-1], middle[j]) <= 0.78){ swap = j; break; }
      }
      if(swap > -1){ const tmp = middle[i]; middle[i] = middle[swap]; middle[swap] = tmp; }
    }
  }
  return [opener, ...middle, closer];
}

/* ---------------- Stage 6: pace onto the beat grid ---------------- */

/* Durations are whole numbers of beats so that when the user adds the suggested
   sound natively in Instagram, the cuts land on the beat. Nothing is baked in. */
function paceShots(ordered, bpm){
  const beatSec = 60/bpm;
  const last = ordered.length-1;
  return ordered.map((rec, i)=>{
    let beats = MID_BEATS;
    if(i===0 || i===last) beats = HERO_BEATS;          // hold the opener and closer
    else if(i%4 === 3) beats = HERO_BEATS;             // periodic breath in the middle
    const prev = i>0 ? ordered[i-1] : null;
    const transition = (prev && similarity(prev, rec) > FADE_SIMILARITY) ? 'fade' : 'cut';
    return {rec, beats, seconds: beats*beatSec, transition};
  });
}

/* ---------------- Public API ---------------- */

/* Score one trend against the gallery and, if it's buildable, curate the edit.
   Returns { trend, mode, confidence, poolCount, distinctCount, need, k,
             selected, shots, durationSec, enough, bpm }. */
export function evaluate(t, gallery, threshold){
  const now = Date.now();
  const minShots = t.minShots ?? 5;
  const maxShots = t.maxShots ?? 14;
  const targetSeconds = t.targetSeconds ?? 14;
  const bpm = (t.sound && t.sound.bpm) || 110;

  // 1. Candidate selection by trend type:
  //   'format'          → any photo, ranked on quality alone (subject doesn't matter)
  //   'dance'           → nothing (a performance can't be assembled from old footage → always advisor)
  //   everything else   → tag-overlap ('location', 'food', 'subject' all match this way)
  let pool;
  if(t.type==='format')     pool = gallery.filter(m=>!m.junk);
  else if(t.type==='dance') pool = [];
  else                      pool = gallery.filter(m=>!m.junk && relevance(m,t)>0);

  const poolCount = pool.length;

  // 2. Quality gate, then collapse near-duplicates.
  const distinct = dedupe(qualityGate(pool));
  const distinctCount = distinct.length;

  // 3. How many shots? Pace and target length set the ideal; supply and the cap bound it.
  const nominalClip = (60/bpm)*MID_BEATS;
  const kIdeal = Math.max(1, Math.round(targetSeconds/nominalClip));
  const k = Math.min(kIdeal, distinctCount, maxShots);

  // 4–6. Select, trim, order, pace.
  let chosen = k>0 ? selectDiverse(distinct, t, k, now) : [];
  chosen = trimWeakTail(chosen, t, now, Math.min(minShots, chosen.length));
  const ordered = orderShots(chosen, t, now);
  const shots = paceShots(ordered, bpm);
  const durationSec = shots.reduce((s,x)=>s+x.seconds, 0);

  // Confidence is computed from the SHOTS WE'D ACTUALLY USE, not the raw match count.
  // (With a 100-photo roll, raw count saturates instantly and stops discriminating.)
  const diversity = ordered.length>1
    ? 1 - avg(ordered.slice(1).map((m,i)=>similarity(ordered[i], m)))
    : 0;
  const confidence = ordered.length ? (
      W.relevance*avg(ordered.map(m=>relevance(m,t)))
    + W.quality  *avg(ordered.map(m=>m.quality))
    + W.recency  *avg(ordered.map(m=>recency(m.capturedAt, now)))
    + W.supply   *clamp(distinctCount/Math.max(kIdeal,1), 0, 1)
    + W.diversity*clamp(diversity, 0, 1)
  ) : 0;

  // The count gate stays SEPARATE from confidence, deliberately: a trend you only have
  // a couple of distinct shots for stays in advisor mode however low the threshold goes.
  const enough = distinctCount >= minShots;
  const mode = (confidence>=threshold && enough) ? 'build' : 'advisor';

  return {
    trend:t, mode, confidence, poolCount, distinctCount, need:minShots, k:ordered.length,
    selected: mode==='build' ? ordered : [],
    shots:    mode==='build' ? shots   : [],
    durationSec: mode==='build' ? durationSec : 0,
    enough, bpm
  };
}
