// Minimal static file server for e2e fixtures. Sets real Content-Type /
// Content-Length headers so the extension's network-based detection
// (background/index.ts's onHeadersReceived listener) has something genuine
// to read — this is what lets the e2e test exercise real header parsing
// instead of only DOM scanning.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;

const MIME_TYPES = {
  ".html": "text/html",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");

  // Hotlink protection, as real video hosts do it: every stream/playlist
  // request must carry a Referer from this site, and the private-player API
  // additionally wants the custom header its player sends. The extension's
  // own fetches (popup, offscreen) only pass because the background worker
  // replays the headers it saw the page send (src/background/request-headers.ts).
  // The private-player API lives on a second origin (127.0.0.1 vs localhost),
  // like a real video CDN, and answers CORS the way most CDNs do: with a
  // wildcard. That wildcard is what breaks an extension fetch that carries
  // cookies AND a replayed Origin header (net::ERR_FAILED) — so the extension
  // must never replay Origin. The e2e picker test guards that.
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-player-token",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const isStreamPath = requestPath.startsWith("/stream/") || requestPath.startsWith("/api/stream/");
  const referer = req.headers["referer"] ?? "";
  if (isStreamPath && !referer.startsWith("http://localhost:8765/") && !referer.startsWith("http://127.0.0.1:8765/")) {
    res.writeHead(403);
    res.end("Referer required");
    return;
  }
  if (requestPath === "/api/stream/playlist" && req.headers["x-player-token"] !== "fixture-token") {
    res.writeHead(403);
    res.end("X-Player-Token required");
    return;
  }

  // Reports whether the request carried the player token — lets the e2e test
  // prove the extension's header replay does NOT leak onto the page's own
  // requests to other endpoints (it must only affect the extension's fetches).
  if (requestPath === "/api/echo-token") {
    const body = JSON.stringify({ token: req.headers["x-player-token"] ?? null });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // A "private player" playlist endpoint: no file extension, wrong
  // Content-Type. Exercises the page-world manifest sniffer (sniff-page.html).
  if (requestPath === "/api/stream/playlist") {
    // Served from a different path than the file lives at, so its variant
    // URIs must be root-relative for the player (and the extension) to resolve them.
    const playlist = Buffer.from(
      fs.readFileSync(path.join(__dirname, "stream", "master.m3u8"), "utf8").replace(/^(\d+p\/)/gm, "/stream/$1")
    );
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": playlist.length, ...CORS });
    res.end(playlist);
    return;
  }
  const filePath = path.join(__dirname, requestPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      ...CORS,
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`fixture server listening on http://localhost:${PORT}`);
});
