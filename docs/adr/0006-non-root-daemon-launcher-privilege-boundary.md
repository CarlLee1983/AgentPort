---
status: accepted
---

# 非 root control daemon，launcher 為唯一特權邊界

正式部署的 control daemon 以非 root 服務帳號執行，只擁有自己的資料目錄並加入 launcher socket 群組；privileged launcher 是主機上唯一的 root 程序，負責建立 ingress 目錄（`root:agentport-ingress`，0771）、ledger 與以 `systemd-run --uid/--gid` 降權啟動 worker。daemon 直接處理來自 HTTP 的不可信 MCP 輸入，若維持目前 `createControlledRuntimeAdmission()` 要求的 uid 0，daemon 一旦被攻破即等於主機 root；把特權集中到只接受 daemon 指令的 launcher，可讓解析外部輸入與持有特權分屬不同程序。

曾考慮讓 daemon 以非 root 擁有 ingress 目錄（群組為 Runtime），但這讓 daemon 能改變 ingress 權限，削弱 launcher 作為唯一特權邊界的意義，故不採用。daemon 與 launcher 之間維持以 socket 群組權限作為認證邊界，不另加共享 token（token 同樣須放在 daemon 可讀處，不增加防護）或 `SO_PEERCRED`（Node 需 native addon，未驗證）。此選擇成立的前提是 launcher socket 群組只包含 daemon 服務帳號，安裝器建立此關係、`doctor` 持續檢查，偏離即不得報告 execution-ready。

GATE-040 補充：Node 無法把 launcher 建立的 listening socket 交給非子程序的 daemon，因此 ingress 目錄由 launcher 擁有，daemon 在其中建立每個 socket（0660，daemon uid 與 Runtime 群組）。daemon 需加入 `agentport-ingress` 與 Runtime 群組；Runtime 只能 traverse 目錄，不能列出、刪除或替換 socket，worker 仍以 ingress token 認證。

GATE-054 補充：G4 的非 root daemon fixture 不能在 root-only core-data 目錄下放置自己的 ingress 與 SQLite 資料。core-data 維持 `root:root` 0700；fixture 改用獨立的 `root:root` 0711 暫存根目錄。此根目錄僅供 daemon traverse 到每次測試建立的 root-owned ingress 與 daemon-owned database，Runtime 仍不得讀寫 core-data 或 fixture root。

代價是 S3-B composition 與 ingress 建立流程需重做，並需同步修正 `docs/deployment-guide.md` 與實作不一致之處。回退成 root daemon 在技術上容易，但會重新把不可信輸入解析放到 root 程序中，必須以新 ADR 明確接受該風險。

**Falsified if:** `src/bootstrap/create-controlled-runtime-admission.ts` 在正式部署路徑仍要求 `getuid() === 0`；或 `src/supervisor/linux/launcher-server.ts` 的 launcher socket 群組允許 daemon 服務帳號以外的成員；或 daemon 需要直接擁有、建立 `src/runtime/worker/ingress.ts` 使用的 ingress 目錄才能運作。
