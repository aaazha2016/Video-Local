"use strict";
/** 极简 JWT（HS256，零依赖）。默认 config.auth.enabled=false，便于开箱即用。 */

const crypto = require("node:crypto");
const config = require("./config");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url").toString("utf8");

function sign(payload, expiresInSec = 7 * 86400) {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec }));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", config.auth.jwtSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expect = crypto.createHmac("sha256", config.auth.jwtSecret).update(data).digest("base64url");
  if (expect.length !== parts[2].length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]))) return null;
  try {
    const payload = JSON.parse(unb64u(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/** Express 中间件：config.auth.enabled=false 时放行并注入默认管理员 */
function middleware(req, _res, next) {
  if (!config.auth.enabled) {
    req.user = { id: "user_local", username: config.auth.username, role: "admin" };
    return next();
  }
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query.token || null);
  const payload = verify(token);
  req.user = payload || null;
  next();
}

function requireAuth(req, res, next) {
  if (!config.auth.enabled) return next();
  if (!req.user) return res.status(401).json({ ok: false, data: null, error: { code: "UNAUTHORIZED", message: "请先登录" } });
  next();
}

module.exports = { sign, verify, middleware, requireAuth };
