// Minimal web proxy. Node 18+, no dependencies.  Run: node server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";

const PORT = process.env.PORT || 3000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// --- Abuse limits ------------------------------------------------------------
const MAX_BYTES = 15 * 1024 * 1024; // refuse bigger responses
const LIMIT = 120;                  // requests per IP per minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const clientIp = (req) =>
  (process.env.TRUST_PROXY && req.headers["x-forwarded-for"]?.split(",")[0].trim()) ||
  req.socket.remoteAddress;
const limited = (req) => {
  const ip = clientIp(req);
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > LIMIT;
};

const isBlockedHost = (host) => {
  const h = (host || "").toLowerCase();
  return (
    !h ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "localhost.localdomain" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.startsWith("::ffff:")
  );
};

// --- Safety: never let the proxy reach private/internal addresses -----------
const isPrivate = (ip) => {
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || a === 255) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && b === 18) return true;
    if (a === 198 && b === 19) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }

  const l = ip.toLowerCase();
  return (
    l === "::1" ||
    l === "::" ||
    l.startsWith("::ffff:") ||
    l.startsWith("fc") ||
    l.startsWith("fd") ||
    l.startsWith("fe80")
  );
};

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https addresses work.");
  if (u.username || u.password) throw new Error("URLs with embedded credentials are not allowed.");
  if (isBlockedHost(u.hostname)) throw new Error("That address is not public.");

  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length) throw new Error("That host has no public DNS record.");
  if (addrs.some((a) => isPrivate(a.address))) throw new Error("That address is private.");
}

// --- Rewriting ---------------------------------------------------------------
const prox = (u, base) => {
  try {
    return "/go?url=" + encodeURIComponent(new URL(u, base).href);
  } catch {
    return u;
  }
};
const skip = /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i;

const rewriteCss = (css, base) =>
  css
    .replace(/url\(\s*(["']?)(?!data:)(.*?)\1\s*\)/gi, (m, q, v) => `url(${q}${prox(v, base)}${q})`)
    .replace(/@import\s+(["'])(.*?)\1/gi, (m, q, v) => `@import ${q}${prox(v, base)}${q}`);

const clientScript = (base) => `<script>(function(){
var B=${JSON.stringify(base)};
function P(u){try{if(String(u).indexOf("/go?url=")===0)return u;return "/go?url="+encodeURIComponent(new URL(u,B).href)}catch(e){return u}}
var f=window.fetch;window.fetch=function(i,o){return f(typeof i==="string"||i instanceof URL?P(i):i,o)};
var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=P(u);return x.apply(this,arguments)};
document.addEventListener("submit",function(e){
  var form=e.target;if((form.method||"get").toLowerCase()!=="get")return;
  e.preventDefault();
  var real=new URL(new URL(form.action,location.href).searchParams.get("url")||B);
  new FormData(form).forEach(function(v,k){if(typeof v==="string")real.searchParams.set(k,v)});
  location.href=P(real.href);
},true);
})();</script>`;

function rewriteHtml(html, base) {
  html = html
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, "")
    .replace(/\sintegrity=(["']).*?\1/gi, "")
    .replace(/(\s(?:href|src|action|poster)=)(["'])(.*?)\2/gi, (m, a, q, v) => {
      v = v.trim().replace(/&amp;/g, "&");
      return skip.test(v) ? m : `${a}${q}${prox(v, base)}${q}`;
    })
    .replace(/\ssrcset=(["'])(.*?)\1/gi, (m, q, v) => {
      const out = v
        .split(",")
        .map((p) => {
          const [u, ...rest] = p.trim().split(/\s+/);
          return [prox(u, base), ...rest].join(" ");
        })
        .join(", ");
      return ` srcset=${q}${out}${q}`;
    });
  html = rewriteCss(html, base); // inline <style> blocks and style="" attributes
  const inject = clientScript(base);
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
}

// --- Server ------------------------------------------------------------------
const page = (msg) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<body style="font:16px system-ui;max-width:32rem;margin:20vh auto;padding:0 1rem">` +
  `<p>${msg}</p><p><a href="/">Back</a></p>`;

http
  .createServer(async (req, res) => {
    const here = new URL(req.url, "http://localhost");

    if (here.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(new URL("./index.html", import.meta.url)));
    }
    if (here.pathname !== "/go") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end(page("Page not found."));
    }

    if (limited(req)) {
      res.writeHead(429, { "content-type": "text/html; charset=utf-8", "retry-after": "60" });
      return res.end(page("Too many requests. Try again in a minute."));
    }

    try {
      const target = new URL(here.searchParams.get("url") || "");
      if (target.host === req.headers.host) throw new Error("That address points back to this proxy.");
      await assertPublic(target);

      const upstream = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          "user-agent": UA,
          accept: req.headers.accept || "*/*",
          "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
        },
      });

      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
        res.writeHead(302, { location: prox(upstream.headers.get("location"), target) });
        return res.end();
      }

      if (Number(upstream.headers.get("content-length")) > MAX_BYTES) {
        throw new Error("That file is too large.");
      }
      const type = upstream.headers.get("content-type") || "application/octet-stream";
      const headers = {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      let body;

      if (/text\/html/i.test(type)) {
        body = rewriteHtml(await upstream.text(), target.href);
      } else if (/text\/css/i.test(type)) {
        body = rewriteCss(await upstream.text(), target.href);
      } else {
        body = Buffer.from(await upstream.arrayBuffer());
      }

      res.writeHead(upstream.status, headers);
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(page(`Couldn't load that page. ${err.message}`));
    }
  })
  .listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));
