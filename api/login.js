"use strict";

const {
  PASSWORD_ENV_NAMES,
  getLoginPasswordConfig,
  setPrivateNoStore,
  setSessionCookie,
  timingSafeEqualText
} = require("./_lib/auth");

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const raw = String(req.body || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

module.exports = async function handler(req, res) {
  setPrivateNoStore(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const passwordConfig = getLoginPasswordConfig();
  if (!passwordConfig.value) {
    return res.status(500).json({
      error: "로그인 비밀번호 환경변수가 없습니다.",
      missing: ["로그인 비밀번호"],
      acceptedPasswordVariables: PASSWORD_ENV_NAMES
    });
  }

  const body = parseBody(req);
  const submittedPassword = String(body.password ?? body.code ?? "");
  if (!submittedPassword || !timingSafeEqualText(submittedPassword, passwordConfig.value)) {
    return res.status(401).json({ error: "입장코드가 올바르지 않습니다." });
  }

  try {
    const session = setSessionCookie(req, res);
    return res.status(200).json({
      ok: true,
      expiresAt: new Date(session.exp * 1000).toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      error: "로그인 세션을 생성하지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
