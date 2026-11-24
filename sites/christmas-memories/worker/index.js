const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const PHOTOS_PER_HOUR = 24;
const TICKET_SECONDS = 12 * 60 * 60;
const PHOTO_KEY = /^photos\/[0-9]{8}\/[a-f0-9]{32}\/[0-9]{2}\.jpg$/;
const encoder = new TextEncoder();
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status, headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", ...headers }
  });
}

function json(data, status) {
  return Response.json(data, { status, headers: securityHeaders });
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function signedValue(key, value) {
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

async function readTicket(key, ticket) {
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([a-f0-9]{64})$/.exec(ticket ?? "");
  if (!match || Number(match[2]) < Date.now() / 1000) return null;
  const signature = Uint8Array.from(match[3].match(/../g), pair => parseInt(pair, 16));
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(match[1] + "." + match[2]));
  return valid ? match[1] : null;
}

async function readPhoto(request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_PHOTO_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function upload(request, env, key, origin) {
  if (request.headers.get("origin") !== origin) return json({ error: "请从圣诞树页面发送照片。" }, 403);
  const visitor = await readTicket(key, request.headers.get("x-upload-ticket"));
  if (!visitor) return json({ error: "页面已过期，请刷新后重试。" }, 403);
  if (request.headers.get("content-type") !== "image/jpeg") return json({ error: "照片格式不受支持。" }, 415);

  const bytes = await readPhoto(request);
  if (!bytes) return json({ error: "照片处理后仍超过 3 MB。" }, 413);
  if (bytes.length < 32 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 ||
      bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
    return json({ error: "照片文件无效。" }, 415);
  }

  const address = request.headers.get("cf-connecting-ip");
  const identity = address ? "address:" + address : "ticket:" + visitor;
  const fingerprint = hex(await signedValue(key, identity)).slice(0, 32);
  const reverseHour = String(99999999 - Math.floor(Date.now() / 3600000)).padStart(8, "0");
  const prefix = `photos/${reverseHour}/${fingerprint}/`;
  const { objects } = await env.BUCKET.list({ prefix, limit: PHOTOS_PER_HOUR });
  const used = new Set(objects.map(photo => photo.key));

  for (let slot = 1, attempts = 0; slot <= PHOTOS_PER_HOUR && attempts < 4; slot++) {
    const name = prefix + String(slot).padStart(2, "0") + ".jpg";
    if (used.has(name)) continue;
    attempts++;
    const stored = await env.BUCKET.put(name, bytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "image/jpeg" }
    });
    if (stored) return json({ saved: true }, 201);
  }
  return json({ error: "发送次数过多，请稍后再试。" }, 429);
}

function inboxPage(body) {
  return html(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>照片收件箱 · Christmas Memories</title>
<style>
:root{color-scheme:dark;background:#0d0c0a;color:#fff3d3;font:16px/1.55 system-ui,sans-serif}
body{max-width:1060px;margin:0 auto;padding:32px 20px 60px}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between;border-bottom:1px solid #756038;padding-bottom:18px;margin-bottom:24px}
h1{font:500 clamp(28px,5vw,42px)/1.2 Georgia,serif;margin:0}
nav{display:flex;gap:12px;flex-wrap:wrap}
a{color:#fceea7;text-underline-offset:3px}
nav a,.more{padding:7px 12px;border:1px solid #756038;border-radius:4px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,215px),1fr));gap:16px}
figure{margin:0;border:1px solid #65522f;border-radius:6px;background:#19150f;overflow:hidden}
figure a{display:block;background:#120f0b}
img{display:block;width:100%;aspect-ratio:4/3;object-fit:contain}
figcaption{padding:8px 12px;color:#e2cfab;font-size:14px}
.more{display:inline-block;margin-top:24px}
</style>
</head>
<body><header><h1>照片收件箱</h1><nav><a href="/">圣诞树</a><a href="/admin">刷新</a></nav></header>
<main>${body}</main></body></html>`, 200, {
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Robots-Tag": "noindex, nofollow"
  });
}

function requireOwner(request, env) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email) return "anonymous";
  return email === env.OWNER_EMAIL?.trim().toLowerCase() ? "owner" : "other";
}

async function admin(request, env, url) {
  const access = requireOwner(request, env);
  if (access !== "owner") {
    if (url.pathname === "/admin" && access === "anonymous") {
      return new Response(null, {
        status: 302, headers: { ...securityHeaders, Location: "/signin-with-chatgpt?return_to=%2Fadmin" }
      });
    }
    return new Response("仅网站创建者可以查看照片。", { status: 403, headers: securityHeaders });
  }
  if (!env.BUCKET) return new Response("照片存储暂不可用。", { status: 503, headers: securityHeaders });

  if (url.pathname === "/admin/photo") {
    const key = url.searchParams.get("id") ?? "";
    if (!PHOTO_KEY.test(key)) return new Response("未找到照片。", { status: 404, headers: securityHeaders });
    const photo = await env.BUCKET.get(key);
    if (!photo) return new Response("未找到照片。", { status: 404, headers: securityHeaders });
    return new Response(photo.body, {
      headers: { ...securityHeaders, "Content-Type": "image/jpeg", "Content-Length": String(photo.size) }
    });
  }

  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor && cursor.length > 2048) return new Response("无效的分页链接。", { status: 400, headers: securityHeaders });
  const recent = await env.BUCKET.list({ prefix: "photos/", cursor, limit: 48 });
  const time = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai"
  });
  const photos = recent.objects.filter(photo => PHOTO_KEY.test(photo.key))
    .sort((first, second) => second.uploaded - first.uploaded);
  const cards = photos.map(photo => {
    const imageUrl = "/admin/photo?id=" + encodeURIComponent(photo.key);
    return `<figure><a href="${imageUrl}" target="_blank" rel="noopener">
<img src="${imageUrl}" alt="访客上传的照片" loading="lazy" decoding="async"></a>
<figcaption><time datetime="${photo.uploaded.toISOString()}">${time.format(photo.uploaded)}</time></figcaption></figure>`;
  }).join("");
  const more = recent.truncated && recent.cursor
    ? `<a class="more" href="/admin?cursor=${encodeURIComponent(recent.cursor)}">查看更多</a>` : "";
  return inboxPage(cards ? `<section class="photos" aria-label="收到的照片">${cards}</section>${more}`
    : "<p>还没有收到照片。访客发送成功后，刷新这里即可查看。</p>" + more);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && (path === "/admin" || path === "/admin/photo")) {
        return await admin(request, env, url);
      }
      if ((request.method === "GET" && path === "/") || (request.method === "POST" && path === "/api/photos")) {
        if (!env.BUCKET || !env.UPLOAD_SIGNING_KEY || !env.OWNER_EMAIL) {
          return json({ error: "照片服务暂不可用，请稍后再试。" }, 503);
        }
        const signingKey = await crypto.subtle.importKey(
          "raw", encoder.encode(env.UPLOAD_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
        );
        if (request.method === "POST") return await upload(request, env, signingKey, env.SITE_ORIGIN ?? url.origin);
        const value = crypto.randomUUID() + "." + (Math.floor(Date.now() / 1000) + TICKET_SECONDS);
        const ticket = value + "." + hex(await signedValue(signingKey, value));
        return html(treeHtml.replace("__UPLOAD_TICKET__", ticket), 200, {
          "Permissions-Policy": "camera=(self), microphone=(), geolocation=()"
        });
      }
      return new Response("未找到页面。", { status: 404, headers: securityHeaders });
    } catch (error) {
      console.error("Christmas Memories request failed", error?.name);
      return json({ error: "暂时无法完成，请稍后再试。" }, 500);
    }
  }
};
