import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ScreenCaptureUnavailable, type CaptureResult, type ScreenCapture } from "../capture/screen.js";
import type { Config } from "../config.js";
import { formatBytes, image, text } from "./support.js";

export function registerScreenshot(
  server: McpServer,
  capture: ScreenCapture,
  config: Config,
): void {
  const settings = config.screenshot;

  server.registerTool(
    "fivem_screenshot",
    {
      title: "Capture the screen the game is on",
      description:
        "Captures the FiveM window and returns it as an image. This " +
        "is the only way to see what the game actually renders -- the HUD, a NUI page, markers " +
        "and blips, whether a menu really opened. Use it after a change with a visible effect, " +
        "and to look at a bug instead of inferring it from the log.\n\n" +
        "The capture happens on the operating-system side and never touches the game, so it " +
        "needs no bridge connection: a crash dialog, a stuck loading screen or the launcher are " +
        "all fair game. It is also the right tool when fivem_bridge_status says nothing is " +
        "connected and you want to know why.\n\n" +
        "By default the image is cropped to the FiveM window, precisely so that whatever else " +
        "is open on that screen -- other applications, chats, browser windows -- stays out of " +
        "the picture. The window is read from the window itself, not from the screen, so the " +
        "game does not have to be in front: it can sit behind a browser or a chat and the " +
        "capture still shows the game (it must not be minimised). Pass crop: \"display\" (or a " +
        "display selector) when you genuinely need the surroundings, e.g. a crash dialog or the " +
        "launcher next to the game; that reads the screen as it looks. When no FiveM window is " +
        "found the whole display is captured and the caption says so. FiveM has to run windowed " +
        "or borderless windowed: exclusive fullscreen yields a black frame, which this tool " +
        "detects and tells you about.",
      inputSchema: {
        display: z
          .union([z.enum(["auto", "primary", "all"]), z.number().int().min(0).max(15)])
          .optional()
          .describe(
            'Which screen to capture: "auto" (default) is the monitor the FiveM window is on, ' +
              '"primary" the main monitor, "all" the whole virtual desktop across every ' +
              "monitor, and a number one specific display -- the indexes are listed in the " +
              "answer of any successful capture.",
          ),
        crop: z
          .enum(["window", "display"])
          .optional()
          .describe(
            '"window" (default) crops the capture to the FiveM window so nothing else on the ' +
              'screen ends up in the image; "display" keeps the whole monitor. Only meaningful ' +
              'with display: "auto" -- naming a display is already a request for that whole screen.',
          ),
        method: z
          .enum(["auto", "window", "screen"])
          .optional()
          .describe(
            `How the game window is read (default ${settings.method}). "window" reads the ` +
              "window's own surface, so other windows in front of the game do not matter; " +
              '"screen" copies the desktop, overlapping windows included; "auto" tries the ' +
              "window first and falls back to the screen.",
          ),
        maxWidth: z
          .number()
          .int()
          .min(0)
          .max(7680)
          .optional()
          .describe(
            `Scale the image down to at most this width (default ${settings.maxWidth}). Use 0 ` +
              "for the native resolution, which is worth it for reading small text and costs a " +
              "much larger payload.",
          ),
        format: z
          .enum(["jpeg", "png"])
          .optional()
          .describe(
            `jpeg is compact and fine for looking at a scene, png is lossless and better for ` +
              `pixel work on UI and text (default ${settings.format}).`,
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`JPEG quality, ignored for png (default ${settings.quality}).`),
        savePath: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Also keep the file and report where it went. The name resolves inside " +
              `${capture.outputDirectory} and may not escape it. Without this the capture is ` +
              "deleted after being returned.",
          ),
      },
    },
    async ({ display, crop, method, maxWidth, format, quality, savePath }) => {
      try {
        const shot = await capture.capture({ display, crop, method, maxWidth, format, quality, savePath });
        const base64 = shot.data.toString("base64");
        return image(base64, shot.mimeType, describe(shot));
      } catch (err) {
        if (err instanceof ScreenCaptureUnavailable) return text(err.message, true);
        return text(`The screenshot failed: ${(err as Error).message}`, true);
      }
    },
  );
}

/** The caption under the image: what was captured, and anything wrong with it. */
function describe(shot: CaptureResult): string {
  const lines: string[] = [];

  const where =
    shot.source === "virtual-desktop"
      ? `The whole virtual desktop (${shot.bounds.width}x${shot.bounds.height} at ${shot.bounds.x},${shot.bounds.y})`
      : shot.crop === "window"
        ? `The FiveM window (${shot.bounds.width}x${shot.bounds.height} at ${shot.bounds.x},${shot.bounds.y} ` +
          `on display ${shot.display?.index ?? "?"}); the rest of that screen is outside the frame`
        : `Display ${shot.display?.index ?? "?"} (${shot.display?.device ?? "unknown"}` +
          `${shot.display?.primary ? ", primary" : ""}) ` +
          `${shot.bounds.width}x${shot.bounds.height} at ${shot.bounds.x},${shot.bounds.y}`;

  lines.push(
    shot.matched
      ? `${where} -- window "${shot.matched.title}" of ${shot.matched.process}.exe (pid ${shot.matched.pid})`
      : where,
  );

  const downscaled =
    shot.width === shot.nativeWidth
      ? ""
      : `, scaled down from ${shot.nativeWidth}x${shot.nativeHeight}`;
  const how =
    shot.method === "print-window"
      ? "read from the window itself, windows in front of it are not in the picture"
      : "GDI BitBlt of the screen";
  lines.push(
    `Returned ${shot.width}x${shot.height} ${shot.format.toUpperCase()}, ` +
      `${formatBytes(shot.bytes)}${downscaled} (${how}, DPI awareness: ${shot.dpiMode}).`,
  );

  if (shot.savedTo) lines.push(`Saved to ${shot.savedTo}`);
  if (shot.note) lines.push(shot.note);

  if (shot.black) {
    lines.push(
      `The frame is black (brightest sampled channel ${shot.brightest}/255). Windows cannot ` +
        "read an exclusive-fullscreen Direct3D swapchain -- switch FiveM to windowed or " +
        "borderless windowed and capture again. A locked session or a disconnected remote " +
        "desktop looks the same, and so does a genuinely black loading screen." +
        (shot.method === "print-window"
          ? ' If the game is windowed, try method: "screen" with the window in front.'
          : ""),
    );
  }

  if (shot.displays.length > 1) {
    const list = shot.displays
      .map((d) => `${d.index}: ${d.width}x${d.height}${d.primary ? " (primary)" : ""}`)
      .join(", ");
    lines.push(`Displays on this machine -- ${list}.`);
  }

  return lines.join("\n");
}
