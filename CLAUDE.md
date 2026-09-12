# Camena

Turns the photos and videos already sitting in someone's camera roll into trend-matched, post-ready social content — reels, stories, and posts.

The insight the product rests on: most people already have footage worth posting; they just don't know which of it is worth posting *right now*. Camena matches what's trending against what you already have.

**Current state:** a working web prototype (`index.html`) deployed to GitHub Pages, being tested with a small group. The native app has not been built yet.

---

## Hard constraints — decisions already made, do not relitigate

These were each researched and settled. If a change would violate one, stop and flag it rather than working around it.

1. **The app never auto-posts.** All output stays on the device in a local folder; the user shares manually. Instagram's publishing API requires Business/Creator accounts, needs app review, and the consumer-login path doesn't support Reels or Stories publishing at all. Auto-posting is not realistically available for a mass-market app on personal accounts.

2. **No commercial audio is ever baked into an exported file.** Trending sounds are licensed music; embedding them means distributing unlicensed audio, which gets videos muted or pulled and creates app-store risk. Exports are silent or royalty-free. The trending sound is surfaced as a *hint* the user applies natively inside Instagram after export.

3. **User media never leaves the device.** All gallery reading, tagging, matching, and rendering happen on-device. This is simultaneously the privacy promise, the main marketing differentiator, and the reason server costs stay near zero. Never add an upload path for photos or video.

4. **Zero budget.** Hosting is GitHub Pages only. No paid hosting, no paid APIs, no paid services. The backend (when built) is a GitHub Actions cron job writing a static JSON file — not a running server.

5. **No FFmpeg.** `ffmpeg-kit` was retired in January 2025 and its binaries pulled; the community wrappers are unmaintained, and there are GPL licensing concerns. Native rendering uses AVFoundation (iOS) and Media3 Transformer (Android).

---

## Architecture

**On-device pipeline** (the whole product):

```
gallery → content understanding → gallery index → trend matcher → generation → local output
          (geo, vision, quality)   (tags, scores)   (build/advise)  (compose)
```

**Backend** is metadata-only: it pulls public trend data, normalises it into one typed catalog, and serves it as JSON. It never sees user media. Because it's just a JSON file that changes daily, it can be a static file — planned as GitHub Actions (scheduled) → `catalog.json` → GitHub Pages, with API keys in GitHub Secrets.

This boundary is structural, not a promise: the only thing that touches the network is the catalog fetch.

### The matcher — core logic

Scores each trend against the user's indexed gallery, decides **build** vs **advisor** mode, and — when building — curates an *edit*: which shots, how many, in what order, held for how long.

The input is assumed to be a large, messy pool (a 100-photo trip roll), not a curated handful. That assumption drives the whole design:

1. **Filter.** Candidate selection is by trend type: `location`/`food`/`subject` match on tags; `format` matches any photo ranked on quality alone; `dance` matches nothing (a performance can't be assembled from old footage — always advisor). Junk (screenshots, menus, receipts — see `JUNK_RULES`) is dropped. The quality gate is *adaptive*: with a big pool it keeps roughly the better half (40th percentile), with a small one it falls back to an absolute floor so the edit isn't starved.
2. **Collapse near-duplicates.** Bursts and near-identical frames are clustered on perceptual-hash distance plus capture-time proximity, keeping the best of each. Without this, a trip roll yields three identical sunsets in a row.
3. **Decide k.** `k = min(targetSeconds / clipLength, distinctCount, maxShots)`, then a marginal-value pass trims a weak tail rather than padding to hit the target — a tight 8-shot reel beats a padded 15.
4. **Select k** with a greedy diversity-penalised pass (MMR): `0.45·quality + 0.25·relevance + 0.10·recency − 0.20·maxSimilarityToAlreadyPicked`. Similarity blends perceptual hash, capture time and tag overlap, so the reel spreads across the *trip*, not just across pixels.
5. **Order.** Strongest shot opens, second-strongest closes, middle runs chronologically with a de-clumping pass so similar shots never sit adjacent.
6. **Pace** onto a beat grid (below).

Other invariants:

- Place matching (reverse-geocoded GPS vs. a trend's location) is a native-app feature that needs an offline gazetteer — the web prototype captures `lat`/`lng` per photo but scores on tags only.
- Confidence blends relevance `0.38`, quality `0.22`, recency `0.14`, supply `0.18`, diversity `0.08` — **computed over the shots actually selected, never the raw match count.** Raw count saturates instantly on a large roll and stops discriminating; that was a real bug.
- **The count gate is separate from confidence**: `distinctCount >= minShots`, on *distinct* (post-dedupe) shots. A trend you only have a couple of distinct shots for stays in advisor mode no matter how low the threshold goes. This is deliberate — don't collapse it into the confidence score.
- **The threshold is the single most important product lever.** Too loose ships mediocre montages that make users look bad; too strict makes the app feel empty. It's exposed as a slider in the prototype specifically so it can be tuned against real galleries.

### The beat grid

Clip durations are whole numbers of beats of the trend's `sound.bpm` (opener and closer held longer). **No audio is ever baked into the export** — the sound stays a hint, per hard constraint 2. Cutting on the grid means that when the user adds that sound natively in Instagram, the cuts land on the beat. This is the cheapest large gain in perceived production value available to us.

### Two modes

- **Build** — the user already has the footage; assemble it. Works for locations, food, and generic format/aesthetic trends. This is the core value.
- **Advisor** — nothing matches; coach the user on what to capture. The only option for dances and challenges.

---

## The web prototype (`index.html`)

Static, **no build step** — plain files the browser loads directly. `index.html` is markup only; styling is in `styles.css`; logic is split into native ES modules under `js/` (no bundler):

| File | Role |
|---|---|
| `js/dom.js` | Shared DOM helpers (`$`, `show`, `toast`) |
| `js/catalog.js` | Trend catalog + label→tag vocabulary (pure data, backend-catalog shape) |
| `js/matcher.js` | The core matcher — pure logic, no DOM; the piece that ports to native |
| `js/vision.js` | On-device tagging: MobileNet + quality + EXIF; loads its CDN libs lazily |
| `js/reel.js` | The reel screen: Ken Burns playback, format switching, best-effort export |
| `js/app.js` | Entry point (`type="module"`): app state, pipeline, feed, wiring |
| `sw.js` | Service worker — offline resilience for the installed PWA |

Uses TensorFlow.js + MobileNet from CDN for real in-browser image classification, `exifr` for EXIF date/GPS, and canvas for the rendered edit. The heavy ML libs are lazy-loaded and SRI-pinned.

**Two structural decisions in `js/vision.js` — do not undo them:**

- **Index / render split.** Indexing keeps only small features + a thumbnail per photo, never a full-resolution decode. The original `File` is retained (a cheap disk reference) and the big source is decoded lazily, at reel-build time, for the handful of selected shots. This is what makes a large roll affordable; it is also the structural version of the blank-canvas fix.
- **Two-pass indexing.** Pass A computes cheap features (thumb, quality, perceptual hash, focus point, EXIF) for every photo. Only survivors go through Pass B (MobileNet). On a big roll this avoids most of the inference cost.

**Performance notes:** the model is warmed on idle after first paint *and* when the file picker opens, with a throwaway inference to force WebGL shader compilation — so the download is off the user's critical path. `MODEL` is MobileNet v1 @ alpha 0.5 (~5MB) rather than v2 @ 1.0 (~14MB); tags are coarse enough that the trade is worth it, and it's a one-line change. Decoding uses `createImageBitmap` with resize-on-decode (off the main thread) so a 12MP photo never materialises as a ~48MB bitmap on the UI thread. Concurrency is bounded (3) on purpose — unbounded parallelism spikes memory on low-end Android. Per-stage timings are shown on the processing screen and parked on `window.__camenaTimings`.

**These are inherent prototype limitations, not bugs — do not "fix" them:**

- The user hand-picks photos; the native app will scan the library.
- MobileNet returns generic ImageNet categories (`food`, `beach`, `beverage`) rather than specifics. Production needs a fine-tuned classifier (Core ML / LiteRT).
- The "reel" is a canvas animation, not an encoded video — stills with motion applied will always read as stills with motion applied. The genuine step-change (real video clips, speed ramps, hardware encode) is native: spike-spec Q2.
- The focus point used to anchor the crop is a detail centroid, not real saliency. Native replaces it with Vision / ML Kit saliency + face rectangles.
- Video export on iOS Safari is unreliable (`captureStream` support is patchy, and Safari tends to open files rather than save them). Screen-recording is the honest fallback.

**Bug history — don't regress these:**

- *Black preview / blank export.* Caused by retaining a large canvas per photo. Mobile browsers silently discard canvas backing stores under memory pressure, so `drawImage` "succeeds" and paints nothing. Fixed by storing photos as compact JPEG blobs loaded into `<img>` elements (re-decodable, survive eviction), releasing working canvases immediately, and capping at 12 photos. **Never go back to retaining canvases.**
- Source images are kept at their *original* aspect ratio so each output format can cover-crop from the full frame; pre-cropping breaks the 4:5 Post format.
- Frame zero is painted synchronously before the animation loop so the stage is never blank if rAF is throttled.
- Trend cards take their class from the matcher's `mode` (`build` / `advisor`); the accent CSS must match those exact names (`.card.build` / `.card.advisor`). An earlier `.card.advise` typo silently dropped the advisor accent — keep the class name and the selector in sync.

---

## Deployment

GitHub Pages, deploy-from-branch, `main` / root. `index.html` at the repo root. Repo must be public (free-tier Pages). No build step, no CI.

---

## Open decisions

- **Native stack: Flutter vs React Native.** Currently leaning Flutter (better custom/animated UI, `photo_manager` and `google_mlkit_*` plugins fit well). React Native's advantages are hiring depth for JS/TS and smoother first-party deployment via Expo EAS. Either works; the native modules below are identical in both, so the choice is low lock-in.
- **Name.** Camena — from the Camenae, the Roman muses of song and memory; also echoes "camera". Checked: no app-store collision, existing companies with the name are in unrelated sectors. Wordmark splits **cam**/*ena*; always written plainly as "Camena" in text and package names.

## Next steps

1. Act on friends-test feedback. The make-or-break signal is whether the app picks photos people are *proud* to post — everything else is secondary.
2. Build the native spike (see the spike spec if present in the repo): on-device tagging + a single rendered reel, native only, to answer whether vision tagging is specific enough and whether on-device render is fast enough on low-end Android.
3. Build the trend catalog generator (GitHub Actions → static JSON) to replace the prototype's hard-coded trend list.

## Working notes

- Prefer small, verifiable changes; the deployed prototype is what testers are using. Logic lives in the `js/` modules now, not one script block — edit the module that owns the concern (see the table above).
- The trend catalog is hard-coded in `js/catalog.js`, in the same shape the real backend will serve — keep that shape when wiring up the live catalog so nothing else has to change.
- **Local testing needs a server that sends the correct JS MIME type.** ES modules must be served as `text/javascript`; Python 3.13+ `http.server` on Windows serves `.js` as `text/plain`, which browsers refuse to execute (the app silently fails to wire up). Use a server that sets the right MIME, or just test on GitHub Pages, which serves it correctly. Opening `index.html` as a `file://` URL also won't work — modules require http(s).
- Test on a real phone, both iOS Safari and Android Chrome. They fail differently, and low-end Android is the target market's actual hardware.
