"use strict";

const {
  requireAuth,
  setPrivateDataCache,
  setPrivateNoStore
} = require("./_lib/auth");

const URL_ENV_NAMES = [
  "LEADER_SPEECH_APPS_SCRIPT_URL"
];

const TOKEN_ENV_NAMES = [
  "LEADER_SPEECH_DASHBOARD_API_TOKEN",
  "DASHBOARD_API_TOKEN"
];

// 브라우저 캐시가 화면 이동 속도를 담당하므로 서버 메모리는 짧게 유지합니다.
const MEMORY_CACHE_MS = 5 * 60 * 1000;
const BROWSER_MAX_AGE_SECONDS = 5 * 60;
const BROWSER_STALE_SECONDS = 0;
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

function backgroundRevalidationRequested(req) {
  const value = req?.query?.revalidate;
  return value === "1" || value === "true" || value === "yes";
}

function sendNoStore(res, status, payload) {
  setPrivateNoStore(res);
  return res.status(status).json(payload);
}

function sendSuccess(res, payload, cacheLabel) {
  setPrivateDataCache(res, {
    maxAgeSeconds: BROWSER_MAX_AGE_SECONDS,
    staleWhileRevalidateSeconds: BROWSER_STALE_SECONDS
  });
  res.setHeader("X-Data-Cache", cacheLabel);
  return res.status(200).json(payload);
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendNoStore(res, 405, { error: "method_not_allowed" });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const urlConfig = firstConfiguredEnv(URL_ENV_NAMES);
  const tokenConfig = firstConfiguredEnv(TOKEN_ENV_NAMES);
  const missing = [];
  if (!urlConfig.value) missing.push("LEADER_SPEECH_APPS_SCRIPT_URL");
  if (!tokenConfig.value) missing.push("LEADER_SPEECH_DASHBOARD_API_TOKEN 또는 DASHBOARD_API_TOKEN");

  if (missing.length) {
    return sendNoStore(res, 500, {
      error: "주요 발언 API 환경변수가 없습니다.",
      missing
    });
  }

  const forceRefresh = forceRefreshRequested(req);
  const backgroundRevalidation = backgroundRevalidationRequested(req);
  if (!forceRefresh && memoryCache.payload && memoryCache.expiresAt > Date.now()) {
    return sendSuccess(res, memoryCache.payload, "memory-hit");
  }

  try {
    const upstreamUrl = new URL(urlConfig.value);
    if (!/^https?:$/.test(upstreamUrl.protocol)) {
      return sendNoStore(res, 500, { error: "주요 발언 Apps Script URL 형식이 올바르지 않습니다." });
    }
    upstreamUrl.searchParams.set("token", tokenConfig.value);
    if (forceRefresh) {
      const nonce = String(Date.now());
      upstreamUrl.searchParams.set("refresh", nonce);
      upstreamUrl.searchParams.set("_", nonce);
    }

    const { response, raw, data } = await fetchJsonWithTimeout(upstreamUrl);
    if (!data) {
      return sendNoStore(res, 502, {
        error: "주요 발언 Apps Script 응답을 JSON으로 해석하지 못했습니다.",
        preview: raw.slice(0, 240)
      });
    }

    if (!response.ok || data.error) {
      return sendNoStore(res, 502, {
        error: data.error || `주요 발언 Apps Script 오류 HTTP ${response.status}`,
        detail: data
      });
    }

    const payload = {
      updatedAt: String(data.updatedAt || ""),
      items: Array.isArray(data.items) ? data.items : []
    };
    memoryCache = { expiresAt: Date.now() + MEMORY_CACHE_MS, payload };
    return sendSuccess(
      res,
      payload,
      forceRefresh ? "forced-upstream" : (backgroundRevalidation ? "background-upstream" : "upstream")
    );
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return sendNoStore(res, timedOut ? 504 : 500, {
      error: timedOut ? "주요 발언 API 연결 시간이 초과되었습니다." : "주요 발언 API 연결 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
