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

// 한 글자 성은 물론 대표적인 복성 약칭도 동일 인물 판별에 사용할 수 있습니다.
const COMPOUND_SURNAMES = new Set([
  "남궁", "황보", "제갈", "선우", "독고", "사공", "서문"
]);

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

function cleanText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeRole(item) {
  const speaker = cleanText(item?.speaker);
  const position = cleanText(item?.position);
  const value = `${speaker} ${position}`.trim();

  if (/대통령/.test(value)) return "대통령";

  if (/국무총리/.test(value) || (!/부총리/.test(value) && /(^|\s)총리(?=\s|$)/.test(value))) {
    return "국무총리";
  }

  if (/부총리/.test(value)) {
    if (/경제/.test(value)) return "경제부총리";
    if (/사회/.test(value)) return "사회부총리";
    return "부총리";
  }

  const ministerMatch = value.match(/([가-힣A-Za-z·]+부)\s*장관/);
  if (ministerMatch) return `${ministerMatch[1]} 장관`;
  if (/장관/.test(value)) return "장관";

  return position;
}

function roleFamily(role) {
  if (role === "대통령") return "대통령";
  if (role === "국무총리") return "국무총리";
  if (/부총리$/.test(role)) return "부총리";
  if (/장관$/.test(role)) return "장관";
  return role;
}

function rolesCompatible(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;

  const leftFamily = roleFamily(left);
  const rightFamily = roleFamily(right);
  if (leftFamily !== rightFamily) return false;

  if (leftFamily === "장관") {
    return left === "장관" || right === "장관";
  }

  if (leftFamily === "부총리") {
    return left === "부총리" || right === "부총리";
  }

  return false;
}

function extractSpeakerName(item, role) {
  const speaker = cleanText(item?.speaker);
  if (!speaker) return "";

  const titled = speaker.match(
    /^([가-힣]{1,4})\s*(?=대통령|국무총리|총리|(?:경제|사회)?부총리|(?:[가-힣A-Za-z·]+부\s*)?장관)/
  );
  if (titled) return titled[1];

  if (role && /^[가-힣]{1,4}$/.test(speaker)) return speaker;
  return "";
}

function isAbbreviatedName(name) {
  return /^[가-힣]$/.test(name) || COMPOUND_SURNAMES.has(name);
}

function roleSpecificity(role) {
  if (!role) return 0;
  if (role === "장관" || role === "부총리") return 1;
  if (role === "대통령" || role === "국무총리") return 3;
  if (/부총리$/.test(role) || /장관$/.test(role)) return 3;
  return 2;
}

function buildCanonicalSpeaker(name, role, fallback) {
  if (name && role) return `${name} ${role}`;
  return cleanText(fallback);
}

function chooseFullCandidate(current, entries) {
  const candidates = entries.filter((candidate) => {
    if (!candidate.name || isAbbreviatedName(candidate.name)) return false;
    if (!candidate.name.startsWith(current.name)) return false;
    return rolesCompatible(current.role, candidate.role);
  });

  if (!candidates.length) return null;

  const byName = new Map();
  for (const candidate of candidates) {
    if (!byName.has(candidate.name)) byName.set(candidate.name, []);
    byName.get(candidate.name).push(candidate);
  }

  // 같은 성·직위에 서로 다른 전체 이름이 둘 이상이면 자동 통합하지 않습니다.
  if (byName.size !== 1) return null;

  const samePersonCandidates = [...byName.values()][0];
  const specificRoles = new Set(
    samePersonCandidates
      .map((candidate) => candidate.role)
      .filter((role) => roleSpecificity(role) > 1)
  );

  // 동일 이름이라도 서로 다른 구체 직위를 가진 기록이 섞여 있고
  // 현재 약칭 직위가 이를 구분하지 못하면 잘못 합치지 않습니다.
  if (specificRoles.size > 1 && roleSpecificity(current.role) <= 1) return null;

  const exactRole = samePersonCandidates.find((candidate) => candidate.role === current.role);
  if (exactRole) return exactRole;

  return samePersonCandidates
    .slice()
    .sort((a, b) => roleSpecificity(b.role) - roleSpecificity(a.role))[0];
}

function normalizeSpeakerAliases(items) {
  if (!Array.isArray(items) || !items.length) return [];

  const entries = items.map((item, index) => {
    const role = normalizeRole(item);
    return {
      index,
      item,
      speaker: cleanText(item?.speaker),
      position: cleanText(item?.position),
      role,
      name: extractSpeakerName(item, role)
    };
  });

  return items.map((item, index) => {
    const current = entries[index];
    if (!current.name || !current.role) return item;

    let target = current;

    if (isAbbreviatedName(current.name)) {
      const matched = chooseFullCandidate(current, entries);
      if (!matched) {
        const standardized = buildCanonicalSpeaker(current.name, current.role, current.speaker);
        return standardized && standardized !== current.speaker
          ? { ...item, speaker: standardized }
          : item;
      }
      target = matched;
    } else {
      const sameNameCandidates = entries
        .filter((candidate) => candidate.name === current.name && rolesCompatible(current.role, candidate.role))
        .sort((a, b) => roleSpecificity(b.role) - roleSpecificity(a.role));
      if (sameNameCandidates.length) target = sameNameCandidates[0];
    }

    const canonicalSpeaker = buildCanonicalSpeaker(target.name, target.role, target.speaker);
    return canonicalSpeaker && canonicalSpeaker !== cleanText(item?.speaker)
      ? { ...item, speaker: canonicalSpeaker }
      : item;
  });
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

    const sourceItems = Array.isArray(data.items) ? data.items : [];
    const payload = {
      updatedAt: String(data.updatedAt || ""),
      items: normalizeSpeakerAliases(sourceItems)
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
