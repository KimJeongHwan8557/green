"use strict";

const {
  requireAuth,
  setPrivateDataCache,
  setPrivateNoStore
} = require("./_lib/auth");

// 2026-08-07 새로 생성한 Apps Script v4.5 웹앱 배포.
// 기존 Vercel APPS_SCRIPT_URL이 오래된 배포를 가리키는 문제를 우회하기 위해
// 서버 코드에서 현재 정상 배포 URL을 우선 사용합니다. API 토큰은 계속 Vercel 비밀변수를 사용합니다.
const CURRENT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_5tUCTfFRgrHPl1GUf7smUziDumQx4bxx2AACa8SLiXFDiv4_scC0A5lfSq6X9ACweA/exec";

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
  upstreamUrl.searchParams.set("refresh", nonce);
  upstreamUrl.searchParams.set("_", nonce);
  return upstreamUrl;
}

function normalizePayload(data) {
  return {
    schemaVersion: 4,
    apiVersion: String(data?.apiVersion || ""),
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

  const tokenConfig = firstConfiguredEnv(TOKEN_ENV_NAMES);
  if (!tokenConfig.value) {
    console.error("[api/news] missing token environment");
    return sendNoStore(res, 500, {
      error: "뉴스 API 토큰 환경변수가 없습니다."
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
    const upstreamUrl = buildUpstreamUrl(CURRENT_APPS_SCRIPT_URL, tokenConfig.value);
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
      apiVersion: payload.apiVersion,
      updatedAt: payload.updatedAt
    });

    if (payload.items.length === 0) {
      memoryCache = { expiresAt: 0, payload: null };
      console.error("[api/news] upstream returned zero items", {
        apiVersion: payload.apiVersion,
        updatedAt: payload.updatedAt
      });
      return sendNoStore(res, 502, {
        error: "Apps Script 뉴스 응답이 0건입니다.",
        apiVersion: payload.apiVersion || "unknown"
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
