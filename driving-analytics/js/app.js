// app.js — Overtaker controller. Wires the UI to CarTracker (detection.js)
// and TripTracker / TripHistory (trip.js). Modern ES module, no globals on window.

import { CarTracker } from './detection.js';
import { TripTracker, TripHistory } from './trip.js';
import { MotionTracker } from './motion.js';

const ONBOARDING_KEY = 'overtaker_onboarded';
const DETECTION_INTERVAL_MS = 200;
// Must match the 270deg-arc stroke-dasharray/circumference set in styles.css for #speed-gauge-fill.
const SPEED_GAUGE_ARC_LENGTH = 282.7;
const SPEED_GAUGE_MAX_MPH = 120;
// How many g's map to the meter dot sitting right at the ring's edge.
const G_METER_MAX_G = 0.8;
const G_METER_RADIUS_PX = 34;

// TripTracker/TripHistory work entirely in km & km/h internally (Haversine distance is
// naturally metric) — conversion to the displayed unit happens only here, at render time.
const KM_TO_MI = 0.621371;
const kmToMi = (km) => (km || 0) * KM_TO_MI;
const kmhToMph = (kmh) => (kmh || 0) * KM_TO_MI;
const mpsToMph = (mps) => (mps || 0) * 2.23694;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const els = {
  onboardingOverlay: document.getElementById('onboarding-overlay'),
  onboardingContinueBtn: document.getElementById('onboarding-continue-btn'),

  viewDashboard: document.getElementById('view-dashboard'),
  viewTripDetail: document.getElementById('view-trip-detail'),
  tripDetailBackBtn: document.getElementById('trip-detail-back-btn'),
  tripDetailDate: document.getElementById('trip-detail-date'),
  tripDetailStats: document.getElementById('trip-detail-stats'),
  routeMapContainer: document.getElementById('route-map'),
  startDriveBtn: document.getElementById('start-drive-btn'),
  statTotalTrips: document.getElementById('stat-total-trips'),
  statTotalDistance: document.getElementById('stat-total-distance'),
  statNetScore: document.getElementById('stat-net-score'),
  statBestSpeed: document.getElementById('stat-best-speed'),
  tripHistoryList: document.getElementById('trip-history-list'),
  tripHistoryCount: document.getElementById('trip-history-count'),

  viewDrive: document.getElementById('view-drive'),
  cameraVideo: document.getElementById('camera-video'),
  overlayCanvas: document.getElementById('overlay-canvas'),
  liveSpeed: document.getElementById('live-speed'),
  liveTimer: document.getElementById('live-timer'),
  speedGaugeFill: document.getElementById('speed-gauge-fill'),
  countOvertook: document.getElementById('count-overtook'),
  countOvertaken: document.getElementById('count-overtaken'),
  countOvertookPill: document.getElementById('count-overtook-pill'),
  countOvertakenPill: document.getElementById('count-overtaken-pill'),
  toastContainer: document.getElementById('event-toast-container'),
  modelLoadingBadge: document.getElementById('model-loading-badge'),
  gpsStatusBadge: document.getElementById('gps-status-badge'),
  gpsStatusText: document.getElementById('gps-status-text'),
  gpsPermissionHelp: document.getElementById('gps-permission-help'),
  gpsPermissionSteps: document.getElementById('gps-permission-steps'),
  gpsRetryBtn: document.getElementById('gps-retry-btn'),
  gpsDismissBtn: document.getElementById('gps-dismiss-btn'),
  lensSwitcher: document.getElementById('lens-switcher'),
  gMeter: document.getElementById('g-meter'),
  gMeterDot: document.getElementById('g-meter-dot'),
  gMeterPeakDot: document.getElementById('g-meter-peak-dot'),
  gMeterPeakValue: document.getElementById('g-meter-peak-value'),
  driveError: document.getElementById('drive-error'),
  driveErrorMessage: document.getElementById('drive-error-message'),
  driveErrorBackBtn: document.getElementById('drive-error-back-btn'),
  endDriveBtn: document.getElementById('end-drive-btn'),

  summaryModal: document.getElementById('summary-modal'),
  summaryDistance: document.getElementById('summary-distance'),
  summaryDuration: document.getElementById('summary-duration'),
  summaryAvgSpeed: document.getElementById('summary-avg-speed'),
  summaryTopSpeed: document.getElementById('summary-top-speed'),
  summaryOvertook: document.getElementById('summary-overtook'),
  summaryOvertaken: document.getElementById('summary-overtaken'),
  summaryNetMessage: document.getElementById('summary-net-message'),
  summarySaveBtn: document.getElementById('summary-save-btn'),
  summaryPeakGCard: document.getElementById('summary-peak-g-card'),
  summaryPeakG: document.getElementById('summary-peak-g'),
};

// ---------------------------------------------------------------------------
// Module-scoped state (no globals on window)
// ---------------------------------------------------------------------------

const state = {
  carTracker: null,
  tripTracker: null,
  mediaStream: null,
  detectionTimer: null,
  rafId: null,
  latestTracks: [],
  overtakesByMe: 0,
  overtakesOfMe: 0,
  driveStartedAt: null,
  liveDurationSec: 0,
  liveTopSpeedKmh: 0,
  lastSummary: null,
  timerIntervalId: null,
  resizeObserver: null,
  gpsFixAcquired: false,
  activeLensDeviceId: null,
  lensByDeviceId: null,
  motionTracker: null,
  lastPeakG: 0,
  currentSpeedKmh: 0,
  driveEvents: [],
  routeMap: null,
  routeMapLayerGroup: null,
};

const GPS_ERROR_MESSAGES = {
  permission_denied: 'Location permission denied — enable it in Settings to track speed & distance.',
  position_unavailable: 'GPS signal unavailable — move somewhere with a clearer sky view.',
  timeout: 'Still waiting for a GPS fix…',
  unsupported: "This browser doesn't support location tracking.",
  unknown: 'Waiting for GPS…',
};

// No website can silently re-grant a permission the user (or OS) has already denied — that's
// a hard browser security boundary. The best we can do is walk them to the exact right screen.
function detectGpsPermissionSteps() {
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIos && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome/.test(ua) && !/Edg|OPR/.test(ua);

  if (isIos && isSafari) {
    return [
      'Tap the "AA" icon at the left of the address bar',
      'Tap "Website Settings"',
      'Set Location to "Allow"',
      'Reload this page',
      "If there's no Location option there, check Settings app → Privacy & Security → Location Services → Safari Websites → \"While Using the App\"",
    ];
  }
  if (isAndroid && isChrome) {
    return [
      'Tap the lock or info icon (🔒 / ⓘ) in the address bar',
      'Tap "Permissions" → "Location"',
      'Set it to "Allow"',
      'Reload this page',
    ];
  }
  return [
    "Open your browser's site settings for this page",
    'Find "Location" and set it to "Allow"',
    'Reload this page',
  ];
}

function showGpsPermissionHelp() {
  els.gpsStatusBadge.classList.add('hidden');
  els.gpsPermissionSteps.innerHTML = '';
  for (const step of detectGpsPermissionSteps()) {
    const li = document.createElement('li');
    li.textContent = step;
    els.gpsPermissionSteps.appendChild(li);
  }
  els.gpsPermissionHelp.classList.remove('hidden');
}

function hideGpsPermissionHelp() {
  els.gpsPermissionHelp.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatDurationLong(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function round1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function updateSpeedGauge(speedMph) {
  const fraction = Math.max(0, Math.min(1, (speedMph || 0) / SPEED_GAUGE_MAX_MPH));
  els.speedGaugeFill.style.strokeDashoffset = String(SPEED_GAUGE_ARC_LENGTH * (1 - fraction));
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function initOnboarding() {
  const alreadyOnboarded = localStorage.getItem(ONBOARDING_KEY) === '1';
  if (alreadyOnboarded) {
    els.onboardingOverlay.classList.add('hidden');
  } else {
    els.onboardingOverlay.classList.remove('hidden');
  }

  els.onboardingContinueBtn.addEventListener('click', () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      // Ignore storage failures (e.g. private browsing) — just proceed.
    }
    els.onboardingOverlay.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

async function renderDashboard() {
  const [aggregate, trips] = await Promise.all([
    TripHistory.getAggregateStats(),
    TripHistory.getAllTrips(),
  ]);

  els.statTotalTrips.textContent = String(aggregate.totalTrips);
  els.statTotalDistance.innerHTML = `${round1(kmToMi(aggregate.totalDistanceKm))}<span class="stat-unit">mi</span>`;
  els.statNetScore.textContent =
    aggregate.netScore > 0 ? `+${aggregate.netScore}` : String(aggregate.netScore);
  els.statBestSpeed.innerHTML = `${Math.round(kmhToMph(aggregate.bestTopSpeedKmh))}<span class="stat-unit">mph</span>`;

  els.tripHistoryCount.textContent = trips.length ? `${trips.length} drive${trips.length === 1 ? '' : 's'}` : '';

  els.tripHistoryList.innerHTML = '';

  if (trips.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No drives yet — start one to build your history.';
    els.tripHistoryList.appendChild(empty);
    return;
  }

  for (const trip of trips) {
    els.tripHistoryList.appendChild(buildTripCard(trip));
  }
}

function buildTripCard(trip) {
  const net = (trip.overtakesByMe || 0) - (trip.overtakesOfMe || 0);
  const netClass = net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
  const netLabel = net > 0 ? `+${net}` : String(net);

  const card = document.createElement('div');
  card.className = 'trip-card';
  card.innerHTML = `
    <div class="trip-card-top">
      <div class="trip-card-date">${formatDate(trip.startedAt)}</div>
      <div class="trip-card-net ${netClass}">${netLabel} net</div>
    </div>
    <div class="trip-card-stats">
      <div><div class="val">${round1(kmToMi(trip.distanceKm || 0))}</div><div class="lbl">mi</div></div>
      <div><div class="val">${formatDurationLong(trip.durationSec || 0)}</div><div class="lbl">duration</div></div>
      <div><div class="val">${Math.round(kmhToMph(trip.avgSpeedKmh || 0))}</div><div class="lbl">avg mph</div></div>
      <div><div class="val">${Math.round(kmhToMph(trip.topSpeedKmh || 0))}</div><div class="lbl">top mph</div></div>
      ${typeof trip.peakG === 'number' ? `<div><div class="val">${trip.peakG.toFixed(1)}</div><div class="lbl">peak g</div></div>` : ''}
    </div>
    <button class="trip-card-delete" type="button">Delete trip</button>
  `;

  const deleteBtn = card.querySelector('.trip-card-delete');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't also trigger the card's own click-through-to-detail handler
    try {
      await TripHistory.deleteTrip(trip.id);
    } catch (err) {
      console.error('Failed to delete trip', err);
    }
    renderDashboard();
  });

  card.addEventListener('click', () => showTripDetail(trip));

  return card;
}

// ---------------------------------------------------------------------------
// Trip detail / route replay
// ---------------------------------------------------------------------------

function showTripDetail(trip) {
  showView('trip-detail');
  els.tripDetailDate.textContent = formatDate(trip.startedAt);

  els.tripDetailStats.innerHTML = `
    <div class="stat-card"><div class="stat-label">Distance</div><div class="stat-value">${round1(kmToMi(trip.distanceKm || 0))}<span class="stat-unit">mi</span></div></div>
    <div class="stat-card"><div class="stat-label">Duration</div><div class="stat-value">${formatDurationLong(trip.durationSec || 0)}</div></div>
    <div class="stat-card"><div class="stat-label">Avg speed</div><div class="stat-value">${Math.round(kmhToMph(trip.avgSpeedKmh || 0))}<span class="stat-unit">mph</span></div></div>
    <div class="stat-card"><div class="stat-label">Top speed</div><div class="stat-value">${Math.round(kmhToMph(trip.topSpeedKmh || 0))}<span class="stat-unit">mph</span></div></div>
  `;

  initRouteMapIfNeeded();
  renderRouteOnMap(trip);
  // The map container was hidden (display:none) until showView() ran above, and Leaflet sizes
  // its tile grid from the container's dimensions at the moment it's told to — a map created or
  // updated while still hidden ends up with a wrong/zero size and renders blank or torn until
  // manually nudged. Deferred one tick so the browser has actually applied the layout change.
  setTimeout(() => state.routeMap && state.routeMap.invalidateSize(), 0);
}

// Real map tiles (free CARTO "Dark Matter" basemap — no API key required) rather than a hand-
// drawn sketch, so the route is recognizable against actual streets. One Leaflet map instance
// is created lazily and reused across trips (Leaflet errors if you re-initialize a map on the
// same container twice); a dedicated layer group is cleared and rebuilt for each trip viewed.
function initRouteMapIfNeeded() {
  if (state.routeMap || typeof L === 'undefined') return;
  state.routeMap = L.map(els.routeMapContainer, {
    zoomControl: true,
    attributionControl: true,
  }).setView([0, 0], 2);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(state.routeMap);

  state.routeMapLayerGroup = L.layerGroup().addTo(state.routeMap);
}

function renderRouteOnMap(trip) {
  const map = state.routeMap;
  if (!map) {
    // Leaflet didn't load (offline, blocked CDN, etc.) — fail visibly but gracefully rather
    // than throwing on the undefined global, same pattern as every other optional feature here.
    els.routeMapContainer.textContent = 'Map unavailable — check your connection and reload.';
    return;
  }
  const layerGroup = state.routeMapLayerGroup;
  layerGroup.clearLayers();

  const route = trip.route;
  if (!route || route.length < 2) {
    map.setView([0, 0], 2);
    return;
  }

  const latLngs = route.map((p) => [p.lat, p.lng]);
  L.polyline(latLngs, { color: '#00d9ff', weight: 4, opacity: 0.9, lineJoin: 'round' }).addTo(layerGroup);

  const marker = (lat, lng, color, radius) =>
    L.circleMarker([lat, lng], {
      radius,
      color: 'rgba(5, 7, 11, 0.6)',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(layerGroup);

  marker(route[0].lat, route[0].lng, '#39ff9d', 7);
  marker(route[route.length - 1].lat, route[route.length - 1].lng, '#8b93a7', 7);

  for (const ev of trip.events || []) {
    if (typeof ev.lat !== 'number' || typeof ev.lng !== 'number') continue;
    marker(ev.lat, ev.lng, ev.type === 'overtook' ? '#4ade80' : '#ff5470', 6);
  }

  map.fitBounds(L.latLngBounds(latLngs), { padding: [24, 24] });
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(view) {
  els.viewDashboard.classList.toggle('hidden', view !== 'dashboard');
  els.viewDrive.classList.toggle('hidden', view !== 'drive');
  els.viewTripDetail.classList.toggle('hidden', view !== 'trip-detail');
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_COPY = {
  overtook: ['You overtook a car! 🎉', 'Cleared another one! 🚀', 'Smooth pass! 🏎️'],
  overtaken: ['A car overtook you 💨', 'Someone just blew by 😅', 'Getting passed happens 💨'],
};

function showToast(type, detail) {
  const messages = TOAST_COPY[type] || [];
  const message = messages[Math.floor(Math.random() * messages.length)] || '';

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = detail ? `${message} (${detail})` : message;
  els.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function pulsePill(pillEl) {
  pillEl.classList.remove('pulse');
  // Force reflow so the animation can restart on rapid repeated events.
  void pillEl.offsetWidth;
  pillEl.classList.add('pulse');
}

// ---------------------------------------------------------------------------
// Drive lifecycle
// ---------------------------------------------------------------------------

async function startDrive() {
  showView('drive');
  els.driveError.classList.add('hidden');
  els.overlayCanvas.getContext('2d').clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);

  state.overtakesByMe = 0;
  state.overtakesOfMe = 0;
  state.latestTracks = [];
  state.liveTopSpeedKmh = 0;
  state.driveEvents = [];
  els.countOvertook.textContent = '0';
  els.countOvertaken.textContent = '0';
  els.liveSpeed.textContent = '0';
  els.liveTimer.textContent = '00:00';
  updateSpeedGauge(0);
  resetGMeter();

  // Requested first and not awaited-around before other permission prompts: iOS only grants
  // this from a call made directly inside the click that's still active right now, and
  // getUserMedia below can itself take a moment in a way that risks losing that window.
  const motionPermissionPromise = MotionTracker.isSupported()
    ? MotionTracker.requestPermission()
    : Promise.resolve(false);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    console.error('getUserMedia failed', err);
    showDriveError(
      err && err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in your browser settings and try again.'
        : "We couldn't access your camera. Make sure it isn't in use by another app and try again."
    );
    return;
  }

  state.mediaStream = stream;
  els.cameraVideo.srcObject = stream;

  try {
    await els.cameraVideo.play();
  } catch {
    // Autoplay can reject on some browsers until a user gesture; the click
    // that triggered startDrive() already counts as one, so this is rare.
  }

  resizeCanvasToVideo();
  window.addEventListener('resize', resizeCanvasToVideo);
  state.resizeObserver = new ResizeObserver(() => resizeCanvasToVideo());
  state.resizeObserver.observe(els.viewDrive);

  setupLensSwitcher(stream).catch(() => {
    // No lens data (e.g. Android usually exposes only one back camera) — leave the
    // switcher hidden, not an error worth surfacing.
  });

  // Vision model loads in the background — the drive/GPS side starts immediately.
  els.modelLoadingBadge.classList.remove('hidden');
  state.carTracker = new CarTracker();
  state.carTracker
    .load()
    .then(() => {
      els.modelLoadingBadge.classList.add('hidden');
      startDetectionLoop();
    })
    .catch((err) => {
      console.error('Vision model failed to load', err);
      els.modelLoadingBadge.classList.add('hidden');
    });

  state.gpsFixAcquired = false;
  els.gpsStatusText.textContent = GPS_ERROR_MESSAGES.unknown;
  els.gpsStatusBadge.classList.remove('hidden');

  state.tripTracker = new TripTracker();
  state.tripTracker.onUpdate((liveStats) => {
    if (!state.gpsFixAcquired) {
      state.gpsFixAcquired = true;
      els.gpsStatusBadge.classList.add('hidden');
      hideGpsPermissionHelp();
    }
    const speedMph = kmhToMph(liveStats.speedKmh);
    els.liveSpeed.textContent = String(Math.round(speedMph));
    updateSpeedGauge(speedMph);
    // Stays in km/h internally to match summary.topSpeedKmh from TripTracker.stop(), which
    // this gets merged with in presentSummary() — converted to mph only at render time there.
    state.liveTopSpeedKmh = Math.max(state.liveTopSpeedKmh, liveStats.speedKmh || 0);
    state.currentSpeedKmh = liveStats.speedKmh || 0;
  });
  state.tripTracker.onError((reason) => {
    if (state.gpsFixAcquired) return; // already getting fixes — a stray error isn't worth interrupting the UI for
    if (reason === 'permission_denied') {
      showGpsPermissionHelp();
      return;
    }
    els.gpsStatusText.textContent = GPS_ERROR_MESSAGES[reason] || GPS_ERROR_MESSAGES.unknown;
    els.gpsStatusBadge.classList.remove('hidden');
  });
  state.tripTracker.start();
  state.driveStartedAt = Date.now();

  state.timerIntervalId = setInterval(() => {
    const elapsed = (Date.now() - state.driveStartedAt) / 1000;
    els.liveTimer.textContent = formatDuration(elapsed);
  }, 1000);

  motionPermissionPromise.then((granted) => {
    if (!granted) return; // denied, unsupported, or this browser has no permission concept and just works — either way nothing to show if it's not granted
    state.motionTracker = new MotionTracker();
    state.motionTracker.onUpdate((motionStats) => updateGMeter(motionStats));
    state.motionTracker.start();
    els.gMeter.classList.remove('hidden');
  });

  startDrawLoop();
}

function resetGMeter() {
  state.lastPeakG = 0;
  els.gMeterDot.style.transform = 'translate(-50%, -50%)';
  els.gMeterPeakDot.style.transform = 'translate(-50%, -50%)';
  els.gMeterPeakValue.textContent = '0.0';
  els.gMeter.classList.add('hidden');
}

function gOffsetPx(value) {
  const clamped = Math.max(-G_METER_MAX_G, Math.min(G_METER_MAX_G, value || 0));
  return (clamped / G_METER_MAX_G) * G_METER_RADIUS_PX;
}

function updateGMeter(motionStats) {
  // Screen x maps to the device's x-axis; y is inverted since a forward pitch (device y-axis)
  // should read as a downward dot movement on screen, matching how these meters conventionally
  // read (visually "forward" force pushes the dot toward the bottom of the display).
  const dotX = gOffsetPx(motionStats.ax);
  const dotY = gOffsetPx(-motionStats.ay);
  els.gMeterDot.style.transform = `translate(calc(-50% + ${dotX}px), calc(-50% + ${dotY}px))`;

  state.lastPeakG = motionStats.peakG;
  const peakX = gOffsetPx(motionStats.peakAx);
  const peakY = gOffsetPx(-motionStats.peakAy);
  els.gMeterPeakDot.style.transform = `translate(calc(-50% + ${peakX}px), calc(-50% + ${peakY}px))`;
  els.gMeterPeakValue.textContent = motionStats.peakG.toFixed(1);
}

function resizeCanvasToVideo() {
  const rect = els.viewDrive.getBoundingClientRect();
  els.overlayCanvas.width = rect.width;
  els.overlayCanvas.height = rect.height;
}

// iOS Safari (16.4+) exposes each physical rear lens as its own labeled device — this lets
// the driver pick the ultra-wide ("0.5x") lens to see more of the road at once. Most Android
// browsers only expose one combined back camera, in which case this quietly does nothing.
async function setupLensSwitcher(currentStream) {
  els.lensSwitcher.innerHTML = '';
  els.lensSwitcher.classList.add('hidden');

  if (!navigator.mediaDevices.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();

  const backCameras = devices.filter(
    (d) => d.kind === 'videoinput' && /back|rear|environment/i.test(d.label)
  );
  if (backCameras.length < 2) return;

  const classify = (label) => {
    if (/ultra.?wide/i.test(label)) return { order: 0, zoomLabel: '0.5x' };
    if (/tele/i.test(label)) return { order: 2, zoomLabel: '2x' };
    return { order: 1, zoomLabel: '1x' };
  };

  const currentDeviceId = currentStream.getVideoTracks()[0]?.getSettings().deviceId || null;
  state.activeLensDeviceId = currentDeviceId;

  const lenses = backCameras
    .map((d) => ({ deviceId: d.deviceId, ...classify(d.label) }))
    .sort((a, b) => a.order - b.order);
  state.lensByDeviceId = new Map(lenses.map((lens) => [lens.deviceId, lens]));

  for (const lens of lenses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lens-btn' + (lens.deviceId === currentDeviceId ? ' active' : '');
    btn.textContent = lens.zoomLabel;
    btn.dataset.deviceId = lens.deviceId;
    btn.addEventListener('click', () => switchLens(lens.deviceId));
    els.lensSwitcher.appendChild(btn);
  }

  els.lensSwitcher.classList.remove('hidden');
  applyTileCountForLens(currentDeviceId);
}

// Ultra-wide phone lenses are typically ~100-120° horizontal FOV vs ~65-70° for the main lens —
// this feeds the tracker's pixel-width-to-distance estimate, which is FOV-dependent.
const ULTRA_WIDE_HFOV_DEG = 102;
const MAIN_LENS_HFOV_DEG = 68;
// Tiled detection (used on the ultra-wide lens) runs the model twice per tick instead of once,
// lowering the effective detection rate — widen the tracker's frame-to-frame matching tolerance
// to compensate, or a fast-moving car can outrun it and fragment into several lost tracks.
const ULTRA_WIDE_MATCH_DISTANCE_RATIO = 0.28;
const MAIN_LENS_MATCH_DISTANCE_RATIO = 0.15;

function applyTileCountForLens(deviceId) {
  const lens = state.lensByDeviceId?.get(deviceId);
  const isUltraWide = lens?.order === 0;
  state.carTracker?.setTileCount(isUltraWide ? 2 : 1);
  state.carTracker?.setHorizontalFovDeg(isUltraWide ? ULTRA_WIDE_HFOV_DEG : MAIN_LENS_HFOV_DEG);
  state.carTracker?.setMatchDistanceRatio(isUltraWide ? ULTRA_WIDE_MATCH_DISTANCE_RATIO : MAIN_LENS_MATCH_DISTANCE_RATIO);
}

async function switchLens(deviceId) {
  if (deviceId === state.activeLensDeviceId) return;

  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    console.error('Failed to switch camera lens', err);
    return;
  }

  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) track.stop();
  }
  state.mediaStream = newStream;
  els.cameraVideo.srcObject = newStream;
  state.activeLensDeviceId = deviceId;
  applyTileCountForLens(deviceId);

  for (const btn of els.lensSwitcher.children) {
    btn.classList.toggle('active', btn.dataset.deviceId === deviceId);
  }
}

function showDriveError(message) {
  els.driveErrorMessage.textContent = message;
  els.driveError.classList.remove('hidden');
}

function startDetectionLoop() {
  if (state.detectionTimer) return;
  // Guards against overlapping ticks: 'mobilenet_v2' inference can take longer than the poll
  // interval on some phones, and firing detect()/update() again before the previous call
  // finishes would race on the tracker's shared state.
  let detectionInFlight = false;
  state.detectionTimer = setInterval(async () => {
    if (detectionInFlight) return;
    if (!state.carTracker || !state.carTracker.ready) return;
    const video = els.cameraVideo;
    if (!video.videoWidth || !video.videoHeight) return;

    detectionInFlight = true;
    try {
      const detections = await state.carTracker.detectVehicles(video);
      const ourSpeedMps = state.currentSpeedKmh / 3.6;
      const { tracks, events } = state.carTracker.update(detections, video.videoWidth, video.videoHeight, ourSpeedMps);
      state.latestTracks = tracks;

      for (const event of events) {
        handleOvertakeEvent(event);
      }
    } catch (err) {
      console.error('Detection tick failed', err);
    } finally {
      detectionInFlight = false;
    }
  }, DETECTION_INTERVAL_MS);
}

// Estimated from an assumed vehicle width + camera FOV, not a calibrated measurement — sanity-
// bound before ever showing it, so a noisy track can't surface an absurd "1200 mph" toast.
function estimatedSpeedLabel(theirSpeedMps) {
  if (typeof theirSpeedMps !== 'number') return null;
  const mph = mpsToMph(theirSpeedMps);
  if (!(mph >= 0 && mph <= 150)) return null;
  return `~${Math.round(mph)} mph`;
}

function handleOvertakeEvent(event) {
  const speedLabel = estimatedSpeedLabel(event.theirSpeedMps);
  state.driveEvents.push({ type: event.type, timestamp: event.timestamp });
  if (event.type === 'overtook') {
    state.overtakesByMe += 1;
    els.countOvertook.textContent = String(state.overtakesByMe);
    pulsePill(els.countOvertookPill);
    showToast('overtook', speedLabel);
  } else if (event.type === 'overtaken') {
    state.overtakesOfMe += 1;
    els.countOvertaken.textContent = String(state.overtakesOfMe);
    pulsePill(els.countOvertakenPill);
    showToast('overtaken', speedLabel);
  }
}

// Manual implementation instead of the native ctx.roundRect() — that's only supported on
// fairly recent browsers, and this canvas has to work across whatever phone is testing it.
function tracePath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Draws HUD-style targeting brackets (like a camera autofocus reticle) at each corner of a
// box instead of a plain rectangle — reads as a live tracking system, not a debug outline.
function drawHudBox(ctx, x, y, w, h, label) {
  const cornerLen = Math.max(10, Math.min(w, h) * 0.28);

  ctx.beginPath();
  ctx.moveTo(x, y + cornerLen);
  ctx.lineTo(x, y);
  ctx.lineTo(x + cornerLen, y);

  ctx.moveTo(x + w - cornerLen, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + cornerLen);

  ctx.moveTo(x + w, y + h - cornerLen);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - cornerLen, y + h);

  ctx.moveTo(x + cornerLen, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h - cornerLen);
  ctx.stroke();

  const text = label || 'vehicle';
  ctx.font = '600 11px "Rajdhani", sans-serif';
  const textWidth = ctx.measureText(text).width;
  const chipW = textWidth + 14;
  const chipH = 18;
  const chipX = x;
  const chipY = y - chipH - 4 < 0 ? y + h + 4 : y - chipH - 4;

  ctx.fillStyle = 'rgba(0, 217, 255, 0.16)';
  tracePath(ctx, chipX, chipY, chipW, chipH, 5);
  ctx.fill();

  ctx.fillStyle = '#c9f7ff';
  ctx.fillText(text, chipX + 7, chipY + 13);
}

function startDrawLoop() {
  const ctx = els.overlayCanvas.getContext('2d');

  const draw = () => {
    const canvas = els.overlayCanvas;
    const video = els.cameraVideo;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (video.videoWidth && video.videoHeight && state.latestTracks.length) {
      // #camera-video is styled with object-fit: cover, which scales the video uniformly to
      // fill the canvas box (cropping whichever axis overflows) rather than stretching each
      // axis independently — mapping boxes with separate scaleX/scaleY assumed object-fit:
      // fill and was wrong on any device whose video aspect ratio didn't exactly match the
      // screen (i.e. basically always, and especially so after a portrait/landscape rotation).
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const offsetX = (canvas.width - video.videoWidth * scale) / 2;
      const offsetY = (canvas.height - video.videoHeight * scale) / 2;

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#00d9ff';
      ctx.shadowColor = 'rgba(0, 217, 255, 0.65)';
      ctx.shadowBlur = 6;

      for (const track of state.latestTracks) {
        const [x, y, w, h] = track.bbox;
        drawHudBox(
          ctx,
          x * scale + offsetX,
          y * scale + offsetY,
          w * scale,
          h * scale,
          track.class
        );
      }

      ctx.shadowBlur = 0;
    }

    state.rafId = requestAnimationFrame(draw);
  };

  state.rafId = requestAnimationFrame(draw);
}

function stopDrive({ showSummary } = { showSummary: true }) {
  if (state.detectionTimer) {
    clearInterval(state.detectionTimer);
    state.detectionTimer = null;
  }
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.timerIntervalId) {
    clearInterval(state.timerIntervalId);
    state.timerIntervalId = null;
  }
  window.removeEventListener('resize', resizeCanvasToVideo);
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }

  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) {
      track.stop();
    }
    state.mediaStream = null;
  }
  els.cameraVideo.srcObject = null;

  els.gpsStatusBadge.classList.add('hidden');
  hideGpsPermissionHelp();
  els.lensSwitcher.classList.add('hidden');
  els.lensSwitcher.innerHTML = '';
  state.activeLensDeviceId = null;
  state.lensByDeviceId = null;

  let peakG = null;
  if (state.motionTracker) {
    peakG = state.motionTracker.stop().peakG;
    state.motionTracker = null;
  }
  resetGMeter();

  let summary = null;
  if (state.tripTracker) {
    summary = state.tripTracker.stop();
    state.tripTracker = null;
  }

  if (state.carTracker) {
    state.carTracker.reset();
    state.carTracker = null;
  }

  if (showSummary && summary) {
    presentSummary(summary, peakG);
  }
}

function netScoreMessage(net) {
  if (net > 3) return `Absolute legend — you overtook ${net} more than got past you. 🏆`;
  if (net > 0) return `Net +${net}. You came out ahead today. 😎`;
  if (net === 0) return "Dead even — nobody won this one. Rematch tomorrow? 🤝";
  if (net > -4) return `Net ${net}. A tough crowd out there today. 😅`;
  return `Net ${net}. Rough one — the highway had other plans. 🫠`;
}

// Correlates each in-drive event (which only has a timestamp) to the nearest-in-time GPS
// route point, so it can later be pinned on the trip's route replay. O(events x route length),
// trivial even for a long drive's route (a few thousand comparisons at most).
function correlateEventsToRoute(events, route) {
  if (!route || route.length === 0) {
    return events.map((e) => ({ type: e.type, t: e.timestamp, lat: null, lng: null }));
  }
  return events.map((e) => {
    let nearest = route[0];
    let bestDiff = Math.abs(route[0].t - e.timestamp);
    for (const point of route) {
      const diff = Math.abs(point.t - e.timestamp);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = point;
      }
    }
    return { type: e.type, t: e.timestamp, lat: nearest.lat, lng: nearest.lng };
  });
}

function presentSummary(summary, peakG) {
  const net = state.overtakesByMe - state.overtakesOfMe;

  state.lastSummary = {
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    durationSec: summary.durationSec,
    distanceKm: summary.distanceKm,
    avgSpeedKmh: summary.avgSpeedKmh,
    topSpeedKmh: Math.max(summary.topSpeedKmh, state.liveTopSpeedKmh),
    overtakesByMe: state.overtakesByMe,
    overtakesOfMe: state.overtakesOfMe,
    // null (not 0) when motion permission was denied/unsupported — a real 0.0g reading and
    // "we never measured this" are different things, and trip cards/history should be able
    // to tell them apart rather than showing a misleadingly precise zero.
    peakG: typeof peakG === 'number' ? peakG : null,
    route: summary.route || [],
    events: correlateEventsToRoute(state.driveEvents, summary.route),
  };

  els.summaryDistance.innerHTML = `${round1(kmToMi(summary.distanceKm))}<span class="stat-unit">mi</span>`;
  els.summaryDuration.textContent = formatDuration(summary.durationSec);
  els.summaryAvgSpeed.innerHTML = `${Math.round(kmhToMph(summary.avgSpeedKmh))}<span class="stat-unit">mph</span>`;
  els.summaryTopSpeed.innerHTML = `${Math.round(kmhToMph(state.lastSummary.topSpeedKmh))}<span class="stat-unit">mph</span>`;
  els.summaryOvertook.textContent = String(state.overtakesByMe);
  els.summaryOvertaken.textContent = String(state.overtakesOfMe);
  els.summaryNetMessage.textContent = netScoreMessage(net);

  if (state.lastSummary.peakG !== null) {
    els.summaryPeakG.innerHTML = `${state.lastSummary.peakG.toFixed(1)}<span class="stat-unit">g</span>`;
    els.summaryPeakGCard.classList.remove('hidden');
  } else {
    els.summaryPeakGCard.classList.add('hidden');
  }

  els.summaryModal.classList.remove('hidden');
}

async function saveSummaryAndReturn() {
  if (state.lastSummary) {
    try {
      await TripHistory.saveTrip({ ...state.lastSummary });
    } catch (err) {
      console.error('Failed to save trip', err);
    }
  }
  state.lastSummary = null;
  els.summaryModal.classList.add('hidden');
  showView('dashboard');
  renderDashboard();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function init() {
  initOnboarding();
  renderDashboard();
  showView('dashboard');

  els.startDriveBtn.addEventListener('click', () => {
    startDrive();
  });

  els.endDriveBtn.addEventListener('click', () => {
    stopDrive({ showSummary: true });
  });

  els.driveErrorBackBtn.addEventListener('click', () => {
    stopDrive({ showSummary: false });
    els.driveError.classList.add('hidden');
    showView('dashboard');
  });

  els.gpsRetryBtn.addEventListener('click', () => {
    hideGpsPermissionHelp();
    // Safe to fully reset here: reaching this UI means no fix has ever landed yet this
    // drive (state.gpsFixAcquired is still false), so there's no accumulated distance to lose.
    els.gpsStatusText.textContent = GPS_ERROR_MESSAGES.unknown;
    els.gpsStatusBadge.classList.remove('hidden');
    state.tripTracker.start();
  });

  els.gpsDismissBtn.addEventListener('click', () => {
    hideGpsPermissionHelp();
  });

  els.summarySaveBtn.addEventListener('click', () => {
    saveSummaryAndReturn();
  });

  els.tripDetailBackBtn.addEventListener('click', () => {
    showView('dashboard');
  });
}

init();
