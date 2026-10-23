import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { log } from "./logger.js";

/**
 * The two faces of the same boundary -- the bridge is a local dev tool and must
 * stay on loopback. Kept side by side because they drift apart when maintained
 * in different files, but deliberately not merged: one lists the *names* a
 * config may bind to, the other the *socket addresses* a loopback client shows
 * up as ("localhost" never appears as a remote address, "::ffff:127.0.0.1" is
 * never a bind target).
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The bridge websocket address, as both bridge roles and their logs print it. */
export function bridgeAddress(config: { host: string; port: number }): string {
  return `ws://${config.host}:${config.port}`;
}

/**
 * Ceiling for a single websocket frame. A snippet plus its JSON envelope must
 * fit under this, which is why code.maxBytes is validated against it below.
 */
export const MAX_PAYLOAD_BYTES = 65_536;

const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(39271),
  /**
   * Where the shared secret lives. Must sit inside the resource folder so
   * server/main.lua can LoadResourceFile it; the default matches the repo
   * layout, where the resource lives next to this package.
   */
  tokenFile: z.string().default("../fivem-mcp-bridge/bridge.token"),
  /** Empty means "any cfx-nui-* origin". Fill in your resource name once you know it. */
  allowedResources: z.array(z.string()).default([]),
  /** Only for local testing without a browser origin (scripts/mock-nui.mjs --no-origin). */
  allowNoOrigin: z.boolean().default(false),
  requestTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  rateLimit: z
    .object({
      commandsPerMinute: z.number().int().min(1).max(10_000).default(120),
    })
    .prefault({}),
  clientLog: z
    .object({
      /** Turns the log tools off entirely. */
      enabled: z.boolean().default(true),
      /** null = auto-detect %LOCALAPPDATA%\FiveM\FiveM.app\logs */
      directory: z.string().nullable().default(null),
      /** Lines returned by fivem_read_log when the caller does not say. */
      defaultLines: z.number().int().min(1).max(1000).default(20),
      /** Append the console output a command produced to the tool's answer. */
      captureOnExecute: z.boolean().default(true),
    })
    .prefault({}),
  crashes: z
    .object({
      /** Turns fivem_read_crash off entirely; the tool is then not even registered. */
      enabled: z.boolean().default(true),
      /** null = auto-detect %LOCALAPPDATA%\FiveM\FiveM.app\crashes */
      directory: z.string().nullable().default(null),
      /** Entries in the "other recent crashes" list. */
      maxCrashes: z.number().int().min(1).max(50).default(10),
    })
    .prefault({}),
  code: z
    .object({
      /** Turns fivem_run_code off entirely; the tool is then not even registered. */
      enabled: z.boolean().default(true),
      /** Upper bound for a single snippet. Must stay below MAX_PAYLOAD_BYTES. */
      maxBytes: z.number().int().min(256).max(1024 * 1024).default(16_384),
      /** Snippets do more than dispatch a command, so they get their own default wait. */
      defaultTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    })
    .prefault({}),
  natives: z
    .object({
      /** Turns the reference check off; fivem_native_info is then not registered either. */
      enabled: z.boolean().default(true),
      /**
       * strict rejects a snippet that calls something the client does not have,
       * warn runs it and says so, off skips the check. Callers can lower this
       * per call, never raise it.
       */
      mode: z.enum(["strict", "warn", "off"]).default("strict"),
      /**
       * Ask the connected client which names really exist before running. Costs
       * one extra round trip (single-digit ms on loopback) and is the only way
       * to catch natives the reference lists but the game build does not expose.
       */
      probeClient: z.boolean().default(true),
    })
    .prefault({}),
  commands: z
    .object({
      mode: z.enum(["denylist", "allowlist"]).default("denylist"),
      denylist: z
        .array(z.string())
        .default(["quit", "exit", "connect", "disconnect", "loadlevel"]),
      allowlist: z.array(z.string()).default([]),
    })
    .prefault({}),
  screenshot: z
    .object({
      /** Turns fivem_screenshot off entirely; the tool is then not even registered. */
      enabled: z.boolean().default(true),
      /**
       * Process names the game window is looked for under, as PowerShell -like
       * patterns without the .exe. The game lives in the GTAProcess; a bare
       * "FiveM" is the launcher window and is matched last on purpose.
       */
      processNames: z
        .array(z.string())
        .default(["FiveM_*GTAProcess", "FiveM_GTAProcess", "FiveM_b*", "FiveM"]),
      /** Width the returned image is scaled down to when the display is wider. 0 = native size. */
      maxWidth: z.number().int().min(0).max(7680).default(1280),
      format: z.enum(["jpeg", "png"]).default("jpeg"),
      /** JPEG only; ignored for PNG. */
      quality: z.number().int().min(1).max(100).default(80),
      /** How long PowerShell gets before the capture is abandoned. */
      timeoutMs: z.number().int().min(500).max(60_000).default(15_000),
      /** null = the OS temp folder. Also the base for relative savePath values. */
      saveDirectory: z.string().nullable().default(null),
      /** Capture the primary display when no FiveM window is found, instead of failing. */
      fallbackToPrimary: z.boolean().default(true),
      /**
       * How the game window is read. "window" asks Windows for the window's own
       * surface (PrintWindow), so it works while other windows cover the game;
       * "screen" copies the desktop, like a normal screenshot; "auto" tries the
       * window first and falls back to the screen.
       */
      method: z.enum(["auto", "window", "screen"]).default("auto"),
    })
    .prefault({}),
  txAdmin: z
    .object({
      /**
       * Off by default: needs a dedicated txAdmin admin account. When enabled,
       * fivem_server_console and fivem_server_command are registered.
       */
      enabled: z.boolean().default(false),
      /** txAdmin panel origin. txAdmin's default port is 40120. */
      url: z.string().default("http://127.0.0.1:40120"),
      /**
       * The dedicated admin account the MCP logs in as. null means the tools
       * explain what to configure instead of failing cryptically.
       */
      username: z.string().nullable().default(null),
      /**
       * Where the account's password lives, unless FIVEM_TXADMIN_PASSWORD is
       * set. The default points at .fivem-mcp/ at the repo root (one level above
       * this package), like tokenFile's default assumes the repo layout; a
       * standalone install sets an explicit path.
       */
      passwordFile: z.string().default("../.fivem-mcp/txadmin.password"),
      /**
       * Quiet period after which a command's output capture is considered
       * complete: once output has started, the capture stops when nothing new
       * arrived for this long.
       */
      captureSettleMs: z.number().int().min(0).max(10_000).default(250),
      /** How long the capture waits for a command's *first* console output. */
      captureWaitMs: z.number().int().min(0).max(10_000).default(1_200),
      /** Budget for login + socket connect before a tool gives up. */
      connectTimeoutMs: z.number().int().min(500).max(30_000).default(8_000),
      /** Bytes returned by fivem_server_console when the caller does not say. */
      defaultReadBytes: z.number().int().min(256).max(65_536).default(8_192),
      /**
       * Same shape as the client-side "commands" policy, checked by the same
       * code. Only "quit" is denied by default: it stops the whole server
       * (txAdmin restarts it, but every player drops).
       */
      commands: z
        .object({
          mode: z.enum(["denylist", "allowlist"]).default("denylist"),
          denylist: z.array(z.string()).default(["quit"]),
          allowlist: z.array(z.string()).default([]),
        })
        .prefault({}),
      /**
       * Resources fivem_server_command must not take down: "stop <name>" is
       * blocked outright and a restart/ensure carries a warning. Defaults to
       * the bridge resource -- stopping it severs this server's own connection
       * to the game with nothing left in-game to bring it back.
       */
      protectedResources: z.array(z.string()).default(["fivem-mcp-bridge"]),
    })
    .prefault({}),
  launch: z
    .object({
      /** Turns fivem_launch off entirely; the tool is then not even registered. */
      enabled: z.boolean().default(true),
      /** null = %LOCALAPPDATA%\FiveM\FiveM.exe, then the fivem:// protocol handler. */
      executablePath: z.string().nullable().default(null),
      /**
       * Used when the caller passes no address. null means the caller has to
       * supply one -- and is told to ask the user rather than guess.
       */
      defaultAddress: z.string().nullable().default(null),
      /** Empty = any address. Entries are a host or a host:port. */
      allowedAddresses: z.array(z.string()).default([]),
      /** Image names that mean "the game is already up", checked before launching. `*` is a wildcard. */
      processNames: z
        .array(z.string())
        .default(["FiveM.exe", "FiveM_*GTAProcess.exe", "FiveM_b*.exe"]),
      /** How long the process lookup gets before it is abandoned as inconclusive. */
      probeTimeoutMs: z.number().int().min(200).max(30_000).default(5_000),
    })
    .prefault({}),
  serverEval: z
    .object({
      /**
       * Off by default on both sides: fivem_server_run_code is only registered
       * when this is true, and the bridge resource additionally requires
       * serverEval = true in its config.lua before the in-game handler exists.
       */
      enabled: z.boolean().default(false),
      /**
       * host:port of the FXServer game endpoint the bridge resource's HTTP
       * handler lives behind. Must stay on loopback -- the token crosses this
       * connection in a header over plain http.
       */
      gameEndpoint: z.string().default("127.0.0.1:30120"),
      /** How long to wait for a server snippet's result. */
      defaultTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    })
    .prefault({}),
  nui: z
    .object({
      /**
       * host:port of FiveM's CEF remote-debugging endpoint (the documented NUI
       * debugging port). Must stay on loopback -- DevTools has no auth at all.
       */
      devtoolsEndpoint: z.string().default("127.0.0.1:13172"),
      /** Budget for one DevTools operation (discovery + attach + evaluate). */
      timeoutMs: z.number().int().min(500).max(30_000).default(8_000),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file that was read, or null when defaults were used. */
  sourcePath: string | null;
  /** Absolute path of the token file. */
  tokenFilePath: string;
  /** Absolute path of the txAdmin password file. */
  txAdminPasswordFilePath: string;
}

export class ConfigError extends Error {}

const DEFAULT_CONFIG_FILENAME = "fivem-mcp.config.json";

/**
 * @param baseDir Root that relative paths resolve against. Callers pass the
 *   mcp-server package directory rather than process.cwd(), because an MCP
 *   client spawns this process with an unpredictable working directory.
 */
export function loadConfig(baseDir: string): LoadedConfig {
  const explicit = process.env["FIVEM_BRIDGE_CONFIG"];
  const candidate = explicit
    ? resolve(baseDir, explicit)
    : resolve(baseDir, DEFAULT_CONFIG_FILENAME);

  let raw: unknown = {};
  let sourcePath: string | null = null;

  try {
    raw = JSON.parse(readFileSync(candidate, "utf8"));
    sourcePath = candidate;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (explicit) {
        throw new ConfigError(
          `Config file not found: ${candidate} (from FIVEM_BRIDGE_CONFIG)`,
        );
      }
      log.debug(`No ${DEFAULT_CONFIG_FILENAME} found, using defaults`);
    } else if (err instanceof SyntaxError) {
      throw new ConfigError(`Config file ${candidate} is not valid JSON: ${err.message}`);
    } else {
      throw new ConfigError(`Could not read config file ${candidate}: ${String(err)}`);
    }
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration in ${candidate}:\n${issues}`);
  }

  const config = applyEnvOverrides(parsed.data);
  assertLoopback(config.host);
  checkTxAdminUrl(config);
  assertLoopbackEndpoint("serverEval.gameEndpoint", config.serverEval.gameEndpoint);
  assertLoopbackEndpoint("nui.devtoolsEndpoint", config.nui.devtoolsEndpoint);

  if (config.code.enabled && config.code.maxBytes >= MAX_PAYLOAD_BYTES) {
    log.warn(
      `code.maxBytes (${config.code.maxBytes}) is not smaller than the ${MAX_PAYLOAD_BYTES}-byte ` +
        "frame ceiling. A snippet at the limit will not fit into a frame together with its " +
        "JSON envelope and the connection would be closed instead.",
    );
  }

  const tokenFilePath = isAbsolute(config.tokenFile)
    ? config.tokenFile
    : resolve(baseDir, config.tokenFile);

  const txAdminPasswordFilePath = isAbsolute(config.txAdmin.passwordFile)
    ? config.txAdmin.passwordFile
    : resolve(baseDir, config.txAdmin.passwordFile);

  return { config, sourcePath, tokenFilePath, txAdminPasswordFilePath };
}

function applyEnvOverrides(config: Config): Config {
  const portRaw = process.env["FIVEM_BRIDGE_PORT"];
  if (portRaw !== undefined && portRaw !== "") {
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`FIVEM_BRIDGE_PORT must be a port number, got "${portRaw}"`);
    }
    config.port = port;
  }
  const txUrl = process.env["FIVEM_TXADMIN_URL"];
  if (txUrl !== undefined && txUrl !== "") config.txAdmin.url = txUrl;
  const txUser = process.env["FIVEM_TXADMIN_USERNAME"];
  if (txUser !== undefined && txUser !== "") config.txAdmin.username = txUser;
  return config;
}

/**
 * The txAdmin URL may leave loopback -- unlike the bridge, the MCP is a client
 * here and txAdmin does its own authentication, and panels commonly run on a
 * remote VPS. Plaintext credentials crossing a network still deserve a warning.
 */
function checkTxAdminUrl(config: Config): void {
  if (!config.txAdmin.enabled) return;
  let parsed: URL;
  try {
    parsed = new URL(config.txAdmin.url);
  } catch {
    throw new ConfigError(`txAdmin.url is not a valid URL: "${config.txAdmin.url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `txAdmin.url must be http or https, got "${parsed.protocol}//" in "${config.txAdmin.url}"`,
    );
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    log.warn(
      `txAdmin.url ${config.txAdmin.url} is plain http off loopback -- the admin password ` +
        "will cross the network unencrypted. Put txAdmin behind https or a tunnel.",
    );
  }
}

/**
 * Validates a "host:port" endpoint and pins it to loopback. Both users carry
 * unauthenticated or token-bearing plain-http traffic and must never leave the
 * machine.
 */
function assertLoopbackEndpoint(key: string, endpoint: string): void {
  const match = /^(\[?[^\]]*\]?|[^:]+):(\d+)$/.exec(endpoint);
  const host = match?.[1]?.replace(/^\[|\]$/g, "");
  const port = match ? Number.parseInt(match[2] ?? "", 10) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${key} must be "host:port", got "${endpoint}"`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `${key} must stay on loopback (${[...LOOPBACK_HOSTS].join(", ")}), got "${endpoint}".`,
    );
  }
}

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `Refusing to bind the bridge to "${host}". This server accepts unauthenticated ` +
        `upgrade requests before the token handshake and must stay on loopback. ` +
        `Allowed values: ${[...LOOPBACK_HOSTS].join(", ")}.`,
    );
  }
}
