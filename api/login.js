const {
  constantTimeEqual,
  createSessionCookie,
  parseJsonBody
} = require("./_auth");

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  const configuredPassword = String(process.env.SITE_PASSWORD || "");
  if (!configuredPassword) {
    return res.status(500).json({
      error: "SITE_PASSWORD 환경변수가 설정되지 않았습니다."
    });
  }

  const body = parseJsonBody(req);
  const submittedPassword = String(body.password || "");

  if (!constantTimeEqual(submittedPassword, configuredPassword)) {
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
  }

  try {
    res.setHeader("Set-Cookie", createSessionCookie());
    return res.status(200).json({ ok: true });
  } catch (_error) {
    return res.status(500).json({
      error: "SESSION_SECRET 환경변수를 32자 이상으로 설정하세요."
    });
  }
};
