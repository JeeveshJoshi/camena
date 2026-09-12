# Native Spike — On-Device Tagging + Reel Render

**Type:** throwaway spike (learning code, not a foundation)
**Goal:** retire the two biggest engineering risks before any app is built around them.
**Estimated effort:** ~2–2.5 dev-days per platform, plus 1 day of on-device testing. Budget 4–5 days total.

---

## 0. Why a spike, and what it must answer

A spike is disposable code written to answer specific questions, not to be extended into the product. Resist the urge to make it clean, generic, or reusable. The moment a question is answered, the code has done its job.

This spike exists to answer three risk questions. Write down the answers — that is the deliverable, not the app.

**Q1 — Vision usefulness.** Do the on-device labelers produce tags good enough to drive trend matching, on a *real, messy* camera roll? Specifically: what fraction of photos get at least one tag a human agrees is useful, how specific are those tags (do they distinguish "food / beach / city" reliably), and how fast is inference per image?

**Q2 — Render feasibility.** Can we compose and encode a 5-clip, 9:16 reel mixing photos and short video clips, entirely on-device, in an acceptable time — and does the output play correctly with the right aspect ratio and no artifacts?

**Q3 — Throughput & thermals.** Indexing ~50 photos end to end: how long does it take, how much memory does it use, and does the device get hot or jank? This is the signal for whether full-library indexing is viable on the low-end devices our market actually uses.

**Explicit non-goals (do NOT build these):** real UI, the trend catalog, the matching logic, embeddings-based search, cloud anything, error handling beyond crash-avoidance, or any production polish. Inputs and outputs are hard-coded.

---

## 1. Scope — one screen, two buttons

A single throwaway screen on each platform:

- **Button A — "Index 50 photos."** Reads the N most recent photos, runs labeling + metadata + a crude quality score, writes rows to SQLite, and appends timings to an on-screen text log.
- **Button B — "Build reel."** Takes a *hard-coded, ordered list of 5 media IDs*, composes a 9:16 reel with a fixed 2.5s per clip, exports an MP4 to the app's own storage, and logs the total compose+export time and output file size.
- **A scrolling text log** showing, per indexed image: its tags with confidences, its quality score, and per-image latency; and for the reel: total time, output path, size, resolution, fps.

That's it. No navigation, no lists, no styling.

---

## 2. How to build it — native-first, no React Native yet

Build the spike as **two standalone native sample apps** (a SwiftUI screen on iOS, a Compose screen on Android). Do **not** put it behind a React Native bridge yet.

Rationale: the risk questions are about native *capability and performance*. Introducing the RN bridge now adds a second variable — bridge serialization cost, TurboModule setup, threading — that muddies the timing numbers and slows the spike. Prove the native pieces work and are fast first; wrapping them as TurboModules is a separate, lower-risk task once these questions are answered. (When you do wrap them, the heavy work stays in native threads and only small JSON results cross the bridge, so the bridge is not on the hot path anyway.)

---

## 3. Shared data contract — the gallery index schema

Both platforms write the same SQLite shape. This is the one piece of the spike that *does* carry forward, because it's the contract the real app's content-understanding pass produces. Keep it minimal.

```sql
CREATE TABLE media (
  id           TEXT PRIMARY KEY,   -- PHAsset.localIdentifier (iOS) / MediaStore _ID (Android)
  type         TEXT NOT NULL,      -- 'photo' | 'video'
  captured_at  INTEGER,            -- epoch ms
  lat          REAL,               -- nullable: many photos have no GPS
  lng          REAL,
  place        TEXT,               -- reverse-geocoded label, nullable
  width        INTEGER,
  height       INTEGER,
  quality      REAL,               -- 0..1, crude
  face_count   INTEGER DEFAULT 0,
  indexed_at   INTEGER
);

CREATE TABLE media_tag (
  media_id     TEXT NOT NULL REFERENCES media(id),
  label        TEXT NOT NULL,      -- e.g. 'food', 'beach', 'beverage'
  confidence   REAL NOT NULL       -- 0..1 from the labeler
);

CREATE INDEX idx_tag_label ON media_tag(label);
```

Optional stretch column (only if Q1 looks good and you want to peek at semantic matching): a `BLOB embedding` on `media` holding a feature-print vector. Skip it for the first pass — embeddings are not one of the three risk questions.

---

## 4. iOS implementation outline

**Frameworks:** PhotoKit, Vision, CoreLocation, AVFoundation, plus SQLite (GRDB is fine, or raw `sqlite3`). Swift + SwiftUI. **Test on a real device** — the Simulator has no Neural Engine and unrepresentative GPU/encode performance.

### 4.1 Read photos (PhotoKit)

1. Request `PHPhotoLibrary` authorization (Info.plist: `NSPhotoLibraryUsageDescription`).
2. Fetch the N newest assets:
   ```swift
   let opts = PHFetchOptions()
   opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
   opts.fetchLimit = 50
   let assets = PHAsset.fetchAssets(with: opts)
   ```
3. Per `PHAsset`, read metadata directly: `mediaType`, `creationDate`, `location` (a `CLLocation` → lat/lng; **often nil** — handle it), `pixelWidth`, `pixelHeight`.
4. Request a **downsized** image for labeling (≈512px on the long edge — do not feed full-res; it's slower with no accuracy gain) via `PHImageManager.default().requestImage(...)` with an appropriate `targetSize` and `.highQualityFormat`.

### 4.2 Tag + score (Vision)

Run a `VNImageRequestHandler` per downsized image with these requests:

- **`VNClassifyImageRequest`** → scene/object labels with confidences. Keep results above ~0.1–0.2. This is the core tagging signal. **Known limitation to record for Q1:** the built-in taxonomy returns *generic* categories (e.g. `food`, `beverage`, `beach`, `outdoor`) — it will not say "Goa" or "Korean corn dog." That is expected; the production upgrade is a fine-tuned Core ML classifier for food/landmark specificity. The spike's job is to judge whether the *generic* categories are specific enough to drive location/food/format matching.
- **`VNGenerateAttentionBasedSaliencyImageRequest`** → a saliency heat map; a strong, well-placed salient region is a cheap composition signal.
- **`VNDetectFaceRectanglesRequest`** → face count → `face_count`.
- Combine saliency with a **sharpness metric** (variance of a Laplacian over the downsized image, via vImage/Accelerate or a quick CPU pass) into a single 0..1 `quality`. Crude is fine.

### 4.3 Reverse-geocode

For the spike, `CLGeocoder.reverseGeocodeLocation` (online) on the asset's `CLLocation` → a place string. Note for production: this should move to an offline gazetteer to honor the no-network-for-media privacy promise, but online is fine to prove the flow.

### 4.4 Write to SQLite

Insert one `media` row and N `media_tag` rows per asset.

### 4.5 Build the reel (AVFoundation)

Hard-code 5 IDs in display order. Target: 1080×1920, 30fps, 2.5s per clip, **no audio** (we keep audio royalty-free / added natively later, so render silent).

1. **Each video clip** → `AVURLAsset`; insert a 2.5s `CMTimeRange` of its video track into an `AVMutableCompositionTrack`.
2. **Each still** → render a 2.5s silent clip from the image. Simplest reliable path: `AVAssetWriter` + `AVAssetWriterInputPixelBufferAdaptor`, appending the image's `CVPixelBuffer` for the clip's frames at 30fps, producing a short `.mov`; then insert that into the composition like a video. (Optional Ken Burns: apply a slowly changing affine transform per frame.)
3. Concatenate all five segments back-to-back in the `AVMutableComposition`.
4. Build an `AVMutableVideoComposition` with `renderSize = 1080×1920` and `frameDuration = 1/30`; for each segment add an `AVMutableVideoCompositionLayerInstruction` with a transform that **aspect-fills and center-crops** the source into 9:16.
5. Export with `AVAssetExportSession` (attach the video composition; H.264/HEVC) to an MP4 in the app's Documents directory. Log export time and file size.

> Confirm exact initializer/property names against the current SDK as you go — AVFoundation is stable but a few signatures have shifted across Swift versions.

---

## 5. Android implementation outline

**Frameworks:** MediaStore, ML Kit Image Labeling (`com.google.mlkit:image-labeling`) + Face Detection, AndroidX Media3 Transformer (`androidx.media3:media3-transformer` + `media3-effect`, latest stable), Room (or raw SQLite). Kotlin + Compose. **Test on a real low-end device** representative of the target market, not just an emulator — encode performance and thermals are the whole point of Q2/Q3.

### 5.1 Read photos (MediaStore)

1. Permissions: `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` (Android 13+), plus **`ACCESS_MEDIA_LOCATION`** if you want GPS out of EXIF.
2. Query `MediaStore.Images` (and `.Video`) with a projection of `_ID`, `DATE_TAKEN`, `WIDTH`, `HEIGHT`, sorted by `DATE_TAKEN DESC`, limited to 50; build a content `Uri` per row.
3. GPS: open the original via `ContentResolver` (`setRequireOriginal` for location-redacted media) and read `ExifInterface.getLatLong(...)`. Expect many nulls.

### 5.2 Tag + score (ML Kit)

```kotlin
val labeler = ImageLabeling.getClient(
  ImageLabelerOptions.Builder().setConfidenceThreshold(0.5f).build()
)
val image = InputImage.fromFilePath(context, uri)   // downscale large images first
labeler.process(image)
  .addOnSuccessListener { labels -> /* label.text, label.confidence -> media_tag */ }
```

- Add a `FaceDetection` client for `face_count`.
- `quality` = a sharpness metric (Laplacian variance via OpenCV, or a manual 3×3 convolution) blended with a label-confidence heuristic. Crude is fine.
- **Same Q1 caveat as iOS:** ML Kit's default model returns a generic ~400+ entity set, not food/landmark specifics. Judge whether generic is enough; the production upgrade is a fine-tuned classifier shipped via LiteRT (or MediaPipe `ImageClassifier`).

### 5.3 Reverse-geocode

`Geocoder.getFromLocation(...)` for the spike (online). Offline gazetteer is the production path.

### 5.4 Write to SQLite

Same two-table schema as §3.

### 5.5 Build the reel (Media3 Transformer)

Media3 Transformer turns stills into video, concatenates mixed assets, and applies aspect-ratio framing — all hardware-accelerated on top of MediaCodec + OpenGL. The key calls:

- **Each still → a timed video segment.** Setting an image duration is *mandatory* to import a `MediaItem` as an image:
  ```kotlin
  val imageItem = MediaItem.Builder()
      .setUri(photoUri)
      .setImageDurationMs(2500)
      .build()
  val edited = EditedMediaItem.Builder(imageItem)
      .setFrameRate(30)
      .setEffects(Effects(emptyList(), listOf(/* 9:16 presentation + crop */)))
      .build()
  ```
- **Each video clip** → `MediaItem` with a `ClippingConfiguration` (start 0, end 2500ms) and the same 9:16 effects.
- **9:16 framing** → a `Presentation` effect sized to 1080×1920 plus a `Crop`/`ScaleAndRotateTransformation` to aspect-fill. Apply the effect list to **every** `EditedMediaItem` (see caveat below).
- **Concatenate** → `EditedMediaItemSequence(item1, item2, item3, item4, item5)`, then `Composition.Builder(sequence).build()`.
- **Export** →
  ```kotlin
  val transformer = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .addListener(/* onCompleted -> log time + size */)
      .build()
  transformer.start(composition, outputFilePath)
  ```
  Render silent (no audio sequence) for the spike.

> **Version caveat to verify:** on some older Media3 releases, per-item effects in a multi-item sequence were applied only to the first item (a known concatenation bug). Use a current stable version and confirm in the output that each clip's framing is correct, not just the first.

---

## 6. Instrumentation & success gates

Log to the on-screen text view and to logcat/Console so you can copy the numbers out.

**Capture per run:**
- Per image: tag list + confidences, labeling latency (ms), quality score.
- Indexing total: wall-clock for all 50, peak memory, device thermal state (`ProcessInfo.thermalState` on iOS / `PowerManager` thermal status on Android).
- Reel: total compose+export time, output file size, resolution, fps, and a manual "plays correctly? aspect right? artifacts?" yes/no.

**Suggested pass bars** (tune to your devices — these are starting lines, not gospel):

| Question | Pass signal | Refine signal |
|---|---|---|
| Q1 tagging | ≥~70% of photos get ≥1 human-agreed useful tag; generic categories clearly separate food/place/scene; <~250ms/image mid-device | Tags too generic to match on → schedule the custom Core ML / LiteRT classifier earlier than planned |
| Q2 render | 5-clip 9:16 reel composes+exports in <~8–12s mid-device; output correct | Too slow on low-end → cut clip count/resolution, or adopt "preview now, render on save" UX |
| Q3 throughput | 50 photos index in <~20–30s, no crash, tolerable thermals | Indexing is hot/slow → batch in the background, throttle, index incrementally |

The point of the gates is the **decision after**, per question: green = proceed as architected; amber = a specific, now-known adjustment to the plan.

---

## 7. Test conditions (don't skip these)

- **Real devices only.** iOS Simulator lacks the Neural Engine; Android emulators misrepresent encode speed and thermals. The numbers from a simulator are not the numbers you'll ship against.
- **At least one low-end Android** representative of the target market, plus one mid/recent iPhone. Q2 and Q3 are really questions about the *floor*, not the ceiling.
- **A real, messy camera roll.** Curate ~50 images that include the failure modes: travel/beach, food close-ups, people, screenshots, low-light, near-duplicate bursts, and a couple of videos. A clean test set hides exactly the problems the spike is meant to surface.

---

## 8. Deliverable from the spike

Not production code — a **one-page findings note** containing: the timing tables, a sampled list of ~15 images with their tags and a human thumbs-up/down on each, the exported reels themselves, and a one-line green/amber verdict per risk question with the specific adjustment if amber.

Once that note exists, the spike is done. Delete or archive the sample apps; the schema in §3 and the lessons are what move into the real build.
