const { createHash, createHmac, timingSafeEqual } = require("node:crypto");

const ledger = "{loan-tracker}:v1:ledger";
const safeId = /^[a-zA-Z0-9_-]{1,100}$/;
const imagePattern = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const sessionName = "tracker_session";
const sessionAge = 60 * 60 * 24 * 7;
const pinPattern = /^[0-9]{4}$/;
const loginAttempts = "{loan-tracker}:v1:login-attempts";

const checkLogin = `
  local failures = tonumber(redis.call('GET', KEYS[1]) or '0')
  if failures >= 10 then return math.max(1, redis.call('TTL', KEYS[1])) end
  if ARGV[1] == 'invalid' then
    if redis.call('INCR', KEYS[1]) == 1 then
      redis.call('EXPIRE', KEYS[1], 900)
    end
  end
  return 0
`;

function equal(a, b) {
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function sign(expiry, password, token) {
  return createHmac("sha256", token).update("tracker-session:" + password + ":" + expiry).digest("hex");
}

function redisToken() {
  return process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = redisToken();
  if (!url || !token) throw new Error("Missing Redis configuration");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error("Redis operation failed");
  return data.result;
}

const savePayment = `
  if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
  for i = 3, #ARGV, 2 do
    redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
  end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
`;

const deletePhoto = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local payment = cjson.decode(raw)
  local ids = {}
  for _, id in ipairs(payment.photoIds) do
    if id ~= ARGV[2] then table.insert(ids, id) end
  end
  payment.photoIds = ids
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(payment))
  return 1
`;

const attachPhoto = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local payment = cjson.decode(raw)
  if payment.datePaid ~= ARGV[2] or payment.amountPaid ~= tonumber(ARGV[3]) then return 0 end
  if redis.call('HEXISTS', KEYS[2], ARGV[4]) == 1 then return 1 end
  table.insert(payment.photoIds, ARGV[4])
  redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(payment))
  return 1
`;

function photoKey(id) {
  return "{loan-tracker}:v1:photos:" + id;
}

function validatePayment(body) {
  const { id, amountPaid, datePaid, screenshots } = body;
  if (typeof id !== "string" || !safeId.test(id)) return false;
  const cents = Math.round(amountPaid * 100);
  if (typeof amountPaid !== "number" || !Number.isSafeInteger(cents) ||
      cents <= 0 || Math.abs(amountPaid * 100 - cents) > 0.00001) return false;
  if (typeof datePaid !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(datePaid)) return false;
  const date = new Date(datePaid);
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== datePaid) return false;
  return Array.isArray(screenshots) &&
    new Set(screenshots.map((photo) => photo?.id)).size === screenshots.length &&
    screenshots.every((photo) => typeof photo?.id === "string" && safeId.test(photo.id) &&
      typeof photo.data === "string" && imagePattern.test(photo.data));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const password = process.env.TRACKER_PASSWORD;
  if (!password || password.length !== 4 || !pinPattern.test(password)) {
    return res.status(503).json({ error: "Set TRACKER_PASSWORD to exactly four digits in Vercel." });
  }

  const token = redisToken();
  if (!token) return res.status(503).json({ error: "Connect Upstash Redis in Vercel." });

  try {
    const body = req.body || {};
    if (req.method === "POST" && body.action === "login") {
      if (typeof body.password !== "string" || body.password.length !== 4 || !pinPattern.test(body.password)) {
        return res.status(400).json({ error: "Enter a four-digit PIN." });
      }
      const valid = equal(body.password, password);
      const retryAfter = await redis(["EVAL", checkLogin, 1, loginAttempts, valid ? "valid" : "invalid"]);
      if (retryAfter !== 0) {
        res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
        return res.status(429).json({ error: "Too many incorrect PINs. Wait a few minutes and try again." });
      }
      if (!valid) return res.status(401).json({ error: "Incorrect PIN." });
      const expiry = String(Math.floor(Date.now() / 1000) + sessionAge);
      res.setHeader("Set-Cookie", sessionName + "=" + expiry + "." + sign(expiry, password, token) +
        "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + sessionAge);
      return res.status(200).json({ ok: true });
    }

    const cookie = (req.headers.cookie || "").match(/(?:^|;\s*)tracker_session=(\d{10})\.([a-f0-9]{64})(?:;|$)/);
    if (!cookie || Number(cookie[1]) <= Date.now() / 1000 ||
        !equal(cookie[2], sign(cookie[1], password, token))) {
      return res.status(401).json({ error: "Please sign in." });
    }

    if (req.method === "GET" && req.query.session === "1") {
      return res.status(200).json({ ok: true });
    }

    const { id, photo } = req.query;
    if (req.method === "GET" && (id !== undefined || photo !== undefined)) {
      if (typeof id !== "string" || !safeId.test(id) ||
          typeof photo !== "string" || !safeId.test(photo)) return res.status(400).end();
      const data = await redis(["HGET", photoKey(id), photo]);
      const match = typeof data === "string" && imagePattern.exec(data);
      if (!match) return res.status(404).end();
      res.setHeader("Content-Type", "image/" + match[1]);
      return res.status(200).send(Buffer.from(match[2], "base64"));
    }

    if (req.method === "GET") {
      const rows = await redis(["HVALS", ledger]);
      return res.status(200).json(rows.map((row) => {
        const { photoIds, ...payment } = JSON.parse(row);
        return {
          ...payment,
          screenshots: Array.isArray(photoIds) ? photoIds.map((photo) => ({
            id: photo,
            data: "/api/payments?id=" + payment.id + "&photo=" + photo,
          })) : [],
        };
      }));
    }

    if (req.method === "POST") {
      if (!validatePayment(body)) return res.status(400).json({ error: "Invalid payment or photo." });
      const { id, amountPaid, datePaid, screenshots } = body;
      if (body.action === "attach") {
        if (screenshots.length !== 1) return res.status(400).json({ error: "Select one receipt." });
        const receipt = screenshots[0];
        const attached = await redis(["EVAL", attachPhoto, 2, ledger, photoKey(id), id,
          datePaid, String(amountPaid), receipt.id, receipt.data]);
        return attached ? res.status(200).json({ id }) :
          res.status(409).json({ error: "The matching payment changed. Refresh and try again." });
      }
      const metadata = JSON.stringify({ id, amountPaid, datePaid,
        photoIds: screenshots.map((photo) => photo.id) });
      await redis(["EVAL", savePayment, 2, ledger, photoKey(id), id, metadata,
        ...screenshots.flatMap((photo) => [photo.id, photo.data])]);
      return res.status(200).json({ id });
    }

    if (req.method === "DELETE" && typeof id === "string" && safeId.test(id) &&
        typeof photo === "string" && safeId.test(photo)) {
      await redis(["EVAL", deletePhoto, 2, ledger, photoKey(id), id, photo]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Unsupported request." });
  } catch {
    return res.status(503).json({ error: "Shared storage is unavailable. Please try again." });
  }
};
