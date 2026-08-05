module.exports = function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const configured = {
    APPS_SCRIPT_URL: Boolean(process.env.APPS_SCRIPT_URL),
    APPS_SCRIPT_TOKEN: Boolean(process.env.APPS_SCRIPT_TOKEN),
    SITE_PASSWORD: Boolean(process.env.SITE_PASSWORD),
    SESSION_SECRET: String(process.env.SESSION_SECRET || "").length >= 32
  };

  return res.status(200).json({
    ok: true,
    service: "news-briefing-vercel",
    runtime: "vercel-node-function",
    configured,
    allConfigured: Object.values(configured).every(Boolean),
    checkedAt: new Date().toISOString()
  });
};
