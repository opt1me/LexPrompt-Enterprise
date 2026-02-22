type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitOptions = {
  limit: number;
  windowMs: number;
  keySuffix?: string;
};

const store = new Map<string, RateLimitEntry>();

const now = () => Date.now();

export const getClientIp = (req: any): string => {
  const xff = req?.headers?.["x-forwarded-for"] || req?.headers?.["X-Forwarded-For"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  const xrip = req?.headers?.["x-real-ip"] || req?.headers?.["X-Real-Ip"];
  if (typeof xrip === "string" && xrip.trim()) return xrip.trim();
  return "unknown-ip";
};

export const hitRateLimit = (key: string, options: RateLimitOptions): { allowed: boolean; remaining: number; resetAt: number } => {
  const ts = now();
  const existing = store.get(key);
  if (!existing || existing.resetAt <= ts) {
    const resetAt = ts + options.windowMs;
    store.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: Math.max(options.limit - 1, 0), resetAt };
  }

  existing.count += 1;
  store.set(key, existing);
  const remaining = Math.max(options.limit - existing.count, 0);
  return { allowed: existing.count <= options.limit, remaining, resetAt: existing.resetAt };
};

export const enforceRateLimit = (
  req: any,
  res: any,
  scope: string,
  options: RateLimitOptions
): boolean => {
  const ip = getClientIp(req);
  const suffix = options.keySuffix ? `:${options.keySuffix}` : "";
  const key = `${scope}:${ip}${suffix}`;
  const result = hitRateLimit(key, options);
  const resetAfterSec = Math.max(Math.ceil((result.resetAt - now()) / 1000), 0);
  res.setHeader("X-RateLimit-Limit", String(options.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("X-RateLimit-Reset", String(result.resetAt));
  if (!result.allowed) {
    res.setHeader("Retry-After", String(resetAfterSec));
    res.status(429).json({ error: "Too many requests. Please retry shortly." });
    return false;
  }
  return true;
};
