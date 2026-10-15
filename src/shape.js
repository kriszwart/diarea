/* The shape of a JSON value: its key paths, never its values.
 *
 * Collectors turn API responses and hydration payloads into shapes such as
 * ["user.email", "projects[].costPrice"], and checks.js decides which field
 * names are telling. Values are dropped here, before anything reaches a
 * report, so a response full of personal data is judged by its field names
 * alone. "[]" marks an array of two or more records (other people's data);
 * a single record is "[0]".
 *
 * Node only. collect-page.js carries its own copy of this walk, because it
 * runs inside the page and cannot import anything.
 */

export function keyPaths(value, { maxKeys = 400, maxDepth = 8 } = {}) {
  const out = new Set();
  const walk = (v, at, depth) => {
    if (out.size >= maxKeys || depth > maxDepth || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const records = v.filter((x) => x && typeof x === "object").slice(0, 3);
      for (const r of records) walk(r, at + (v.length > 1 ? "[]" : "[0]"), depth + 1);
      return;
    }
    for (const k of Object.keys(v).slice(0, 200)) {
      const p = at ? at + "." + k : k;
      out.add(p);
      walk(v[k], p, depth + 1);
    }
  };
  walk(value, "", 0);
  return Array.from(out);
}
