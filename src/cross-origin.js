/* Scripts a page loads from other origins, and which of them are the site's own.
 *
 * Plenty of sites serve their bundles from a CDN host (cdn.example.com,
 * d123.cloudfront.net) rather than the page's origin. Those files are the
 * site's own code and can leak like any other, but the page cannot read them
 * across origins. The extension asks for permission to read them (and only
 * them); the live CLI reads them from Node. Third-party scripts (analytics,
 * payment widgets, libraries on public CDNs) are not the site's code, so they
 * are left alone: judging them would only blame you for someone else's bundle.
 *
 * Pure helpers, no DOM, no Node: the extension and the CLI share this file.
 */

// Hosting CDNs whose hostnames do not share the site's domain, but whose
// files are almost always the site's own build.
const HOSTING_CDNS = ["cloudfront.net", "azureedge.net", "akamaized.net", "b-cdn.net", "r2.dev"];
// Second-level labels used under country codes: example.co.uk, example.com.my.
const SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu|ltd|plc|sch|nhs|ne|or|go)$/;

const isIp = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");

/** The registrable domain of a hostname, near enough: "cdn.example.co.uk" -> "example.co.uk". */
export function baseDomain(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (isIp(h)) return h;
  const parts = h.split(".");
  const n = parts.length;
  if (n <= 2) return h;
  if (parts[n - 1].length === 2 && SECOND_LEVEL.test(parts[n - 2])) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/** True when a script host is the site's own: the same domain, or a hosting CDN. */
export function isRelatedHost(pageHost, scriptHost) {
  const s = String(scriptHost).toLowerCase();
  return baseDomain(pageHost) === baseDomain(s) || HOSTING_CDNS.some((c) => s === c || s.endsWith("." + c));
}

/**
 * Group a page's cross-origin script URLs by origin.
 * @returns {{related: {origin, urls}[], other: {origin, urls}[]}}
 */
export function crossOriginScripts(pageUrl, srcs) {
  let page;
  try { page = new URL(pageUrl); } catch { return { related: [], other: [] }; }
  const groups = new Map();
  for (const src of srcs || []) {
    let u;
    try { u = new URL(src, page); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.origin === page.origin) continue;
    if (!groups.has(u.origin)) groups.set(u.origin, { origin: u.origin, host: u.hostname, urls: [] });
    const g = groups.get(u.origin);
    if (!g.urls.includes(u.href)) g.urls.push(u.href);
  }
  const all = Array.from(groups.values());
  const strip = ({ origin, urls }) => ({ origin, urls });
  return {
    related: all.filter((g) => isRelatedHost(page.hostname, g.host)).map(strip),
    other: all.filter((g) => !isRelatedHost(page.hostname, g.host)).map(strip),
  };
}

/** Where a script's source map would be: its SourceMap header, or the file name plus .map. */
export function mapUrlFor(scriptUrl, header) {
  const m = new URL(header || scriptUrl, scriptUrl);
  if (!header) { m.search = ""; m.hash = ""; m.pathname += ".map"; }
  return m.href;
}

/** True when a response body is a source map, not an HTML fallback page. */
export function isSourceMap(body) {
  return /^\s*(?:\)\]\}'[^\n]*\n)?\s*\{/.test(body || "") && /"sources"\s*:/.test(body || "");
}
