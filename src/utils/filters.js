// src/utils/filters.js
/**
 * Builds a raw Galaxy filters query segment. We keep it raw because
 * the backend expects the exact filter grammar (do NOT use axios params).
 */
function buildRawFilter(field, value, op) {
  // Example: `[{AFFILIATES_REVNUM:[123,GreaterOrEqual]}]`
  // Keep numbers as-is, strings quoted.
  const isNumber = typeof value === "number" && Number.isFinite(value);
  const val = isNumber ? value : `"${String(value)}"`;
  return `[{"${field}":[${val},${op}]}]`.replace(/"/g, ""); // Galaxy filter grammar is unquoted for op
}

module.exports = { buildRawFilter };
