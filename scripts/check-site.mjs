import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "site-dist");
const required = ["index.html", "assets/site.css", "assets/tokens.css"];
for (const path of required) await access(resolve(output, path));

const html = await readFile(resolve(output, "index.html"), "utf8");
for (const reference of ["./assets/site.css"]) {
  if (!html.includes(reference)) throw new Error(`site-dist/index.html is missing ${reference}`);
}
