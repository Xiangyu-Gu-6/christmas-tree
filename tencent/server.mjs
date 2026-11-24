import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable, pipeline } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const root = dirname(fileURLToPath(import.meta.url));
const assetRoot = resolve(root, "assets");

export function openBucket(database) {
  const db = new DatabaseSync(database, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS objects (
      key TEXT PRIMARY KEY, body BLOB NOT NULL,
      uploaded INTEGER NOT NULL, metadata TEXT
    ) WITHOUT ROWID;
  `);
  const find = db.prepare("SELECT * FROM objects WHERE key = ?");
  const head = db.prepare("SELECT key, uploaded, metadata, length(body) AS size FROM objects WHERE key = ?");
  const list = db.prepare(`
    SELECT key, uploaded, metadata, length(body) AS size FROM objects
    WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?
  `);
  const add = db.prepare("INSERT INTO objects VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING");
  const replace = db.prepare("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?)");
  const remove = db.prepare("DELETE FROM objects WHERE key = ?");
  const describe = row => ({
    key: row.key, uploaded: new Date(row.uploaded),
    size: row.size ?? row.body.byteLength, customMetadata: JSON.parse(row.metadata)
  });

  return {
    close: () => db.close(),
    transaction(operation) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    head(key) {
      const row = head.get(key);
      return row ? describe(row) : null;
    },
    get(key) {
      const row = find.get(key);
      return row ? { ...describe(row), body: row.body } : null;
    },
    put(key, value, options = {}) {
      const body = Buffer.from(value);
      const uploaded = Date.now();
      const metadata = JSON.stringify(options.customMetadata ?? null);
      const statement = options.onlyIf?.get("If-None-Match") === "*" ? add : replace;
      if (!statement.run(key, body, uploaded, metadata).changes) return null;
      return { key, uploaded: new Date(uploaded), size: body.length, customMetadata: options.customMetadata };
    },
    delete(key) { remove.run(key); },
    list({ prefix = "", cursor, limit = 1000 }) {
      const after = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : "";
      if (cursor && !after.startsWith(prefix)) return { objects: [], truncated: false };
      const rows = list.all(prefix, prefix + "\uffff", after, limit + 1);
      const objects = rows.slice(0, limit).map(describe);
      return {
        objects, truncated: rows.length > limit,
        cursor: rows.length > limit ? Buffer.from(objects.at(-1).key).toString("base64url") : undefined
      };
    }
  };
}

const mimeTypes = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".task": "application/octet-stream",
  ".txt": "text/plain"
};

async function serveAsset(path, incoming, outgoing) {
  const filename = resolve(assetRoot, decodeURIComponent(path.slice("/assets/".length)));
  const local = relative(assetRoot, filename);
  const mime = mimeTypes[extname(filename)];
  if (!mime || !local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) return false;
  const info = await stat(filename).catch(error => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!info?.isFile()) return false;
  outgoing.writeHead(200, {
    "Content-Type": mime, "Content-Length": info.size,
    "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"
  });
  if (incoming.method === "HEAD") outgoing.end();
  else pipeline(createReadStream(filename), outgoing, () => {});
  return true;
}

async function start() {
  const { SITE_ORIGIN, UPLOAD_SIGNING_KEY, PHOTO_DATABASE = "./data/photos.sqlite",
    PORT = "8080", HOST = "127.0.0.1", TRUST_LOCAL_PROXY } = process.env;
  if (!SITE_ORIGIN || !/^https?:$/.test(new URL(SITE_ORIGIN).protocol) ||
      new URL(SITE_ORIGIN).origin !== SITE_ORIGIN || (UPLOAD_SIGNING_KEY?.length ?? 0) < 32) {
    throw new Error("Set SITE_ORIGIN to the exact HTTP(S) origin and UPLOAD_SIGNING_KEY to a random secret.");
  }
  await mkdir(dirname(resolve(PHOTO_DATABASE)), { recursive: true, mode: 0o700 });
  const bucket = openBucket(PHOTO_DATABASE);
  const { default: worker } = await import("./dist/server/index.js");
  const env = { SITE_ORIGIN, UPLOAD_SIGNING_KEY, OWNER_EMAIL: "sites-only", BUCKET: bucket };

  const server = createServer({ requestTimeout: 30000 }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, SITE_ORIGIN);
      if (url.origin !== SITE_ORIGIN) {
        outgoing.writeHead(400).end();
        return;
      }
      const path = url.pathname;
      if (path === "/admin" || path.startsWith("/admin/")) {
        // The original archive uses an identity provided by Sites. Keep that archive there.
        outgoing.writeHead(404).end();
        return;
      }
      if (path.startsWith("/assets/") && ["GET", "HEAD"].includes(incoming.method)) {
        if (!await serveAsset(path, incoming, outgoing)) outgoing.writeHead(404).end();
        return;
      }

      const headers = new Headers(incoming.headers);
      const socketAddress = incoming.socket.remoteAddress;
      const proxyAddress = headers.get("x-christmas-client-ip");
      const localProxy = socketAddress === "127.0.0.1" || socketAddress === "::1" ||
        socketAddress === "::ffff:127.0.0.1";
      headers.delete("oai-authenticated-user-id");
      headers.delete("oai-authenticated-user-email");
      headers.delete("x-christmas-client-ip");
      headers.delete("cf-connecting-ip");
      if (TRUST_LOCAL_PROXY === "1" && localProxy && isIP(proxyAddress ?? "")) {
        headers.set("cf-connecting-ip", proxyAddress);
      } else if (socketAddress) {
        headers.set("cf-connecting-ip", socketAddress);
      }

      const body = ["GET", "HEAD"].includes(incoming.method) ? undefined : Readable.toWeb(incoming);
      const request = new Request(url, { method: incoming.method, headers, body, duplex: "half" });
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) pipeline(Readable.fromWeb(response.body), outgoing, () => {});
      else outgoing.end();
    } catch (error) {
      console.error("Request could not be served:", error.name);
      if (!outgoing.headersSent) outgoing.writeHead(error instanceof URIError ? 400 : 500);
      outgoing.end();
    }
  });
  server.listen(Number(PORT), HOST, () => console.log("Christmas Memories listening on %s:%s", HOST, PORT));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => bucket.close()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
