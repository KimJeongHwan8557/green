"use strict";

const { requireAuth, setPrivateNoStore } = require("./_lib/auth");

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

const MEMORY_CACHE_MS = 60 * 1000;
let memoryCache = { expiresAt: 0, payload: null };

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: "", value: "" };
}

function forceRefreshRequested(req) {
  const value = req?.query?.refresh;
  return value === "1" || value === "true" || value === "yes";
}

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: controller.signal
    });
    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      return { response, raw, data: null };
    }
    return { response, raw, data };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  setPrivateNoStore(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const urlConfig = firstConfiguredEnv(URL_ENV_NAMES);
  const tokenConfig = firstConfiguredEnv(TOKEN_ENV_NAMES);
  const missing = [];
  if (!urlConfig.value) missing.push(`뉴스 Apps Script URL (${URL_ENV_NAMES.join(" 또는 ")})`);
  if (!tokenConfig.value) missing.push(`뉴스 API 토큰 (${TOKEN_ENV_NAMES.join(" 또는 ")})`);

  if (missing.length) {
    return res.status(500).json({
      error: "뉴스 API 환경변수가 없습니다.",
      missing
    });
  }

  const forceRefresh = forceRefreshRequested(req);
  if (!forceRefresh && memoryCache.payload && memoryCache.expiresAt > Date.now()) {
    res.setHeader("X-Data-Cache", "memory-hit");
    return res.status(200).json(memoryCache.payload);
  }

  try {
    const upstreamUrl = new URL(urlConfig.value);
    if (!/^https?:$/.test(upstreamUrl.protocol)) {
      return res.status(500).json({ error: "뉴스 Apps Script URL 형식이 올바르지 않습니다." });
    }
    upstreamUrl.searchParams.set("token", tokenConfig.value);
    if (forceRefresh) upstreamUrl.searchParams.set("refresh", String(Date.now()));

    const { response, raw, data } = await fetchJsonWithTimeout(upstreamUrl);
    if (!data) {
      return res.status(502).json({
        error: "뉴스 Apps Script 응답을 JSON으로 해석하지 못했습니다.",
        preview: raw.slice(0, 240)
      });
    }

    if (!response.ok || data.error) {
      return res.status(502).json({
        error: data.error || `뉴스 Apps Script 오류 HTTP ${response.status}`,
        detail: data
      });
    }

    const payload = {
      updatedAt: String(data.updatedAt || ""),
      items: Array.isArray(data.items) ? data.items : []
    };
    memoryCache = { expiresAt: Date.now() + MEMORY_CACHE_MS, payload };
    res.setHeader("X-Data-Cache", "upstream");
    return res.status(200).json(payload);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? "뉴스 API 연결 시간이 초과되었습니다." : "뉴스 API 연결 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
