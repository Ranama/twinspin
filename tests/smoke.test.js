import { clamp, wrapPhase, fmtTime, fmtBpm, fmtPercent, mulberry32 } from '../src/core/util.js';
import { Settings, DEFAULTS } from '../src/core/settings.js';

test('util basics', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.closeTo(wrapPhase(0.75), -0.25, 1e-12);
  assert.closeTo(wrapPhase(-0.6), 0.4, 1e-12);
  assert.equal(fmtTime(75.4), '1:15');
  assert.equal(fmtTime(75.4, true), '-1:15');
  assert.equal(fmtBpm(127.96), '128.0');
  assert.equal(fmtPercent(0.023), '+2.3%');
  const r = mulberry32(1); const a = r(); assert(a >= 0 && a < 1);
});

test('settings persist', () => {
  const s = new Settings('t.k');
  s.set('tempoRange', 0.16);
  const s2 = new Settings('t.k');
  assert.equal(s2.get('tempoRange'), 0.16);
  assert.equal(s2.get('xfadeCurve'), DEFAULTS.xfadeCurve);
});
