import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRequestRateLimiter } from "../middleware/request-rate-limit.js";

describe("request rate limiter", () => {
  it("limits anonymous CLI challenge creation by proxy-aware client IP", async () => {
    let currentTime = 0;
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      "/api/cli-auth/challenges",
      createRequestRateLimiter({
        name: "cli-auth-challenge",
        policy: { maxRequests: 2, windowMs: 60_000 },
        now: () => currentTime,
      }),
    );
    app.post("/api/cli-auth/challenges", (_req, res) => res.status(201).json({ ok: true }));

    const client = request(app);
    await client.post("/api/cli-auth/challenges").set("X-Forwarded-For", "198.51.100.9").expect(201);
    await client.post("/api/cli-auth/challenges").set("X-Forwarded-For", "198.51.100.9").expect(201);
    const limited = await client
      .post("/api/cli-auth/challenges")
      .set("X-Forwarded-For", "198.51.100.9")
      .expect(429);

    expect(limited.body).toMatchObject({ code: "rate_limit_exceeded", retryAfterSeconds: 60 });
    expect(limited.headers["retry-after"]).toBe("60");
    await client.post("/api/cli-auth/challenges").set("X-Forwarded-For", "198.51.100.10").expect(201);

    currentTime = 60_001;
    await client.post("/api/cli-auth/challenges").set("X-Forwarded-For", "198.51.100.9").expect(201);
  });

  it("gives authenticated actors independent budgets behind one proxy", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: req.header("x-test-user") ?? undefined,
        source: "session",
      };
      next();
    });
    app.use(
      "/api/environments",
      createRequestRateLimiter({
        name: "environment-operation",
        policy: { maxRequests: 1, windowMs: 60_000 },
      }),
    );
    app.post("/api/environments/probe", (_req, res) => res.json({ ok: true }));

    const client = request(app);
    await client.post("/api/environments/probe").set("X-Forwarded-For", "198.51.100.9").set("X-Test-User", "user-a").expect(200);
    await client.post("/api/environments/probe").set("X-Forwarded-For", "198.51.100.9").set("X-Test-User", "user-a").expect(429);
    await client.post("/api/environments/probe").set("X-Forwarded-For", "198.51.100.9").set("X-Test-User", "user-b").expect(200);
  });
});
