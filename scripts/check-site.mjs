import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "site-dist");
const required = ["index.html", "zh-TW/index.html", "ja/index.html", "assets/site.css", "assets/tokens.css", "assets/agentport-mark.png"];
for (const path of required) await access(resolve(output, path));

const pages = [
  ["index.html", "./assets/site.css", "./assets/agentport-mark.png", 'lang="en"'],
  ["zh-TW/index.html", "../assets/site.css", "../assets/agentport-mark.png", 'lang="zh-Hant-TW"'],
  ["ja/index.html", "../assets/site.css", "../assets/agentport-mark.png", 'lang="ja"'],
];
for (const [path, stylesheet, icon, language] of pages) {
  const html = await readFile(resolve(output, path), "utf8");
  for (const reference of [stylesheet, icon, language, 'rel="canonical"', 'hreflang="zh-Hant"', 'hreflang="ja"']) {
    if (!html.includes(reference)) throw new Error(`site-dist/${path} is missing ${reference}`);
  }
}
