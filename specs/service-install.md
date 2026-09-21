---
title: AgentPort service 子命令 — 一個指令完成本機常駐部署
labels: [ready-for-agent]
status: draft
created: 2026-09-21
related: agentport-v2.md（部署與憑證）
---

# AgentPort service 子命令 — 一個指令完成本機常駐部署

詞彙依 `CONTEXT.md`：Caller、Logical Agent、Workspace、Runtime、Task。本文另用「服務定義」指 macOS 的 LaunchAgent plist 或 Linux 的 systemd user unit，「安裝目錄」指服務實際執行的那份程式，「包裝指令」指放進 PATH 的 `agentport` 小腳本；三者都是維運用語，不進 `CONTEXT.md`。

## Problem Statement

主機管理者要讓 AgentPort 常駐，目前得照 README 手動走完十幾步：建設定目錄、以 0600 建 env 檔並自己產生 token、用 sed 把 plist / unit 範本的佔位符換成 node 路徑與 repo 路徑、`plutil -lint`、`launchctl bootstrap` 或 `systemctl --user enable`、再自己看 log 確認有沒有起來。任何一步漏掉或打錯，服務就起不來，而且錯誤只會出現在 launchd / journal 的 log 裡。

此外，現行範本讓服務直接執行 repo 裡的建置產物：管理者在 repo 裡改程式、執行 build，常駐服務下次重啟就跑到新（可能是半成品）的程式碼。更新與開發沒有分開。

## Solution

在 AgentPort CLI 加一組 `service` 子命令，並在 repo 提供一個打包腳本：

- 管理者在 repo 裡執行一個 package 腳本，它 build、把只含正式依賴的程式打包到暫存目錄，再以那份程式執行 `agentport service install`。
- `service install` 把程式放到固定的安裝目錄、補齊設定與 token、產生並載入服務定義、確認服務真的開始監聽，並把 `agentport` 包裝指令放進 `~/.local/bin`。重跑即更新。
- 之後的日常操作用 `agentport service status | restart | uninstall`，不必再記 `launchctl` / `systemctl` 的語法。

## User Stories

### 第一次安裝

1. As a 主機管理者, I want 在 repo 裡執行一個指令就完成 build、打包與安裝, so that 不必照 README 手動走十幾步。
2. As a 主機管理者, I want 設定檔不存在時自動產生一份帶註解的骨架並停下來, so that 我知道要填什麼、填在哪裡。
3. As a 主機管理者, I want 骨架預設含一個 caller `default`, so that 我只需要填 agent 就能重跑。
4. As a 主機管理者, I want 已存在的設定檔永遠不被覆寫, so that 重跑安裝不會毀掉我的設定。
5. As a 主機管理者, I want 安裝前先驗證設定檔、有錯就一次列出並中止, so that 不會裝上一個起不來的服務。
6. As a 主機管理者, I want 設定檔裡每個 caller 的 token 若在 env 檔中不存在就自動產生隨機值, so that 不用自己想 token、也不會忘記建 env 檔。
7. As a 主機管理者, I want 新產生的 token 只在當下印出一次、不寫進任何 log, so that 我能複製到 client 端而 token 不會四處殘留。
8. As a 主機管理者, I want env 檔以 0600 建立、已存在的 token 值永遠不被改動, so that 既有 client 不會因為重跑安裝而失效。
9. As a 主機管理者, I want 安裝自動偵測 macOS 或 Linux 並產生對應的服務定義, so that 同一個指令在兩個平台都能用。
10. As a 主機管理者, I want 服務定義裡的 node 路徑、安裝目錄、HOME、USER、PATH 都自動填好（含路徑有空白的情況）, so that 不會因為 sed 或引號出錯。
11. As a 主機管理者, I want 安裝後自動等服務開始監聽、成功就回報監聽位址, so that 我立刻知道部署成功。
12. As a 主機管理者, I want 服務在時限內沒起來時看到錯誤 log 的尾端並得到非零結束碼, so that 不必自己去翻 launchd 或 journal 的 log。
13. As a 主機管理者, I want 安裝時 `~/.local/bin/agentport` 被建立, so that 之後在任何目錄都能打 `agentport service status` 或 `agentport check-config`。
14. As a 主機管理者, I want `~/.local/bin/agentport` 若已存在且不是 AgentPort 安裝的就拒絕覆寫, so that 不會蓋掉我自己的同名工具。
15. As a 主機管理者, I want `--dry-run` 印出將產生的服務定義、包裝指令與要執行的系統指令而不動任何檔案, so that 我能先看清楚它會做什麼。
16. As a 主機管理者, I want 在 macOS、Linux 以外的平台執行時明確報錯, so that 不會得到半套安裝。

### 更新

17. As a 主機管理者, I want 重跑安裝就是更新（停服務、換程式、重新載入）, so that 升級只有一個動作。
18. As a 主機管理者, I want 重跑安裝的結果與第一次安裝相同（冪等）, so that 我不必判斷目前是什麼狀態。
19. As a 主機管理者, I want 常駐服務執行的是安裝目錄裡的那份程式而不是 repo, so that 我在 repo 裡開發、build 不會影響正在跑的服務。
20. As a 主機管理者, I want 新版本先完整寫到暫存位置再換上, so that 複製到一半失敗時舊版仍完整。
21. As a 主機管理者, I want 要回到舊版就 checkout 舊 commit 再重跑安裝, so that 不必另外學回滾機制。

### 日常操作

22. As a 主機管理者, I want `agentport service status` 告訴我服務是否在跑、監聽位址、安裝目錄與 node 路徑, so that 一眼看出健康狀態。
23. As a 主機管理者, I want `status` 在記錄的 node 路徑已不存在時（例如切換了 nvm 版本）提示重跑安裝, so that 我知道服務為什麼起不來。
24. As a 主機管理者, I want `status` 顯示最近的錯誤 log, so that 不必記 log 放在哪。
25. As a Linux 主機管理者, I want `status` 顯示 linger 是否開啟, so that 我知道服務能不能在沒登入時開機啟動。
26. As a Linux 主機管理者, I want 安裝時若 linger 未開啟只得到提示指令而不被代為執行, so that 需要 sudo 或改變系統登入行為的事由我自己決定。
27. As a 主機管理者, I want `agentport service restart` 在改了設定檔或 env 檔後重啟服務, so that 不必記 `launchctl kickstart -k` 或 `systemctl --user restart`。
28. As a 主機管理者, I want `restart` 先驗證設定檔、有錯就不重啟, so that 不會把正在正常跑的服務換成起不來的設定。

### 移除

29. As a 主機管理者, I want `agentport service uninstall` 停止服務並移除服務定義、安裝目錄與包裝指令, so that 系統回到安裝前的樣子。
30. As a 主機管理者, I want uninstall 保留設定檔、env 檔、SQLite 與 log, so that Task 紀錄照 ADR-0002 永久保留、重新安裝即可接續。
31. As a 主機管理者, I want 服務沒安裝時執行 uninstall 或 status 得到清楚的「未安裝」而不是錯誤堆疊, so that 行為可預期。

### 文件

32. As a 主機管理者, I want README 的部署章節只剩 `pnpm service:install` 與 `agentport service ...`, so that 不會有兩套流程互相矛盾。
33. As a Linux 主機管理者, I want README 標明 Linux 路徑尚未經實機驗收, so that 我知道自己是第一個實測的人。

## Implementation Decisions

### 形式與分工

- 新增 CLI 子命令群 `service`：`install`、`uninstall`、`status`、`restart`。`install` 支援 `--dry-run` 與既有的 `--config`。其他平台（非 darwin / linux）一律報錯、結束碼非零。
- 打包不在子命令內：repo 提供 package 腳本 `service:install`，依序 build → `pnpm deploy --legacy --prod` 到暫存目錄 → 以打包出的那份程式執行 `service install`。子命令本身不依賴 pnpm 或 repo，只負責「把目前執行中的這份程式裝成服務」。
- package manifest 補上只發佈建置產物的檔案清單；實測發現缺這一項時 `pnpm deploy` 只帶到 bin 指向的單一檔案（建置產物被 gitignore 排除），打包出的程式無法執行。實測 `pnpm deploy --legacy --prod` 產出約 47 MB，better-sqlite3 native 模組可在新位置載入。`--legacy` 是 pnpm 10 起對非 injected workspace 的要求。

### 安裝目錄與更新

- 安裝目錄固定為 `${XDG_DATA_HOME:-~/.local/share}/agentport/app`。install 先把目前程式完整複製到同層的 `app.new`，再停服務、以換名取代 `app`（舊的先移到暫存名再刪除）、載入服務。不保留舊版。
- node 路徑於安裝當下固定為執行 install 的 node 可執行檔絕對路徑，寫進服務定義與包裝指令。不複製 node 本體（會與 native 模組的 ABI 綁死）。
- 包裝指令為 `~/.local/bin/agentport` 的 POSIX shell 腳本：以固定的 node 路徑執行安裝目錄的 CLI 並轉傳所有參數；內含可辨識的標記行，install / uninstall 只覆寫或刪除帶有此標記的檔案，否則報錯。

### 設定、env 與 token

- 設定檔位置沿用既有尋找順序（`--config` → `$AGENTPORT_CONFIG` → XDG 預設）。不存在時在該路徑產生骨架後中止（結束碼非零，並印出路徑與下一步）：骨架含 `[server]` / `[storage]` 預設值的註解、一段註解掉的 `[[agents]]` 範例、一個 caller `default`（`token_env = "AGENTPORT_TOKEN_DEFAULT"`）。存在時絕不改寫。
- 設定檔驗證沿用 `check-config` 的同一套載入與驗證，錯誤一次列出後中止。
- env 檔位於設定檔所在目錄的 `agentport.env`。install 對設定檔中每個 `callers[].token_env`：env 檔已有該變數就不動；沒有就產生 32 bytes 隨機值（hex）附加進去。env 檔不存在時以 0600 建立；已存在但權限寬於 0600 時改成 0600 並提示。
- 新產生的 token 以「caller 名稱、變數名、值」印到 stdout 一次，並提示這是唯一一次顯示；不寫進服務 log 或任何其他檔案。
- 服務定義一律把實際使用的設定檔路徑以 `--config` 明確傳入，避免服務管理器環境裡的 XDG 變數與安裝當下不同。

### 服務定義（兩平台）

- 範本改為程式內的純渲染函式，是唯一來源；移除 repo 裡的手動範本檔與 env 範例檔。輸入為「平台、node 路徑、安裝目錄、HOME、USER、設定檔路徑、env 檔路徑」，輸出為服務定義全文。
- macOS：LaunchAgent label `com.agentport.serve`，放在 `~/Library/LaunchAgents/`；以 node 內建 `--env-file` 讀 env 檔；`EnvironmentVariables` 帶 `HOME`、`USER`、`PATH`（含 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`）；`RunAtLoad`、`KeepAlive`；stdout / stderr 到 `~/Library/Logs/agentport/`。載入用 `launchctl bootstrap gui/<uid>`，卸載用 `bootout`，重啟用 `kickstart -k`。已載入時 install 先 bootout 再 bootstrap。
- Linux：unit `agentport.service` 放在 `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`；`EnvironmentFile=` 讀 env 檔；`Environment=PATH=...`；`ExecStart` 的路徑加引號；`Restart=always`；`WantedBy=default.target`。載入用 `systemctl --user daemon-reload` + `enable --now`，卸載用 `disable --now` + 刪 unit + `daemon-reload`，重啟用 `restart`。linger 只以 `loginctl show-user` 查詢並提示，不執行 `enable-linger`。

### 成功判定與狀態

- install / restart 載入後，以 TCP 連線探測設定檔 `[server] listen` 的位址，最多等 10 秒。成功印出監聽位址；逾時印出錯誤 log 尾端（macOS 讀 err log 檔、Linux 讀 `journalctl --user -u agentport` 最後數行），結束碼非零，服務保持載入、不自動回滾。
- `status` 回報：是否已安裝、服務管理器回報的執行狀態與 pid、監聽位址是否可連、安裝目錄、node 路徑是否仍存在（不存在時提示重跑 install）、最近錯誤 log、（Linux）linger 狀態。
- `restart` 先驗證設定檔，失敗即中止、不動服務。
- `uninstall`：停止並移除服務定義、刪除安裝目錄與（帶標記的）包裝指令；設定檔、env 檔、SQLite、log 一律保留，不提供 purge。未安裝時回報「未安裝」並以 0 結束。

### 可注入的依賴（模組介面）

`service` 模組對外只有一個入口：依子命令與選項執行，回傳結束碼並透過注入的輸出寫訊息。可注入：平台、HOME、USER、uid、node 路徑、目前程式根目錄、環境變數、系統指令執行器（launchctl / systemctl / journalctl / loginctl）、埠探測、隨機 token 產生器。正式路徑由 CLI 以真實值組裝。

- 票 02 實作時定案：程式目錄複製、移動、清理、服務定義寫入、時鐘與等待也由入口注入；前四者讓 `app.new` 複製、換名、舊版清理或 plist 寫入失敗可保證復原既有服務，後兩者讓 10 秒監聽逾時可在測試中無等待驗證。
- 票 02 review 時定案：新服務成功載入後若清理 `.old` 失敗，可能已有部分舊檔被刪；保留已驗證的新 app/service 與殘留 `.old`，不冒險回復可能不完整的舊版；印出明確錯誤並以非零結束。

### 文件

- README 部署章節改寫為：`pnpm service:install`、設定檔骨架與填寫、token 取得方式、`agentport service status | restart | uninstall`、遠端連入與 client 設定（沿用）、Linux 尚未實機驗收的標示。刪除 sed 手動流程。
- `agentport-v2.md`「部署與憑證」加一行連到本文；ADR-0011 的 Falsified if 所引用的範本檔改為本功能的渲染模組（實作時同步修改）。

## Testing Decisions

- 好的測試只看外部行為：對 `service` 入口下子命令後，暫存 HOME 底下出現哪些檔案與內容、權限，送出的系統指令序列，輸出文字與結束碼。不測渲染函式以外的私有 helper，不斷言內部呼叫順序以外的細節。
- **主 seam：`service` 模組入口**。以暫存目錄當 HOME、假的系統指令執行器（記錄呼叫並依腳本回應）、假的埠探測、固定的 token 產生器與 node 路徑。macOS 與 Linux 都在此 seam 測。涵蓋：第一次安裝（設定檔不存在 → 骨架 + 中止；存在 → 安裝成功）、設定檔驗證失敗中止、token 只補缺且不覆寫既有值、env 檔權限、服務定義內容（含路徑有空白）、重跑安裝冪等與更新時序、`app.new` 換名、埠逾時印 log 並非零結束、包裝指令標記與拒絕覆寫、`--dry-run` 不動檔案、restart 驗證失敗不重啟、uninstall 保留資料、未安裝時的 status / uninstall、不支援的平台、Linux linger 提示、node 路徑失效提示。
- **CLI seam（沿用既有子程序測試）**：以真的建置產物執行一條 `agentport service install --dry-run`（暫存 HOME、既有設定檔），確認子命令路由與輸出，不碰真實服務管理器。
- **人工驗收**：在本機 Mac 以 `pnpm service:install` 走完 install → status → restart → uninstall，確認 launchd 實際載入、監聽、兩個 Runtime 各一輪派工成功、uninstall 後資料仍在。Linux 無實機，驗收條件列出但不勾。
- Prior art：`tests/cli/serve.test.ts` / `stdio.test.ts`（真子程序 CLI）、`tests/config/helpers.ts`（暫存目錄與設定檔）、`tests/helpers/fake-driver.ts`（以腳本回應的假依賴）。
- 覆蓋目標 80%+；TDD。

## Out of Scope

- 部署到遠端主機（SSH 推送、多主機）。
- 自動建立 SSH tunnel、自動設定 client 端（`claude mcp add`、Codex `config.toml`）；token 會以明文落在 client 設定檔，由使用者自行決定。
- 代為執行 `loginctl enable-linger`、macOS 自動登入設定。
- 舊版保留與回滾指令；`--purge`。
- 複製或管理 node 本體；Windows 與其他平台。
- `agentport stdio` 的另一份設定與 `db_path`（沿用 README 說明）。

## Further Notes

- 決策來源：2026-09-21 grilling（Q1–Q19，使用者全數採用建議）。
- 單實例鎖（建置票 11）保證同一 `db_path` 只有一個服務程序；install 在停舊服務與啟新服務之間不會有兩個程序同時持有同一資料庫。
- LaunchAgent 屬 `gui/<uid>`，重開機後需登入才會啟動（Keychain 同樣需登入解鎖），`status` 與 README 維持此提示。
