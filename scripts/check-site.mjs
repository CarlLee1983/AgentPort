import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "site-dist");
const required = ["index.html", "zh-TW/index.html", "ja/index.html", "assets/site.css", "assets/tokens.css", "assets/agentport-mark.png", "assets/agentport-cover.png", "assets/agentport-dispatch.png"];
for (const path of required) await access(resolve(output, path));

const pages = [
  ["index.html", "./assets/site.css", "./assets/agentport-mark.png", 'lang="en"'],
  ["zh-TW/index.html", "../assets/site.css", "../assets/agentport-mark.png", 'lang="zh-Hant-TW"'],
  ["ja/index.html", "../assets/site.css", "../assets/agentport-mark.png", 'lang="ja"'],
];
for (const [path, stylesheet, icon, language] of pages) {
  const html = await readFile(resolve(output, path), "utf8");
  const prefix = path === "index.html" ? "./assets" : "../assets";
  for (const reference of [stylesheet, icon, `${prefix}/agentport-cover.png`, `${prefix}/agentport-dispatch.png`, language, 'rel="canonical"', 'hreflang="zh-Hant"', 'hreflang="ja"']) {
    if (!html.includes(reference)) throw new Error(`site-dist/${path} is missing ${reference}`);
  }
}
