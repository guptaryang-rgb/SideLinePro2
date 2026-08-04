// motion.js — G-force tracking via the DeviceMotionEvent API.
// A phone's mount angle relative to the car is unknown, so this reports a single combined
// "total non-gravity acceleration" magnitude (in g's) rather than pretending to cleanly
// separate true lateral (cornering) from longitudinal (braking/accel) forces — that split
// only works with a calibrated, fixed mount orientation, which we don't have.

const GRAVITY_MS2 = 9.80665;
const GRAVITY_LOW_PASS_ALPHA = 0.9;

export class MotionTracker {
  constructor() {
    this._listener = null;
    this._updateListeners = [];
    this.currentG = 0;
    this.peakG = 0;
    this.peakAx = 0;
    this.peakAy = 0;
    this._gravityEstimate = null;
  }

  static isSupported() {
    return typeof DeviceMotionEvent !== 'undefined';
  }

  // iOS 13+ requires this to be called directly inside a user-gesture handler (e.g. a button
  // click) or it silently rejects — other browsers have no such permission concept and this
  // resolves true immediately.
  static async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission !== 'function') return true;
    try {
      const result = await DeviceMotionEvent.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  start() {
    this.currentG = 0;
    this.peakG = 0;
    this.peakAx = 0;
    this.peakAy = 0;
    this._gravityEstimate = null;
    this._listener = (event) => this._onMotion(event);
    window.addEventListener('devicemotion', this._listener);
  }

  stop() {
    if (this._listener) {
      window.removeEventListener('devicemotion', this._listener);
      this._listener = null;
    }
    return { peakG: this.peakG };
  }

  onUpdate(callback) {
    this._updateListeners.push(callback);
  }

  _onMotion(event) {
    let ax;
    let ay;
    let az;

    if (event.acceleration && event.acceleration.x !== null && event.acceleration.x !== undefined) {
      // Some devices already report gravity-excluded acceleration directly — use it as-is.
      ax = event.acceleration.x || 0;
      ay = event.acceleration.y || 0;
      az = event.acceleration.z || 0;
    } else if (event.accelerationIncludingGravity) {
      // Otherwise estimate gravity as a slow-moving average of the raw signal and subtract it
      // out — a standard low-pass-filter trick for isolating the non-gravity component when
      // the device doesn't do it for us.
      const raw = event.accelerationIncludingGravity;
      if (!this._gravityEstimate) {
        this._gravityEstimate = { x: raw.x || 0, y: raw.y || 0, z: raw.z || 0 };
      } else {
        const a = GRAVITY_LOW_PASS_ALPHA;
        this._gravityEstimate.x = a * this._gravityEstimate.x + (1 - a) * (raw.x || 0);
        this._gravityEstimate.y = a * this._gravityEstimate.y + (1 - a) * (raw.y || 0);
        this._gravityEstimate.z = a * this._gravityEstimate.z + (1 - a) * (raw.z || 0);
      }
      ax = (raw.x || 0) - this._gravityEstimate.x;
      ay = (raw.y || 0) - this._gravityEstimate.y;
      az = (raw.z || 0) - this._gravityEstimate.z;
    } else {
      return;
    }

    const magnitudeG = Math.sqrt(ax * ax + ay * ay + az * az) / GRAVITY_MS2;
    this.currentG = magnitudeG;
    if (magnitudeG > this.peakG) {
      this.peakG = magnitudeG;
      // Track the horizontal (x/y) position of the peak reading too, purely for the meter's
      // trailing "high water mark" dot — not otherwise used.
      this.peakAx = ax / GRAVITY_MS2;
      this.peakAy = ay / GRAVITY_MS2;
    }

    for (const listener of this._updateListeners) {
      try {
        listener({
          currentG: this.currentG,
          peakG: this.peakG,
          ax: ax / GRAVITY_MS2,
          ay: ay / GRAVITY_MS2,
          peakAx: this.peakAx,
          peakAy: this.peakAy,
        });
      } catch {
        // Never let a listener error break the tracking loop.
      }
    }
  }
}
