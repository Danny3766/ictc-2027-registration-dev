import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const files = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/success.html", "success.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/success.js", "success.js"],
  ["/hosting.js", "hosting.js"],
  ["/pickup.js", "pickup.js"],
  ["/meals.js", "meals.js"],
  ["/ui.js", "ui.js"],
  ["/config.js", "config.js"],
  ["/admin/", "admin/index.html"],
  ["/admin/index.html", "admin/index.html"],
  ["/admin/staff.js", "admin/staff.js"],
  ["/admin/staff.css", "admin/staff.css"],
]);
const types = { html: "text/html", css: "text/css", js: "text/javascript" };

export function startServer({ config } = {}) {
  const server = createServer(async (request, response) => {
    const name = files.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!name) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = name === "config.js" && config
        ? `window.APP_CONFIG = ${JSON.stringify(config)};\n`
        : await readFile(new URL(`../site/${name}`, import.meta.url));
      response.writeHead(200, { "Content-Type": `${types[name.split(".").at(-1)]}; charset=utf-8` }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8765, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startServer();
