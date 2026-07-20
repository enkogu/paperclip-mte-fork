import { createReadStream, existsSync, realpathSync, statSync, watch } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface PluginDevServerOptions {
  /** Plugin project root. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Relative path from root to built UI assets. Defaults to `dist/ui`. */
  uiDir?: string;
  /** Bind port for local preview server. Defaults to `4177`. */
  port?: number;
  /** Bind host. Defaults to `127.0.0.1`. */
  host?: string;
}

export interface PluginDevServer {
  url: string;
  close(): Promise<void>;
}

interface Closeable {
  close(): void;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function decodeRequestedPath(reqPath: string): string | null {
  const queryIndex = reqPath.indexOf("?");
  let decoded = queryIndex === -1 ? reqPath : reqPath.slice(0, queryIndex);

  for (let iteration = 0; iteration < 5; iteration += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next;
    if (iteration === 4) return null;
  }

  if (decoded.includes("\0")) return null;

  const normalized = decoded.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;

  const relativePath = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join(path.sep);
  return relativePath || "index.js";
}

export type DevServerFileResolution =
  | { ok: true; filePath: string }
  | { ok: false; reason: "denied" | "missing" };

/** Resolve a static asset without statting or reading it before containment. */
export function resolveContainedDevServerFile(
  realUiDir: string,
  reqPath: string,
): DevServerFileResolution {
  const relativePath = decodeRequestedPath(reqPath);
  if (relativePath === null) return { ok: false, reason: "denied" };

  const candidatePath = path.resolve(realUiDir, relativePath);
  if (!isPathContained(realUiDir, candidatePath)) {
    return { ok: false, reason: "denied" };
  }

  let realFilePath: string;
  try {
    realFilePath = realpathSync(candidatePath);
  } catch {
    return { ok: false, reason: "missing" };
  }

  if (!isPathContained(realUiDir, realFilePath)) {
    return { ok: false, reason: "denied" };
  }

  return { ok: true, filePath: realFilePath };
}

function send404(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Not found" }));
}

function sendJson(res: ServerResponse, value: unknown) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

async function ensureContainedUiDir(rootDir: string, uiDir: string): Promise<string> {
  let existingAncestor = uiDir;
  while (true) {
    try {
      const realAncestor = realpathSync(existingAncestor);
      if (!isPathContained(rootDir, realAncestor)) {
        throw new Error("UI directory must stay within the plugin root");
      }
      break;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) throw error;
        existingAncestor = parent;
        continue;
      }
      throw error;
    }
  }

  await mkdir(uiDir, { recursive: true });
  const realUiDir = realpathSync(uiDir);
  if (!isPathContained(rootDir, realUiDir)) {
    throw new Error("UI directory must stay within the plugin root");
  }
  return realUiDir;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFilesRecursive(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function snapshotSignature(rows: Array<{ file: string; mtimeMs: number }>): string {
  return rows.map((row) => `${row.file}:${Math.trunc(row.mtimeMs)}`).join("|");
}

async function startUiWatcher(uiDir: string, onReload: (filePath: string) => void): Promise<Closeable> {
  try {
    // macOS/Windows support recursive native watching.
    const watcher = watch(uiDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      onReload(path.join(uiDir, filename));
    });
    return watcher;
  } catch {
    // Linux may reject recursive watch. Fall back to polling snapshots.
    let previous = snapshotSignature(
      (await getUiBuildSnapshot(path.dirname(uiDir), path.basename(uiDir))).map((row) => ({
        file: row.file,
        mtimeMs: row.mtimeMs,
      })),
    );

    const timer = setInterval(async () => {
      try {
        const nextRows = await getUiBuildSnapshot(path.dirname(uiDir), path.basename(uiDir));
        const next = snapshotSignature(nextRows);
        if (next === previous) return;
        previous = next;
        onReload("__snapshot__");
      } catch {
        // Ignore transient read errors while bundlers are writing files.
      }
    }, 500);

    return {
      close() {
        clearInterval(timer);
      },
    };
  }
}

/**
 * Start a local static server for plugin UI assets with SSE reload events.
 *
 * Endpoint summary:
 * - `GET /__paperclip__/health` for diagnostics
 * - `GET /__paperclip__/events` for hot-reload stream
 * - Any other path serves files from the configured UI build directory
 */
export async function startPluginDevServer(options: PluginDevServerOptions = {}): Promise<PluginDevServer> {
  const configuredRootDir = path.resolve(options.rootDir ?? process.cwd());
  const rootDir = realpathSync(configuredRootDir);
  const configuredUiDir = path.resolve(rootDir, options.uiDir ?? "dist/ui");
  if (!isPathContained(rootDir, configuredUiDir)) {
    throw new Error("UI directory must stay within the plugin root");
  }

  const uiDir = await ensureContainedUiDir(rootDir, configuredUiDir);

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4177;

  const sseClients = new Set<ServerResponse>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/__paperclip__/health") {
      sendJson(res, { ok: true, rootDir, uiDir });
      return;
    }

    if (url === "/__paperclip__/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: connected\ndata: {"ok":true}\n\n`);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    try {
      const fileResolution = resolveContainedDevServerFile(uiDir, url);
      if (!fileResolution.ok) {
        send404(res);
        return;
      }

      const filePath = fileResolution.filePath;
      if (!statSync(filePath).isFile()) {
        send404(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentType(filePath));
      createReadStream(filePath).pipe(res);
    } catch {
      send404(res);
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const notifyReload = (filePath: string) => {
    const rel = path.relative(uiDir, filePath);
    const payload = JSON.stringify({ type: "reload", file: rel, at: new Date().toISOString() });
    for (const client of sseClients) {
      client.write(`event: reload\ndata: ${payload}\n\n`);
    }
  };

  const watcher = await startUiWatcher(uiDir, notifyReload);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = address && typeof address === "object" ? (address as AddressInfo).port : port;

  return {
    url: `http://${host}:${actualPort}`,
    async close() {
      watcher.close();
      for (const client of sseClients) {
        client.end();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Return a stable file+mtime snapshot for a built plugin UI directory.
 *
 * Used by the polling watcher fallback and useful for tests that need to assert
 * whether a UI build has changed between runs.
 */
export async function getUiBuildSnapshot(rootDir: string, uiDir = "dist/ui"): Promise<Array<{ file: string; mtimeMs: number }>> {
  const baseDir = path.resolve(rootDir, uiDir);
  if (!existsSync(baseDir)) return [];
  const files = await listFilesRecursive(baseDir);
  const rows = await Promise.all(files.map(async (filePath) => {
    const fileStat = await stat(filePath);
    return {
      file: path.relative(baseDir, filePath),
      mtimeMs: fileStat.mtimeMs,
    };
  }));
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
