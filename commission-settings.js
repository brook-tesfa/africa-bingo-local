'use strict';

const PRESET_COMMISSION_CONFIGS = Object.freeze({
  A: Object.freeze({ minValues: [1, 3, 16, 41, 91], maxValues: [2, 15, 40, 90, 150], percentages: [0, 18, 25, 30, 50] }),
  O: Object.freeze({ minValues: [1, 3, 20, 50, 100], maxValues: [2, 19, 49, 99, 200], percentages: [0, 10, 15, 20, 30] }),
  TG: Object.freeze({ minValues: [1, 3, 10, 30, 70], maxValues: [2, 9, 29, 69, 140], percentages: [0, 25, 35, 45, 70] }),
  AT: Object.freeze({ minValues: [1, 3, 16, 41, 91], maxValues: [2, 15, 40, 90, 150], percentages: [30, 30, 30, 30, 30] }),
  AE: Object.freeze({ minValues: [1, 3, 16, 41, 91], maxValues: [2, 15, 40, 90, 150], percentages: [18, 18, 18, 18, 18] }),
  ATW: Object.freeze({ minValues: [1, 3, 16, 41, 91], maxValues: [2, 15, 40, 90, 150], percentages: [20, 20, 20, 20, 20] })
});

const DEFAULT_INTERVAL_RULES = Object.freeze([
  Object.freeze({ min: 1, max: 5, percent: 20 }),
  Object.freeze({ min: 6, max: 10, percent: 25 }),
  Object.freeze({ min: 11, max: 20, percent: 30 }),
  Object.freeze({ min: 21, max: 30, percent: 35 }),
  Object.freeze({ min: 31, max: 50, percent: 40 }),
  Object.freeze({ min: 51, max: null, percent: 50 })
]);

function defaultCommissionSettings() {
  return {
    v: 1,
    mode: 'preset',
    preset: 'A',
    manualPercent: 20,
    auto: { baseCartelas: 1, basePercent: 20, incrementPercent: 1 },
    interval: {
      rules: DEFAULT_INTERVAL_RULES.map(rule => ({ ...rule })),
      fallbackPercent: 20
    }
  };
}

function requirePercent(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${label} must be between 0% and 100%.`);
  }
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function validateCommissionSettings(input) {
  if (typeof input === 'string') {
    const clean = input.trim();
    if (Object.hasOwn(PRESET_COMMISSION_CONFIGS, clean)) {
      return { ...defaultCommissionSettings(), preset: clean };
    }
    try {
      input = JSON.parse(clean);
    } catch {
      throw new Error('Invalid commission settings.');
    }
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid commission settings.');
  }

  const defaults = defaultCommissionSettings();
  const mode = String(input.mode || defaults.mode);
  if (!['preset', 'manual', 'auto', 'interval'].includes(mode)) {
    throw new Error('Invalid commission mode.');
  }

  const preset = String(input.preset || defaults.preset);
  if (!Object.hasOwn(PRESET_COMMISSION_CONFIGS, preset)) {
    throw new Error('Invalid commission preset.');
  }

  const autoInput = input.auto || defaults.auto;
  const baseCartelas = Number(autoInput.baseCartelas);
  if (!Number.isInteger(baseCartelas) || baseCartelas < 1 || baseCartelas > 10000) {
    throw new Error('Base Cartela Count must be a whole number between 1 and 10000.');
  }

  const intervalInput = input.interval || defaults.interval;
  if (!Array.isArray(intervalInput.rules) || intervalInput.rules.length < 1 || intervalInput.rules.length > 100) {
    throw new Error('Add between 1 and 100 custom cartela ranges.');
  }

  const rules = intervalInput.rules.map((rule, index) => {
    const min = Number(rule?.min);
    const rawMax = rule?.max;
    const max = rawMax === null || rawMax === '' || rawMax === undefined ? null : Number(rawMax);
    if (!Number.isInteger(min) || min < 1 || min > 10000) {
      throw new Error(`Range ${index + 1}: From must be a whole number between 1 and 10000.`);
    }
    if (max !== null && (!Number.isInteger(max) || max < min || max > 10000)) {
      throw new Error(`Range ${index + 1}: To must be blank or a whole number from ${min} to 10000.`);
    }
    return {
      min,
      max,
      percent: requirePercent(rule?.percent, `Range ${index + 1} commission`)
    };
  }).sort((a, b) => a.min - b.min);

  for (let index = 1; index < rules.length; index += 1) {
    const previous = rules[index - 1];
    const current = rules[index];
    if (previous.max === null || current.min <= previous.max) {
      throw new Error('Custom cartela ranges cannot overlap.');
    }
  }

  return {
    v: 1,
    mode,
    preset,
    manualPercent: requirePercent(input.manualPercent ?? defaults.manualPercent, 'Manual commission'),
    auto: {
      baseCartelas,
      basePercent: requirePercent(autoInput.basePercent, 'Base commission'),
      incrementPercent: requirePercent(autoInput.incrementPercent, 'Increase per extra cartela')
    },
    interval: {
      rules,
      fallbackPercent: requirePercent(intervalInput.fallbackPercent, 'Unmatched count commission')
    }
  };
}

function parseCommissionSettings(stored) {
  try {
    return validateCommissionSettings(stored || 'A');
  } catch {
    return defaultCommissionSettings();
  }
}

function calculateCommissionPercent(settingsInput, selectedCards) {
  const settings = validateCommissionSettings(settingsInput);
  const count = Number(selectedCards);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new Error('Selected cartela count must be a whole number between 1 and 10000.');
  }

  if (settings.mode === 'manual') return settings.manualPercent;
  if (settings.mode === 'auto') {
    const extra = Math.max(0, count - settings.auto.baseCartelas);
    return Math.min(100, Math.max(0, settings.auto.basePercent + (extra * settings.auto.incrementPercent)));
  }
  if (settings.mode === 'interval') {
    const match = settings.interval.rules.find(rule =>
      count >= rule.min && (rule.max === null || count <= rule.max)
    );
    return match ? match.percent : settings.interval.fallbackPercent;
  }

  const preset = PRESET_COMMISSION_CONFIGS[settings.preset];
  const index = preset.minValues.findIndex((min, itemIndex) =>
    count >= min && count <= preset.maxValues[itemIndex]
  );
  return index >= 0 ? preset.percentages[index] : 0;
}

function serializeCommissionSettings(settings) {
  return JSON.stringify(validateCommissionSettings(settings));
}

module.exports = {
  PRESET_COMMISSION_CONFIGS,
  DEFAULT_INTERVAL_RULES,
  defaultCommissionSettings,
  validateCommissionSettings,
  parseCommissionSettings,
  calculateCommissionPercent,
  serializeCommissionSettings
};
