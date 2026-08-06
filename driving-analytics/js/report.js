// report.js — client-side "Race Weekend Summary" PDF export.
// Relies on `window.jspdf.jsPDF` being loaded as a page global before this module runs.
// Drawn entirely with jsPDF's own vector primitives (no canvas/image embedding) so the
// output is crisp at any zoom and has no dependency on a map tile server's CORS policy.

const ACCENT = [0, 217, 255];
const ACCENT_2 = [57, 255, 157];
const POSITIVE = [74, 222, 128];
const NEGATIVE = [255, 84, 112];
const WARNING = [255, 180, 84];
const BG = [9, 12, 19];
const BG_CARD = [22, 27, 38];
const BORDER = [35, 42, 56];
const TEXT = [238, 242, 248];
const TEXT_MUTED = [139, 147, 167];
const TEXT_FAINT = [86, 95, 116];

const KM_TO_MI = 0.621371;
const kmToMi = (km) => (km || 0) * KM_TO_MI;
const kmhToMph = (kmh) => (kmh || 0) * KM_TO_MI;
const mpsToMph = (mps) => (mps || 0) * 2.23694;
const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;

function downsample(arr, maxPoints) {
  if (!arr || arr.length <= maxPoints) return arr || [];
  const step = arr.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatLongDate(ts) {
  const d = new Date(ts);
  return (
    d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}

export function isReportSupported() {
  return typeof window !== 'undefined' && window.jspdf && typeof window.jspdf.jsPDF === 'function';
}

function netScoreMessage(net) {
  if (net > 3) return `Absolute legend — ${net} more passes made than taken.`;
  if (net > 0) return `Net +${net}. Came out ahead this drive.`;
  if (net === 0) return 'Dead even — nobody won this one.';
  if (net > -4) return `Net ${net}. A tough crowd out there.`;
  return `Net ${net}. Rough one out there.`;
}

function drawBackground(doc, pageW, pageH) {
  doc.setFillColor(...BG);
  doc.rect(0, 0, pageW, pageH, 'F');
}

function drawSectionLabel(doc, text, x, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setCharSpace(0.6);
  doc.setTextColor(...TEXT_FAINT);
  doc.text(text.toUpperCase(), x, y);
  doc.setCharSpace(0);
}

function drawCardBox(doc, x, y, w, h) {
  doc.setFillColor(...BG_CARD);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(1);
  doc.roundedRect(x, y, w, h, 6, 6, 'FD');
}

function drawHeader(doc, trip, pageW, margin) {
  let y = margin;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(...ACCENT);
  doc.text('OVERTAKER', margin, y + 18);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...TEXT_MUTED);
  doc.text('Race Weekend Summary', margin, y + 34);

  doc.setFontSize(9);
  doc.setTextColor(...TEXT_FAINT);
  doc.text(formatLongDate(trip.startedAt), pageW - margin, y + 14, { align: 'right' });
  doc.text('Generated ' + formatLongDate(Date.now()), pageW - margin, y + 27, { align: 'right' });

  y += 50;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(1);
  doc.line(margin, y, pageW - margin, y);

  return y + 24;
}

function drawStatGrid(doc, trip, x, y, w) {
  const net = (trip.overtakesByMe || 0) - (trip.overtakesOfMe || 0);
  const stats = [
    { label: 'Distance', value: `${round1(kmToMi(trip.distanceKm || 0))} mi` },
    { label: 'Duration', value: formatClock(trip.durationSec || 0) },
    { label: 'Avg Speed', value: `${Math.round(kmhToMph(trip.avgSpeedKmh || 0))} mph` },
    { label: 'Top Speed', value: `${Math.round(kmhToMph(trip.topSpeedKmh || 0))} mph` },
    { label: 'Peak G-Force', value: typeof trip.peakG === 'number' ? `${trip.peakG.toFixed(1)}g` : '—' },
    { label: 'Net Score', value: net > 0 ? `+${net}` : String(net) },
  ];

  const cols = 3;
  const gap = 10;
  const boxW = (w - gap * (cols - 1)) / cols;
  const boxH = 58;

  stats.forEach((stat, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bx = x + col * (boxW + gap);
    const by = y + row * (boxH + gap);

    drawCardBox(doc, bx, by, boxW, boxH);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...TEXT_FAINT);
    doc.text(stat.label.toUpperCase(), bx + 12, by + 20);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(...TEXT);
    doc.text(String(stat.value), bx + 12, by + 44);
  });

  const rows = Math.ceil(stats.length / cols);
  const gridHeight = rows * boxH + (rows - 1) * gap;

  const message = netScoreMessage(net);
  const messageY = y + gridHeight + 22;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(11);
  doc.setTextColor(net > 0 ? POSITIVE[0] : net < 0 ? NEGATIVE[0] : TEXT_MUTED[0], net > 0 ? POSITIVE[1] : net < 0 ? NEGATIVE[1] : TEXT_MUTED[1], net > 0 ? POSITIVE[2] : net < 0 ? NEGATIVE[2] : TEXT_MUTED[2]);
  doc.text(message, x, messageY);

  return messageY + 28;
}

// Projects a trip's route into a bordered box as a simple vector line sketch, with start/end/
// event markers — deliberately not a real map (no tile server dependency, always renders).
function drawRouteSection(doc, trip, x, y, w, h) {
  drawSectionLabel(doc, 'Route', x, y);
  const boxY = y + 8;
  const boxH = h;
  drawCardBox(doc, x, boxY, w, boxH);

  const route = downsample(trip.route, 220);
  const pad = 16;
  const innerX = x + pad;
  const innerY = boxY + pad;
  const innerW = w - pad * 2;
  const innerH = boxH - pad * 2;

  if (!route || route.length < 2) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_FAINT);
    doc.text('No route data recorded for this drive.', x + w / 2, boxY + boxH / 2, { align: 'center' });
    return boxY + boxH + 20;
  }

  const lats = route.map((p) => p.lat);
  const lngs = route.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const lngScale = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) || 1;

  const spanLat = Math.max(maxLat - minLat, 0.00001);
  const spanLng = Math.max((maxLng - minLng) * lngScale, 0.00001);
  const scale = Math.min(innerW / spanLng, innerH / spanLat);
  const drawnW = spanLng * scale;
  const drawnH = spanLat * scale;
  const offsetX = innerX + (innerW - drawnW) / 2;
  const offsetY = innerY + (innerH - drawnH) / 2;

  // y flips so higher latitude (further north) draws toward the top of the box, matching how
  // a map conventionally reads.
  const projectPoint = (lat, lng) => {
    const px = offsetX + (lng - minLng) * lngScale * scale;
    const py = offsetY + drawnH - (lat - minLat) * scale;
    return [px, py];
  };

  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(1.8);
  for (let i = 1; i < route.length; i++) {
    const [x1, y1] = projectPoint(route[i - 1].lat, route[i - 1].lng);
    const [x2, y2] = projectPoint(route[i].lat, route[i].lng);
    doc.line(x1, y1, x2, y2);
  }

  const dot = (lat, lng, color, r) => {
    const [px, py] = projectPoint(lat, lng);
    doc.setFillColor(...color);
    doc.circle(px, py, r, 'F');
  };

  dot(route[0].lat, route[0].lng, ACCENT_2, 3.5);
  dot(route[route.length - 1].lat, route[route.length - 1].lng, TEXT_FAINT, 3.5);
  for (const ev of trip.events || []) {
    if (typeof ev.lat !== 'number' || typeof ev.lng !== 'number') continue;
    dot(ev.lat, ev.lng, ev.type === 'overtook' ? POSITIVE : NEGATIVE, 3);
  }

  return boxY + boxH + 20;
}

// A simple XY line chart (value vs. time-since-start) inside a bordered box.
function drawLineChart(doc, { title, x, y, w, h, points, valueKey, unit, color, formatValue }) {
  drawSectionLabel(doc, title, x, y);
  const boxY = y + 8;
  drawCardBox(doc, x, boxY, w, h);

  const pad = 16;
  const innerX = x + pad;
  const innerY = boxY + pad;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  if (!points || points.length < 2) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_FAINT);
    doc.text('Not enough data recorded.', x + w / 2, boxY + h / 2, { align: 'center' });
    return boxY + h + 20;
  }

  const t0 = points[0].t;
  const values = points.map((p) => p[valueKey] || 0);
  const minV = 0; // charts start at zero — more honest than an auto-cropped baseline
  const maxV = Math.max(...values, 0.001);
  const maxT = Math.max((points[points.length - 1].t - t0) / 1000, 0.001);

  const projX = (tSec) => innerX + (tSec / maxT) * innerW;
  const projY = (v) => innerY + innerH - ((v - minV) / (maxV - minV)) * innerH;

  doc.setDrawColor(...color);
  doc.setLineWidth(1.6);
  for (let i = 1; i < points.length; i++) {
    const t1 = (points[i - 1].t - t0) / 1000;
    const t2 = (points[i].t - t0) / 1000;
    doc.line(projX(t1), projY(values[i - 1]), projX(t2), projY(values[i]));
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...TEXT_FAINT);
  doc.text(formatValue(maxV) + ' ' + unit, innerX, innerY + 4);
  doc.text('0 ' + unit, innerX, innerY + innerH);
  doc.text('start', innerX, innerY + innerH + 12);
  doc.text('finish', innerX + innerW, innerY + innerH + 12, { align: 'right' });

  return boxY + h + 22;
}

function drawPassLog(doc, trip, x, y, w, maxRows) {
  drawSectionLabel(doc, 'Pass Log', x, y);
  const events = (trip.events || []).slice().sort((a, b) => a.t - b.t);

  if (events.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_FAINT);
    doc.text('No overtakes recorded this drive.', x, y + 20);
    return y + 40;
  }

  let cy = y + 22;
  const shown = events.slice(0, maxRows);
  for (const ev of shown) {
    const relSec = (ev.t - trip.startedAt) / 1000;
    const color = ev.type === 'overtook' ? POSITIVE : NEGATIVE;
    const label = ev.type === 'overtook' ? 'Overtook a car' : 'Overtaken by a car';
    const speedText = typeof ev.theirSpeedMps === 'number' ? `  ·  ~${Math.round(mpsToMph(ev.theirSpeedMps))} mph` : '';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...TEXT_FAINT);
    doc.text(formatClock(relSec), x, cy);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...color);
    doc.text(label + speedText, x + 46, cy);

    cy += 16;
  }

  if (events.length > maxRows) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...TEXT_FAINT);
    doc.text(`+ ${events.length - maxRows} more`, x, cy + 4);
    cy += 18;
  }

  return cy + 12;
}

function drawFooter(doc, pageW, pageH, margin) {
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(1);
  doc.line(margin, pageH - margin, pageW - margin, pageH - margin);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...TEXT_FAINT);
  doc.text(
    'Overtaker — stats are best-effort estimates from an uncalibrated phone camera, GPS, and accelerometer, not a certified record.',
    margin,
    pageH - margin + 14
  );
}

export function generateTripReport(trip) {
  if (!isReportSupported()) {
    throw new Error('PDF export is unavailable right now — check your connection and reload.');
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;

  drawBackground(doc, pageW, pageH);
  let y = drawHeader(doc, trip, pageW, margin);
  y = drawStatGrid(doc, trip, margin, y, contentW);
  y = drawRouteSection(doc, trip, margin, y, contentW, 220);
  drawPassLog(doc, trip, margin, y, contentW, 8);
  drawFooter(doc, pageW, pageH, margin);

  // Page 2: telemetry graphs, kept separate so the summary page stays uncluttered.
  doc.addPage();
  drawBackground(doc, pageW, pageH);
  let y2 = margin;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...TEXT);
  doc.text('Telemetry', margin, y2 + 12);
  y2 += 36;

  const speedPoints = (trip.route || []).map((p) => ({ t: p.t, speedMph: kmhToMph(p.speedKmh || 0) }));
  y2 = drawLineChart(doc, {
    title: 'Speed Over Time',
    x: margin,
    y: y2,
    w: contentW,
    h: 180,
    points: speedPoints,
    valueKey: 'speedMph',
    unit: 'mph',
    color: ACCENT,
    formatValue: (v) => String(Math.round(v)),
  });

  const gPoints = (trip.gSeries || []).map((p) => ({ t: p.t, g: p.g }));
  drawLineChart(doc, {
    title: 'G-Force Over Time',
    x: margin,
    y: y2,
    w: contentW,
    h: 180,
    points: gPoints,
    valueKey: 'g',
    unit: 'g',
    color: WARNING,
    formatValue: (v) => v.toFixed(1),
  });

  drawFooter(doc, pageW, pageH, margin);

  const dateSlug = new Date(trip.startedAt).toISOString().slice(0, 10);
  doc.save(`overtaker-race-summary-${dateSlug}.pdf`);
}
