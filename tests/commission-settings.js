'use strict';

const assert = require('node:assert/strict');
const {
  defaultCommissionSettings,
  validateCommissionSettings,
  parseCommissionSettings,
  calculateCommissionPercent,
  serializeCommissionSettings
} = require('../commission-settings');

const presetA = validateCommissionSettings('A');
assert.equal(presetA.mode, 'preset');
assert.equal(calculateCommissionPercent(presetA, 2), 0);
assert.equal(calculateCommissionPercent(presetA, 3), 18);
assert.equal(calculateCommissionPercent(presetA, 16), 25);
assert.equal(calculateCommissionPercent(presetA, 91), 50);
assert.equal(calculateCommissionPercent({ ...defaultCommissionSettings(), preset: 'ATW' }, 100), 20);

const manual = { ...defaultCommissionSettings(), mode: 'manual', manualPercent: 27.5 };
assert.equal(calculateCommissionPercent(manual, 12), 27.5);

const automatic = {
  ...defaultCommissionSettings(),
  mode: 'auto',
  auto: { baseCartelas: 3, basePercent: 20, incrementPercent: 2 }
};
assert.equal(calculateCommissionPercent(automatic, 3), 20);
assert.equal(calculateCommissionPercent(automatic, 8), 30);
assert.equal(calculateCommissionPercent(automatic, 100), 100, 'automatic commission must be capped at 100%');

const interval = {
  ...defaultCommissionSettings(),
  mode: 'interval',
  interval: {
    rules: [
      { min: 1, max: 5, percent: 10 },
      { min: 6, max: 10, percent: 25 },
      { min: 20, max: null, percent: 40 }
    ],
    fallbackPercent: 7
  }
};
assert.equal(calculateCommissionPercent(interval, 4), 10);
assert.equal(calculateCommissionPercent(interval, 8), 25);
assert.equal(calculateCommissionPercent(interval, 15), 7);
assert.equal(calculateCommissionPercent(interval, 50), 40);

assert.throws(
  () => validateCommissionSettings({
    ...interval,
    interval: {
      rules: [
        { min: 1, max: 10, percent: 10 },
        { min: 10, max: 20, percent: 20 }
      ],
      fallbackPercent: 0
    }
  }),
  /cannot overlap/i
);
assert.throws(
  () => validateCommissionSettings({ ...manual, manualPercent: 101 }),
  /between 0% and 100%/i
);
assert.throws(() => calculateCommissionPercent(interval, 0), /whole number between 1 and 10000/i);

const serialized = serializeCommissionSettings(interval);
assert.deepEqual(parseCommissionSettings(serialized), validateCommissionSettings(interval));
assert.deepEqual(parseCommissionSettings('not-valid'), defaultCommissionSettings(), 'bad legacy data must fail closed to the default');

console.log('commission settings passed (preset, manual, automatic, custom ranges, validation)');
