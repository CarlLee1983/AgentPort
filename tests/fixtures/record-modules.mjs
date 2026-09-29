// 以 `node --import` 預載：把每個解析到的模組 URL 逐行附加到
// AGENTPORT_MODULE_LOG 指定的檔案，讓測試檢查某條路徑載入了哪些模組。
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const logPath = process.env.AGENTPORT_MODULE_LOG;
if (logPath === undefined) {
  throw new Error("AGENTPORT_MODULE_LOG 未設定");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    appendFileSync(logPath, `${result.url}\n`);
    return result;
  },
});
