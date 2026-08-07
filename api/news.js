"use strict";

const {
  requireAuth,
  setPrivateDataCache,
  setPrivateNoStore
} = require("./_lib/auth");

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

const MEMORY_CACHE_MS = 5 * 60 * 1000;
const BROWSER_MAX_AGE_SECONDS = 60;
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
  res.setHeader("X-News-Item-Count", String(Array.isArray(payload?.items) ? payload.items.length : 0));
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
      signal: controller.signal,
      cache: "no-store"
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

function buildUpstreamUrl(urlValue, tokenValue, forceRefresh) {
  const upstreamUrl = new URL(urlValue);
  if (!/^https?:$/.test(upstreamUrl.protocol)) {
    throw new Error("invalid_apps_script_url");
  }
  upstreamUrl.searchParams.set("token", tokenValue);
  if (forceRefresh) {
    const nonce = String(Date.now());
    upstreamUrl.searchParams.set("refresh", nonce);
    upstreamUrl.searchParams.set("_", nonce);
  }
  return upstreamUrl;
}

async function requestUpstream(urlValue, tokenValue, forceRefresh) {
  const upstreamUrl = buildUpstreamUrl(urlValue, tokenValue, forceRefresh);
  return fetchJsonWithTimeout(upstreamUrl);
}

function normalizePayload(data) {
  return {
    schemaVersion: 4,
    updatedAt: String(data?.updatedAt || ""),
    items: Array.isArray(data?.items) ? data.items : []
  };
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
  if (!urlConfig.value) missing.push("뉴스 Apps Script URL (NEWS_APPS_SCRIPT_URL 또는 NEWS_APPS_SCRIPT_WEB_APP_URL 또는 APPS_SCRIPT_URL)");
  if (!tokenConfig.value) missing.push("뉴스 API 토큰 (NEWS_DASHBOARD_API_TOKEN 또는 NEWS_API_TOKEN 또는 DASHBOARD_API_TOKEN)");

  if (missing.length) {
    return sendNoStore(res, 500, {
      error: "뉴스 API 환경변수가 없습니다.",
      missing
    });
  }

  const forceRefresh = forceRefreshRequested(req);
  const backgroundRevalidation = backgroundRevalidationRequested(req);
  const cachedItems = Array.isArray(memoryCache.payload?.items) ? memoryCache.payload.items : [];
  if (!forceRefresh && cachedItems.length > 0 && memoryCache.expiresAt > Date.now()) {
    return sendSuccess(res, memoryCache.payload, "memory-hit");
  }

  try {
    let upstream = await requestUpstream(urlConfig.value, tokenConfig.value, forceRefresh);

    if (!upstream.data) {
      return sendNoStore(res, 502, {
        error: "뉴스 Apps Script 응답을 JSON으로 해석하지 못했습니다.",
        preview: upstream.raw.slice(0, 240)
      });
    }

    if (!upstream.response.ok || upstream.data.error) {
      return sendNoStore(res, 502, {
        error: upstream.data.error || `뉴스 Apps Script 오류 HTTP ${upstream.response.status}`,
        detail: upstream.data
      });
    }

    let payload = normalizePayload(upstream.data);
    let cacheLabel = forceRefresh ? "forced-upstream" : (backgroundRevalidation ? "background-upstream" : "upstream");

    // 시트 구조 변경 직후 Apps Script CacheService가 빈 배열을 돌려주는 경우가 있어
    // 일반 조회가 0건이면 한 번 강제 새로고침하여 실제 시트를 다시 읽습니다.
    if (!forceRefresh && payload.items.length === 0) {
      const retry = await requestUpstream(urlConfig.value, tokenConfig.value, true);
      if (retry.data && retry.response.ok && !retry.data.error) {
        const retryPayload = normalizePayload(retry.data);
        if (retryPayload.items.length > 0) {
          payload = retryPayload;
          cacheLabel = "empty-retry-recovered";
        }
      }
    }

    // 빈 응답은 서버 메모리 캐시를 오염시키지 않습니다.
    if (payload.items.length > 0) {
      memoryCache = { expiresAt: Date.now() + MEMORY_CACHE_MS, payload };
    } else {
      memoryCache = { expiresAt: 0, payload: null };
    }

    return sendSuccess(res, payload, cacheLabel);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    if (error?.message === "invalid_apps_script_url") {
      return sendNoStore(res, 500, { error: "뉴스 Apps Script URL 형식이 올바르지 않습니다." });
    }
    return sendNoStore(res, timedOut ? 504 : 500, {
      error: timedOut ? "뉴스 API 연결 시간이 초과되었습니다." : "뉴스 API 연결 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
