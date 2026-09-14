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
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
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
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`fixture server listening on http://localhost:${PORT}`);
});
