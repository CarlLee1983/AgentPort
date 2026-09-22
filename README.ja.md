# AgentPort

[English](README.md) | [繁體中文](README.zh-TW.md) | 日本語

AgentPort は、対象ホスト上の AI Coding Runtime（Claude Code、Codex）を Logical Agent として公開し、リモートで作業を実行できるようにします。ホスト管理者は設定ファイルで Agent を特定の Workspace と Runtime に紐付けます。リモート Caller は許可された範囲でのみタスクを依頼でき、パスの指定や Agent の登録はできません。

用語の詳しい定義は `CONTEXT.md`、アーキテクチャと判断は `specs/agentport-v2.md` を参照してください。

## インストールとデプロイ

Node.js（バージョンは `package.json` の `engines.node` を参照）と、ローカルでログイン済みの `claude` / `codex` CLI が必要です。リポジトリのルートで実行します。

```sh
pnpm install
pnpm service:install
```

このコマンドは build を実行し、本番依存関係とビルド成果物だけを含むプログラムを一時ディレクトリにパッケージ化してから、そのプログラムでサービスをインストールします。常駐サービスはリポジトリ内のファイルを実行しません。初回実行時には `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml` にひな形が生成され、処理を停止します。少なくとも 1 つの agent を入力した後、同じコマンドを再実行してください。

ひな形の設定ファイル探索順は、`--config <path>` → `$AGENTPORT_CONFIG` → `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml` です。デフォルト以外の場所を使えます。

```sh
pnpm service:install -- --config /path/to/agentport.toml
```

ひな形には `default` caller が 1 つ残されています。agent を追加する際は、次の例に沿って変更できます。

```toml
[server]
listen = "127.0.0.1:3333"
long_poll_max_seconds = 30       # 上限 55
turn_timeout_seconds = 3600      # 1 Turn の最大秒数。超過時はキャンセル扱い（error.code = timeout）

[storage]
db_path = "~/.local/state/agentport/agentport.sqlite"
log_dir = "~/.local/state/agentport/logs"

[runtimes.claude]
command = "~/.local/bin/claude"  # 任意。デフォルトでは PATH から探索

[[agents]]
name = "stationhub"              # [a-z0-9-]+、一意
description = "StationHub バックエンド"  # 任意
workspace = "~/Dev/CMG/StationHub"
runtime = "claude"               # claude | codex
policy = "workspace-write"       # 必須：read-only | workspace-write | full
extra_args = ["--model", "opus"]

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"  # token は環境変数からのみ読み、設定ファイルには書かない
```

`~` は `$HOME` に展開され、相対パスは設定ファイルのあるディレクトリからの相対になります。不明なフィールドはエラーです。

`service install` は隣接する `agentport.env`（mode 0600）を作成し、各 caller で不足している token を補います。新しい token はその時点で 1 回だけ出力されます。この値は安全な方法で MCP client に渡してください。token を TOML や log に書き込まないでください。設定ファイルが既に存在する場合、インストールはその内容や既存の token を上書きしません。

インストールに成功すると、`~/.local/bin/agentport` はインストールディレクトリ内の固定バージョンを指します。日常操作のためにリポジトリへ戻る必要はありません。

```sh
agentport check-config
agentport service status
agentport service restart
agentport service uninstall
```

`restart` は TOML または env を変更した後に使います。`uninstall` はサービス定義、インストールディレクトリ、AgentPort が作成したラッパーコマンドだけを削除します。設定、env、SQLite、log は保持されます。`--dry-run` で先にサービス定義とシステムコマンドを確認できます：`pnpm service:install -- --dry-run`。

macOS ではログイン中のユーザーの LaunchAgent として実行されるため、再起動後はそのユーザーがログインし、Keychain のロックが解除されるまで待つ必要があります。Linux は systemd user unit を使用します。**Linux の経路は実機でまだ検証されていません**。ログインしていない間に実行するには、影響を自身で確認したうえで `loginctl enable-linger $USER` を実行してください。

## リモート接続

原則として `listen` を loopback 以外に変更しないでください。リモートマシンからは SSH port forward を使ってローカルの loopback に接続します。

```sh
ssh -N -L 3333:127.0.0.1:3333 <host>
```

その後、リモート側の MCP client が `http://127.0.0.1:3333/` を指せば、ホスト上の loopback を直接呼び出すのと同じです。SSH を迂回して HTTP へ直接接続する必要が明確な場合にのみ `[server] listen` を変更してください。その場合、`[server] allowed_hosts` は必須です（起動時に検証）。未指定なら `check-config` / `serve` によって拒否されます。

## MCP client の設定例

AgentPort の HTTP server は stateless streamable HTTP です。handler はリスニングアドレス全体にマウントされ、パスを見ません。以下の例ではすべてルートパス `http://127.0.0.1:3333/` を使用します。

**Claude Code**（上記の SSH tunnel 経由）：

```sh
claude mcp add --transport http agentport http://127.0.0.1:3333/ \
  --header "Authorization: Bearer ${AGENTPORT_TOKEN}"
```

ここでの `${AGENTPORT_TOKEN}` は `claude mcp add` 実行時に caller 側の shell が展開するものであり、Claude Code 自身が接続時に環境変数を読むものではありません。展開後の平文 token は `~/.claude.json`（または `-s` scope に応じてプロジェクトの `.mcp.json`）へ直接書き込まれます。Claude Code 2.1.278 で検証したところ、header 値は `${VAR}` 形式の実行時展開をサポートしません。`\${AGENTPORT_TOKEN}`（shell 展開をエスケープ）と書くと、文字どおりの `${AGENTPORT_TOKEN}` が header 値として送られ、接続できません。現在、平文での保存を避ける方法はありません。token が他の MCP server 認証情報と同様にその設定ファイルに保存されることを受け入れ、そのファイルへのアクセス権を他の機密設定と同じように制限してください。

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.agentport]
url = "http://127.0.0.1:3333/"
bearer_token_env_var = "AGENTPORT_TOKEN"
tool_timeout_sec = 120
```

`AGENTPORT_TOKEN` は caller 側の環境で事前に設定してください（Codex は接続時に `bearer_token_env_var` を読み、値を `config.toml` に書き込みません）。この値は、ホスト上の `agentport.toml` にあるいずれかの caller の `token_env` が指す値に対応します。Long-poll の上限は `[server] long_poll_max_seconds`（≤ 55 秒）です。Codex は MCP server ごとに `tool_timeout_sec` を設定できます（codex-cli 0.155.0 の設定 schema に存在し、`strings` で出力した binary の定数によりこのフィールド名を確認済み）。公式ドキュメントには 60 秒とありますが、その文書の対象バージョンがローカルの 0.155.0 と一致するかは追加確認しておらず、0.155.0 で実際に有効になるデフォルト値も見つからなかったため、特定のデフォルト値を仮定しません。設定には `long_poll_max_seconds` より大きい値（上記の 120 秒など）を明示し、デフォルトに依存しないでください。

**ローカル stdio**：ネットワークを経由せず、ローカルで直接実行します。`serve` が常駐している間に別の `stdio` を開く場合、両者は同じ `db_path` を共有できません（single-instance ロック。spec の「Task 状態モデル」節を参照）。そのため stdio には別の設定ファイルを使用し、`[storage]` の `db_path` だけを変更します（通常は両者の log が混ざらないよう `log_dir` も変更します）。その他のフィールド（agents、callers、server）はコピーしてください。

```sh
cp ~/.config/agentport/agentport.toml ~/.config/agentport/agentport.stdio.toml
# agentport.stdio.toml を編集し、[storage] db_path（および log_dir）を serve とは別のパスへ変更。例：
#   db_path = "~/.local/state/agentport/agentport-stdio.sqlite"
#   log_dir = "~/.local/state/agentport/logs-stdio"

agentport stdio --config ~/.config/agentport/agentport.stdio.toml
```

同じ `db_path` のまま stdio を起動すると `SQLITE_BUSY` となり、非ゼロのコードで終了して「別の agentport プロセスが &lt;db_path&gt; を使用中」と表示されます。

## デプロイの検証

- `agentport check-config` が想定した agent 一覧を出力し、exit code 0 になる
- LaunchAgent / systemd unit が running と表示される（`launchctl print gui/$(id -u)/com.agentport.serve` または `systemctl --user status agentport`）
- client から `list_agents` を呼び出すと、`check-config` と一致する一覧が返る
- Claude task を送信し、`completed` になるまで実行する
- Codex task を送信し、`completed` になるまで実行する

## MCP tools

すべての tool は `structuredContent` と同じ内容の `content[0].text`（JSON）を返します。tool 層のエラーは `isError: true` と `{ "error": { "code", "message" } }` を返します。code は `not_found`、`invalid_state`、`unknown_agent` です。

| tool          | 入力                                               | 戻り値                                                                                         |
| ------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list_agents` | —                                                  | `{ agents: [{ name, description?, runtime, policy }] }`                                        |
| `submit_task` | `{ agent, prompt }`                                | `{ task_id, context_id, state: "queued" }`。同時に新しい Context を作成                       |
| `follow_up`   | `{ context_id, prompt }`                           | 同上。該当 Context の Agent と Runtime Session を継続                                         |
| `get_task`    | `{ task_id, wait_seconds? }`                       | Task の完全な記録。`wait_seconds` > 0 では状態が変わるか `min(wait_seconds, long_poll_max_seconds)` まで待機 |
| `cancel_task` | `{ task_id }`                                      | `{ task_id, state }`。終了済み Task では `invalid_state`                                     |
| `list_tasks`  | `{ agent?, context_id?, state?, limit?, cursor? }` | `{ tasks: [要約], next_cursor }`。新しい順。`limit` のデフォルトは 50、上限は 100              |

Task の状態：`queued → running → completed | failed | cancelled`。Task の記録には `final_text`、`diff_stat`（Turn 中の `git diff --stat` と未追跡ファイル）、`commits`、`usage`、`hints`（`permission_denied`、`git`、`truncated`）、`error`、`raw_log_path`（CLI の生出力）が含まれます。`error.code` は `runtime_failed`、`session_unresumable`、`interrupted`（サービス再起動時に実行中）、`cancelled`、`timeout` の場合があります。

典型的な流れ：`submit_task` → 終了するまで `get_task`（`wait_seconds` 付き）を繰り返す → Runtime の最終応答が質問なら `follow_up` で回答します。サービス再起動後も `task_id` は取得できます。queued 中の Task は自動で継続され、running 中のものは `interrupted` とマークされ、同じ Context で `follow_up` して再度依頼できます。

## 既知の制限

- **Codex のキャンセル後の follow-up は不安定**：実行中の Codex Task をキャンセルした後、同じ Context の `follow_up` は完了してもキャンセル前の内容を記憶していないことがあり、または `session_unresumable` を返す場合があります。Claude はキャンセル後も正常に継続できます。
- **`read-only` は Claude の `plan` モードに対応**：Claude はファイル書き込みを試みないため、`hints.permission_denied` は発生せず、`~/.claude/plans/` にファイルを残します。
- **`workspace-write` は Claude の `acceptEdits` に対応**：ファイル編集は自動許可されますが、一部の Bash コマンドは拒否される場合があります（`hints.permission_denied` に記録）。
- **policy は隔離境界ではない**：サービスは管理者本人として実行され、Runtime はそのユーザーがアクセスできるすべてにアクセスできます（`docs/adr/0009-*`、`docs/adr/0011-*` を参照）。
- **各 `db_path` にはサービスプロセスを 1 つだけ**：上記「ローカル stdio」を参照。

## 開発

```sh
pnpm install
pnpm check      # format:check → lint → typecheck → build → test。検証は必ずこれを実行
```

`pnpm test` はまず package 依存関係ツリーに触れないテストを並列実行し、その後 production package の受け入れテストを個別に実行します。後者は `pnpm deploy --prod` によりリポジトリの `node_modules` リンクを一時的に再構築します。その依存関係ツリーから module をロードする他のテストとは並列実行できません。`pnpm service:install` 自体も frozen lockfile を使ってビルド依存関係を補うため、以前の production deploy で production-only の依存関係ツリーが残った後でも、インストールを再実行すれば build できます。

実際の CLI テストはデフォルトでスキップされます。ローカルでログイン済みの `claude` / `codex` が必要で、サブスクリプションの利用枠を消費します。

```sh
AGENTPORT_REAL_CLI=1 pnpm vitest run tests/driver/claude/real-cli.test.ts \
  tests/driver/codex/real-cli.test.ts tests/mcp/follow-up-real-cli.test.ts tests/mcp/cancel-real-cli.test.ts
```

## ドキュメント

- `CONTEXT.md`：ドメイン用語
- `specs/agentport-v2.md`：仕様および各ビルドチケットの実装決定
- `docs/adr/`：アーキテクチャ決定（0001 / 0002 / 0003 / 0005 / 0009 は v1 から継承、0011 は v2 の認証情報モデル）
- `.scratch/agentport-v2/map.md`：判断マップと未解決の論点。`.scratch/agentport-v2-build/`：ビルドチケット
