// src/utils/filters.js
/**
 * Builds a raw Galaxy filters query segment.
 * Example: buildRawFilter("AFFILIATES_REVNUM", 5339779, "GreaterOrEqual")
 * => `[{AFFILIATES_REVNUM:[5339779,GreaterOrEqual]}]`
 */
function buildRawFilter(field, value, op) {
  const isNum = Number.isFinite(value);
  const val = isNum ? value : `"${String(value)}"`;
  return `[{${field}:[${val},${op}]}]`;
}

module.exports = { buildRawFilter };
