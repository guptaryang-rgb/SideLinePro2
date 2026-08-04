// Vehicle detection + tracking for Overtaker.
// Relies on `tf` and `cocoSsd` being loaded as page globals before this module runs.

export const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];

// Tuned from real-drive testing: a dash-mounted phone's wide field of view means a car one
// lane over rarely fills much of the frame, and the default fast model missed distant cars
// outright — so closeWidthRatio/scoreThreshold are relaxed and minTrackAgeFrames/maxMissedFrames
// are more forgiving of the gaps that noisier detections leave in a track's history.
const DEFAULT_OPTS = {
  maxMissedFrames: 10,
  minTrackAgeFrames: 4,
  closeWidthRatio: 0.1,
  matchDistanceRatio: 0.15,
  scoreThreshold: 0.4,
  // How far off dead-center (as a fraction of frame width) a track must get, at either end of
  // its life, to count as a real pass. Without this, a car directly ahead in our own lane that
  // simply pulls away (shrinking but never leaving the center of frame) looked identical to a
  // genuine overtake — it just eventually vanished off the top of frame, not to a side.
  minLateralOffset: 0.08,
};

// De-dupe threshold for tiled detection: two boxes from overlapping tiles this close together
// are almost certainly the same vehicle seen twice, not two vehicles.
const TILE_DEDUPE_IOU = 0.4;

const bboxIou = (a, b) => {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;
  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
};

const bboxCenter = ([x, y, w, h]) => [x + w / 2, y + h / 2];

const centerDistance = (a, b) => {
  const [ax, ay] = bboxCenter(a);
  const [bx, by] = bboxCenter(b);
  return Math.hypot(ax - bx, ay - by);
};

const avg = (nums) => nums.reduce((sum, n) => sum + n, 0) / nums.length;

export class CarTracker {
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.tracks = new Map();
    this.nextId = 1;
    this.model = null;
    this.ready = false;
    this.tileCount = 1;
    this._tileCanvas = null;
    this._tileCtx = null;
  }

  async load() {
    // 'mobilenet_v2' trades some inference speed for materially better accuracy on small/
    // distant objects than the default 'lite_mobilenet_v2' — worth it here since missing far
    // cars was the main complaint and our detection loop already tolerates slower ticks.
    this.model = await cocoSsd.load({ base: 'mobilenet_v2' });
    this.ready = true;
  }

  // Called whenever the active camera lens changes. The model always resizes whatever image
  // it's given down to its own small fixed input size before inference — so a wider field of
  // view (like an ultra-wide 0.5x lens) doesn't just show more road, it also means every car in
  // frame ends up represented by fewer effective pixels once resized, and small/distant ones
  // get lost. Tiling (running the model separately on overlapping left/right crops instead of
  // the whole frame at once) keeps each region closer to the model's native input size.
  setTileCount(n) {
    this.tileCount = Math.max(1, Math.min(3, Math.round(n)));
  }

  async detectVehicles(videoEl) {
    if (!this.ready) return [];
    if (this.tileCount <= 1) {
      const preds = await this.model.detect(videoEl);
      return this._filterVehicles(preds);
    }
    return this._detectTiled(videoEl);
  }

  _filterVehicles(preds) {
    return preds
      .filter((p) => VEHICLE_CLASSES.includes(p.class) && p.score > this.opts.scoreThreshold)
      .map((p) => ({ bbox: p.bbox, class: p.class, score: p.score }));
  }

  async _detectTiled(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return [];

    if (!this._tileCanvas) {
      this._tileCanvas = document.createElement('canvas');
      this._tileCtx = this._tileCanvas.getContext('2d');
    }

    // Each tile covers a bit more than half the frame so a vehicle straddling the seam still
    // lands fully inside at least one tile; overlapping detections get de-duped below.
    const tileW = Math.round(vw * 0.58);
    const tileOffsets = [0, vw - tileW];
    this._tileCanvas.width = tileW;
    this._tileCanvas.height = vh;

    const all = [];
    for (const offsetX of tileOffsets) {
      this._tileCtx.drawImage(videoEl, offsetX, 0, tileW, vh, 0, 0, tileW, vh);
      const preds = await this.model.detect(this._tileCanvas);
      for (const p of this._filterVehicles(preds)) {
        all.push({ ...p, bbox: [p.bbox[0] + offsetX, p.bbox[1], p.bbox[2], p.bbox[3]] });
      }
    }
    return this._dedupeOverlaps(all);
  }

  _dedupeOverlaps(detections) {
    const sorted = [...detections].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const det of sorted) {
      const isDuplicate = kept.some((k) => bboxIou(k.bbox, det.bbox) > TILE_DEDUPE_IOU);
      if (!isDuplicate) kept.push(det);
    }
    return kept;
  }

  update(detections, frameWidth, frameHeight) {
    const liveTracks = Array.from(this.tracks.values());
    const matchedTrackIds = new Set();
    const matchedDetectionIdxs = new Set();
    const pairs = [];

    // Greedily pair every detection with the highest-IOU live track, falling back to
    // nearest-center distance (bounded by matchDistanceRatio) when boxes don't overlap
    // at all, e.g. a fast-moving vehicle sampled at a low frame rate.
    detections.forEach((det, detIdx) => {
      let bestTrack = null;
      let bestIou = 0;
      for (const track of liveTracks) {
        if (matchedTrackIds.has(track.id)) continue;
        const iou = bboxIou(det.bbox, track.bbox);
        if (iou > bestIou) {
          bestIou = iou;
          bestTrack = track;
        }
      }
      if (!bestTrack) {
        let bestDist = Infinity;
        for (const track of liveTracks) {
          if (matchedTrackIds.has(track.id)) continue;
          const dist = centerDistance(det.bbox, track.bbox);
          if (dist < bestDist) {
            bestDist = dist;
            bestTrack = track;
          }
        }
        if (!bestTrack || bestDist > this.opts.matchDistanceRatio * frameWidth) {
          bestTrack = null;
        }
      }
      if (bestTrack) {
        matchedTrackIds.add(bestTrack.id);
        matchedDetectionIdxs.add(detIdx);
        pairs.push({ track: bestTrack, det });
      }
    });

    for (const { track, det } of pairs) {
      const [x, y, w] = det.bbox;
      track.bbox = det.bbox;
      track.class = det.class;
      track.history.push({
        t: Date.now(),
        w: w / frameWidth,
        cx: (x + w / 2) / frameWidth,
      });
      if (track.history.length > 90) {
        track.history.splice(0, track.history.length - 90);
      }
      track.missedFrames = 0;
      track.age += 1;
    }

    detections.forEach((det, detIdx) => {
      if (matchedDetectionIdxs.has(detIdx)) return;
      const [x, y, w] = det.bbox;
      const id = this.nextId++;
      this.tracks.set(id, {
        id,
        bbox: det.bbox,
        class: det.class,
        age: 1,
        missedFrames: 0,
        history: [
          {
            t: Date.now(),
            w: w / frameWidth,
            cx: (x + w / 2) / frameWidth,
          },
        ],
      });
    });

    const events = [];
    for (const track of liveTracks) {
      if (matchedTrackIds.has(track.id)) continue;
      track.missedFrames += 1;
      if (track.missedFrames > this.opts.maxMissedFrames) {
        const event = this._classifyTrack(track);
        if (event) events.push(event);
        this.tracks.delete(track.id);
      }
    }

    return {
      tracks: Array.from(this.tracks.values()).map(({ id, bbox, class: cls }) => ({ id, bbox, class: cls })),
      events,
    };
  }

  // Bbox width is a cheap proxy for how close a vehicle is: growing width means we're
  // closing on it (or it on us). Whether it drifts toward center or an edge as it's lost
  // tells us who did the passing: a car that was alongside us mid-pass drifts off-center
  // as it falls behind (we overtook it); a car that was already close/off-center and
  // shrinks back toward the middle was pulling away ahead of us (it overtook us).
  _classifyTrack(track) {
    const h = track.history;
    if (h.length < this.opts.minTrackAgeFrames) return null;

    let peakW = -Infinity;
    let peakIndex = 0;
    h.forEach((sample, i) => {
      if (sample.w > peakW) {
        peakW = sample.w;
        peakIndex = i;
      }
    });

    const first3 = h.slice(0, 3);
    const last3 = h.slice(-3);
    const startW = avg(first3.map((s) => s.w));
    const endW = avg(last3.map((s) => s.w));
    const startCx = avg(first3.map((s) => s.cx));
    const endCx = avg(last3.map((s) => s.cx));

    if (peakW < this.opts.closeWidthRatio) return null;

    const startOffset = Math.abs(startCx - 0.5);
    const endOffset = Math.abs(endCx - 0.5);

    // A track that never gets meaningfully off-center — at neither its start nor its end — is
    // just traffic ahead of or behind us in our own lane (catching up or pulling away in a
    // straight line, typically lost off the top of frame), not a pass. Require real sideways
    // presence before considering it a candidate at all.
    if (Math.max(startOffset, endOffset) < this.opts.minLateralOffset) return null;

    if (
      endW - startW > 0 &&
      peakIndex >= h.length / 2 &&
      endOffset > startOffset
    ) {
      return { type: 'overtook', id: track.id, timestamp: Date.now() };
    }

    if (
      peakIndex < h.length / 2 &&
      startW - endW > 0 &&
      startOffset > endOffset
    ) {
      return { type: 'overtaken', id: track.id, timestamp: Date.now() };
    }

    return null;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }
}
