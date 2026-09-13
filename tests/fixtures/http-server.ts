import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * Deterministic local fixture server for Phase-5 gates. Counts every
 * server-side write so tests prove behavior from the server's journal,
 * never from displayed text alone.
 */
export interface FixtureServer {
  baseUrl: string;
  writes: (kind?: string) => number;
  release: (kind: string) => void;
  reset: () => void;
  close: () => Promise<void>;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const bytes = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": bytes.length,
    ...headers,
  });
  res.end(bytes);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const counts = new Map<string, number>();
  const blocked = new Map<string, Array<() => void>>();
  const bump = (kind: string): number => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return next;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/state") {
        send(res, 200, JSON.stringify({ writes: Object.fromEntries(counts) }), {
          "content-type": "application/json",
        });
        return;
      }
      if (req.method === "POST" && path === "/reset") {
        counts.clear();
        send(res, 200, "reset");
        return;
      }
      if (req.method === "POST" && path === "/release") {
        const kind = url.searchParams.get("kind") ?? "submit";
        const waiting = blocked.get(kind) ?? [];
        blocked.set(kind, []);
        for (const release of waiting) release();
        send(res, 200, `released ${waiting.length}`);
        return;
      }

      if (req.method === "GET" && path === "/form") {
        const block = url.searchParams.get("block") === "1" ? "?block=1" : "";
        send(
          res,
          200,
          `<!doctype html><html><head><title>Submit form</title></head><body>
<h1>Submit form</h1>
<form method="POST" action="/submit${block}"><label for="name">Name</label>
<input id="name" name="name" type="text" /><button type="submit">Send</button></form>
</body></html>`,
        );
        return;
      }
      if (req.method === "POST" && path === "/submit") {
        const n = bump("submit");
        const delay = Number(url.searchParams.get("delay") ?? "0");
        if (url.searchParams.get("block") === "1") {
          await new Promise<void>((resolve) => {
            const waiting = blocked.get("submit") ?? [];
            waiting.push(resolve);
            blocked.set("submit", waiting);
          });
        } else if (delay > 0) {
          await new Promise((r) => setTimeout(r, Math.min(delay, 20_000)));
        }
        send(res, 200, `Submitted #${n}`);
        return;
      }

      if (req.method === "GET" && path === "/redirect") {
        res.writeHead(302, { location: "/landing" });
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/landing") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Landing</title></head><body><p id="here">Landing reached</p><a id="dl" href="/download">Get report</a></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/meta") {
        send(
          res,
          200,
          `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=/landing"><title>Hop</title></head><body><p>hopping…</p></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/slow") {
        const ms = Math.min(
          Number(url.searchParams.get("ms") ?? "3000"),
          25_000,
        );
        await new Promise((r) => setTimeout(r, ms));
        send(
          res,
          200,
          `<!doctype html><html><head><title>Slow</title></head><body><p id="slow">slow ok</p></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/download") {
        bump("download");
        send(res, 200, "report contents", {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        return;
      }
      if (req.method === "GET" && path === "/upload-page") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Upload</title></head><body>
<h1>Upload</h1>
<form method="POST" action="/upload" enctype="multipart/form-data">
<label for="file">File</label><input id="file" name="file" type="file" />
<button id="send-file" type="submit">Send file</button></form>
<div id="out" role="status"></div>
<script>document.getElementById('file').addEventListener('change', (e) => {
document.getElementById('out').textContent = 'picked: ' + (e.target.files[0]?.name ?? 'none'); });</script>
</body></html>`,
        );
        return;
      }
      if (req.method === "POST" && path === "/upload") {
        const body = await readBody(req);
        bump("upload");
        send(
          res,
          200,
          JSON.stringify({
            bytes: body.length,
            hasFilename: body.includes("filename="),
          }),
          {
            "content-type": "application/json",
          },
        );
        return;
      }
      if (req.method === "GET" && path === "/cookie-set") {
        send(res, 200, "cookie set", {
          "set-cookie": "bridge=choc-chip; Path=/; Max-Age=3600",
        });
        return;
      }
      if (req.method === "GET" && path === "/cookie-echo") {
        send(res, 200, `cookies: ${req.headers["cookie"] ?? "(none)"}`, {
          "content-type": "text/plain",
        });
        return;
      }
      if (req.method === "GET" && path === "/dialog") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Dialogs</title></head><body>
<h1>Dialogs</h1><button id="alert-btn" type="button">Raise alert</button>
<button id="confirm-btn" type="button">Ask confirm</button>
<div id="out" role="status"></div>
<script>
document.getElementById('alert-btn').addEventListener('click', () => { alert('boom-alert'); document.getElementById('out').textContent = 'after alert'; });
document.getElementById('confirm-btn').addEventListener('click', () => { document.getElementById('out').textContent = confirm('sure?') ? 'confirmed' : 'cancelled'; });
</script></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/shadow") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Shadow</title></head><body>
<h1>Shadow</h1><div id="open-host"></div><div id="closed-host"></div><div id="out" role="status"></div>
<script>
const open = document.getElementById('open-host').attachShadow({ mode: 'open' });
open.innerHTML = '<button id="shadow-btn" type="button">Shadow button</button>';
open.getElementById('shadow-btn').addEventListener('click', () => { document.getElementById('out').textContent = 'shadow clicked'; });
const closed = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
closed.innerHTML = '<button type="button">Hidden button</button>';
</script></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/overlay") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Overlay</title></head><body>
<h1>Overlay</h1><button id="covered-btn" type="button">Covered button</button>
<div id="out" role="status"></div>
<div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10;display:flex;align-items:center;justify-content:center;">
<div style="background:white;padding:2rem;"><p id="modal-text">Modal blocks the page</p><button id="dismiss-btn" type="button">Dismiss</button></div></div>
<script>
document.getElementById('covered-btn').addEventListener('click', () => { document.getElementById('out').textContent = 'covered clicked'; });
document.getElementById('dismiss-btn').addEventListener('click', () => { document.getElementById('modal').style.display = 'none'; });
</script></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/cookie-wall") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Cookie wall</title></head><body>
<h1>Cookie wall</h1><button id="buy-btn" type="button">Buy now</button>
<div id="out" role="status"></div>
<div id="consent" role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10;display:flex;align-items:center;justify-content:center;">
<div style="background:white;padding:2rem;"><p>We use cookies and data to run this shop.</p><button id="reject-btn" type="button">Reject all</button><button id="accept-btn" type="button">Accept all</button></div></div>
<script>
document.getElementById('buy-btn').addEventListener('click', () => { document.getElementById('out').textContent = 'bought'; });
document.getElementById('reject-btn').addEventListener('click', () => { document.getElementById('consent').style.display = 'none'; });
document.getElementById('accept-btn').addEventListener('click', () => { document.getElementById('out').textContent = 'TRACKED'; });
</script></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/virtual") {
        send(
          res,
          200,
          `<!doctype html><html><head><title>Virtual</title></head><body>
<h1>Virtual list</h1>
<div id="feed" role="region" aria-label="Rows" style="height:200px;overflow:auto;border:1px solid #ccc;position:relative;">
<div id="spacer" style="height:30000px;"></div>
<div id="window" style="position:absolute;top:0;left:0;right:0;"></div>
</div>
<div id="out" role="status"></div>
<script>
const ROWS = 1000, ROW_H = 30;
const feed = document.getElementById('feed'), win = document.getElementById('window');
function render() {
  const start = Math.max(0, Math.floor(feed.scrollTop / ROW_H) - 5);
  const end = Math.min(ROWS, start + 25);
  win.style.transform = 'translateY(' + (start * ROW_H) + 'px)';
  let html = '';
  for (let i = start; i < end; i++) html += '<button class="vrow" data-i="' + i + '" type="button" style="display:block;height:30px;">row ' + i + '</button>';
  win.innerHTML = html;
}
win.addEventListener('click', (e) => {
  const btn = e.target.closest('.vrow');
  if (btn) document.getElementById('out').textContent = 'picked row ' + btn.dataset.i;
});
feed.addEventListener('scroll', render);
render();
</script>
</body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/boom") {
        send(res, 500, "boom", { "content-type": "text/plain" });
        return;
      }
      send(res, 404, "not found", { "content-type": "text/plain" });
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // client already gone
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    writes: (kind?: string) =>
      kind
        ? (counts.get(kind) ?? 0)
        : [...counts.values()].reduce((a, b) => a + b, 0),
    release: (kind: string) => {
      const waiting = blocked.get(kind) ?? [];
      blocked.set(kind, []);
      for (const resolve of waiting) resolve();
    },
    reset: () => counts.clear(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
