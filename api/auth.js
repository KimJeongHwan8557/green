"use strict";

const { getSession, setPrivateNoStore } = require("./_lib/auth");

module.exports = async function handler(req, res) {
  setPrivateNoStore(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, authenticated: false });
  }

  return res.status(200).json({
    ok: true,
    authenticated: true,
    expiresAt: new Date(session.exp * 1000).toISOString()
  });
};
