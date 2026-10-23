import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Config } from "../config.js";
import { log } from "../logger.js";
import { runTool, type ToolRunResult } from "../runTool.js";
import { CAPTURE_SCRIPT } from "./script.js";

/**
 * Captures the FiveM window -- read from the window itself via PrintWindow, so
 * other windows in front of it do not matter -- or a whole display through the
 * Windows desktop compositor.
 *
 * Deliberately not a bridge feature: a screenshot is a property of the
 * operating system, not of the game, so this never talks to the FiveM resource
 * and keeps working when the bridge is down, the payload is stale or the game
 * is stuck on a loading screen.
 *
 * The work happens in a PowerShell child process (src/capture/script.ts),
 * because System.Drawing plus a handful of user32 calls is the whole job and
 * gets it done without pulling a native module into this package.
 *
 * Note for anyone extending this: the bridge's websocket frame limit
 * (MAX_PAYLOAD_BYTES in config.ts) has nothing to do with a screenshot.
 * Nothing here crosses the bridge, and a normal capture is larger than that
 * limit -- applying it by reflex would reject every image.
 */

export class ScreenCaptureUnavailable extends Error {}

/**
 * GDI cannot read an exclusive-fullscreen swapchain and hands back a black
 * frame. The brightest sampled channel at or below this counts as black.
 */
const BLACK_THRESHOLD = 8;

export interface DisplayInfo {
  index: number;
  device: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatchedWindow {
  process: string;
  pid: number;
  title: string;
}

export type CaptureMethod = "auto" | "window" | "screen";

interface CaptureOptions {
  display?: string | number;
  crop?: "window" | "display";
  method?: CaptureMethod;
  maxWidth?: number;
  format?: "jpeg" | "png";
  quality?: number;
  savePath?: string;
}

export interface CaptureResult {
  data: Buffer;
  mimeType: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  /** True when every sampled pixel was black -- almost always exclusive fullscreen. */
  black: boolean;
  /** Brightest channel found while sampling, for the black-frame message. */
  brightest: number;
  /** Which DPI awareness the worker managed to claim; wrong bounds trace back to this. */
  dpiMode: string;
  /** "print-window" = read from the window itself (occlusion-proof), "screen" = BitBlt of the desktop. */
  method: string;
  /** How the display was picked: game-window, primary, primary-fallback, explicit-index, virtual-desktop. */
  source: string;
  /** What the bounds cover: "window" (the FiveM window), "display", or "all" (virtual desktop). */
  crop: string;
  note: string | null;
  display: DisplayInfo | null;
  bounds: { x: number; y: number; width: number; height: number };
  matched: MatchedWindow | null;
  displays: DisplayInfo[];
  /** Set when the caller asked for the file to be kept. */
  savedTo: string | null;
}

/**
 * The worker's JSON is `as`-cast, not validated, so the fields the mapping
 * below defaults are typed as genuinely optional rather than asserted present.
 */
interface ScriptSuccess
  extends Omit<CaptureResult, "data" | "bytes" | "savedTo" | "note" | "display" | "matched" | "displays" | "method"> {
  ok: true;
  path: string;
  method?: string;
  note?: string | null;
  display?: DisplayInfo | null;
  matched?: MatchedWindow | null;
  displays?: DisplayInfo[];
}

interface ScriptFailure {
  ok: false;
  error: string;
  displays: DisplayInfo[];
}

const EXTENSION: Record<"jpeg" | "png", string> = { jpeg: "jpg", png: "png" };

/** What PowerShell says when the execution policy refuses a .ps1 outright. */
const POLICY_REFUSAL = /execution of scripts is disabled|UnauthorizedAccess|cannot be loaded/i;

export class ScreenCapture {
  /** Written lazily on first use; the name carries a hash so a changed script never goes stale. */
  private scriptPath: string | null = null;

  /**
   * @param baseDir Root that a relative screenshot.saveDirectory resolves
   *   against -- the package directory, never process.cwd(), for the same
   *   reason loadConfig takes one.
   */
  constructor(
    private readonly config: Config,
    private readonly baseDir: string,
  ) {}

  /** False on anything but Windows -- the worker is System.Drawing and user32. */
  get available(): boolean {
    return process.platform === "win32";
  }

  get outputDirectory(): string {
    const configured = this.config.screenshot.saveDirectory;
    if (!configured) return join(tmpdir(), "fivem-mcp");
    return isAbsolute(configured) ? configured : resolve(this.baseDir, configured);
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    if (!this.available) {
      throw new ScreenCaptureUnavailable(
        "Screenshots are only supported on Windows, and this server is running on " +
          `${process.platform}. The capture uses PowerShell and the Windows GDI, which have no ` +
          'equivalent here. Set "screenshot.enabled" to false in fivem-mcp.config.json to stop ' +
          "offering the tool.",
      );
    }

    const settings = this.config.screenshot;
    const format = options.format ?? settings.format;
    const directory = this.outputDirectory;

    try {
      mkdirSync(directory, { recursive: true });
    } catch (err) {
      throw new ScreenCaptureUnavailable(
        `Cannot create the screenshot folder ${directory}: ${(err as Error).message}. Point ` +
          '"screenshot.saveDirectory" somewhere writable.',
      );
    }

    const keep = options.savePath !== undefined;
    const outputPath = keep
      ? this.resolveSavePath(options.savePath as string, directory)
      : join(directory, `capture-${randomBytes(6).toString("hex")}.${EXTENSION[format]}`);

    const args = {
      display: options.display ?? "auto",
      crop: options.crop ?? "window",
      method: options.method ?? settings.method,
      maxWidth: options.maxWidth ?? settings.maxWidth,
      format,
      quality: options.quality ?? settings.quality,
      blackThreshold: BLACK_THRESHOLD,
      processNames: settings.processNames,
      fallbackToPrimary: settings.fallbackToPrimary,
      outputPath,
    };

    const parsed = await this.run(JSON.stringify(args));
    if (!parsed.ok) throw new ScreenCaptureUnavailable(parsed.error);

    let data: Buffer;
    try {
      data = readFileSync(parsed.path);
    } catch (err) {
      throw new ScreenCaptureUnavailable(
        `The capture reported success but ${parsed.path} could not be read: ${(err as Error).message}`,
      );
    }
    if (data.length === 0) {
      throw new ScreenCaptureUnavailable(`The capture wrote an empty file to ${parsed.path}.`);
    }

    if (!keep) {
      try {
        unlinkSync(parsed.path);
      } catch (err) {
        log.debug(`Could not remove the temporary capture ${parsed.path}`, err);
      }
    }

    return {
      data,
      mimeType: parsed.mimeType,
      format: parsed.format,
      bytes: data.length,
      width: parsed.width,
      height: parsed.height,
      nativeWidth: parsed.nativeWidth,
      nativeHeight: parsed.nativeHeight,
      black: parsed.black,
      brightest: parsed.brightest,
      dpiMode: parsed.dpiMode,
      method: parsed.method ?? "screen",
      source: parsed.source,
      crop: parsed.crop ?? "display",
      note: parsed.note ?? null,
      display: parsed.display ?? null,
      bounds: parsed.bounds,
      matched: parsed.matched ?? null,
      displays: parsed.displays ?? [],
      savedTo: keep ? parsed.path : null,
    };
  }

  /**
   * Keeps the kept file inside the screenshot folder. The caller of this tool
   * is a model; letting it name an arbitrary filesystem path would make the
   * screenshot tool a generic write primitive.
   */
  private resolveSavePath(requested: string, directory: string): string {
    const trimmed = requested.trim();
    if (trimmed === "") {
      throw new ScreenCaptureUnavailable("savePath is empty. Pass a file name, or omit it.");
    }

    const resolved = isAbsolute(trimmed) ? trimmed : resolve(directory, trimmed);
    const escape = relative(directory, resolved);
    if (escape.startsWith("..") || isAbsolute(escape)) {
      throw new ScreenCaptureUnavailable(
        `savePath must stay inside the screenshot folder (${directory}); "${requested}" does ` +
          'not. Use a plain file name, or point "screenshot.saveDirectory" in ' +
          "fivem-mcp.config.json where the files should go.",
      );
    }
    return resolved;
  }

  /**
   * Runs the worker and returns whatever JSON it printed.
   *
   * The .ps1 goes first because a real file is debuggable by hand and the error
   * message can name it. Should a machine policy refuse script files even with
   * -ExecutionPolicy Bypass, the same source runs once more as -EncodedCommand:
   * the execution policy governs script *files*, not in-memory commands.
   */
  private async run(argsJson: string): Promise<ScriptSuccess | ScriptFailure> {
    const shell = resolvePowerShell();
    const common = ["-NoProfile", "-NonInteractive", "-NoLogo"];

    const scriptPath = this.ensureScript();
    let attempt = await this.spawnWorker(
      shell,
      [...common, "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      argsJson,
    );

    if (
      !attempt.timedOut &&
      attempt.code !== 0 &&
      lastJsonLine(attempt.stdout) === null &&
      POLICY_REFUSAL.test(attempt.stderr)
    ) {
      log.debug("PowerShell refused the capture script file; retrying it as -EncodedCommand");
      const encoded = Buffer.from(CAPTURE_SCRIPT, "utf16le").toString("base64");
      attempt = await this.spawnWorker(shell, [...common, "-EncodedCommand", encoded], argsJson);
    }

    if (attempt.stderr.trim()) log.debug(`screen capture stderr: ${attempt.stderr.trim()}`);

    if (attempt.timedOut) {
      throw new ScreenCaptureUnavailable(
        `The screenshot did not finish within ${this.config.screenshot.timeoutMs} ms and the ` +
          "PowerShell process was stopped. This usually means the machine is under heavy load " +
          'or the session is locked. Raise "screenshot.timeoutMs" in fivem-mcp.config.json, or ' +
          "try again.",
      );
    }

    const line = lastJsonLine(attempt.stdout);
    if (line === null) {
      throw new ScreenCaptureUnavailable(
        `The capture helper exited with code ${attempt.code} and printed nothing usable. Run ` +
          "this by hand to see the real error:\n  " +
          `${shell} -NoProfile -ExecutionPolicy Bypass -File ${scriptPath}\n` +
          `Its error output was: ${attempt.stderr.trim() || "(empty)"}`,
      );
    }

    try {
      return JSON.parse(line) as ScriptSuccess | ScriptFailure;
    } catch (err) {
      throw new ScreenCaptureUnavailable(
        `The capture helper printed something that is not JSON: ${(err as Error).message}`,
      );
    }
  }

  private async spawnWorker(shell: string, argv: string[], argsJson: string): Promise<ToolRunResult> {
    // No -STA: powershell.exe has been STA since v3, and pwsh rejects the flag.
    const result = await runTool(shell, argv, {
      timeoutMs: this.config.screenshot.timeoutMs,
      env: { ...process.env, FIVEM_AGENT_CAPTURE_ARGS: argsJson },
    });
    if ("spawnError" in result) {
      throw new ScreenCaptureUnavailable(
        `PowerShell could not be started from ${shell}: ${result.spawnError.message}. Screenshots ` +
          'need Windows PowerShell; set "screenshot.enabled" to false if it is unavailable here.',
      );
    }
    return result;
  }

  /**
   * Materialises the worker next to the OS temp files. The hash in the name
   * means a rebuilt server never runs a stale copy.
   */
  private ensureScript(): string {
    if (this.scriptPath !== null) return this.scriptPath;

    const digest = createHash("sha256").update(CAPTURE_SCRIPT).digest("hex").slice(0, 12);
    const directory = join(tmpdir(), "fivem-mcp");
    const path = join(directory, `capture-${digest}.ps1`);

    try {
      mkdirSync(directory, { recursive: true });
      if (!existsSync(path)) {
        // BOM, so PowerShell reads it as UTF-8 whatever the console codepage is.
        writeFileSync(path, `﻿${CAPTURE_SCRIPT}`, "utf8");
      }
    } catch (err) {
      throw new ScreenCaptureUnavailable(
        `Could not write the capture helper to ${path}: ${(err as Error).message}`,
      );
    }

    this.scriptPath = path;
    return path;
  }
}

/** The absolute path, so a broken PATH does not turn into a confusing ENOENT. */
function resolvePowerShell(): string {
  const root = process.env["SystemRoot"];
  if (root) {
    const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

/** The worker prints one JSON line; anything else on stdout is noise from a profile or module. */
function lastJsonLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line && line.startsWith("{") && line.endsWith("}")) return line;
  }
  return null;
}
