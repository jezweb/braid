// A local smart-HTTP git server for tests: `git http-backend` behind node's http.
// Repos live under GIT_ROOT (default ./.jez/git-root); push is enabled for all.
// Usage: node test/git-server.mjs [port]
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function startGitServer({ port = 0, root = resolve(".jez/git-root") } = {}) {
  mkdirSync(root, { recursive: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "test",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.receivepack",
        GIT_CONFIG_VALUE_0: "true",
        REQUEST_METHOD: req.method,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk) => {
      if (headersDone) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
        else res.setHeader(k, v);
      }
      res.writeHead(status);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.stderr.on("data", (d) => process.stderr.write(d));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, root, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, root } = await startGitServer({ port: Number(process.argv[2] ?? 8787 + 100) });
  console.log(`git server http://127.0.0.1:${port}/ root ${root}`);
}
