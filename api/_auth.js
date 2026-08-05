const crypto = require("crypto");

const COOKIE_NAME = "__Host-council_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function toBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
}

function constantTimeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""), "utf8");
  const right = Buffer.from(String(rightValue ?? ""), "utf8");

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getSessionSecret() {
  const secret = String(process.env.SESSION_SECRET || "");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

function parseCookies(req) {
  const cookieHeader = String(req.headers.cookie || "");
  const cookies = {};

  cookieHeader.split(";").forEach((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  });

  return cookies;
}

function createSessionCookie() {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload = toBase64Url(
    JSON.stringify({
      issuedAt: now,
      expiresAt: now + MAX_AGE_SECONDS,
      version: 1
    })
  );
  const token = `${payload}.${sign(payload, secret)}`;

  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`
  ].join("; ");
}

function clearSessionCookie() {
  return [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ].join("; ");
}

function isAuthorized(req) {
  try {
    const secret = getSessionSecret();
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return false;

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const [payload, signature] = parts;
    const expectedSignature = sign(payload, secret);
    if (!constantTimeEqual(signature, expectedSignature)) return false;

    const data = JSON.parse(fromBase64Url(payload));
    const now = Math.floor(Date.now() / 1000);
    return Number(data.expiresAt) > now && Number(data.version) === 1;
  } catch (_error) {
    return false;
  }
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body !== "string" || !req.body.trim()) return {};

  try {
    return JSON.parse(req.body);
  } catch (_error) {
    return {};
  }
}

module.exports = {
  clearSessionCookie,
  constantTimeEqual,
  createSessionCookie,
  isAuthorized,
  parseJsonBody
};
