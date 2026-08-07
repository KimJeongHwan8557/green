"use strict";

const crypto = require("crypto");

const CURRENT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_5tUCTfFRgrHPl1GUf7smUziDumQx4bxx2AACa8SLiXFDiv4_scC0A5lfSq6X9ACweA/exec";
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
  const tokenConfig = first(TOKEN_ENV_NAMES);
  if (!tokenConfig.value) {
    return res.status(500).json({ ok: false, missingConfig: true });
  }

  try {
    const upstreamUrl = new URL(CURRENT_APPS_SCRIPT_URL);
    const match = upstreamUrl.pathname.match(/\/macros\/s\/([^/]+)\/exec$/);
    const deploymentId = match ? match[1] : "";
    const nonce = String(Date.now());
    upstreamUrl.searchParams.set("token", tokenConfig.value);
    upstreamUrl.searchParams.set("refresh", nonce);
    upstreamUrl.searchParams.set("debug", "1");
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

    const debug = data && typeof data.debug === "object" ? data.debug : null;
    return res.status(200).json({
      ok: true,
      urlFingerprint: crypto.createHash("sha256").update(CURRENT_APPS_SCRIPT_URL).digest("hex").slice(0, 12),
      deploymentIdPrefix: deploymentId ? deploymentId.slice(0, 14) : "",
      deploymentIdSuffix: deploymentId ? deploymentId.slice(-14) : "",
      upstreamStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      apiVersion: String(data?.apiVersion || ""),
      updatedAt: String(data?.updatedAt || ""),
      itemCount: Array.isArray(data?.items) ? data.items.length : null,
      debug: debug ? {
        spreadsheetIdSuffix: String(debug.spreadsheetIdSuffix || ""),
        spreadsheetName: String(debug.spreadsheetName || ""),
        sheetName: String(debug.sheetName || ""),
        sheetId: debug.sheetId ?? null,
        lastRow: debug.lastRow ?? null,
        lastColumn: debug.lastColumn ?? null,
        dataRangeRows: debug.dataRangeRows ?? null,
        dataRangeColumns: debug.dataRangeColumns ?? null,
        headerA: String(debug.headerA || ""),
        headerD: String(debug.headerD || ""),
        headerQ: String(debug.headerQ || ""),
        nonEmptyRowCount: debug.nonEmptyRowCount ?? null,
        titleRowCount: debug.titleRowCount ?? null,
        itemCount: debug.itemCount ?? null,
        firstTitle: String(debug.firstTitle || "").slice(0, 80),
        lastTitle: String(debug.lastTitle || "").slice(0, 80)
      } : null,
      upstreamKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
      upstreamError: String(data?.error || "")
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
