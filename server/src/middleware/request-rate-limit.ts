import type { Request, RequestHandler, Response } from "express";

export type RequestRateLimitPolicy = {
  maxRequests: number;
  windowMs: number;
};

type RequestRateLimitOptions = {
  name: string;
  policy: RequestRateLimitPolicy | ((req: Request) => RequestRateLimitPolicy);
  now?: () => number;
  maxKeys?: number;
};

type RateLimitBucket = {
  hits: number[];
  lastAccessedAt: number;
};

const DEFAULT_MAX_KEYS = 10_000;

function requestPrincipal(req: Request) {
  if (req.actor.type === "agent" && req.actor.agentId) return `agent:${req.actor.agentId}`;
  if (req.actor.type === "board" && req.actor.userId) return `board:${req.actor.userId}`;
  // `req.ip` honors the application's TRUST_PROXY policy. Do not inspect
  // X-Forwarded-For directly, since it is attacker-controlled without one.
  return `ip:${req.ip || "unknown"}`;
}

function evictLeastRecentlyUsedBucket(buckets: Map<string, RateLimitBucket>) {
  let oldestKey: string | undefined;
  let oldestAccessedAt = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets) {
    if (bucket.lastAccessedAt < oldestAccessedAt) {
      oldestKey = key;
      oldestAccessedAt = bucket.lastAccessedAt;
    }
  }
  if (oldestKey) buckets.delete(oldestKey);
}

function writeRateLimitHeaders(
  res: Response,
  policy: RequestRateLimitPolicy,
  remaining: number,
  retryAfterSeconds: number,
) {
  res.setHeader("RateLimit-Limit", String(policy.maxRequests));
  res.setHeader("RateLimit-Remaining", String(remaining));
  if (retryAfterSeconds > 0) res.setHeader("Retry-After", String(retryAfterSeconds));
}

/**
 * A small in-process limiter for public or high-cost route groups.
 *
 * It is intentionally keyed by authenticated actor when possible, otherwise
 * by Express's proxy-aware `req.ip`. It is not a distributed quota service;
 * deployment-wide limits remain the reverse-proxy's responsibility.
 */
export function createRequestRateLimiter(options: RequestRateLimitOptions): RequestHandler {
  const buckets = new Map<string, RateLimitBucket>();
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  return (req, res, next) => {
    const policy = typeof options.policy === "function" ? options.policy(req) : options.policy;
    const currentTime = now();
    const key = `${options.name}:${requestPrincipal(req)}`;
    const cutoff = currentTime - policy.windowMs;
    const existing = buckets.get(key);
    const recentHits = (existing?.hits ?? []).filter((hit) => hit > cutoff);

    if (recentHits.length >= policy.maxRequests) {
      const oldestHit = recentHits[0] ?? currentTime;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestHit + policy.windowMs - currentTime) / 1_000));
      buckets.set(key, { hits: recentHits, lastAccessedAt: currentTime });
      writeRateLimitHeaders(res, policy, 0, retryAfterSeconds);
      res.status(429).json({
        error: "Too many requests",
        code: "rate_limit_exceeded",
        retryAfterSeconds,
      });
      return;
    }

    if (!existing && buckets.size >= maxKeys) evictLeastRecentlyUsedBucket(buckets);
    recentHits.push(currentTime);
    buckets.set(key, { hits: recentHits, lastAccessedAt: currentTime });
    writeRateLimitHeaders(res, policy, Math.max(0, policy.maxRequests - recentHits.length), 0);
    next();
  };
}
