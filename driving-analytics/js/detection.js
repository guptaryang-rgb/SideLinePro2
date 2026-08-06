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

// A road bump (pothole, speed bump, rough pavement) jolts the phone hard enough to both blur
// the video for a tick or two AND shift the camera's own framing — a track's normal matching
// tolerance is sized for how far the VEHICLE moves, not for a jolt like this, so a bump was
// fragmenting tracks mid-pass (lost entirely, or split into a duplicate). reportMotionSample()
// (fed from the live G-force meter this app already has permission for) detects a bump as a
// spike ABOVE a slow rolling baseline, not an absolute g threshold — so ordinary cornering or
// braking g-loads, which raise the baseline itself, don't trigger it.
const BUMP_BASELINE_ALPHA = 0.95;
const BUMP_TRIGGER_DELTA_G = 0.35;
const BUMP_ABSOLUTE_MIN_G = 0.45;
// How long (ms) a detected bump keeps matching more forgiving, linearly decaying back to normal
// — a graded window, not an on/off flag, so a track doesn't die at tick N but would have
// survived at tick N+1 for no principled reason. Sized generously above the blur/missed-frame
// window itself (not just the jolt's own duration): the boosted radius is needed most at the
// moment detection RESUMES after a multi-tick blur gap, which can itself eat up a second or more
// of this window before reacquisition is even attempted.
const BUMP_GRACE_MS = 2200;
const BUMP_EXTRA_MISSED_FRAMES = 6;
const BUMP_MATCH_RATIO_BOOST = 1.3;
// Sanity gate on the widened bump-window matching radius: a genuinely re-matched car shouldn't
// have visually changed size this much in one tick even mid-bump — guards against the wider
// radius latching onto a different, nearby vehicle instead of the one that got lost.
const BUMP_WIDTH_RATIO_MIN = 0.4;
const BUMP_WIDTH_RATIO_MAX = 2.5;

// How many recent history samples feed each track's own on-screen drift-rate estimate — used to
// predict roughly where it should be next instead of assuming it's still exactly where it was
// last seen. See _updateTrackVelocity/_predictCenterPx.
const VELOCITY_WINDOW_SAMPLES = 5;
// Cap on how far past a track's last real detection to extrapolate its predicted position,
// deliberately kept below the ~2s give-up horizon (maxMissedFrames * the ~200ms detection tick)
// so prediction never speculates further ahead than the track is about to be abandoned anyway.
const MAX_EXTRAPOLATION_SEC = 1.5;
// Clamp on the fitted drift rate (frame-fractions/second) so one noisy/blurred sample inside the
// fit window can't fling a prediction wildly off — a bad fit then just degrades to "no match
// found" rather than confidently pointing at the wrong place.
const MAX_NORM_CENTER_VELOCITY = 1.5;

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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
    // Bump/shake detection state — see reportMotionSample()/_bumpFactor().
    this._gBaseline = null;
    this._lastBumpAt = -Infinity;
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
  // Trade-off: the nearest-centroid fallback below is greedy, not a global optimum, so a wider
  // radius also raises the odds of latching onto a different nearby vehicle in dense traffic
  // (an identity swap) — an inherent cost of this fix, not a bug, but worth knowing about if
  // 0.5x tracking still misbehaves after this.
  setMatchDistanceRatio(ratio) {
    this.opts.matchDistanceRatio = ratio;
  }

  // Ultra-wide's foreshortened field of view means a genuine vehicle is represented by fewer
  // pixels than the same vehicle on the main lens, which systematically suppresses the model's
  // confidence on it — a flat score/close-width threshold tuned for the main lens under-detects
  // real ultra-wide traffic. Let app.js relax both per-lens.
  setScoreThreshold(v) {
    this.opts.scoreThreshold = v;
  }

  setCloseWidthRatio(v) {
    this.opts.closeWidthRatio = v;
  }

  // Feeds this tracker a live accelerometer reading (in g's) so it can recognize a road bump as
  // it happens and temporarily relax track matching/survival to compensate — see the BUMP_*
  // constants above for why. Call this from MotionTracker's onUpdate callback; safe to never
  // call at all (e.g. motion permission denied) — bumpFactor then just always stays 0, identical
  // to pre-bump-handling behavior.
  reportMotionSample(currentG) {
    if (typeof currentG !== 'number' || !isFinite(currentG)) return;
    this._gBaseline = this._gBaseline == null
      ? currentG
      : BUMP_BASELINE_ALPHA * this._gBaseline + (1 - BUMP_BASELINE_ALPHA) * currentG;
    if (currentG - this._gBaseline > BUMP_TRIGGER_DELTA_G && currentG > BUMP_ABSOLUTE_MIN_G) {
      this._lastBumpAt = Date.now();
    }
  }

  // Graded 1 -> 0 decay over BUMP_GRACE_MS since the last detected bump, rather than a binary
  // flag, so nothing keyed off it has an arbitrary cliff-edge.
  _bumpFactor(nowMs) {
    const elapsed = nowMs - this._lastBumpAt;
    if (elapsed < 0 || elapsed > BUMP_GRACE_MS) return 0;
    return 1 - elapsed / BUMP_GRACE_MS;
  }

  // Fits a trailing window of a track's own (cx, cy) history to get its recent on-screen drift
  // rate (frame-fractions/second) — see _predictCenterPx for how this is used. Prefers samples
  // NOT captured during a bump's grace window, same reasoning as _classifyTrack's regression
  // filtering: a sample matched via the widened bump-window radius could be the wrong vehicle,
  // and letting that feed the fitted rate would compound the error into every subsequent tick's
  // prediction. Falls back to the raw trailing window if too few clean samples remain.
  _updateTrackVelocity(track) {
    const clean = track.history.filter((s) => !s.duringBump);
    const window = (clean.length >= 2 ? clean : track.history).slice(-VELOCITY_WINDOW_SAMPLES);
    if (window.length < 2) {
      track.vcx = 0;
      track.vcy = 0;
      return;
    }
    const t0 = window[0].t;
    const ts = window.map((s) => (s.t - t0) / 1000);
    track.vcx = clamp(
      linearRegressionSlope(ts, window.map((s) => s.cx)),
      -MAX_NORM_CENTER_VELOCITY,
      MAX_NORM_CENTER_VELOCITY
    );
    track.vcy = clamp(
      linearRegressionSlope(ts, window.map((s) => s.cy)),
      -MAX_NORM_CENTER_VELOCITY,
      MAX_NORM_CENTER_VELOCITY
    );
  }

  // Extrapolates where a track's center is LIKELY to be right now, given how it's been drifting,
  // rather than assuming it's still exactly where it was last actually seen. dtSec is real
  // elapsed wall-clock time since the last real detection, so it naturally scales to however
  // long a blur/shake gap lasted and however many ticks it spanned — including the longer,
  // less-regular gaps tiled ultra-wide detection already introduces — with no lens-specific
  // branching needed here.
  _predictCenterPx(track, nowMs, frameWidth, frameHeight) {
    const last = track.history[track.history.length - 1];
    const dtSec = clamp((nowMs - last.t) / 1000, 0, MAX_EXTRAPOLATION_SEC);
    const predCx = last.cx + (track.vcx || 0) * dtSec;
    const predCy = last.cy + (track.vcy || 0) * dtSec;
    return [predCx * frameWidth, predCy * frameHeight];
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
    const now = Date.now();
    const bumpFactor = this._bumpFactor(now);
    // Multiplies (rather than replaces) the already lens-tuned matchDistanceRatio, so this
    // composes with the existing main/ultra-wide split instead of overriding it.
    const effectiveMatchDistanceRatio = this.opts.matchDistanceRatio * (1 + BUMP_MATCH_RATIO_BOOST * bumpFactor);

    const liveTracks = Array.from(this.tracks.values());
    // Each live track's predicted current center, extrapolated from its own recent drift rate —
    // matched against instead of the track's static last-known position (see _predictCenterPx).
    // Only the fallback (non-IOU) pass below uses this; a real frame-to-frame overlap is already
    // reliable evidence on its own and is left alone to avoid regressing normal-condition
    // matching.
    const predictedBboxes = new Map(
      liveTracks.map((t) => {
        const [px, py] = this._predictCenterPx(t, now, frameWidth, frameHeight);
        const [, , tw, th] = t.bbox;
        return [t.id, [px - tw / 2, py - th / 2, tw, th]];
      })
    );

    const matchedTrackIds = new Set();
    const matchedDetectionIdxs = new Set();
    const pairs = [];

    // Greedily pair every detection with the highest-IOU live track, falling back to
    // nearest-predicted-center distance (bounded by effectiveMatchDistanceRatio) when boxes
    // don't overlap at all, e.g. a fast-moving vehicle sampled at a low frame rate, or one
    // reacquired after a bump-induced gap.
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
          const dist = centerDistance(det.bbox, predictedBboxes.get(track.id));
          if (dist < bestDist) {
            bestDist = dist;
            bestTrack = track;
          }
        }
        if (!bestTrack || bestDist > effectiveMatchDistanceRatio * frameWidth) {
          bestTrack = null;
        }
        // The bump-widened radius makes the greedy matcher more likely to grab a different,
        // nearby vehicle instead of the one that actually got lost — reject a fallback match
        // whose apparent size implausibly jumped as a sanity check specifically during that
        // widened window.
        if (bestTrack && bumpFactor > 0) {
          const widthRatio = det.bbox[2] / Math.max(1, bestTrack.bbox[2]);
          if (widthRatio < BUMP_WIDTH_RATIO_MIN || widthRatio > BUMP_WIDTH_RATIO_MAX) {
            bestTrack = null;
          }
        }
      }
      if (bestTrack) {
        matchedTrackIds.add(bestTrack.id);
        matchedDetectionIdxs.add(detIdx);
        pairs.push({ track: bestTrack, det });
      }
    });

    for (const { track, det } of pairs) {
      const [x, y, w, h] = det.bbox;
      track.bbox = det.bbox;
      track.class = det.class;
      const realWidthM = VEHICLE_WIDTH_M[det.class] || VEHICLE_WIDTH_M.car;
      track.history.push({
        t: now,
        w: w / frameWidth,
        cx: (x + w / 2) / frameWidth,
        cy: (y + h / 2) / frameHeight,
        distM: estimateDistanceMeters(w, frameWidth, realWidthM, this.horizontalFovDeg),
        // Flags samples captured while a bump's effects were still active, so _classifyTrack can
        // exclude them from the pass/no-pass regression — a blur-corrupted or bump-widened-match
        // sample shouldn't get to skew the closing-rate slope that decides a real pass.
        duringBump: bumpFactor > 0.3,
      });
      if (track.history.length > 90) {
        track.history.splice(0, track.history.length - 90);
      }
      this._updateTrackVelocity(track);
      track.missedFrames = 0;
      track.age += 1;
    }

    detections.forEach((det, detIdx) => {
      if (matchedDetectionIdxs.has(detIdx)) return;
      const [x, y, w, h] = det.bbox;
      const id = this.nextId++;
      const realWidthM = VEHICLE_WIDTH_M[det.class] || VEHICLE_WIDTH_M.car;
      this.tracks.set(id, {
        id,
        bbox: det.bbox,
        class: det.class,
        age: 1,
        missedFrames: 0,
        vcx: 0,
        vcy: 0,
        history: [
          {
            t: now,
            w: w / frameWidth,
            cx: (x + w / 2) / frameWidth,
            cy: (y + h / 2) / frameHeight,
            distM: estimateDistanceMeters(w, frameWidth, realWidthM, this.horizontalFovDeg),
            duringBump: bumpFactor > 0.3,
          },
        ],
      });
    });

    const events = [];
    for (const track of liveTracks) {
      if (matchedTrackIds.has(track.id)) continue;
      track.missedFrames += 1;
      // A bump grants extra survival ticks on top of the normal ceiling, decaying back to it as
      // bumpFactor decays to 0 — without this, even a perfectly-predicted rematch is useless if
      // the track was already deleted before detection resumed.
      const missedFramesCeiling = this.opts.maxMissedFrames + Math.round(BUMP_EXTRA_MISSED_FRAMES * bumpFactor);
      if (track.missedFrames > missedFramesCeiling) {
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

    // A bump landing near a track's closest approach — the exact scenario this feature exists to
    // handle — is squarely within its widest, most off-center samples. Excluding bump-window
    // samples from these geometry reads (rather than just the regression below) would strip the
    // very peak-width/boundary evidence a genuine pass needs, silently dropping it. These read
    // real detected bbox geometry directly and aren't sensitive to the regression's failure mode
    // (a corrupted sample skewing a fitted slope), so they use the full, unfiltered history.
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

    // Unlike the geometry checks above, the regression's fitted slope IS sensitive to a single
    // corrupted sample (blur-affected, or matched via the widened bump-window radius and
    // possibly the wrong vehicle) — exclude bump-window samples here specifically, falling back
    // to the unfiltered history if too few clean samples remain for a robust fit.
    const cleanForRegression = h.filter((s) => !s.duringBump);
    const regressionSamples = cleanForRegression.length >= this.opts.minTrackAgeFrames ? cleanForRegression : h;
    const t0 = regressionSamples[0].t;
    const timesSec = regressionSamples.map((s) => (s.t - t0) / 1000);
    const distances = regressionSamples.map((s) => s.distM);
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
    this._gBaseline = null;
    this._lastBumpAt = -Infinity;
  }
}
