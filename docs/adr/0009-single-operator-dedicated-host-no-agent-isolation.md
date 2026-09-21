---
status: accepted
inherited_from: ../../../AgentPort/docs/adr/0009-single-operator-dedicated-host-no-agent-isolation.md (v1, 2026-09)
---

> 自 v1 原樣繼承，但只取「同主機多個 Agent 共用一個 Runtime 身分、彼此之間無機密
> 隔離」這條核心結論。v1 第一段的「一鍵安裝器」「服務帳號」「固定 Ubuntu
> 24.04／amd64／cgroup v2」不適用於 v2：v2 沒有安裝器建立獨立服務帳號，服務直接
> 以管理者自己的 OS 使用者身分跑（見 `docs/adr/0011-same-user-subscription-credentials.md`），
> 也明確支援 macOS 與 Linux 兩個平台（spec 使用者故事 15），不是單一發行版。第二段
> 「同主機所有 Agent 共用一個 Runtime 帳號與 runtime-home、無機密隔離」在 v2 依然
> 成立且更直接——v2 所有 Agent 共用同一個管理者的 OS 帳號與訂閱憑證，任一 Agent
> 的 Driver 子程序原則上能存取同帳號下其他檔案。第三段「其他環境需另立 Story」
> 的精神保留，但 v2 的「其他環境」是指 macOS／Linux 以外的平台，不是同一份
> Ubuntu-only 限制。v1 原始 falsification 條件（僅供參照，不是 v2 的判準）：
> 「`src/supervisor/linux/launcher-configuration.ts` 改為每個 Agent 各自設定
> Runtime 帳號或 runtime home；或安裝器接受 Ubuntu 24.04／amd64 以外的平台為受
> 支援；或產品文件宣稱同主機 Agent 之間具機密隔離」——該檔案是 v1 專有模組，
> v2 沒有對應檔案，此條件不適用；v2 版判準見下方本文重寫過的 Falsified if。

# 首版部署：單一管理者專用主機，同主機 Agent 之間無機密隔離

一鍵安裝首版只支援單一主機管理者、只運行 AgentPort 的專用主機，平台固定為 Ubuntu 24.04 LTS／amd64／systemd／cgroup v2，其他組合由安裝器明確拒絕，能力偵測只作第二道防線而非支援承諾。專用主機讓安裝器可全權建立服務帳號、群組與目錄，不處理既有 UID 衝突或他人檔案權限；固定單一組合讓內附 Node 與 native SQLite addon 的產物及 Linux E2E 證據維持一份。

同一主機上的所有 Agent 共用一個 Runtime 帳號與 runtime-home：任一 Agent 的 Execution 可讀取其他 Agent 的 Runtime Session 紀錄，以及檔案權限允許的其他 Workspace。這延續 Workspace 不是 Sandbox 的既有語意；需要不同 Access Scope 之間機密隔離時，應分主機部署。每個 Agent 各自 Runtime 帳號會牽動 launcher profile、帳號生命週期與 `isPrivilegeSeparatedRuntimeIdentity` 的單一群組檢查，列為後續增量，不在首版暗中部分實作。

共用主機、其他發行版或 arm64 的支援，須各自另立 Story 與相容性證據，不得以本安裝器在其他環境「看似可運行」推定支援。

（以上為 v1 原文，含 v1 專有的一鍵安裝器／服務帳號／Ubuntu-only 判準，保留供對照；v2 適用範圍見上方繼承注記。）

**Falsified if（v2 版）：** `src/driver/registry.ts` 改為依 Agent 分別建立 Driver 的 `env` / `command`（例如每個 Agent 各自的 Runtime HOME 或帳號），不再是所有 Agent 共用同一份 `config.runtimes.*` 與服務程序自己的環境；或 `deploy/macos/com.agentport.serve.plist` / `deploy/linux/agentport.service` 改以每個 Agent 各自的服務帳號執行；或產品文件宣稱同主機 Agent 之間具機密隔離。
