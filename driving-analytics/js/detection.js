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

// Below this estimated absolute speed, a "vehicle" is effectively not moving — a parked car,
// one waiting at a light or stop sign, etc. We trivially "close the gap" on anything stationary
// just by driving past it, which produced false "overtook" events for every parked/stopped car
// along the road. Real traffic overtakes involve an actually-moving vehicle.
const STATIONARY_SPEED_MPS = 2.5; // ~5.6 mph

// Assumed real-world vehicle widths (meters), used only to turn a bounding box's pixel width
// into a rough estimated distance via a pinhole-camera projection. There's no per-device
// camera calibration here, so treat every distance/speed number this produces as a ballpark
// estimate, not a measurement — it's precise enough to meaningfully improve the pass/no-pass
// classification and give a fun approximate "their speed" readout, not to certify anything.
const VEHICLE_WIDTH_M = {
  car: 1.8,
  truck: 2.5,
  bus: 2.55,
  motorcycle: 0.8,
};

// Typical horizontal field of view for a phone's main rear camera; overridden via
// setHorizontalFovDeg() when the active lens changes (the ultra-wide lens sees a much wider
// angle, which changes how a given pixel width maps to a real-world distance).
const DEFAULT_HFOV_DEG = 68;

function estimateDistanceMeters(bboxWidthPx, frameWidthPx, realWidthM, hFovDeg) {
  const hFovRad = (hFovDeg * Math.PI) / 180;
  const focalPx = frameWidthPx / (2 * Math.tan(hFovRad / 2));
  return (realWidthM * focalPx) / Math.max(1, bboxWidthPx);
}

// Ordinary least-squares slope of ys against xs — used to turn a track's noisy per-frame
// distance samples into one robust closing/receding rate (meters/second) instead of just
// comparing a couple of endpoint samples, which is far more sensitive to a single noisy frame.
function linearRegressionSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

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
    this.horizontalFovDeg = DEFAULT_HFOV_DEG;
  }

  // Called whenever the active camera lens changes — the ultra-wide lens has a much wider
  // field of view, which changes what real-world distance a given bbox pixel-width implies.
  setHorizontalFovDeg(deg) {
    this.horizontalFovDeg = deg;
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

  // Running the model N times per tick (once per tile) instead of once directly lowers the
  // effective detection rate by roughly that factor — a car can then move further between
  // successful detections than a fixed matching tolerance allows, fragmenting one real track
  // into several short ones that each get dropped before a pass event can even fire. This is
  // what "struggled to maintain tracking at 0.5x" actually was. Widen the tolerance to match.
  setMatchDistanceRatio(ratio) {
    this.opts.matchDistanceRatio = ratio;
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

    // Each tile crops a bit more than half the frame's width so a vehicle straddling the seam
    // still lands fully inside at least one tile (overlapping detections get de-duped below).
    // That crop is then drawn into a canvas capped at a modest resolution — the model resizes
    // its input down internally regardless, so handing it a smaller image costs nothing in
    // detection quality but meaningfully cuts per-tile decode/inference time, which matters
    // because two tiles run sequentially every tick (see setMatchDistanceRatio for why that
    // matters for tracking). Detections are scaled back up to full-frame pixel coordinates.
    const cropW = Math.round(vw * 0.6);
    const maxCanvasW = 640;
    const canvasW = Math.min(cropW, maxCanvasW);
    const canvasH = Math.round(vh * (canvasW / cropW));
    const scaleToFullRes = cropW / canvasW;
    const tileOffsets = [0, vw - cropW];
    this._tileCanvas.width = canvasW;
    this._tileCanvas.height = canvasH;

    const all = [];
    for (const offsetX of tileOffsets) {
      this._tileCtx.drawImage(videoEl, offsetX, 0, cropW, vh, 0, 0, canvasW, canvasH);
      const preds = await this.model.detect(this._tileCanvas);
      for (const p of this._filterVehicles(preds)) {
        const [bx, by, bw, bh] = p.bbox;
        all.push({
          ...p,
          bbox: [bx * scaleToFullRes + offsetX, by * scaleToFullRes, bw * scaleToFullRes, bh * scaleToFullRes],
        });
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

  update(detections, frameWidth, frameHeight, ourSpeedMps) {
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
      const realWidthM = VEHICLE_WIDTH_M[det.class] || VEHICLE_WIDTH_M.car;
      track.history.push({
        t: Date.now(),
        w: w / frameWidth,
        cx: (x + w / 2) / frameWidth,
        distM: estimateDistanceMeters(w, frameWidth, realWidthM, this.horizontalFovDeg),
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
      const realWidthM = VEHICLE_WIDTH_M[det.class] || VEHICLE_WIDTH_M.car;
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
            distM: estimateDistanceMeters(w, frameWidth, realWidthM, this.horizontalFovDeg),
          },
        ],
      });
    });

    const events = [];
    for (const track of liveTracks) {
      if (matchedTrackIds.has(track.id)) continue;
      track.missedFrames += 1;
      if (track.missedFrames > this.opts.maxMissedFrames) {
        const event = this._classifyTrack(track, ourSpeedMps);
        if (event) events.push(event);
        this.tracks.delete(track.id);
      }
    }

    return {
      tracks: Array.from(this.tracks.values()).map(({ id, bbox, class: cls }) => ({ id, bbox, class: cls })),
      events,
    };
  }

  // Fits a straight line through the track's estimated-distance-over-time samples to get one
  // robust closing/receding rate (meters/sec) instead of comparing a couple of endpoint
  // samples, which one noisy frame can throw off. Negative slope = we were closing the gap
  // overall; positive = it was pulling away overall. Combined with whether the track drifted
  // toward or away from dead-center, that tells us who did the passing — and the slope's
  // magnitude, combined with our own GPS speed, gives a rough estimate of the other vehicle's
  // absolute speed at the time.
  _classifyTrack(track, ourSpeedMps) {
    const h = track.history;
    if (h.length < this.opts.minTrackAgeFrames) return null;

    const peakW = Math.max(...h.map((s) => s.w));
    if (peakW < this.opts.closeWidthRatio) return null;

    const first3 = h.slice(0, 3);
    const last3 = h.slice(-3);
    const startCx = avg(first3.map((s) => s.cx));
    const endCx = avg(last3.map((s) => s.cx));
    const startOffset = Math.abs(startCx - 0.5);
    const endOffset = Math.abs(endCx - 0.5);

    // A track that never gets meaningfully off-center — at neither its start nor its end — is
    // just traffic ahead of or behind us in our own lane (catching up or pulling away in a
    // straight line, typically lost off the top of frame), not a pass. Require real sideways
    // presence before considering it a candidate at all.
    if (Math.max(startOffset, endOffset) < this.opts.minLateralOffset) return null;

    const t0 = h[0].t;
    const timesSec = h.map((s) => (s.t - t0) / 1000);
    const distances = h.map((s) => s.distM);
    const closingRateMps = -linearRegressionSlope(timesSec, distances);

    const hasOurSpeed = typeof ourSpeedMps === 'number' && isFinite(ourSpeedMps) && ourSpeedMps > 0;

    if (closingRateMps > 0 && endOffset > startOffset) {
      // We were closing the gap overall, and it ended up more off-center than it started —
      // consistent with catching up to and passing it.
      const theirSpeedMps = hasOurSpeed ? Math.max(0, ourSpeedMps - closingRateMps) : null;

      // Trivially true for ANY stationary object we drive past (a parked car, one waiting at a
      // light) — that's not "overtaking" in the traffic sense, so only count it once we have a
      // speed estimate and it's clearly above walking-pace. Without a speed estimate (GPS not
      // yet acquired) we can't tell the difference, so it still passes through as before.
      if (hasOurSpeed && theirSpeedMps < STATIONARY_SPEED_MPS) return null;

      return {
        type: 'overtook',
        id: track.id,
        timestamp: Date.now(),
        theirSpeedMps,
      };
    }

    if (closingRateMps < 0 && startOffset > endOffset) {
      // The gap was growing overall (it was pulling away), and it started more off-center than
      // it ended — consistent with having been alongside/behind and then pulling ahead of us.
      return {
        type: 'overtaken',
        id: track.id,
        timestamp: Date.now(),
        theirSpeedMps: hasOurSpeed ? ourSpeedMps + Math.abs(closingRateMps) : null,
      };
    }

    return null;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }
}
