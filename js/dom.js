/* dom.js — tiny shared DOM helpers used across the app.
   No app logic lives here; just element lookup, screen switching, and the toast. */
"use strict";

/** Shorthand for document.getElementById. */
export const $ = id => document.getElementById(id);

/** The four top-level screens, in flow order. */
export const screens = ['start', 'proc', 'feed', 'reel'];

/** Show one screen and hide the others. Resets scroll — the reel screen has no
    inner scroll container, so the window itself can be scrolled on small viewports. */
export function show(id){
  screens.forEach(s => $(s).classList.toggle('on', s === id));
  window.scrollTo(0, 0);
}

/* Transient bottom toast. */
let toastTimer;
export function toast(msg){
  $('toastMsg').textContent = msg;
  $('toast').classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('on'), 2600);
}
