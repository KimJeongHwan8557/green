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

async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
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

function buildUpstreamUrl(urlValue, tokenValue) {
  const upstreamUrl = new URL(urlValue);
  if (!/^https?:$/.test(upstreamUrl.protocol)) {
    throw new Error("invalid_apps_script_url");
  }
  const nonce = String(Date.now());
  upstreamUrl.searchParams.set("token", tokenValue);
  // Vercel 메모리 캐시가 없을 때는 Apps Script CacheService를 우회해
  // 현재 배포된 웹앱이 실제 시트를 한 번만 읽도록 합니다.
  upstreamUrl.searchParams.set("refresh", nonce);
  upstreamUrl.searchParams.set("_", nonce);
  return upstreamUrl;
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
  if (!urlConfig.value) missing.push("뉴스 Apps Script URL");
  if (!tokenConfig.value) missing.push("뉴스 API 토큰");

  if (missing.length) {
    console.error("[api/news] missing environment", { missing });
    return sendNoStore(res, 500, {
      error: "뉴스 API 환경변수가 없습니다.",
      missing
    });
  }

  const forceRefresh = forceRefreshRequested(req);
  const cachedItems = Array.isArray(memoryCache.payload?.items) ? memoryCache.payload.items : [];
  if (!forceRefresh && cachedItems.length > 0 && memoryCache.expiresAt > Date.now()) {
    console.log("[api/news] memory hit", { itemCount: cachedItems.length });
    return sendSuccess(res, memoryCache.payload, "memory-hit");
  }

  const startedAt = Date.now();
  try {
    const upstreamUrl = buildUpstreamUrl(urlConfig.value, tokenConfig.value);
    const upstream = await fetchJsonWithTimeout(upstreamUrl);
    const elapsedMs = Date.now() - startedAt;

    if (!upstream.data) {
      console.error("[api/news] upstream invalid json", {
        status: upstream.response.status,
        elapsedMs,
        preview: upstream.raw.slice(0, 120)
      });
      return sendNoStore(res, 502, {
        error: "뉴스 Apps Script 응답을 JSON으로 해석하지 못했습니다."
      });
    }

    if (!upstream.response.ok || upstream.data.error) {
      console.error("[api/news] upstream error", {
        status: upstream.response.status,
        elapsedMs,
        upstreamError: upstream.data.error || ""
      });
      return sendNoStore(res, 502, {
        error: upstream.data.error || `뉴스 Apps Script 오류 HTTP ${upstream.response.status}`
      });
    }

    const payload = normalizePayload(upstream.data);
    console.log("[api/news] upstream success", {
      elapsedMs,
      itemCount: payload.items.length,
      schemaVersion: payload.schemaVersion,
      updatedAt: payload.updatedAt
    });

    // News_db에는 데이터가 존재하는 운영 시스템이므로 0건은 정상 상태로 캐시하지 않습니다.
    // 가장 흔한 원인은 Apps Script 코드를 저장만 하고 버전형 웹앱 배포를 갱신하지 않은 경우입니다.
    if (payload.items.length === 0) {
      memoryCache = { expiresAt: 0, payload: null };
      console.error("[api/news] upstream returned zero items; check Apps Script web app deployment version");
      return sendNoStore(res, 502, {
        error: "Apps Script 뉴스 응답이 0건입니다. Apps Script의 배포 > 배포 관리에서 웹앱을 최신 코드 버전으로 갱신해 주세요."
      });
    }

    memoryCache = { expiresAt: Date.now() + MEMORY_CACHE_MS, payload };
    return sendSuccess(res, payload, forceRefresh ? "forced-upstream" : "upstream-fresh");
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const timedOut = error?.name === "AbortError";
    console.error("[api/news] request failed", {
      elapsedMs,
      name: error?.name || "",
      message: error instanceof Error ? error.message : String(error)
    });
    if (error?.message === "invalid_apps_script_url") {
      return sendNoStore(res, 500, { error: "뉴스 Apps Script URL 형식이 올바르지 않습니다." });
    }
    return sendNoStore(res, timedOut ? 504 : 500, {
      error: timedOut ? "뉴스 API 연결 시간이 초과되었습니다." : "뉴스 API 연결 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
