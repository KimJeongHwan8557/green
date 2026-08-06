const { isAuthorized } = require("./_auth");

const REQUEST_TIMEOUT_MS = 20000;

function text(value) {
  return value == null ? "" : String(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function normalizeItem(raw) {
  const item = raw && typeof raw === "object" ? raw : {};

  return {
    collectedAt: text(item.collectedAt || item.collected_at || item["수집일"]),
    slot: text(item.slot || item.collectionSlot || item["수집구간"]),
    publishedAt: text(item.publishedAt || item.published_at || item["발행일"]),
    title: text(item.title || item["제목"]),
    link: isHttpUrl(item.link || item.originalLink || item["원문링크"])
      ? text(item.link || item.originalLink || item["원문링크"])
      : "",
    googleNewsLink: isHttpUrl(item.googleNewsLink || item["Google뉴스링크"])
      ? text(item.googleNewsLink || item["Google뉴스링크"])
      : "",
    source: text(item.source || item.publisher || item["언론사"]),
    category: text(item.category || item["카테고리"] || "기타"),
    relatedArea: text(item.relatedArea || item.region || item["관련지역"]),
    department: text(item.department || item["소관부서"]),
    summary: text(item.summary || item["뉴스 요약"] || item["요약"]),
    issue: text(item.issue || item["쟁점"] || item["의정쟁점"]),
    questions: text(item.questions || item["활용 가능 주요 키워드"] || item["활용질의"]),
    importance: Math.max(0, Math.min(100, number(item.importance || item["중요도"]))),
    analysisModel: text(item.analysisModel || item.model || item["분석모델"]),
    analysisBasis: text(item.analysisBasis || item.basis || item["분석기준"])
  };
}

function normalizePayload(data) {
  const rawItems = Array.isArray(data)
    ? data
    : Array.isArray(data && data.items)
      ? data.items
      : [];

  return {
    updatedAt: text(data && data.updatedAt),
    items: rawItems.map(normalizeItem).filter((item) => item.title)
  };
}

function safePreview(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET 요청만 허용됩니다." });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const scriptUrl = String(process.env.APPS_SCRIPT_URL || "").trim();
  const token = String(process.env.APPS_SCRIPT_TOKEN || "").trim();

  const missing = [];
  if (!scriptUrl) missing.push("APPS_SCRIPT_URL");
  if (!token) missing.push("APPS_SCRIPT_TOKEN");

  if (missing.length) {
    return res.status(500).json({
      error: "Vercel 환경변수가 설정되지 않았습니다.",
      missing
    });
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(scriptUrl);
    upstreamUrl.searchParams.set("token", token);
  } catch (_error) {
    return res.status(500).json({
      error: "APPS_SCRIPT_URL 형식이 올바르지 않습니다.",
      hint: "Apps Script 웹 앱의 /exec 주소를 입력하세요."
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "User-Agent": "NewsBriefingVercel/1.0"
      }
    });

    const responseText = await upstream.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      return res.status(502).json({
        error: "Apps Script가 JSON이 아닌 응답을 보냈습니다.",
        upstreamStatus: upstream.status,
        upstreamContentType: upstream.headers.get("content-type") || "",
        preview: safePreview(responseText),
        hint: "웹 앱을 '실행 사용자: 나', '액세스 권한: 모든 사용자'로 새 버전 배포하고 APPS_SCRIPT_URL에 /exec 주소를 입력하세요."
      });
    }

    if (!upstream.ok) {
      return res.status(502).json({
        error: "Apps Script 호출에 실패했습니다.",
        upstreamStatus: upstream.status,
        detail: data
      });
    }

    if (data && data.error === "unauthorized") {
      return res.status(502).json({
        error: "Apps Script 연결 토큰이 일치하지 않습니다.",
        hint: "Apps Script의 DASHBOARD_API_TOKEN과 Vercel의 APPS_SCRIPT_TOKEN을 동일하게 설정하세요."
      });
    }

    const normalized = normalizePayload(data);
    return res.status(200).json(normalized);
  } catch (error) {
    if (error && error.name === "AbortError") {
      return res.status(504).json({
        error: "Apps Script 응답 시간이 20초를 초과했습니다."
      });
    }

    return res.status(502).json({
      error: "Apps Script 연결 중 오류가 발생했습니다.",
      detail: error instanceof Error ? error.message : "unknown error",
      hint: "APPS_SCRIPT_URL이 /exec로 끝나는지 확인하고 Vercel을 재배포하세요."
    });
  } finally {
    clearTimeout(timer);
  }
};
