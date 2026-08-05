const { clearSessionCookie } = require("./_auth");

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.status(200).json({ ok: true });
};
