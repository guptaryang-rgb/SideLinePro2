// trip.js — Overtaker trip tracking module.
// ES module. Runs entirely client-side using the Geolocation API and
// IndexedDB (with a localStorage fallback). No external dependencies.

const EARTH_RADIUS_KM = 6371;
const MAX_ACCEPTABLE_ACCURACY_M = 100;
const MAX_PLAUSIBLE_SPEED_KMH = 250;

/**
 * Great-circle distance between two lat/lng points, in kilometers.
 */
function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export class TripTracker {
  constructor() {
    this.watchId = null;
    this.startedAt = null;
    this.lastSample = null; // last accepted {lat, lng, t}
    this.distanceKm = 0;
    this.topSpeedKmh = 0;
    this.route = []; // array of {lat, lng, t}
    this._lastInstantSpeedKmh = 0;
    this._listeners = [];
    this._errorListeners = [];
  }

  start() {
    // Reset all running stats.
    this.watchId = null;
    this.startedAt = Date.now();
    this.lastSample = null;
    this.distanceKm = 0;
    this.topSpeedKmh = 0;
    this.route = [];
    this._lastInstantSpeedKmh = 0;

    if (
      typeof navigator === 'undefined' ||
      !navigator.geolocation ||
      typeof navigator.geolocation.watchPosition !== 'function'
    ) {
      this._notifyError('unsupported');
      return;
    }

    try {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this._onPosition(pos),
        (err) => this._onPositionError(err),
        // A cold GPS fix in a moving car can genuinely take longer than a few seconds;
        // 10s was timing out (and silently going nowhere) before a fix was ever acquired.
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
      );
    } catch {
      this.watchId = null;
      this._notifyError('unsupported');
    }
  }

  stop() {
    if (
      this.watchId !== null &&
      typeof navigator !== 'undefined' &&
      navigator.geolocation &&
      typeof navigator.geolocation.clearWatch === 'function'
    ) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;

    const startedAt = this.startedAt;
    const endedAt = Date.now();
    const durationSec = startedAt ? (endedAt - startedAt) / 1000 : 0;
    const avgSpeedKmh =
      durationSec > 0 ? this.distanceKm / (durationSec / 3600) : 0;

    return {
      startedAt,
      endedAt,
      durationSec,
      distanceKm: this.distanceKm,
      avgSpeedKmh,
      topSpeedKmh: this.topSpeedKmh,
      route: this.route,
    };
  }

  getLiveStats() {
    const durationSec = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      speedKmh: this._lastInstantSpeedKmh,
      distanceKm: this.distanceKm,
      durationSec,
    };
  }

  onError(callback) {
    this._errorListeners.push(callback);
  }

  _onPositionError(err) {
    const code = err && err.code;
    let reason = 'unknown';
    if (code === 1) reason = 'permission_denied';
    else if (code === 2) reason = 'position_unavailable';
    else if (code === 3) reason = 'timeout';
    this._notifyError(reason);
  }

  _notifyError(reason) {
    for (const listener of this._errorListeners) {
      try {
        listener(reason);
      } catch {
        // Never let a listener error break the tracking loop.
      }
    }
  }

  onUpdate(callback) {
    this._listeners.push(callback);
  }

  _onPosition(pos) {
    const { latitude, longitude, accuracy, speed } = pos.coords;
    const hasDeviceSpeed = typeof speed === 'number' && isFinite(speed) && speed >= 0;

    // Device-reported speed comes from the GPS chip's Doppler measurement, which stays
    // meaningful even when the position fix itself is coarse — so it isn't gated behind the
    // accuracy check below (real driving accuracy routinely exceeds a strict threshold, and
    // gating this too tightly meant live speed just never updated on real drives).
    if (hasDeviceSpeed) {
      const deviceSpeedKmh = speed * 3.6;
      if (deviceSpeedKmh <= MAX_PLAUSIBLE_SPEED_KMH) {
        this._lastInstantSpeedKmh = deviceSpeedKmh;
        this.topSpeedKmh = Math.max(this.topSpeedKmh, deviceSpeedKmh);
      }
    }

    const accuracyOk = typeof accuracy !== 'number' || accuracy <= MAX_ACCEPTABLE_ACCURACY_M;
    if (accuracyOk) {
      const point = { lat: latitude, lng: longitude, t: Date.now() };
      this.route.push(point);

      if (this.lastSample) {
        const deltaKm = haversine(
          this.lastSample.lat,
          this.lastSample.lng,
          point.lat,
          point.lng
        );
        const deltaHours = (point.t - this.lastSample.t) / 3600000;
        const derivedSpeedKmh = deltaHours > 0 ? deltaKm / deltaHours : 0;

        if (derivedSpeedKmh <= MAX_PLAUSIBLE_SPEED_KMH) {
          this.distanceKm += deltaKm;
          // Only fall back to the derived speed when the device didn't already give us one.
          if (!hasDeviceSpeed) {
            this._lastInstantSpeedKmh = derivedSpeedKmh;
            this.topSpeedKmh = Math.max(this.topSpeedKmh, derivedSpeedKmh);
          }
        }
        // else: unrealistic implied speed (GPS jitter) — discard this sample's distance
        // contribution, but still update lastSample & route below.
      }

      this.lastSample = point;
    }

    // Always notify listeners so live speed/timer keep updating through a run of low-accuracy
    // fixes — only distance/route accumulation (above) is gated on position accuracy.
    const liveStats = this.getLiveStats();
    for (const listener of this._listeners) {
      try {
        listener(liveStats);
      } catch {
        // Never let a listener error break the tracking loop.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence layer: IndexedDB with a localStorage fallback, exposed behind
// the same TripHistory API regardless of which backend is active.
// ---------------------------------------------------------------------------

const DB_NAME = 'overtaker-db';
const DB_VERSION = 1;
const STORE_NAME = 'trips';
const LOCALSTORAGE_KEY = 'overtaker_trips_fallback';

const HAS_INDEXEDDB = typeof indexedDB !== 'undefined';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbSaveTrip(tripRecord) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(tripRecord);
        tx.oncomplete = () => resolve(tripRecord);
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbGetAllTrips() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      })
  );
}

function idbDeleteTrip(id) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function readLocalStorageTrips() {
  try {
    const raw = localStorage.getItem(LOCALSTORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalStorageTrips(trips) {
  localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(trips));
}

function lsSaveTrip(tripRecord) {
  const trips = readLocalStorageTrips();
  const idx = trips.findIndex((t) => t.id === tripRecord.id);
  if (idx >= 0) {
    trips[idx] = tripRecord;
  } else {
    trips.push(tripRecord);
  }
  writeLocalStorageTrips(trips);
  return Promise.resolve(tripRecord);
}

function lsGetAllTrips() {
  return Promise.resolve(readLocalStorageTrips());
}

function lsDeleteTrip(id) {
  const trips = readLocalStorageTrips().filter((t) => t.id !== id);
  writeLocalStorageTrips(trips);
  return Promise.resolve();
}

export const TripHistory = {
  async saveTrip(tripRecord) {
    tripRecord.id = String(tripRecord.startedAt);
    if (HAS_INDEXEDDB) {
      return idbSaveTrip(tripRecord);
    }
    return lsSaveTrip(tripRecord);
  },

  async getAllTrips() {
    const trips = HAS_INDEXEDDB ? await idbGetAllTrips() : await lsGetAllTrips();
    return trips.slice().sort((a, b) => b.startedAt - a.startedAt);
  },

  async deleteTrip(id) {
    if (HAS_INDEXEDDB) {
      return idbDeleteTrip(id);
    }
    return lsDeleteTrip(id);
  },

  async getAggregateStats() {
    const trips = HAS_INDEXEDDB ? await idbGetAllTrips() : await lsGetAllTrips();

    let totalDistanceKm = 0;
    let totalOvertakesByMe = 0;
    let totalOvertakesOfMe = 0;
    let bestTopSpeedKmh = 0;

    for (const trip of trips) {
      totalDistanceKm += trip.distanceKm || 0;
      totalOvertakesByMe += trip.overtakesByMe || 0;
      totalOvertakesOfMe += trip.overtakesOfMe || 0;
      bestTopSpeedKmh = Math.max(bestTopSpeedKmh, trip.topSpeedKmh || 0);
    }

    return {
      totalTrips: trips.length,
      totalDistanceKm,
      totalOvertakesByMe,
      totalOvertakesOfMe,
      bestTopSpeedKmh,
      netScore: totalOvertakesByMe - totalOvertakesOfMe,
    };
  },
};
