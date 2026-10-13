// Pure-math tests for the widgets (gesture-math.js, color-math.js): angle unwrap, relative drag with fine
// mode and detents, platter scratch/bend mapping, velocity, waveform zoom and tick placement, needle lock.
import {
  TAU, angleDelta, pointAngle, AngleTracker, angleToSeconds, secondsToAngle, platterAngle,
  bendFromAngularVelocity, bendRelease, platterZone, nudgeRingInner, progressFraction, endWarning,
  VelocityTracker, snapValue, RelativeDrag, valueToFraction, fractionToValue, isDoubleTap, shouldEnterFine,
  keyAdjust, wheelPixels, wheelValueDelta, meterThresholds, meterLitCount, peakToDb, baseVisibleSeconds,
  clampZoom, visibleSeconds, pxPerSecond, pinchZoom, stepZoom, wheelZoom, timeToX, xToTime, firstBeatIndex,
  isBarIndex, beatTicks, tickDensity, columnStats, scrubTarget, nudgeBend, needleLockMode, holdProgress,
  xToFraction, ZOOM_MIN, ZOOM_MAX, ChangeSig,
} from '../src/ui/widgets/gesture-math.js';
import { parseColor, rgba, mixRgb, hslToRgb, luminance, bandPalette, bandColumnColor } from '../src/ui/widgets/color-math.js';

const EPS = 1e-9;

test('angleDelta wraps into (-PI, PI]', () => {
  assert.closeTo(angleDelta(0, 0.5), 0.5, EPS);
  assert.closeTo(angleDelta(3, -3), TAU - 6, EPS);          // crossing +PI forward
  assert.closeTo(angleDelta(-3, 3), 6 - TAU, EPS);          // crossing -PI backward
  assert.closeTo(angleDelta(0, Math.PI), Math.PI, EPS);
  assert.closeTo(angleDelta(0, -Math.PI), Math.PI, EPS);    // -PI maps to +PI
  assert.closeTo(angleDelta(1, 1 + 4 * TAU + 0.1), 0.1, 1e-9);
});

test('pointAngle is clockwise in screen space', () => {
  assert.closeTo(pointAngle(10, 0, 0, 0), 0, EPS);                 // 3 o'clock
  assert.closeTo(pointAngle(0, 10, 0, 0), Math.PI / 2, EPS);       // 6 o'clock (y down)
  assert.closeTo(pointAngle(0, -10, 0, 0), -Math.PI / 2, EPS);     // 12 o'clock
});

test('AngleTracker unwraps full turns and ignores the centre', () => {
  const tr = new AngleTracker(10);
  tr.begin(0, 50);
  // two full clockwise turns in 16 steps per turn
  for (let i = 1; i <= 32; i++) tr.update(wrapPi((i / 16) * TAU), 50);
  assert.closeTo(tr.total, 2 * TAU, 1e-9);
  // back one turn counter-clockwise
  for (let i = 31; i >= 16; i--) tr.update(wrapPi((i / 16) * TAU), 50);
  assert.closeTo(tr.total, TAU, 1e-9);
  // passing through the centre: no contribution, re-anchors without a jump
  tr.update(2.5, 3);
  const before = tr.total;
  tr.update(2.0, 40);
  assert.closeTo(tr.total, before, EPS);
  tr.update(2.1, 40);
  assert.closeTo(tr.total, before + 0.1, 1e-9);
});

function wrapPi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

test('platter mapping: 1.8 s per turn', () => {
  assert.closeTo(angleToSeconds(TAU), 1.8, EPS);
  assert.closeTo(angleToSeconds(-Math.PI), -0.9, EPS);
  assert.closeTo(secondsToAngle(0.45), Math.PI / 2, EPS);
  assert.closeTo(platterAngle(1.8), 0, 1e-9);
  assert.closeTo(platterAngle(0.9), Math.PI, 1e-9);
  assert.closeTo(platterAngle(-0.45), 1.5 * Math.PI, 1e-9);
  assert.equal(platterAngle(NaN), 0);
});

test('bend from angular velocity: 6 % per normal-speed turn, clamped 12 %', () => {
  const normal = TAU / 1.8;
  assert.closeTo(bendFromAngularVelocity(normal), 0.06, 1e-12);
  assert.closeTo(bendFromAngularVelocity(-normal), -0.06, 1e-12);
  assert.closeTo(bendFromAngularVelocity(normal / 2), 0.03, 1e-12);
  assert.equal(bendFromAngularVelocity(normal * 10), 0.12);
  assert.equal(bendFromAngularVelocity(-normal * 10), -0.12);
  assert.equal(bendFromAngularVelocity(NaN), 0);
  assert.closeTo(bendRelease(0.1, 0), 0.1, EPS);
  assert.closeTo(bendRelease(0.1, 75), 0.05, 1e-12);
  assert.equal(bendRelease(0.1, 150), 0);
  assert.equal(bendRelease(-0.1, 1000), 0);
});

test('platter zones: nudge ring only on platters >= 200 px', () => {
  // 152 px phone platter, radius 70: whole disc scratches with vinyl on
  assert.equal(platterZone(65, 70, 152, true), 'scratch');
  assert.equal(platterZone(10, 70, 152, true), 'scratch');
  assert.equal(platterZone(90, 70, 152, true), 'outside');
  assert.equal(platterZone(65, 70, 152, false), 'bend');
  // 260 px tablet platter, radius 120: ring = max(36, 28) = 36 px
  assert.equal(platterZone(100, 120, 260, true), 'bend');
  assert.equal(platterZone(80, 120, 260, true), 'scratch');
  assert.equal(platterZone(80, 120, 260, false), 'bend');
  assert.closeTo(nudgeRingInner(120, 260), 0.7, 1e-12);
  assert.closeTo(nudgeRingInner(90, 200), 1 - 28 / 90, 1e-12);
  assert.equal(nudgeRingInner(70, 152), 0);
});

test('progress and end warning', () => {
  assert.equal(progressFraction(30, 120), 0.25);
  assert.equal(progressFraction(30, 0), 0);
  assert.equal(progressFraction(500, 120), 1);
  assert.equal(endWarning(95, 120), true);
  assert.equal(endWarning(80, 120), false);
  assert.equal(endWarning(120, 120), false);
  assert.equal(endWarning(10, 0), false);
});

test('VelocityTracker: steady slope, window, stale -> 0', () => {
  const v = new VelocityTracker(50);
  for (let i = 0; i <= 10; i++) v.push(i * 10, i * 2); // 2 units per 10 ms = 200/s
  assert.closeTo(v.velocity(100), 200, 1e-9);
  assert.equal(v.velocity(200), 0);                     // finger stopped
  v.reset();
  assert.equal(v.velocity(0), 0);
  v.push(0, 0);
  v.push(8, 4);
  assert.closeTo(v.velocity(8), 500, 1e-9);
  // ring buffer wrap
  const w = new VelocityTracker(30, 4);
  for (let i = 0; i < 20; i++) w.push(i * 10, i);
  assert.closeTo(w.velocity(190), 100, 1e-9);
});

test('RelativeDrag: no jump, linear travel, clamps re-anchor', () => {
  const d = new RelativeDrag({ min: 0, max: 1, travel: 200 });
  assert.equal(d.begin(0.3, 500), 0.3);
  assert.closeTo(d.move(500), 0.3, EPS);                // touching does not jump
  assert.closeTo(d.move(550), 0.55, 1e-12);
  assert.closeTo(d.move(450), 0.05, 1e-12);
  assert.equal(d.move(300), 0);                          // past the end
  assert.closeTo(d.move(320), 0.1, 1e-12);               // reversing responds at once
  // fine mode re-anchors and scales x0.25
  d.setFine(true, 320);
  assert.closeTo(d.move(360), 0.15, 1e-12);
  d.setFine(false, 360);
  assert.closeTo(d.move(380), 0.25, 1e-12);
});

test('RelativeDrag: detent is sticky and reports entry once', () => {
  const d = new RelativeDrag({ min: -1, max: 1, travel: 300, detent: 0, detentWidth: 0.04 });
  d.begin(-0.2, 0);
  assert.closeTo(d.move(15), -0.1, 1e-12);
  assert.equal(d.entered, false);
  assert.equal(d.move(26), 0);                            // raw -0.0267 -> snapped
  assert.equal(d.entered, true);
  assert.equal(d.move(30), 0);                            // still inside
  assert.equal(d.entered, false);
  assert.closeTo(d.move(40), 0.0667, 1e-3);               // left the zone
  assert.equal(d.inDetent, false);
  // starting inside the detent does not tick
  d.begin(0, 0);
  assert.equal(d.inDetent, true);
  d.move(2);
  assert.equal(d.entered, false);
});

test('RelativeDrag: kill snap at min', () => {
  const d = new RelativeDrag({ min: -1, max: 1, travel: 180, snapMin: 0.04, detent: 0, detentWidth: 0.03 });
  d.begin(-0.5, 0);
  const v = d.move(-40);                                  // raw -0.944 -> within 0.04? no: -0.944+1 = 0.056
  assert.closeTo(v, -0.9444, 1e-3);
  assert.equal(d.move(-43), -1);                          // raw -0.978 -> kill snap
  assert.equal(d.entered, true);
  assert.equal(snapValue(-0.99, -1, 0, 0.03, 0.04), -1);
  assert.equal(snapValue(0.02, -1, 0, 0.03, 0.04), 0);
  assert.equal(snapValue(0.5, -1, null, 0.03, 0), 0.5);
});

test('fractions, double tap, fine-mode decision', () => {
  assert.equal(valueToFraction(0, -1, 1), 0.5);
  assert.equal(valueToFraction(5, 0, 1), 1);
  assert.equal(fractionToValue(0.25, -1, 1), -0.5);
  const prev = { t: 1000, x: 100, y: 100 };
  assert.equal(isDoubleTap(prev, 1200, 110, 95), true);
  assert.equal(isDoubleTap(prev, 1400, 110, 95), false);
  assert.equal(isDoubleTap(prev, 1200, 200, 100), false);
  assert.equal(isDoubleTap(null, 1200, 100, 100), false);
  assert.equal(shouldEnterFine(450, 3), true);
  assert.equal(shouldEnterFine(449, 0), false);
  assert.equal(shouldEnterFine(600, 10), false);
});

test('keyboard and wheel mapping', () => {
  assert.closeTo(keyAdjust('ArrowUp', 0.5, 0, 1, 0.01), 0.51, 1e-12);
  assert.closeTo(keyAdjust('ArrowLeft', 0.5, 0, 1, 0.01, true), 0.4975, 1e-12);
  assert.closeTo(keyAdjust('PageDown', 0.5, 0, 1, 0.01), 0.4, 1e-12);
  assert.equal(keyAdjust('End', 0.5, 0, 1, 0.01), 1);
  assert.equal(keyAdjust('Home', 0.5, -1, 1, 0.01), -1);
  assert.equal(keyAdjust('Delete', 0.5, 0, 1, 0.01, false, 0.8), 0.8);
  assert.equal(keyAdjust('a', 0.5, 0, 1, 0.01), null);
  assert.equal(keyAdjust('ArrowUp', 1, 0, 1, 0.01), 1);
  assert.equal(wheelPixels(0, -100, 0), 100);             // wheel up = increase
  assert.equal(wheelPixels(0, 3, 1), -48);                // 3 lines down
  assert.equal(wheelPixels(100, 0, 0), -100);             // Shift+wheel down arrives as deltaX
  assert.closeTo(wheelValueDelta(100, 0, 1), 0.03, 1e-12);
  assert.closeTo(wheelValueDelta(100, -1, 1, true), 0.015, 1e-12);
});

test('meter scale', () => {
  const th = meterThresholds(12);
  assert.equal(th.length, 12);
  assert.closeTo(th[0], -36, 1e-4);
  assert.equal(th[11], 0);
  for (let i = 1; i < 12; i++) assert(th[i] > th[i - 1], 'ascending');
  assert.equal(meterLitCount(-100, th), 0);
  assert.equal(meterLitCount(0.5, th), 12);
  assert.equal(meterLitCount(-36, th), 1);
  assert.equal(meterLitCount(peakToDb(0.5), th), meterLitCount(-6.02, th));
  assert.equal(peakToDb(0), -90);
  assert.closeTo(peakToDb(1), 0, 1e-12);
});

test('waveform zoom: one px/s for both decks', () => {
  assert.equal(baseVisibleSeconds(328), 6);
  assert.equal(baseVisibleSeconds(728), 8);
  assert.equal(baseVisibleSeconds(1360), 10);
  assert.equal(clampZoom(10), ZOOM_MAX);
  assert.equal(clampZoom(0), 1);
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  assert.equal(visibleSeconds(328, 2), 12);
  assert.closeTo(pxPerSecond(330, 1), 55, 1e-12);
  assert.closeTo(pxPerSecond(330, 0.5), 110, 1e-12);
  assert.closeTo(pinchZoom(1, 100, 200), 0.5, 1e-12);   // fingers apart -> zoom in
  assert.closeTo(pinchZoom(1, 200, 100), 2, 1e-12);
  assert.equal(pinchZoom(1, 100, 10000), ZOOM_MIN);
  assert.closeTo(stepZoom(1, 1), 1 / 1.5, 1e-12);
  assert.closeTo(stepZoom(1, -1), 1.5, 1e-12);
  assert.equal(stepZoom(1 / 1.5, -1), 1);
  assert.equal(stepZoom(ZOOM_MIN, 1), ZOOM_MIN);
  assert(wheelZoom(1, 100) > 1 && wheelZoom(1, -100) < 1, 'wheel down zooms out');
  assert.equal(timeToX(12, 10, 160, 55), 270);
  assert.closeTo(xToTime(270, 10, 160, 55), 12, 1e-12);
});

test('beat ticks: placement, bars, negative indices', () => {
  // 120 bpm = 0.5 s per beat, grid anchored at 0.25 s
  const ticks = beatTicks(0, 2.5, 120, 0.25);
  assert.deepEqual(ticks.map((t) => t.t), [0.25, 0.75, 1.25, 1.75, 2.25]);
  assert.deepEqual(ticks.map((t) => t.bar), [true, false, false, false, true]);
  // view before the anchor: negative beats, bars every 4 counted from the anchor
  const pre = beatTicks(-1.8, 0.3, 120, 0.25);
  assert.deepEqual(pre.map((t) => t.index), [-4, -3, -2, -1, 0]);
  assert.deepEqual(pre.map((t) => t.bar), [true, false, false, false, true]);
  assert.equal(firstBeatIndex(0.25, 120, 0.25), 0);       // a beat exactly on t0 is included
  assert.equal(firstBeatIndex(0.26, 120, 0.25), 1);
  assert.equal(isBarIndex(-4), true);
  assert.equal(isBarIndex(-3), false);
  assert.deepEqual(beatTicks(0, 5, null, 0), []);
  // dense grids degrade gracefully
  assert.equal(tickDensity(30), 'all');
  assert.equal(tickDensity(3), 'bars');
  assert.equal(tickDensity(1), 'none');
  // 128 bpm over a 6 s window -> 12 or 13 ticks
  const n = beatTicks(10, 16, 128, 0.1).length;
  assert(n === 12 || n === 13, `tick count ${n}`);
});

test('columnStats: aggregate wide columns, interpolate narrow ones', () => {
  const peak = new Float32Array([0, 0.5, 1, 0.25]);
  const low = new Float32Array([0, 1, 0, 0.5]);
  const high = new Float32Array([1, 0, 0.5, 0]);
  const out = {};
  // rate 2 bins/s, column covers 0.5..1.5 s -> bins 1, 2
  columnStats(peak, low, high, 2, 0.5, 1.5, out);
  assert.equal(out.peak, 1);
  assert.closeTo(out.low, 0.5, 1e-12);
  assert.closeTo(out.high, 0.25, 1e-12);
  // narrow column centred on 1.0 s -> between bin 1 (centre 0.75 s) and bin 2 (1.25 s)
  columnStats(peak, low, high, 2, 0.95, 1.05, out);
  assert.closeTo(out.peak, 0.75, 1e-6);
  // outside the track
  columnStats(peak, low, high, 2, -2, -1, out);
  assert.equal(out.peak, 0);
  columnStats(peak, low, high, 2, 10, 11, out);
  assert.equal(out.peak, 0);
});

test('lane scrub and nudge', () => {
  assert.closeTo(scrubTarget(10, 55, 55, 100), 9, 1e-12);   // drag right 1 s worth -> back 1 s
  assert.equal(scrubTarget(0.5, 100, 55, 100), 0);
  assert.equal(scrubTarget(99.5, -200, 55, 100), 100);
  assert.equal(nudgeBend(-55, 55), 0.12);
  assert.closeTo(nudgeBend(-11, 55), 0.06, 1e-12);          // pushing left speeds up
  assert.closeTo(nudgeBend(11, 55), -0.06, 1e-12);
  assert.equal(nudgeBend(NaN, 55), 0);
});

test('needle lock decision', () => {
  assert.equal(needleLockMode({ playing: false, audible: false }), 'tap');
  assert.equal(needleLockMode({ playing: true, audible: false }), 'tap');
  assert.equal(needleLockMode({ playing: true, audible: true }), 'hold');
  assert.equal(needleLockMode(null), 'tap');
  assert.equal(holdProgress(175), 0.5);
  assert.equal(holdProgress(1000), 1);
  assert.equal(xToFraction(50, 200), 0.25);
  assert.equal(xToFraction(-5, 200), 0);
});

test('colour helpers', () => {
  assert.deepEqual(parseColor('#3da5ff'), [61, 165, 255]);
  assert.deepEqual(parseColor(' #FFF '), [255, 255, 255]);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(parseColor('rgba(10 20 30 / 0.5)'), [10, 20, 30]);
  assert.equal(parseColor('teal'), null);
  assert.equal(parseColor(''), null);
  assert.equal(rgba([1, 2, 3], 0.5), 'rgba(1,2,3,0.5)');
  assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
  assert.deepEqual(hslToRgb(0, 1, 0.5), [255, 0, 0]);
  assert.deepEqual(hslToRgb(120, 1, 0.5), [0, 255, 0]);
  assert.deepEqual(hslToRgb(240, 0, 0.5), [128, 128, 128]);
  assert(luminance([255, 255, 255]) > 0.99 && luminance([0, 0, 0]) < 0.01, 'luminance');
  const pal = bandPalette([61, 165, 255]);
  assert.deepEqual(pal.low, [61, 165, 255]);
  assert(pal.high[0] > pal.mid[0] && pal.mid[0] > pal.low[0], 'tints get lighter');
  const c = [0, 0, 0];
  bandColumnColor(pal, 0, c);
  assert.deepEqual(c, pal.mid);
  bandColumnColor(pal, 1, c);
  assert.deepEqual(c, pal.high);
});

test('ChangeSig detects changes without allocation', () => {
  const s = new ChangeSig(4);
  s.begin(); s.put(1); s.put(2);
  assert.equal(s.same, false);                             // first frame always draws
  s.begin(); s.put(1); s.put(2);
  assert.equal(s.same, true);
  s.begin(); s.put(1); s.put(3);
  assert.equal(s.same, false);
  s.begin(); s.put(1); s.put(3);
  assert.equal(s.same, true);
  s.invalidate();
  s.begin(); s.put(1); s.put(3);
  assert.equal(s.same, false);
  s.begin(); s.put(NaN); s.put(null);
  assert.equal(s.same, false);
  s.begin(); s.put(NaN); s.put(null);
  assert.equal(s.same, true);                              // NaN is stored as a stable sentinel
  s.begin(); s.put(true); s.put(false);
  assert.equal(s.same, false);
});

test('fillColumn: symmetric body, bass core, anti-aliased edges', async () => {
  const { fillColumn } = await import('../src/ui/widgets/wave-tiles.js');
  const W = 3;
  const H = 10;
  const data = new Uint8ClampedArray(W * H * 4);
  const body = [200, 220, 255];
  const core = [10, 100, 255];
  fillColumn(data, W, H, 1, 5, 2.5, 1, body, core);   // rows 2.5 .. 7.5, core 4 .. 6
  const px = (y) => Array.from(data.slice((y * W + 1) * 4, (y * W + 1) * 4 + 4));
  assert.deepEqual(px(0), [0, 0, 0, 0]);
  assert.deepEqual(px(1), [0, 0, 0, 0]);
  assert.equal(px(2)[3], 128);                           // half-covered edge row
  assert.deepEqual(px(3), [200, 220, 255, 255]);
  assert.deepEqual(px(4), [10, 100, 255, 255]);          // bass core
  assert.deepEqual(px(5), [10, 100, 255, 255]);
  assert.deepEqual(px(6), [200, 220, 255, 255]);
  assert.equal(px(7)[3], 128);
  assert.deepEqual(px(8), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(data.slice(0, 4)), [0, 0, 0, 0]);   // other columns untouched
});
