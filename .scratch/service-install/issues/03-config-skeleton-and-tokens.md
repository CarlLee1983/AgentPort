# 03: 設定檔骨架與 token 自動產生

**What to build:** 第一次安裝時沒有設定檔，得到一份骨架並被告知下一步；填好 agent 重跑後，每個 caller 缺的 token 被自動產生並只顯示一次，env 檔權限正確，既有 token 永不被改。

**Blocked by:** 02

**Status:** done

- [x] 設定檔不存在：在尋找順序決定的路徑產生骨架（含註解掉的 `[[agents]]` 範例與 caller `default` / `AGENTPORT_TOKEN_DEFAULT`），印出路徑與「填好 agent 後重跑」，結束碼非零，未寫 plist、未送任何 launchctl 指令
- [x] 設定檔已存在時內容逐位元組不變（即使驗證失敗）
- [x] 設定檔有兩個 caller、env 檔不存在：env 檔以 0600 建立，含兩個變數，值為注入 token 產生器的輸出；stdout 各印一次「caller、變數名、值」；plist 與 err log 中都不含 token 值
- [x] env 檔已有其中一個變數（值 `keep-me`）：該值不變，只補另一個，stdout 只印新的那一個
- [x] env 檔權限為 0644：安裝後為 0600，並印出已收緊的提示
- [x] 所有 token 都已存在時重跑：env 檔內容不變，stdout 不含任何 token
