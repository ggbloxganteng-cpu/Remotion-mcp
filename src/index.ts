#!/usr/bin/env node
/**
 * remotion-render-mcp
 * MCP server (stdio) untuk me-render FULL proyek Remotion:
 *  - list_compositions     : daftar composition + resolusi/fps/durasi
 *  - render_video          : render satu composition penuh (mp4/webm/mov/gif/audio)
 *  - render_all            : render SEMUA composition di proyek
 *  - render_still          : render satu frame (PNG/JPEG)
 *  - get_render_status     : cek progres job
 *  - list_render_jobs      : daftar job
 *  - cancel_render         : batalkan job
 *
 * Render berjalan sebagai job (antrian satu-per-satu) agar tidak timeout di klien MCP.
 * Gunakan wait=true untuk menunggu sampai selesai (progress dikirim lewat notifikasi MCP).
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import {createReadStream, existsSync} from "node:fs";
import {randomBytes, randomUUID, timingSafeEqual} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {RequestHandlerExtra} from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {ServerNotification, ServerRequest} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {bundle} from "@remotion/bundler";
import {
  ensureBrowser,
  getCompositions,
  makeCancelSignal,
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";

// stdout dipakai oleh protokol MCP: semua log harus ke stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
const CODECS = [
  "h264",
  "h265",
  "vp8",
  "vp9",
  "prores",
  "gif",
  "h264-mkv",
  "mp3",
  "aac",
  "wav",
] as const;
type CodecName = (typeof CODECS)[number];

const EXT: Record<CodecName, string> = {
  h264: "mp4",
  h265: "mp4",
  vp8: "webm",
  vp9: "webm",
  prores: "mov",
  gif: "gif",
  "h264-mkv": "mkv",
  mp3: "mp3",
  aac: "aac",
  wav: "wav",
};
const CRF_CODECS = new Set<CodecName>(["h264", "h265", "vp8", "vp9", "h264-mkv"]);
const AUDIO_ONLY = new Set<CodecName>(["mp3", "aac", "wav"]);

// Mode HTTP (untuk deploy remote, mis. Railway): aktif kalau MCP_TRANSPORT=http atau env PORT ada.
const HTTP_MODE = process.env.MCP_TRANSPORT === "http" || Boolean(process.env.PORT);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const BASE_URL = (
  process.env.PUBLIC_BASE_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/$/, "");

const ENV_ROOTS = (process.env.REMOTION_MCP_ALLOWED_ROOTS ?? "")
  .split(path.delimiter)
  .filter(Boolean)
  .map((p) => path.resolve(p));
// Di mode HTTP default-nya folder ./projects supaya server publik tidak bisa baca seluruh disk.
const ALLOWED_ROOTS: string[] =
  ENV_ROOTS.length > 0 ? ENV_ROOTS : HTTP_MODE ? [path.resolve("projects")] : [];

// Registry file hasil render -> link download acak (tanpa membocorkan token utama).
const downloadsByKey = new Map<string, string>();
const downloadsByPath = new Map<string, string>();
function downloadUrlFor(file: string): string | undefined {
  if (!HTTP_MODE) return undefined;
  let key = downloadsByPath.get(file);
  if (!key) {
    key = randomBytes(16).toString("hex");
    downloadsByPath.set(file, key);
    downloadsByKey.set(key, file);
  }
  return `${BASE_URL}/d/${key}`;
}

const BROWSER_EXECUTABLE = process.env.REMOTION_BROWSER_EXECUTABLE ?? null;
type ChromiumOptions = NonNullable<Parameters<typeof renderMedia>[0]["chromiumOptions"]>;
const CHROMIUM_OPTIONS: ChromiumOptions = process.env.REMOTION_GL
  ? {gl: process.env.REMOTION_GL as ChromiumOptions["gl"]}
  : {};

const MAX_JOBS_KEPT = 50;

// Remotion mewajibkan format bitrate seperti "8M", "192k".
type Bitrate = `${number}k` | `${number}K` | `${number}M`;
const bitrateSchema = z
  .string()
  .regex(/^\d+(\.\d+)?[kKM]$/, 'Format bitrate harus seperti "8M" atau "192k".')
  .transform((v) => v as Bitrate);

// ---------------------------------------------------------------------------
// Helper path & project
// ---------------------------------------------------------------------------
function assertAllowed(p: string): string {
  const abs = path.resolve(p);
  if (ALLOWED_ROOTS.length === 0) return abs;
  const ok = ALLOWED_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!ok) {
    throw new Error(`Path di luar REMOTION_MCP_ALLOWED_ROOTS: ${abs}`);
  }
  return abs;
}

function resolveProject(projectPath: string, entryPoint?: string) {
  const root = assertAllowed(projectPath);
  if (!existsSync(path.join(root, "package.json"))) {
    throw new Error(`package.json tidak ditemukan di ${root}. Pastikan projectPath adalah root proyek Remotion.`);
  }
  if (!existsSync(path.join(root, "node_modules", "remotion"))) {
    throw new Error(`Dependency proyek belum terpasang. Jalankan "npm install" di ${root} dulu.`);
  }
  const candidates = entryPoint
    ? [entryPoint]
    : ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"];
  for (const c of candidates) {
    const abs = path.resolve(root, c);
    if (existsSync(abs)) return {root, entry: abs};
  }
  throw new Error(
    `Entry point tidak ketemu (dicoba: ${candidates.join(", ")}). Isi parameter entryPoint, mis. "src/index.ts".`,
  );
}

// ---------------------------------------------------------------------------
// Bundle cache (otomatis bundle ulang kalau file proyek berubah)
// ---------------------------------------------------------------------------
async function fingerprint(root: string): Promise<string> {
  const skip = new Set(["node_modules", "out", ".git", "build", "dist", ".cache", ".next"]);
  let newest = 0;
  let count = 0;
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, {withFileTypes: true})) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        const s = await fs.stat(p);
        count++;
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
    }
  }
  await walk(root);
  return `${count}:${newest}`;
}

const bundleCache = new Map<string, {fp: string; serveUrl: string}>();

async function getServeUrl(
  root: string,
  entry: string,
  force: boolean,
  onProgress: (percent: number) => void,
): Promise<string> {
  const fp = await fingerprint(root);
  const cached = bundleCache.get(entry);
  if (cached && cached.fp === fp && !force) return cached.serveUrl;
  const serveUrl = await bundle({
    entryPoint: entry,
    rootDir: root,
    onProgress,
  });
  bundleCache.set(entry, {fp, serveUrl});
  return serveUrl;
}

// ---------------------------------------------------------------------------
// Job system
// ---------------------------------------------------------------------------
type JobStatus = "queued" | "bundling" | "rendering" | "done" | "error" | "cancelled";

interface JobItem {
  compositionId: string;
  status: "pending" | "rendering" | "done" | "error";
  progress: number; // 0..1
  output?: string;
  sizeBytes?: number;
  durationInFrames?: number;
  fps?: number;
  error?: string;
}

interface Job {
  id: string;
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  items: JobItem[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cancelRequested: boolean;
  cancel?: () => void;
  subscribers: Set<(job: Job) => void>;
  done: Promise<void>;
}

interface RenderRequest {
  root: string;
  entry: string;
  compositionIds: string[] | "all";
  outputPath?: string;
  outputDir: string;
  codec: CodecName;
  crf?: number;
  concurrency?: number | string;
  scale: number;
  imageFormat?: "jpeg" | "png";
  muted: boolean;
  overwrite: boolean;
  videoBitrate?: Bitrate;
  audioBitrate?: Bitrate;
  timeoutInMilliseconds: number;
  props: Record<string, unknown>;
  startFrame?: number;
  endFrame?: number;
  rebundle: boolean;
}

const jobs = new Map<string, Job>();
let queue: Promise<void> = Promise.resolve();

function notify(job: Job) {
  for (const s of job.subscribers) {
    try {
      s(job);
    } catch {
      /* abaikan error subscriber */
    }
  }
}

function update(job: Job, patch: Partial<Pick<Job, "status" | "progress" | "message" | "error">>) {
  Object.assign(job, patch);
  notify(job);
}

function overallProgress(job: Job): number {
  const n = job.items.length || 1;
  const sum = job.items.reduce((a, i) => a + (i.status === "done" ? 1 : i.progress), 0);
  return 0.05 + 0.95 * (sum / n);
}

function jobView(job: Job) {
  return {
    jobId: job.id,
    status: job.status,
    progressPercent: Math.round(job.progress * 100),
    message: job.message,
    elapsedSeconds: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    error: job.error,
    items: job.items.map((i) => ({
      composition: i.compositionId,
      status: i.status,
      progressPercent: Math.round(i.progress * 100),
      output: i.output,
      downloadUrl: i.output ? downloadUrlFor(i.output) : undefined,
      sizeMB: i.sizeBytes ? Number((i.sizeBytes / 1048576).toFixed(2)) : undefined,
      frames: i.durationInFrames,
      fps: i.fps,
      error: i.error,
    })),
  };
}

async function runJob(job: Job, req: RenderRequest): Promise<void> {
  const {cancelSignal, cancel} = makeCancelSignal();
  job.cancel = () => {
    job.cancelRequested = true;
    cancel();
  };

  try {
    if (job.cancelRequested) {
      update(job, {status: "cancelled", message: "Dibatalkan sebelum mulai."});
      return;
    }

    update(job, {status: "bundling", progress: 0, message: "Menyiapkan browser & bundle proyek..."});
    if (!BROWSER_EXECUTABLE) await ensureBrowser();

    const serveUrl = await getServeUrl(req.root, req.entry, req.rebundle, (p) =>
      update(job, {progress: (p / 100) * 0.05, message: `Bundling ${p}%`}),
    );

    let ids: string[];
    if (req.compositionIds === "all") {
      const comps = await getCompositions(serveUrl, {
        inputProps: req.props,
        chromiumOptions: CHROMIUM_OPTIONS,
        browserExecutable: BROWSER_EXECUTABLE,
      });
      ids = comps.map((c) => c.id);
      if (ids.length === 0) throw new Error("Proyek tidak punya composition.");
    } else {
      ids = req.compositionIds;
    }
    job.items = ids.map((id) => ({compositionId: id, status: "pending", progress: 0}));
    update(job, {status: "rendering", progress: 0.05, message: `Render ${ids.length} composition...`});

    for (const item of job.items) {
      if (job.cancelRequested) break;
      item.status = "rendering";
      update(job, {message: `Render "${item.compositionId}"...`});

      try {
        const composition = await selectComposition({
          serveUrl,
          id: item.compositionId,
          inputProps: req.props,
          chromiumOptions: CHROMIUM_OPTIONS,
          browserExecutable: BROWSER_EXECUTABLE,
        });
        item.durationInFrames = composition.durationInFrames;
        item.fps = composition.fps;

        const output =
          ids.length === 1 && req.outputPath
            ? assertAllowed(path.resolve(req.root, req.outputPath))
            : assertAllowed(path.join(req.outputDir, `${item.compositionId}.${EXT[req.codec]}`));
        await fs.mkdir(path.dirname(output), {recursive: true});

        let frameRange: [number, number] | undefined;
        if (req.startFrame !== undefined || req.endFrame !== undefined) {
          const start = req.startFrame ?? 0;
          const end = req.endFrame ?? composition.durationInFrames - 1;
          if (start < 0 || end >= composition.durationInFrames || start > end) {
            throw new Error(
              `frameRange tidak valid (${start}-${end}); durasi composition = ${composition.durationInFrames} frame.`,
            );
          }
          frameRange = [start, end];
        }

        await renderMedia({
          composition,
          serveUrl,
          codec: req.codec,
          outputLocation: output,
          inputProps: req.props,
          overwrite: req.overwrite,
          scale: req.scale,
          muted: req.muted,
          concurrency: req.concurrency ?? null,
          frameRange: frameRange ?? null,
          timeoutInMilliseconds: req.timeoutInMilliseconds,
          chromiumOptions: CHROMIUM_OPTIONS,
          browserExecutable: BROWSER_EXECUTABLE,
          cancelSignal,
          logLevel: "warn",
          ...(CRF_CODECS.has(req.codec) && req.crf !== undefined ? {crf: req.crf} : {}),
          ...(!AUDIO_ONLY.has(req.codec) && req.imageFormat ? {imageFormat: req.imageFormat} : {}),
          ...(req.videoBitrate ? {videoBitrate: req.videoBitrate} : {}),
          ...(req.audioBitrate ? {audioBitrate: req.audioBitrate} : {}),
          onProgress: ({progress}) => {
            item.progress = progress;
            update(job, {
              progress: overallProgress(job),
              message: `Render "${item.compositionId}" ${Math.round(progress * 100)}%`,
            });
          },
        });

        const stat = await fs.stat(output);
        item.output = output;
        item.sizeBytes = stat.size;
        item.progress = 1;
        item.status = "done";
        update(job, {progress: overallProgress(job)});
      } catch (e) {
        if (job.cancelRequested) break;
        item.status = "error";
        item.error = e instanceof Error ? e.message : String(e);
        update(job, {progress: overallProgress(job)});
      }
    }

    if (job.cancelRequested) {
      update(job, {status: "cancelled", message: "Dibatalkan."});
    } else {
      const failed = job.items.filter((i) => i.status === "error").length;
      if (failed > 0) {
        update(job, {
          status: "error",
          progress: 1,
          message: `${failed} dari ${job.items.length} composition gagal.`,
          error: job.items.find((i) => i.error)?.error,
        });
      } else {
        update(job, {status: "done", progress: 1, message: "Selesai."});
      }
    }
  } catch (e) {
    if (job.cancelRequested) {
      update(job, {status: "cancelled", message: "Dibatalkan."});
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      update(job, {status: "error", message: msg, error: msg});
    }
  } finally {
    job.finishedAt = Date.now();
    notify(job);
  }
}

function startJob(req: RenderRequest): Job {
  const id = randomUUID().slice(0, 8);
  const job: Job = {
    id,
    status: "queued",
    progress: 0,
    message: "Dalam antrian...",
    items: [],
    startedAt: Date.now(),
    cancelRequested: false,
    subscribers: new Set(),
    done: Promise.resolve(),
  };
  // Antrian: satu render sekaligus supaya CPU/RAM tidak habis.
  job.done = queue = queue.then(() => runJob(job, req));
  jobs.set(id, job);

  // Batasi memori: buang job lama yang sudah selesai.
  if (jobs.size > MAX_JOBS_KEPT) {
    for (const [key, j] of jobs) {
      if (jobs.size <= MAX_JOBS_KEPT) break;
      if (j.finishedAt) jobs.delete(key);
    }
  }
  return job;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

async function waitForJob(job: Job, extra: ToolExtra) {
  const token = extra._meta?.progressToken;
  let last = -1;
  const sub = (j: Job) => {
    if (token === undefined) return;
    const pct = Math.floor(j.progress * 100);
    if (pct === last) return;
    last = pct;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {progressToken: token, progress: pct, total: 100, message: j.message},
      })
      .catch(() => {});
  };
  job.subscribers.add(sub);
  try {
    await job.done;
  } finally {
    job.subscribers.delete(sub);
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
// Dibungkus fungsi supaya mode HTTP (stateless) bisa membuat server baru per request.
function buildServer(): McpServer {
const server = new McpServer({name: "remotion-render-mcp", version: "1.0.0"});

const text = (value: unknown, isError = false) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  ...(isError ? {isError: true} : {}),
});

const fail = (e: unknown) => text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);

const projectShape = {
  projectPath: z.string().describe("Path absolut root proyek Remotion (folder yang berisi package.json)."),
  entryPoint: z
    .string()
    .optional()
    .describe('Entry file relatif terhadap projectPath. Default: auto-detect "src/index.(ts|tsx|js|jsx)".'),
};

const renderShape = {
  codec: z.enum(CODECS).default("h264").describe("Codec output. h264=mp4, vp9=webm, prores=mov, gif, atau audio (mp3/aac/wav)."),
  crf: z.number().int().min(0).max(51).optional().describe("Kualitas (makin kecil makin bagus). Hanya untuk h264/h265/vp8/vp9."),
  concurrency: z
    .union([z.number().int().positive(), z.string()])
    .optional()
    .describe('Jumlah tab render paralel, mis. 4 atau "50%". Default: otomatis.'),
  scale: z.number().positive().default(1).describe("Skala resolusi (2 = 2x lebih besar)."),
  imageFormat: z.enum(["jpeg", "png"]).optional().describe('Format frame perantara. Pakai "png" untuk transparansi (webm/prores).'),
  muted: z.boolean().default(false).describe("Buang audio."),
  overwrite: z.boolean().default(true).describe("Timpa file output yang sudah ada."),
  videoBitrate: bitrateSchema.optional().describe('Mis. "8M". Alternatif dari crf.'),
  audioBitrate: bitrateSchema.optional().describe('Mis. "192k".'),
  timeoutInMilliseconds: z.number().int().positive().default(120000).describe("Timeout per frame (delayRender)."),
  props: z.record(z.string(), z.unknown()).default({}).describe("inputProps untuk composition (JSON)."),
  startFrame: z.number().int().min(0).optional().describe("Frame awal (opsional, render sebagian)."),
  endFrame: z.number().int().min(0).optional().describe("Frame akhir inklusif (opsional)."),
  rebundle: z.boolean().default(false).describe("Paksa bundle ulang. Biasanya tidak perlu: perubahan file terdeteksi otomatis."),
  wait: z
    .boolean()
    .default(false)
    .describe("true = tunggu sampai render selesai. false = langsung return jobId, cek dengan get_render_status."),
};

type RenderArgs = {
  codec: CodecName;
  crf?: number;
  concurrency?: number | string;
  scale: number;
  imageFormat?: "jpeg" | "png";
  muted: boolean;
  overwrite: boolean;
  videoBitrate?: Bitrate;
  audioBitrate?: Bitrate;
  timeoutInMilliseconds: number;
  props: Record<string, unknown>;
  startFrame?: number;
  endFrame?: number;
  rebundle: boolean;
  wait: boolean;
};

function toRequest(
  project: {root: string; entry: string},
  a: RenderArgs,
  extra: {compositionIds: string[] | "all"; outputPath?: string; outputDir?: string},
): RenderRequest {
  return {
    root: project.root,
    entry: project.entry,
    compositionIds: extra.compositionIds,
    outputPath: extra.outputPath,
    outputDir: extra.outputDir
      ? assertAllowed(path.resolve(project.root, extra.outputDir))
      : path.join(project.root, "out"),
    codec: a.codec,
    crf: a.crf,
    concurrency: a.concurrency,
    scale: a.scale,
    imageFormat: a.imageFormat,
    muted: a.muted,
    overwrite: a.overwrite,
    videoBitrate: a.videoBitrate,
    audioBitrate: a.audioBitrate,
    timeoutInMilliseconds: a.timeoutInMilliseconds,
    props: a.props,
    startFrame: a.startFrame,
    endFrame: a.endFrame,
    rebundle: a.rebundle,
  };
}

// --- list_compositions ------------------------------------------------------
server.registerTool(
  "list_compositions",
  {
    title: "Daftar composition",
    description: "Bundle proyek Remotion lalu tampilkan semua composition (id, resolusi, fps, durasi, defaultProps).",
    inputSchema: {
      ...projectShape,
      props: z.record(z.string(), z.unknown()).default({}).describe("inputProps (opsional)."),
      rebundle: z.boolean().default(false),
    },
  },
  async ({projectPath, entryPoint, props, rebundle}) => {
    try {
      const project = resolveProject(projectPath, entryPoint);
      if (!BROWSER_EXECUTABLE) await ensureBrowser();
      const serveUrl = await getServeUrl(project.root, project.entry, rebundle, () => {});
      const comps = await getCompositions(serveUrl, {
        inputProps: props,
        chromiumOptions: CHROMIUM_OPTIONS,
        browserExecutable: BROWSER_EXECUTABLE,
      });
      return text(
        comps.map((c) => ({
          id: c.id,
          width: c.width,
          height: c.height,
          fps: c.fps,
          durationInFrames: c.durationInFrames,
          durationSeconds: Number((c.durationInFrames / c.fps).toFixed(2)),
          defaultProps: c.defaultProps,
        })),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- render_video -----------------------------------------------------------
server.registerTool(
  "render_video",
  {
    title: "Render video penuh",
    description:
      "Render SATU composition Remotion secara penuh (semua frame + audio) ke file final. Berjalan sebagai job; pakai wait=true untuk menunggu, atau cek dengan get_render_status.",
    inputSchema: {
      ...projectShape,
      compositionId: z.string().describe("ID composition (lihat list_compositions)."),
      outputPath: z.string().optional().describe('Path output (relatif ke projectPath atau absolut). Default: "out/<compositionId>.<ext>".'),
      ...renderShape,
    },
  },
  async (args, extra) => {
    try {
      const project = resolveProject(args.projectPath, args.entryPoint);
      const job = startJob(
        toRequest(project, args, {compositionIds: [args.compositionId], outputPath: args.outputPath}),
      );
      if (args.wait) await waitForJob(job, extra);
      return text(jobView(job), job.status === "error");
    } catch (e) {
      return fail(e);
    }
  },
);

// --- render_all -------------------------------------------------------------
server.registerTool(
  "render_all",
  {
    title: "Render semua composition",
    description:
      "Render SEMUA composition di proyek Remotion (atau daftar tertentu) satu per satu ke folder output. Cocok untuk 'render full proyek'.",
    inputSchema: {
      ...projectShape,
      compositionIds: z
        .array(z.string())
        .optional()
        .describe("Opsional: hanya composition ini. Kosong = semua composition."),
      outputDir: z.string().optional().describe('Folder output (relatif ke projectPath atau absolut). Default: "out".'),
      ...renderShape,
    },
  },
  async (args, extra) => {
    try {
      const project = resolveProject(args.projectPath, args.entryPoint);
      const job = startJob(
        toRequest(project, args, {
          compositionIds: args.compositionIds?.length ? args.compositionIds : "all",
          outputDir: args.outputDir,
        }),
      );
      if (args.wait) await waitForJob(job, extra);
      return text(jobView(job), job.status === "error");
    } catch (e) {
      return fail(e);
    }
  },
);

// --- render_still -----------------------------------------------------------
server.registerTool(
  "render_still",
  {
    title: "Render satu frame",
    description: "Render satu frame composition menjadi gambar PNG/JPEG (sinkron, cepat).",
    inputSchema: {
      ...projectShape,
      compositionId: z.string(),
      frame: z.number().int().min(0).default(0),
      outputPath: z.string().optional().describe('Default: "out/<compositionId>-<frame>.<png|jpeg>".'),
      imageFormat: z.enum(["png", "jpeg"]).default("png"),
      scale: z.number().positive().default(1),
      props: z.record(z.string(), z.unknown()).default({}),
      rebundle: z.boolean().default(false),
    },
  },
  async (args) => {
    try {
      const project = resolveProject(args.projectPath, args.entryPoint);
      if (!BROWSER_EXECUTABLE) await ensureBrowser();
      const serveUrl = await getServeUrl(project.root, project.entry, args.rebundle, () => {});
      const composition = await selectComposition({
        serveUrl,
        id: args.compositionId,
        inputProps: args.props,
        chromiumOptions: CHROMIUM_OPTIONS,
        browserExecutable: BROWSER_EXECUTABLE,
      });
      if (args.frame >= composition.durationInFrames) {
        throw new Error(`frame ${args.frame} di luar durasi (${composition.durationInFrames} frame).`);
      }
      const ext = args.imageFormat === "jpeg" ? "jpeg" : "png";
      const output = assertAllowed(
        args.outputPath
          ? path.resolve(project.root, args.outputPath)
          : path.join(project.root, "out", `${args.compositionId}-${args.frame}.${ext}`),
      );
      await fs.mkdir(path.dirname(output), {recursive: true});
      await renderStill({
        composition,
        serveUrl,
        output,
        frame: args.frame,
        imageFormat: args.imageFormat,
        scale: args.scale,
        inputProps: args.props,
        overwrite: true,
        chromiumOptions: CHROMIUM_OPTIONS,
        browserExecutable: BROWSER_EXECUTABLE,
        logLevel: "warn",
      });
      return text({
        output,
        downloadUrl: downloadUrlFor(output),
        frame: args.frame,
        sizeKB: Math.round((await fs.stat(output)).size / 1024),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// --- get_render_status ------------------------------------------------------
server.registerTool(
  "get_render_status",
  {
    title: "Status render",
    description: "Cek progres & hasil job render berdasarkan jobId.",
    inputSchema: {jobId: z.string()},
  },
  async ({jobId}) => {
    const job = jobs.get(jobId);
    return job ? text(jobView(job)) : text(`Job "${jobId}" tidak ditemukan.`, true);
  },
);

// --- list_render_jobs -------------------------------------------------------
server.registerTool(
  "list_render_jobs",
  {
    title: "Daftar job render",
    description: "Tampilkan semua job render (terbaru di atas).",
    inputSchema: {},
  },
  async () => {
    const list = [...jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => ({
        jobId: j.id,
        status: j.status,
        progressPercent: Math.round(j.progress * 100),
        message: j.message,
        compositions: j.items.map((i) => i.compositionId),
      }));
    return text(list.length ? list : "Belum ada job.");
  },
);

// --- cancel_render ----------------------------------------------------------
server.registerTool(
  "cancel_render",
  {
    title: "Batalkan render",
    description: "Batalkan job render yang sedang berjalan atau masih antri.",
    inputSchema: {jobId: z.string()},
  },
  async ({jobId}) => {
    const job = jobs.get(jobId);
    if (!job) return text(`Job "${jobId}" tidak ditemukan.`, true);
    if (job.finishedAt) return text(`Job sudah selesai dengan status "${job.status}".`);
    job.cancelRequested = true;
    job.cancel?.();
    return text(`Pembatalan job ${jobId} diminta.`);
  },
);

return server;
}

// ---------------------------------------------------------------------------
// Transport: HTTP (remote) atau stdio (lokal)
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const supplied = bearer || url.searchParams.get("token") || "";
  return safeEqual(supplied, AUTH_TOKEN);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("Body terlalu besar.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {"Content-Type": "application/json"});
  res.end(JSON.stringify(body));
}

async function startHttp() {
  if (!AUTH_TOKEN && process.env.MCP_ALLOW_NO_AUTH !== "1") {
    console.error(
      "MCP_AUTH_TOKEN belum di-set. Endpoint publik bisa menjalankan render & menulis file, jadi token wajib. " +
        "Set MCP_AUTH_TOKEN di environment (atau MCP_ALLOW_NO_AUTH=1 kalau benar-benar sengaja tanpa auth).",
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3000);
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, {"Content-Type": "text/plain"});
        res.end("remotion-render-mcp ok");
        return;
      }

      // Download hasil render lewat link acak yang dikembalikan tool.
      if (url.pathname.startsWith("/d/") && req.method === "GET") {
        const file = downloadsByKey.get(url.pathname.slice(3));
        if (!file || !existsSync(file)) {
          res.writeHead(404).end("Not found");
          return;
        }
        const stat = await fs.stat(file);
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
        });
        createReadStream(file).pipe(res);
        return;
      }

      if (url.pathname === "/mcp") {
        if (!isAuthorized(req, url)) {
          sendJson(res, 401, {jsonrpc: "2.0", error: {code: -32001, message: "Unauthorized"}, id: null});
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, {jsonrpc: "2.0", error: {code: -32000, message: "Method not allowed."}, id: null});
          return;
        }
        const body = await readJsonBody(req);
        const mcp = buildServer();
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(404).end("Not found");
    } catch (e) {
      console.error("[http error]", e);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: {code: -32603, message: e instanceof Error ? e.message : "Internal error"},
          id: null,
        });
      } else {
        res.end();
      }
    }
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`remotion-render-mcp siap (HTTP) di port ${port}  ->  endpoint: /mcp`);
    console.error(`Folder proyek yang diizinkan: ${ALLOWED_ROOTS.join(", ")}`);
  });
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error("remotion-render-mcp siap (stdio).");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));

if (HTTP_MODE) {
  await startHttp();
} else {
  await startStdio();
}
