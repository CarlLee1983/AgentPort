---
status: accepted
---

# 首版部署：單一管理者專用主機，同主機 Agent 之間無機密隔離

一鍵安裝首版只支援單一主機管理者、只運行 AgentPort 的專用主機，平台固定為 Ubuntu 24.04 LTS／amd64／systemd／cgroup v2，其他組合由安裝器明確拒絕，能力偵測只作第二道防線而非支援承諾。專用主機讓安裝器可全權建立服務帳號、群組與目錄，不處理既有 UID 衝突或他人檔案權限；固定單一組合讓內附 Node 與 native SQLite addon 的產物及 Linux E2E 證據維持一份。

同一主機上的所有 Agent 共用一個 Runtime 帳號與 runtime-home：任一 Agent 的 Execution 可讀取其他 Agent 的 Runtime Session 紀錄，以及檔案權限允許的其他 Workspace。這延續 Workspace 不是 Sandbox 的既有語意；需要不同 Access Scope 之間機密隔離時，應分主機部署。每個 Agent 各自 Runtime 帳號會牽動 launcher profile、帳號生命週期與 `isPrivilegeSeparatedRuntimeIdentity` 的單一群組檢查，列為後續增量，不在首版暗中部分實作。

共用主機、其他發行版或 arm64 的支援，須各自另立 Story 與相容性證據，不得以本安裝器在其他環境「看似可運行」推定支援。

**Falsified if:** `src/supervisor/linux/launcher-configuration.ts` 改為每個 Agent 各自設定 Runtime 帳號或 runtime home；或安裝器接受 Ubuntu 24.04／amd64 以外的平台為受支援；或產品文件宣稱同主機 Agent 之間具機密隔離。
