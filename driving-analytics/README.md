# Overtaker

A mobile-first PWA that turns a boring drive into a little game. Point your
phone's rear camera at the road, mount it securely, and Overtaker uses a
pretrained vision model plus your GPS to notice cars you overtake vs. cars
that overtake you — tallying a live score and building a trip history as you
go.

## How overtake detection works

Overtaker runs [coco-ssd](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd)
(a pretrained TensorFlow.js object detector) on the camera feed a few times a
second, tracks each detected vehicle across frames, and watches two cheap
signals: how the vehicle's bounding-box **width** changes (a proxy for how
close it is — vehicles loom larger as you close the gap) and how its
horizontal **position** drifts before it's lost from view. A car that grows
large mid-frame and then drifts off toward an edge as it disappears was
likely alongside you and fell behind — an overtake by you. A car that starts
close/off-center and shrinks back toward the middle before vanishing was
pulling away ahead — it overtook you.

This is a **best-effort heuristic**, not a precise or legal record. It can be
fooled by lane changes, parked cars, poor lighting, or a shaky mount. Treat
the tally as a fun estimate, not ground truth.

## Running locally

No build step and zero runtime dependencies — everything is plain HTML/CSS/JS.

```bash
cd driving-analytics
node serve.js
# or: npm start
```

Then open **http://localhost:8787** in a browser.

## Testing on your phone (why you need HTTPS)

Camera access (`getUserMedia`) is only allowed in a browser **secure
context**: HTTPS, or the exact origin `http://localhost`. A plain
`http://<your-lan-ip>:8787` address — which is what you'd normally use to
open the dev server from your phone over WiFi — will **not** be granted
camera permission.

Since Overtaker is 100% static (no backend, no server-side state), the
easiest paths to a real HTTPS URL are:

1. **Deploy the static files** to [Vercel](https://vercel.com), [Netlify](https://netlify.com),
   or [GitHub Pages](https://pages.github.com) — just point any of them at
   this `driving-analytics/` folder. Free tier, HTTPS by default.
2. **Tunnel the local dev server** with a tool like [ngrok](https://ngrok.com)
   (`ngrok http 8787`) or [localtunnel](https://github.com/localtunnel/localtunnel)
   (`npx localtunnel --port 8787`) to get a temporary HTTPS URL that proxies
   to `node serve.js` running on your machine.
3. Open that HTTPS URL on your phone and add it to your home screen for the
   full standalone PWA experience.

## Safety first

Mount your phone securely (windshield or dash mount) before you drive. Never
hold or interact with your phone while the car is moving — only start/end a
drive or review your stats when safely parked. Overtaker is for
entertainment only; it is **not** a certified speedometer or a legal record
of anything. Always obey traffic laws and drive attentively.

## Ideas for v2

- Use device motion / accelerometer sensors to smooth out speed readings
  when GPS is noisy (tunnels, dense cities, poor signal).
- Cloud sync so friends can compare net scores and run a leaderboard.
- Exportable trip replay (route + overtake events plotted on a map/timeline).
- A better tracking/re-identification model to cut down on false overtakes
  from lane changes, parked cars, or oncoming traffic.
