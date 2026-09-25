<div align="center">

# mc-mcp

### Minecraftボット制御MCPサーバ

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/ja/docs/Web/JavaScript)
[![Minecraft](https://img.shields.io/badge/Minecraft-1.21.4-62B47A?style=flat&logo=minecraft&logoColor=white)](https://minecraft.net)
[![MCP](https://img.shields.io/badge/MCP-server-blue?style=flat)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

**MinecraftをLLMにbot+RCONで操作させるMCPサーバー**

---

</div>

## 概要

[mineflayer](https://github.com/PrismarineJS/mineflayer) でMinecraftボットを操作するMCPサーバーです。RCONブリッジを介した管理コマンド実行も可能です。

> **⚠ 信頼モデル — 必ず最初に読んでください。**  
> このサーバーへのstdioアクセスを持つ者は、Minecraftワールドを完全制御できます（RCON、opボット、WorldEdit）。  
> 自分が所有するか、または明示的な管理許可を持つサーバーにのみ接続してください。  
> デフォルト設定は、プライベートRFC1918 IPのオフラインモードLANサーバーを前提としています。

## 特徴

| 機能 | 説明 |
|------|------|
| ボット操作 | mineflayer経由でボットをスポーン・移動・チャット |
| RCONブリッジ | 許可リストによる安全なサーバーコマンド実行 |
| WorldEdit連携 | ボット経由で空間編集コマンドを実行 |
| パスファインダー | 障害物回避の自動経路探索、掘削ON/OFF選択可 |
| 多重ボット | MAX_BOTS（デフォルト4）まで同時接続可能 |
| スタートアップ警告 | パブリックIPへの接続を検出して警告 |

## サーバー側セットアップ (RCON有効化)

1. **RCONを有効化** (`server.properties`):
   ```properties
   enable-rcon=true
   rcon.port=25575
   rcon.password=<強力なパスワードを設定し MC_RCON_PASSWORD として export する>
   ```
2. **サーバーを再起動** してRCONを有効化します。
3. **(任意) [WorldEdit](https://enginehub.org/worldedit) をインストール** — `worldedit` ツールを使いたい場合に必要です。スポーン時にボットが自動でopされ `//pos1` 等が使えます。
4. mc-mcpのボットはオフラインモード（Mojang認証なし）で接続します。`online-mode=false`（LAN/ホワイトリスト専用！）で運用するか、対象ユーザー名を別途許可してください。

## 環境変数

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `MC_RCON_PASSWORD` | **必須** | — | `server.properties` の `rcon.password` と一致させる。未設定だと起動時にFATALエラー。 |
| `MC_HOST` | 任意 | `192.168.1.7` | MinecraftサーバーのホストまたはIP。パブリックIPでは起動時に警告が出ます。 |
| `MC_PORT` | 任意 | `25565` | MinecraftのTCPポート。 |
| `MC_VERSION` | 任意 | `1.21.4` | プロトコルバージョン。 |
| `MC_RCON_HOST` | 任意 | `MC_HOST` と同じ | RCONのホスト名。RCONが別インターフェースにある場合に上書き。 |
| `MC_RCON_PORT` | 任意 | `25575` | RCONのTCPポート。 |
| `MC_DEFAULT_BOT` | 任意 | `CLAUDE` | ツール呼び出しで `name` を省略した際に使用するボット名。 |
| `MC_BOT_ALLOWLIST` | 任意 | `CLAUDE,CAMERA` | スポーン可能なボットのユーザー名（カンマ区切り）。自動opも許可リスト内のみ。 |
| `MC_RCON_ALLOW` | 任意 | (組み込み安全リスト) | `rcon` ツール経由で許可するコマンド動詞（カンマ区切り）。`*` で無条件拒否リスト以外をすべて許可（非推奨）。 |
| `MAX_BOTS` | 任意 | `4` | 同時接続ボット数の上限（1〜64）。 |

## セキュリティモデル

| 対象 | 制約内容 |
|------|---------|
| `rcon` ツール | 許可リストでverbをチェック。`op, deop, ban, ban-ip, pardon, pardon-ip, whitelist, stop, save-off, save-all, save-on, execute, reload, plugin, plugins, kick, pex, lp, luckperms, schedule, function, jfr` は無条件ブロック。他のverbは `MC_RCON_ALLOW` で追加可能。 |
| `spawn_bot` | `MC_BOT_ALLOWLIST` に含まれない名前は拒否。自動opも許可リスト内のみ。 |
| `chat` | 先頭の `/` や `//` を除去してスラッシュコマンドインジェクションを防止。管理コマンドは `rcon`、WorldEditは `worldedit` ツールを使用。 |
| `worldedit` | 空間操作系のみ許可（`set, replace, sphere, cyl, copy, paste, undo, ...`）。`schem/cs/calc/eval/reload/snapshot` はブロック。 |
| ボット名・アイテムID | 正規表現バリデーションでRCONコマンドインジェクションを無効化。 |
| `move_to` 掘削 | パスファインダーの掘削はデフォルトOFF。呼び出し毎に `allow_dig=true` でオプトイン。 |
| `scan_area` 半径 | `[1, 32]` にクランプ（最大65³ブロック）でCPU使用量を制限。 |

## インストール / Claude Code 設定

```bash
# 依存関係のインストール
npm install

# Claude Code にMCPサーバーとして登録
claude mcp add mc-mcp \
  -e MC_RCON_PASSWORD=<rconパスワード> \
  -e MC_HOST=192.168.1.7 \
  -- node /path/to/mc-mcp/src/index.js
```

接続後、MCPクライアントは以下のようなツール呼び出しが可能です（スラッシュコマンドではなくMCPツール呼び出しです）:

```javascript
spawn_bot { "name": "CLAUDE" }
chat { "name": "CLAUDE", "message": "hello world" }
worldedit { "name": "CLAUDE", "command": "set stone" }
rcon { "command": "time set day" }
move_to { "name": "CLAUDE", "x": 100, "y": 64, "z": 100 }
```

## ツール一覧

| ツール名 | 説明 |
|---------|------|
| `spawn_bot` | Minecraftサーバーに新しいボットを接続。自動でop・クリエイティブモードに設定。 |
| `disconnect_bot` | ボットを切断し、接続が完全に閉じるまで待機。 |
| `list_bots` | 接続中ボットの一覧を位置・体力込みで返す。切断済みエントリもクラッシュなく表示。 |
| `chat` | ボットとしてチャットメッセージを送信。先頭スラッシュは除去される（最大256 UTF-8バイト）。 |
| `worldedit` | ボットとしてWorldEditコマンドを実行（`//` を自動付与）。 |
| `rcon` | RCONでサーバーコンソールコマンドを実行。可能な場合は専用ツールを優先してください。 |
| `get_position` | ボットの現在位置と向きを取得。 |
| `move_to` | パスファインダーでボットをx,y,zへ移動。`fly=true` でRCON経由テレポートも可能。 |
| `look_at` | ボットをx,y,zに向ける。 |
| `get_block` | x,y,zのブロック情報（名前・プロパティ等）を取得。 |
| `scan_area` | ボット周辺のブロック種別カウントを返す（地形調査用、エア除く）。 |
| `get_inventory` | ボットのインベントリアイテム一覧を返す。 |
| `give_item` | RCONでボットにアイテムを付与。 |
| `set_time` | 時刻プリセットを設定（`day / noon / night / midnight`）。 |
| `teleport` | ボットを絶対座標へ即時テレポート（管理者権限、RCON使用）。 |

## screenshot.js (補足)

`screenshot.js` は独立したスタンドアロンCLIです。`CAMERA` ボットを接続してテレポートし、`prismarine-viewer` 経由でPNGレンダリングします。`MC_RCON_PASSWORD` が必要です。

出力パスのデフォルトは `./screenshot.png`。`--output <パス>` で上書き可能ですが、パスは以下の条件でバリデーションされます:
- `.png` で終わること
- `/windows/`, `/program files/`, `/system32/`, `/etc/`, `/bin/` 等のシステムディレクトリを拒否（大文字小文字を問わず）

レンダリング用ライブラリ（`canvas`, `node-canvas-webgl`, `prismarine-viewer`, `three`）は `optionalDependencies` に入っています。MCPサーバー本体には不要なため、`screenshot.js` を使う場合のみ `npm install --include=optional` でインストールしてください。

```bash
MC_RCON_PASSWORD=... node screenshot.js --output ./fort.png
```

> **注意**: `screenshot.js` を `src/index.js` からimportしないでください。診断ログをstdoutに書き出すため、MCP JSON-RPCフレーミングが破壊されます。

## トラブルシューティング

**`rcon connect timeout` / connection refused**  
`server.properties` で `enable-rcon=true` かつ `rcon.port=25575` が設定されているか確認し、変更後にサーバーを再起動してください。ホストファイアウォールがRCONポートをブロックしていないか確認。`MC_RCON_HOST` はデフォルトで `MC_HOST` と同じですが、RCONが別インターフェースにある場合は明示的に指定してください。

**ボットがスポーン直後にキックされる**  
よくある原因: (1) `online-mode=true` がオフラインbotを拒否している（信頼済み/ファイアウォール済みサーバーで `online-mode=false` に設定するか、ユーザー名を事前登録してください）、(2) ボット名が `MC_BOT_ALLOWLIST` に含まれていない、(3) MinecraftのバージョンとMC_VERSIONが一致していない（デフォルト `1.21.4`）。

**`pathfind timeout`**  
エラーには目標座標と経過時間が含まれます。`timeout_ms`（最大300000）を増やすか、`range` を広げて正確な到達を不要にするか、`fly: true` でRCON経由テレポートに切り替えてください。

**`MAX_BOTS=N reached`**  
`disconnect_bot` ツールでボットを切断するか、起動時に `MAX_BOTS`（1〜64）を引き上げてください。

## ライセンス

[MIT](LICENSE) © 2026 cUDGk
