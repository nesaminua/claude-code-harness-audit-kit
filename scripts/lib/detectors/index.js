'use strict';

const IDS = [
  'block-loop',
  'block-bypassed',
  'retry-verbatim',
  'tool-error-loop',
  'user-correction',
  'user-interrupt',
  'hook-error',
  'forbidden-pattern',
];

const allDetectors = IDS.map((id) => require(`./${id}`));

function enabledDetectors(config) {
  const wanted = config && Array.isArray(config.enabledDetectors) ? new Set(config.enabledDetectors) : null;
  return wanted ? allDetectors.filter((d) => wanted.has(d.id)) : allDetectors;
}

module.exports = { IDS, allDetectors, enabledDetectors };
