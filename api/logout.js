"use strict";

const { clearSessionCookie, setPrivateNoStore } = require("./_lib/auth");

module.exports = async function handler(req, res) {
  setPrivateNoStore(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  clearSessionCookie(req, res);
  res.setHeader("Clear-Site-Data", "\"cache\"");
  return res.status(200).json({ ok: true });
};
