/* Posts the Leak Score on a pull request as one sticky comment, updated in
 * place on every push, with how the score moved since the last one.
 *
 * The comment is found by a hidden marker carrying a hash of the scan target
 * (so several Diarea steps in one workflow keep separate comments) and the
 * last score. Only comments written by a bot are updated, so a pasted marker
 * cannot get someone's comment overwritten. Failures never fail the build:
 * forked pull requests get a read-only token, and the job summary still has
 * the full report.
 */
import crypto from "node:crypto";

const MARKER = "<!-- diarea:leak-score";

export const keyOf = (target) =>
  crypto.createHash("sha256").update(String(target)).digest("hex").slice(0, 12);

export function markerFor(key, score) {
  return `${MARKER} key="${key}" score="${Number(score)}" -->`;
}

/** The last score recorded in a comment body for this key, or null. */
export function previousScore(body, key) {
  const m = String(body || "").match(/<!-- diarea:leak-score key="([0-9a-f]+)" score="(\d+)" -->/);
  return m && m[1] === key ? Number(m[2]) : null;
}

export function movement(prev, score) {
  if (prev == null) return "";
  if (score > prev) return `⬆️ **Up from ${prev}** (+${score - prev}) since the last push. Something started leaking.`;
  if (score < prev) return `⬇️ **Down from ${prev}** (${score - prev}) since the last push. Lovely wipe.`;
  return `➡️ Unchanged since the last push.`;
}

export function commentBody({ key, score, summary, sha }) {
  const foot = `<sub>Updated on every push${sha ? ` · last scan at ${String(sha).slice(0, 7)}` : ""} · ` +
    `[What is Diarea?](https://diarea.tools/)</sub>`;
  return `${markerFor(key, score)}\n${summary}\n${foot}\n`;
}

async function gh(fetchImpl, api, token, method, path, body) {
  const res = await fetchImpl(api + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${path} returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Create or update the sticky comment. render(prev) returns the body, so the
 * caller can mention the previous score. Resolves to { ok, action, prev } or
 * { ok: false, error }; never throws.
 */
export async function upsertComment({ api = "https://api.github.com", repo, pr, token, key, render, fetchImpl = fetch }) {
  try {
    let existing = null;
    for (let page = 1; page <= 20 && !existing; page++) {
      const batch = await gh(fetchImpl, api, token, "GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
      existing = batch.find((c) => c.user && c.user.type === "Bot" && previousScore(c.body, key) != null) || null;
      if (batch.length < 100) break;
    }
    const prev = existing ? previousScore(existing.body, key) : null;
    const body = render(prev);
    if (existing) {
      await gh(fetchImpl, api, token, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
      return { ok: true, action: "updated", prev };
    }
    await gh(fetchImpl, api, token, "POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    return { ok: true, action: "created", prev };
  } catch (error) {
    return { ok: false, error };
  }
}
