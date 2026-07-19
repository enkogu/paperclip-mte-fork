import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockEnvironmentRuntimeService = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/workspace-runtime.js")>()),
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: mockEnvironmentRuntimeService,
}));

function createApp(companyIds = ["company-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockStopRuntimeServicesForExecutionWorkspace.mockResolvedValue(undefined);
    mockEnvironmentRuntimeService.mockReturnValue({
      destroyReusableSandboxLeases: vi.fn().mockResolvedValue([]),
    });
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("delegates bounded workspace overview queries", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?status=active,idle&limit=25&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(mockExecutionWorkspaceService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorkspaceService.listOverview).not.toHaveBeenCalled();
  });

  it("archives a record-only local workspace without marking its preserved project directory as cleanup failed", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-primary-route-"));
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      mode: "isolated_workspace",
      status: "active",
      cwd: workspacePath,
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_fs",
      providerRef: null,
      metadata: { createdByRuntime: false },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
    }));

    try {
      const res = await request(createApp())
        .patch("/api/execution-workspaces/workspace-1")
        .send({ status: "archived" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("archived");
      expect(res.body.cleanupReason).toBeNull();
      expect(mockExecutionWorkspaceService.update).toHaveBeenCalledTimes(1);
      expect((await fs.stat(workspacePath)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("blocks an active workspace before any local cleanup can run", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-close-blocked-"));
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      mode: "isolated_workspace",
      status: "active",
      cwd: workspacePath,
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_fs",
      providerRef: null,
      metadata: { createdByRuntime: true },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "blocked",
      blockingReasons: ["This workspace is still active."],
    });

    try {
      const res = await request(createApp())
        .patch("/api/execution-workspaces/workspace-1")
        .send({ status: "archived" });

      expect(res.status).toBe(409);
      expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
      expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
      expect((await fs.stat(workspacePath)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });
});
