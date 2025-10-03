// src/utils/filters.js
/**
 * Filter Utility
 * --------------
 * Constructs raw Galaxy filter strings to be used in API queries.
 * Example:
 *   buildRawFilter("AFFILIATES_REVNUM", 5339779, "GreaterOrEqual")
 *   => `[{AFFILIATES_REVNUM:[5339779,GreaterOrEqual]}]`
 */

/**
 * Build raw Galaxy filter string
 * @param {string} field
 * @param {string|number} value
 * @param {string} op
 * @returns {string} Filter string
 */
function buildRawFilter(field, value, op) {
  const isNum = Number.isFinite(value);
  const val = isNum ? value : `"${String(value)}"`;
  return `[{${field}:[${val},${op}]}]`;
}

module.exports = { buildRawFilter };
