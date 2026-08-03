// Vehicle detection + tracking for Overtaker.
// Relies on `tf` and `cocoSsd` being loaded as page globals before this module runs.

export const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];

const DEFAULT_OPTS = {
  maxMissedFrames: 8,
  minTrackAgeFrames: 6,
  closeWidthRatio: 0.18,
  matchDistanceRatio: 0.15,
  scoreThreshold: 0.5,
};

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
  }

  async load() {
    this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    this.ready = true;
  }

  async detectVehicles(videoEl) {
    if (!this.ready) return [];
    const preds = await this.model.detect(videoEl);
    return preds
      .filter((p) => VEHICLE_CLASSES.includes(p.class) && p.score > this.opts.scoreThreshold)
      .map((p) => ({ bbox: p.bbox, class: p.class, score: p.score }));
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

    if (
      endW - startW > 0 &&
      peakIndex >= h.length / 2 &&
      Math.abs(endCx - 0.5) > Math.abs(startCx - 0.5)
    ) {
      return { type: 'overtook', id: track.id, timestamp: Date.now() };
    }

    if (peakIndex < h.length / 2 && startW - endW > 0) {
      return { type: 'overtaken', id: track.id, timestamp: Date.now() };
    }

    return null;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }
}
