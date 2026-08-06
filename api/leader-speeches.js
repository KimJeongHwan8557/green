/**
 * Vercel Function: /api/leader-speeches
 *
 * 현재 저장소의 로그인 구현 파일이 제공되지 않아, 기존 /api/news를
 * 인증 게이트로 재사용하는 독립형 버전입니다. 같은 로그인 쿠키를 그대로 전달합니다.
 * 추후 api/news.js의 세션 검증 함수를 공통 모듈로 분리하면 인증 확인용 내부 호출을 제거할 수 있습니다.
 */

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const missing = [];
  const appsScriptUrl = process.env.LEADER_SPEECH_APPS_SCRIPT_URL || "";
  const appsScriptToken = process.env.LEADER_SPEECH_DASHBOARD_API_TOKEN || "";
  if (!appsScriptUrl) missing.push("LEADER_SPEECH_APPS_SCRIPT_URL");
  if (!appsScriptToken) missing.push("LEADER_SPEECH_DASHBOARD_API_TOKEN");

  if (missing.length) {
    return res.status(500).json({
      error: "주요 발언 API 환경변수가 없습니다.",
      missing
    });
  }

  const cookie = req.headers.cookie || "";
  if (!cookie) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    if (!host) {
      return res.status(500).json({ error: "요청 호스트를 확인하지 못했습니다." });
    }

    // 기존 뉴스 API가 동일 로그인 세션을 검사하므로 인증 여부만 위임합니다.
    const authResponse = await fetch(`${protocol}://${host}/api/news`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie
      },
      redirect: "manual"
    });

    if (authResponse.status === 401) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!authResponse.ok) {
      const preview = (await authResponse.text()).slice(0, 240);
      return res.status(502).json({
        error: "기존 로그인 세션 확인에 실패했습니다.",
        hint: "기존 /api/news가 정상 동작하는지 먼저 확인하세요.",
        preview
      });
    }

    const upstreamUrl = new URL(appsScriptUrl);
    upstreamUrl.searchParams.set("token", appsScriptToken);

    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "follow"
    });

    const raw = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      return res.status(502).json({
        error: "Apps Script 응답을 JSON으로 해석하지 못했습니다.",
        preview: raw.slice(0, 240)
      });
    }

    if (!upstream.ok || data.error) {
      return res.status(502).json({
        error: data.error || `Apps Script 오류 HTTP ${upstream.status}`,
        detail: data
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "주요 발언 API 연결 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
