"use strict";

const crypto = require("crypto");

const DEFAULT_COOKIE_NAME = "psobukgu_session";
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const PASSWORD_ENV_NAMES = [
  "DASHBOARD_PASSWORD",
  "DASHBOARD_ACCESS_CODE",
  "ACCESS_CODE",
  "ACCESS_PASSWORD",
  "LOGIN_PASSWORD",
  "SITE_PASSWORD",
  "NEWS_PASSWORD",
  "APP_PASSWORD"
];

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: "", value: "" };
}

function getLoginPasswordConfig() {
  return firstConfiguredEnv(PASSWORD_ENV_NAMES);
}

function getCookieName() {
  const configured = String(process.env.AUTH_SESSION_COOKIE_NAME || "").trim();
  if (/^[A-Za-z0-9_.-]+$/.test(configured)) return configured;
  return DEFAULT_COOKIE_NAME;
}

function getMaxAgeSeconds() {
  const configured = Number.parseInt(String(process.env.AUTH_SESSION_MAX_AGE || ""), 10);
  if (Number.isFinite(configured) && configured >= 300 && configured <= 60 * 60 * 24 * 365) {
    return configured;
  }
  return DEFAULT_MAX_AGE_SECONDS;
}

function getSessionSecret() {
  const configured = String(process.env.AUTH_SESSION_SECRET || "").trim();
  if (configured) return configured;

  // 기존 배포가 비밀번호 환경변수만 가지고 있어도 즉시 작동하도록 하는 호환 경로입니다.
  // 운영에서는 AUTH_SESSION_SECRET을 별도로 설정하는 편이 안전합니다.
  const passwordConfig = getLoginPasswordConfig();
  if (!passwordConfig.value) return "";

  return crypto
    .createHash("sha256")
    .update(`psobukgu-session-secret:${passwordConfig.value}`, "utf8")
    .digest("hex");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function sign(encodedPayload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

function timingSafeEqualText(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left), "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(String(right), "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createSessionToken(nowMs = Date.now()) {
  const secret = getSessionSecret();
  if (!secret) throw new Error("AUTH_SESSION_SECRET 또는 로그인 비밀번호 환경변수가 필요합니다.");

  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + getMaxAgeSeconds();
  const payload = {
    v: 1,
    sub: "dashboard",
    iat: issuedAt,
    exp: expiresAt,
    sid: crypto.randomBytes(18).toString("base64url")
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return {
    token: `${encodedPayload}.${signature}`,
    payload
  };
}

function verifySessionToken(token, nowMs = Date.now()) {
  const secret = getSessionSecret();
  if (!secret) return null;

  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expectedSignature = sign(parts[0], secret);
  if (!timingSafeEqualText(parts[1], expectedSignature)) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(parts[0]));
    const now = Math.floor(nowMs / 1000);
    if (payload?.v !== 1 || payload?.sub !== "dashboard") return null;
    if (!Number.isFinite(payload?.iat) || !Number.isFinite(payload?.exp)) return null;
    if (payload.iat > now + 60 || payload.exp <= now) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return cookies;
      const name = part.slice(0, separatorIndex).trim();
      const rawValue = part.slice(separatorIndex + 1).trim();
      if (!name) return cookies;
      try {
        cookies[name] = decodeURIComponent(rawValue);
      } catch (_error) {
        cookies[name] = rawValue;
      }
      return cookies;
    }, {});
}

function getSession(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return verifySessionToken(cookies[getCookieName()]);
}

function isSecureRequest(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https" || process.env.VERCEL_ENV === "production";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  return parts.join("; ");
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader?.("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }
  const values = Array.isArray(existing) ? existing : [existing];
  res.setHeader("Set-Cookie", [...values, cookieValue]);
}

function setSessionCookie(req, res) {
  const session = createSessionToken();
  appendSetCookie(res, serializeCookie(getCookieName(), session.token, {
    maxAge: getMaxAgeSeconds(),
    path: "/",
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax"
  }));
  return session.payload;
}

function clearSessionCookie(req, res) {
  appendSetCookie(res, serializeCookie(getCookieName(), "", {
    maxAge: 0,
    expires: new Date(0),
    path: "/",
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax"
  }));
}

function setPrivateNoStore(res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
}

function requireAuth(req, res) {
  const secret = getSessionSecret();
  if (!secret) {
    setPrivateNoStore(res);
    res.status(500).json({
      error: "로그인 환경변수가 없습니다.",
      missing: ["AUTH_SESSION_SECRET 또는 로그인 비밀번호 환경변수"],
      acceptedPasswordVariables: PASSWORD_ENV_NAMES
    });
    return null;
  }

  const session = getSession(req);
  if (!session) {
    setPrivateNoStore(res);
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  res.setHeader("Vary", "Cookie");
  return session;
}

module.exports = {
  PASSWORD_ENV_NAMES,
  createSessionToken,
  clearSessionCookie,
  getCookieName,
  getLoginPasswordConfig,
  getMaxAgeSeconds,
  getSession,
  getSessionSecret,
  requireAuth,
  setPrivateNoStore,
  setSessionCookie,
  timingSafeEqualText,
  verifySessionToken
};
