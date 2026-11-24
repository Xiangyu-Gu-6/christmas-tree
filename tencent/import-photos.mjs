import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openBucket } from "./server.mjs";

const [sourceArg, databaseArg] = process.argv.slice(2);
if (!sourceArg || !databaseArg) {
  throw new Error("Usage: node import-photos.mjs https://original-public-site photos.sqlite");
}
const source = new URL(sourceArg);
if (!["http:", "https:"].includes(source.protocol) || source.origin !== sourceArg.replace(/\/$/, "")) {
  throw new Error("Provide the original site's origin.");
}
const database = resolve(databaseArg);
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
const bucket = openBucket(database);
const fetchPublic = url => fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
const validId = /^[0-9]{13}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const cursors = new Set();
let imported = 0;
let cursor = null;

try {
  do {
    const endpoint = new URL("/api/shared-photos", source);
    if (cursor) endpoint.searchParams.set("after", cursor);
    const listing = await fetchPublic(endpoint);
    if (!listing.ok) throw new Error("Public photo list HTTP " + listing.status);
    const page = await listing.json();
    if (!Array.isArray(page.photos) || page.photos.length > 12 ||
        (page.next !== null && (typeof page.next !== "string" || !page.next || cursors.has(page.next)))) {
      throw new Error("Invalid public photo page.");
    }
    for (const { id } of page.photos) {
      if (typeof id !== "string" || !validId.test(id)) throw new Error("Invalid public photo identifier.");
      const index = "shared-index/" + id;
      if (bucket.head(index)) continue;
      const response = await fetchPublic(new URL("/api/shared-photos/" + id, source));
      if (!response.ok || response.headers.get("content-type") !== "image/jpeg") {
        throw new Error("Public photo download failed.");
      }
      const size = Number(response.headers.get("content-length"));
      if (!Number.isInteger(size) || size < 32 || size > 3 * 1024 * 1024) throw new Error("Invalid photo length.");
      const photo = new Uint8Array(await response.arrayBuffer());
      if (photo.length !== size || photo[0] !== 255 || photo[1] !== 216 ||
          photo.at(-2) !== 255 || photo.at(-1) !== 217) throw new Error("Invalid JPEG content.");
      const photoKey = "shared-photos/00000000/" + id.slice(14).replaceAll("-", "") + "/01.jpg";
      bucket.transaction(() => {
        bucket.put(photoKey, photo);
        bucket.put(index, "", { customMetadata: { photoKey } });
      });
      imported++;
    }
    cursor = page.next;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  console.log("Imported %d public photos.", imported);
} finally {
  bucket.close();
}
