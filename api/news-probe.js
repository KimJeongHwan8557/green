"use strict";

const crypto = require("crypto");

const URL_ENV_NAMES = [
  "NEWS_APPS_SCRIPT_URL",
  "NEWS_APPS_SCRIPT_WEB_APP_URL",
  "APPS_SCRIPT_WEB_APP_URL",
  "APPS_SCRIPT_URL",
  "GOOGLE_APPS_SCRIPT_URL"
];
const TOKEN_ENV_NAMES = [
  "NEWS_DASHBOARD_API_TOKEN",
  "NEWS_API_TOKEN",
  "DASHBOARD_API_TOKEN",
  "APPS_SCRIPT_API_TOKEN"
];

function first(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: "", value: "" };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const urlConfig = first(URL_ENV_NAMES);
  const tokenConfig = first(TOKEN_ENV_NAMES);
  if (!urlConfig.value || !tokenConfig.value) {
    return res.status(500).json({ ok: false, missingConfig: true });
  }

  try {
    const upstreamUrl = new URL(urlConfig.value);
    const match = upstreamUrl.pathname.match(/\/macros\/s\/([^/]+)\/exec$/);
    const deploymentId = match ? match[1] : "";
    const nonce = String(Date.now());
    upstreamUrl.searchParams.set("token", tokenConfig.value);
    upstreamUrl.searchParams.set("refresh", nonce);
    upstreamUrl.searchParams.set("_", nonce);

    const startedAt = Date.now();
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      cache: "no-store"
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_error) {}

    return res.status(200).json({
      ok: true,
      configuredEnvName: urlConfig.name,
      urlFingerprint: crypto.createHash("sha256").update(urlConfig.value).digest("hex").slice(0, 12),
      deploymentIdPrefix: deploymentId ? deploymentId.slice(0, 14) : "",
      deploymentIdSuffix: deploymentId ? deploymentId.slice(-14) : "",
      upstreamStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      updatedAt: String(data?.updatedAt || ""),
      itemCount: Array.isArray(data?.items) ? data.items.length : null,
      upstreamKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
      upstreamError: String(data?.error || "")
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
