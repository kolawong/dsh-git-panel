# @dsh-external/dsh-git-panel

**简体中文** | [English](README.md)

[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-web%20plugin-4b8bf5)
![Platform](https://img.shields.io/badge/platform-web-0ea5e9)

DSH Web 的 **Git 面板**：左栏一个 Git 图标，点开就是「所有工作区一眼看尽 + 单仓库三视图」的整页面板。不切分支、不 force push、不偷偷暂存——所有破坏性动作都要你二次确认。

![总览：每个工作区一张卡片，带分支/上游同步、变更计数和一句 AI 项目简介](docs/overview.jpg)

## 安装

这个包是一个 **DSH bundle 插件**（profile 装配层）。三种装法：

**① 装进 profile（推荐，重启后仍在）** —— 在 profile 的 `cordis.patch.yml` 里登记包名与配置：

```yaml
- id: git-panel
  name: '@dsh-external/dsh-git-panel'
  config:
    aiCommitProvider: minimax-cn
    aiCommitModel: MiniMax-M3.1-Flash-Preview
    aiCommitReasoningEffort: low
```

然后把包放进 profile 的 `dsh.profile.bundles`（或 `npm i` 到 profile 目录）。插件自带的 `cordis.patch.yml` 会插入 loader 行——**这一行只能来自包内的 patch 文件**，缺了它重启后面板和路由会一起消失（见「它是一个 bundle」）。

**② 免重启注入（开发时最顺手）**：

```
dev_install_package { "dir": "/path/to/dsh-git-panel" }   # 首次装配
dev_reload_package  { "packageName": "dsh-git-panel" }    # 改了 host 代码后热更新
```

**③ 从源码构建** —— `scripts/build.sh` 会把构建依赖（cordis、schemastery、react、`@types/node`、`@deepseek-ai/dsh-tools`、tsdown）直接从 checkout 链接过来，干净 clone **不需要 `npm i`**：

```bash
git clone git@github.com:kolawong/dsh-git-panel.git
cd dsh-git-panel
DSH_CHECKOUT=/path/to/deepseek-harness npm run build:all   # host tsc + client 打包
```

> ⚠️ 改了 `src/client/**` 必须跑 `npm run build:client`（或 `build:all`）：`scripts/build.sh` 只编译 host 并给 client 做类型检查，**不**打包 `lib/client.js`，否则类型检查通过、浏览器里还是旧界面。

## 配置

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `timeoutMs` | `20000` | 单条只读 git 命令的超时 |
| `actionTimeoutMs` | `60000` | fetch/pull/push 的超时 |
| `outputMaxBytes` | `4194304` | 单条命令 stdout 上限 |
| `actionOutputMaxBytes` | `32768` | 回传给面板的每路输出上限 |
| `contextLines` | `3` | diff 上下文行数 |
| `overviewConcurrency` | `4` | 总览并发读取的工作区数 |
| `allowPush` | `true` | 关掉后 push 一律 403，fetch/pull 照常 |
| `allowRepoWrites` | `true` | 关掉后 stage/unstage/discard/stash/commit 一律 403 |
| `watchEnabled` | `true` | 关掉后 `/events` 返 503，面板退回轮询 |
| `fetchBeforePull` | `true` | pull 前先 `fetch --prune` |
| `aiCommitEnabled` | `true` | AI 总开关（提交信息草稿 + 项目简介） |
| `aiCommitProvider` / `aiCommitModel` | 空 | 面板用的模型；空 = 跟随 profile 默认模型 |
| `aiCommitReasoningEffort` | 空 | 推理等级（`low`/`medium`/`high`/`max`…）。**空 = 整个省略该选项**，不是 `off`——见「思考等级」 |
| `aiCommitLanguage` | `zh` | 草稿与简介的语言 |
| `aiCommitMaxDiffLines` / `aiCommitMaxDiffBytes` | `1200` / `65536` | 一次草稿最多读多少 diff |
| `aiCommitTimeoutMs` | `60000` | 一次模型调用的超时 |
| `aiCommitExtraPrompt` | 空 | 追加到草稿 system prompt 的额外要求 |

## 截图

| 总览 | 变更 + diff |
|---|---|
| ![总览](docs/overview.jpg) | ![变更](docs/changes.jpg) |

| 历史（图形化泳道） | 分支 |
|---|---|
| ![历史](docs/history.jpg) | ![分支](docs/branches.jpg) |

---

DSH Web 的 Git 面板：左栏活动栏一个 **Git** 图标（`sidebar.panellist` @order 15），点开在中列渲染整页面板（`main`，key 同为 `git`）。两屏：

1. **总览（落地屏）**——每个已注册工作区一张卡片，脏的排前面，一眼看出哪个项目要处理：

   ```
   ┌────────────────────────────────────┐
   │ dsh-plugin-quota-badges   [有改动] │
   │ /root/dsh-plugin-quota-badges      │
   │ [main] [↑0 ↓0]                     │
   │ 8 变更 · 2 未跟踪                   │
   └────────────────────────────────────┘
   ```

   卡片左侧色条 = 冲突（红）/ 有改动（黄）/ 干净（绿）/ 非仓库或不可用（灰）；顶部汇总 `12 个工作区 · 4 个有改动`。
2. **仓库页**——点卡片进入，标题栏三个视图：
   - **变更**：分支/上游/ahead-behind、变更文件列表（冲突 / 已暂存 / 变更 / 未跟踪）、按文件 unified diff、提交框（可让模型写信息）；
   - **历史**：图形化提交历史（泳道 + 合并曲线 + ref 标签），范围/作者/提交信息/路径过滤，翻页加载更早的提交，右侧看单个提交的文件与 diff（合并提交可选父提交）；
   - **分支**：本地分支列表（当前分支、上游与 ahead/behind、tip 时间与标题），「看历史」把它交给历史视图。**只读，不切分支。**
   - `← 总览` 返回。

   面板的图标是一整套 16×16 线性 SVG（`src/client/icons.tsx`），没有 emoji，也没有任何字体符号——视觉套件里有一条断言专门盯着这件事。

## 界面语言（2026-10-05 重构）

面板带一套自己的设计系统（`src/client/styles.ts`，一个注入式 `<style>`，卸载即移除），因为 inline style 给不了 hover、focus-visible 和 transition：

- 只引用实测存在于 runtime 的主题 token（`bg-*`、`border-l1/l2/l3`、`label-primary/secondary/tertiary`、`brand-primary`、`interactive-bg-hover/active`、`state-*`、`radius-md/lg/xl`；探测点在应用容器内，不是 `:root`）。
- 控件语言对齐官方页面：28px 胶囊按钮（主操作实心）、分段视图切换（变更/历史/分支）、行 hover = `interactive-bg-hover`、选中 = `interactive-bg-active` + 2px 左侧强调、键盘焦点 2px 品牌色环、`prefers-reduced-motion` 关掉全部动效。
- 仓库页 header 两行：身份行（仓库名 + 分支 chip + 上游同步 + 远端动作 + 刷新）与视图行（tabs + 当前视图的动作，如贮藏）。
- 键盘：变更列表与历史列表都支持 `j`/`k`（或 ↓/↑）移动打开的文件/提交，`Space` 勾选批量暂存（不会触发暂存），输入框聚焦时按键不抢；提交框 `Ctrl/Cmd+Enter` = 主按钮（空信息/无改动时按了也没事，有断言）；流式草稿时 `Esc` = 停止。
- 操作横幅（进行中 merge/rebase 等）与加载骨架（历史首屏的 shimmer 行）都进设计系统（`.gp-banner` / `.gp-skeleton`）；diff 里的折叠标记与 gap chip 有 hover 反馈（`.gp-mini-btn`）。
- 列表与 diff 之间是可拖分栏（`.gp-split-handle`：拖到 [280px, 60%] 区间、双击复位、←/→ 键也能调；变更与历史各一份）。注意：handle 必须 `align-self: stretch`，否则 `align-items: flex-start` 的 flex 行里它高度为 0，拖不到（这条踩过）。
- 提交/分支/贮藏/历史的时间列是**相对时间**（刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天落回绝对日期），完整时间戳在 tooltip。
- **历史页按日期分组**：今天 / 昨天 / 最近 7 天 / 更早 的分隔行（`historyDayLabel` 纯函数，按日历日不是按小时数；分隔行用下一行的 incoming 泳道画穿线，图不断）。行内三级：主题（12.5px/500）→ 元信息一行（短 hash mono + 作者 + 相对时间，三级色，nowrap）→ 引用徽章（HEAD 品牌色、tag 成功色、其余安静）；合并提交在列表里就有橙色分支标记（`title="合并提交 · N 个父提交"`）。写这种「组分隔」时要注意：分隔行不是提交行，别让它进 `buildGraph` 的数据（它是渲染期从相邻两行算出来的）。
- 总览有筛选输入（按名字或路径，匹配数 `N / M 个工作区`，无匹配时给「清除筛选」）。写筛选这种小组件时记住：派生 memo 用的状态必须声明在前（`filtered` 用 `filter`，顺序错了就是 ReferenceError——套件抓到过）。
- **每张卡片带一句「这个项目是干啥的」（AI 总结）**：`POST /project-summaries` 把全部工作区的信号（package.json 的 description、README 开头 400 字符、最近 3 条提交标题）打包进**一次**模型调用，按编号行解析回各仓库（`buildSummaryPrompt`/`parseSummaryLines` 纯函数，垃圾行逐行丢不拖垮整体；同一编号后行覆盖前行）；**按仓库独立持久化**（`~/.dsh/git-panel/summaries.json`，测试用 `DSH_GIT_PANEL_SUMMARY_STORE` 指到沙盒）：每个项目的指纹 = 写简介时所用信号的 sha1（provider/model/标题/description/README/提交标题），只有指纹变了的那几个项目进下一次批量调用，其余从磁盘直接回答（重载/重启后第一次询问就是 cached:true）。离开注册表的工作区会被修剪出 store（store 只描述现存项目）。`force: true` 全量重写。
  - **失败也各自结算（2026-10-11 修）**：批量调用失败时，store 里已经有的那些简介照常返回（响应带 `error` + `failed: N`，`ok` 仍是 true），只有真正没写成的项目留空；**一条都没有**且模型失败时才是诚实的错误（502，超时 504）。客户端**不再**把整份 map 丢成 `{}`：请求失败保留上一次的答案，没有简介的卡片显示安静的「简介暂不可用」（原因在 tooltip），而不是永远闪的骨架条——这正是「一次模型调用失败 → 整屏卡片全变灰条」的原因。
  - **思考等级（`aiCommitReasoningEffort`）**：本插件的两次模型调用（提交信息草稿 + 项目简介）都可以带一个推理等级（`off`/`low`/`medium`/`high`/`max`…，请求体里叫 `reasoningEffort`，也可在插件配置里设）。**留空 ≠ `off`**：留空是把 `reasoningEffort` 整个**省略**（由模型/路由自己决定），写 `off` 是明确要求「不要思考」——MiniMax 的 `MiniMax-M3.1-Flash-Preview` 现在会以 400 拒绝这种请求（`requires adaptive thinking (2013)`），而 DSH 的 pi-ai 适配器在「没要求思考」时会主动发 `thinking.type=disabled`，于是该模型在面板里必然 502。给这个模型配 `aiCommitReasoningEffort: low` 即可。

新项目从哪来：总览读的就是侧栏「工作区」同一个注册表——在侧栏添加工作区（`添加工作区` 按钮 → 选目录 → 打开）后，卡片自动出现，简介下次加载时自然补写（未缓存的项目自动进下一批）。
- **裸 `<button>` 一定要给静止态 `background: transparent`**：UA 的 buttonface（亮色 #efefef / 暗色 rgb(107,107,107)）会把行漆成灰块，用户看到的是「暗色下整个文件列表像被选中」。`.gp-row`/`.gp-commit-row` 里有这条，别删。
- 分割感来自两件事叠加：列表列用 `--dsw-specific-sidebar-fill`（外壳侧栏同一个填充 token）+ 分隔线静止态就是 `border-l2`（不是 l1，l1 弱到看不见）。
- **列要到面板底边**：分栏行是 `flex: 1; align-items: stretch`，列自己 `overflow: auto` 滚动（提交框固定、只滚列表）；`align-items: flex-start` + `maxHeight: calc(100vh - N)` 的老写法会让填充和分隔线停在屏幕中间。视觉套件有一条「列表/diff/分隔线都到面板底边」的断言守着。
- 提交框是扁平的（无卡片边框，只留一条底边），与下面的文件列表在同一个面上——「输入框和 diff 不像一个界面」修的就是这个。
- 提交框按钮的分层：**动作只有一行**（提交 / 一键提交 / AI 写信息 / 全部暂存），设置与计数在上方安静的说明行（模型 chip 在左、`已暂存 N 项` 在右）；禁用的主按钮是描边安静态而不是灰药丸（`.gp-btn-primary:disabled`）；「暂存全部并提交」更名「一键提交」（诚实且短）。视觉套件守着「动作同一行、模型在说明行」的不变式。
- 一致性审计：client 源码里**零**硬编码颜色（grep 断言级纪律）；行内样式不得带 `background`（会压住样式表的 `:hover`——M5 重构时踩过，已记进本文件）。
- 适配实测：暗色主题（`prefers-color-scheme` 跟随，全部颜色来自 token，视觉套件有一条专门断言防硬编码颜色回潮）；1100px 窄窗无横向溢出（header 换行不裁剪）；900px 以下外壳自己收成纯图标栏（`aria-label` 仍在）。

两屏都能执行三个远端动作，结果落在面板底部的**会话内操作日志**（时间 / 每步命令 / exit code / 耗时 / git 输出尾部）：

### 展开被折叠的行

`-U3` 之外的上下文不是丢失，只是收起：两个 hunk 之间会画一条 `⋯ N 行未显示` 的 chip，点它面板就向 host 要**那一段行**（`GET /context`，一次最多 400 行）并作为普通 context 行插回原位，chip 变成 `⋯ 收起 N 行` 可以再收起来。请求只带行号：要读 index、HEAD 还是工作区文件，由 host 按 `staged` / `untracked` 决定，客户端无法指定任意 rev。文件在那一侧不存在（`.gitignore` 后的删除、未跟踪）时返回 `missing`，chip 保持原样。

### 语法着色（保守）

只上四种颜色，且只用本机主题里真实存在的 token：注释 = `label-secondary`，字符串 = `state-success`，关键字 = `brand-primary`，数字 = `state-warn`；其余保持行自身的颜色（新增行仍是绿、删除行仍是红）。原则是**宁可不上色，也不上错色**：

- 只在同一行内闭合的引号才算字符串；未闭合的引号（多行模板、正文里的撇号）保持原样，不会把后面整段染成字符串。
- 关键字只认一小张无歧义词表，且要求它是独立单词、前一个字符不是 `.`/`$`/标识符字符——`row.type`、`myreturn` 都不会被误认。
- 注释只认 `//` 与位于行首或空白后的 `#`。`--`、`;` 刻意不认：JS/Go 里自减与语句结束符远比 SQL 注释常见。
- 行内差异高亮与 token 叠加：被改写的中点会被切开，染色不会溢出到相同的字符上。
- 仓库页 diff 头部有 `着色 开/关` 开关（`data-colorize-toggle`），关掉即完全不产生 token span。

## 写操作（M3-C）

面板现在不止读：**暂存 / 取消暂存 / 还原 / 贮藏 / 提交**都走同一条 `POST /action`，同一套护栏（自定义头 + JSON、工作区白名单、每仓库串行、argv 白名单、子进程绑定插件生命周期）。

| 动作 | 实际命令 | 说明 |
| --- | --- | --- |
| `stage` | `git add -- <paths…>` | 「全部暂存」传 `paths: ['.']`；**必须给路径**，不存在「不写路径 = 整个仓库」的隐式行为 |
| `unstage` | `git reset -q HEAD -- <paths…>` | HEAD 还没出生（首次提交前）时退化为 `git rm --cached -r --quiet -- <paths…>`，否则 `git reset` 会直接失败 |
| `discard` | `git checkout -- <paths…>` | **破坏性，需 `confirm: true`**（与 push 同级二次确认）。还原的是**工作区相对 index** 的改动：已暂存的部分会保留（先取消暂存才能彻底丢弃）。**没有删除未跟踪文件的动作**：对未跟踪路径 `git checkout` 会报错并把文件原样留着，面板也不提供这个按钮 |
| `stash` | `git stash push --include-untracked --message "dsh-git-panel: <ISO>"` | **破坏性，需 `confirm: true`**；默认含未跟踪文件（按钮上写明了） |
| `commit` | `git add -- <paths…>`（可选）→ `git commit -m <message>` | 消息必填（≤ 4000 字符）；给路径就先暂存再提交，不给就提交已暂存的内容；**不用** `--no-verify`，钩子照常生效；提交失败时输入框里的消息会保留 |

另有开关 `allowRepoWrites`（默认 `true`）：关掉后本地写操作一律 403，`fetch`/`pull` 不受影响 —— 想要「只读面板」时用。

界面：仓库页顶部是提交框（`已暂存 N 项` + `提交（N）` + `全部暂存`），选中文件后 diff 头部出现 `暂存 / 取消暂存 / 还原`（`还原` 是二次确认按钮），标题栏有 `贮藏`。所有动作都进底部操作日志，逐步列出 `$ git …` 与 exit code。

## 贮藏管理（M6）

变更视图底部列出仓库的全部贮藏（`贮藏（N）`），每条给出 `stash@{N}`、信息、日期和三个动作：

| 按钮 | 命令 | 说明 |
|---|---|---|
| `应用` | `git stash apply <ref>` | 把这份贮藏应用回工作区，**条目保留** |
| `弹出` | `git stash pop <ref>` | 应用回工作区；应用干净后条目随之移除，有冲突时条目保留 |
| `删除` | `git stash drop <ref>` | 丢弃这份贮藏，不可恢复 —— **二次确认** |

`ref` 只接受列表里给出的 `stash@{N}` 形式（传 `HEAD` 之类的 revision 一律 400）；三个动作都走 `allowRepoWrites` 开关；apply/pop 若会踩到本地文件，git 自己的拒绝会如实显示在操作日志里（条目不动）。列表读路由 `GET /stashes`，agent 侧经 `gitPanel.stashes(dir)` 读同一份数据。

## 冲突与进行中的操作（M7）

面板的 pull 是 `--ff-only`，永远不会自己制造合并；但用户可能在终端里 merge/cherry-pick/revert/rebase，或者 `stash pop` 撞出冲突。这时面板不能只给一列「冲突」文件：

- `/status` 带 `operation: {kind: merge|cherry-pick|revert|rebase, unmerged: N} | null`（一次 `rev-parse --git-path ×5` 检测 + porcelain 计数；rebase 与 MERGE_HEAD 并存时优先报 rebase）。
- 变更视图顶部出现横幅：「合并进行中 · 还有 N 个文件冲突」，给两条诚实的出路：

| 按钮 | 命令 | 说明 |
|---|---|---|
| `完成合并` / `继续…` | merge → `git commit --no-edit`；其余 → `git -c core.editor=true <op> --continue` | **还有未解决冲突时不跑 git**，直接回「还有 N 个文件冲突未解决」 |
| `中止…` | `git <op> --abort` | 丢弃整个操作（含已做的冲突解决）——**二次确认** |

- 冲突文件的 diff 是**合并 diff（`diff --cc`）**：每行两列前缀（两个父提交各一列），解析器按「任一列含 `+` 即结果侧新增、含 `-` 即删除」渲染，只给结果侧行号（没有单一旧侧），diff 头部标 `合并冲突`。在这之前它会被解析器读成「空」。
- 未合并路径的任何 diff 都是 combined——git 对它没有单边答案，这不是面板的选择。
- 动作动词由 host 按实际状态决定（客户端不猜）；没有任何操作在进行时，两个动词如实回答「当前没有进行中的合并/挑拣/回退/变基」。

## 逐行追溯（M11）

diff 头部有「追溯」按钮（`git blame --line-porcelain HEAD -- <path>`）：同一段连续归属只显示一次提交短号/作者/日期，段首行左侧着色区分；头部写清「基于 HEAD，未提交的改动不在其中」。未提交的文件 404，未跟踪文件的按钮禁用并说明原因。agent 侧经 `gitPanel.blame(dir, path)` 读同一份数据。

## 多提交对比（M12）

历史详情头部有「对比…」：武装后点另一个提交即把详情变成范围读（`git diff <基准> <这个提交>` 的文件列表 + 逐文件 diff，复用同一渲染器与 `/show`/`/diff` 的 `base` 参数）；chip `基准..目标 ×` 一点即回单提交视图。`base` 与 `parent` 互斥（一起传 400），哈希过 40-hex 校验。

## 批量暂存（M13）

变更/未跟踪/冲突组的文件行左侧有勾选框；勾选后提交框下方出现批量条「已选 N 项 · 暂存选中 · 清除」，暂存选中走既有 `stage` 动作（argv 白名单不变）。状态刷新后勾选项自动收敛到仍然存在的文件。

## 提交历史：图形化历史视图（M5）

仓库页标题栏是 `变更 / 历史 / 分支` 三个视图。

**左侧是提交图**，不是纯列表：每条提交一行，最左边一列画出它的泳道与合并曲线（`<svg viewBox>` 内 `<line>` 画直行、`<path>` 画跨道曲线），节点圆点跟着泳道配色，当前选中的那一行整行高亮。行内容是「短 hash + 标题 + 作者 + 时间」，`HEAD ->`、`tag:`、`origin/*` 之类的 ref 渲染成标签贴在标题后面。

泳道布局在 `src/client/graph.ts`，是一段纯函数（`buildGraph`），不碰 DOM 也可以单测：git 保证（我们额外要求 `--topo-order`）父提交排在子提交之后，所以一条泳道就是「某个还没出现的提交 id」，等它出现时那条线就接到它的节点上再换成它的父提交，于是线只会被复用、不会无限增长；合并提交的第二个父提交开一条新泳道并画一条曲线过去，遇到已经在线上的父提交则直接接入（折叠重复泳道）。`MAX_LANES` 之外的泳道不再上报（宽度有上限）。

> 两个坑写在代码注释里，也都是断言守住的：① `%P` 给的是**完整 40 位**父哈希，而 `%h` 是缩写，两者配不上会让泳道以为「每个提交的父提交都还没出现」，于是一提交一泳道（在 deepseek-harness 上实测 100 条提交能涨到 117 道 / 1346px 宽）；现在用 `%p`（与 `%h` 同一套缩写规则），并且匹配时还允许前缀。② `git log` 默认按日期排序，并不保证父提交在后，遇到时钟错乱的历史同样会漏泳道；布局对「父提交已经在上面」这件事显式处理，host 也加了 `--topo-order`。修好后同一个仓库 100 条提交是 18 道 / 230px。

**过滤与翻页**（都在真实路由上跑，前端只做 300ms 防抖）：

| 控件 | 作用 |
|---|---|
| 范围下拉 `当前分支（xxx）` | 当前分支的历史 |
| 范围下拉 `所有 ref` | `git log --all`，能看到还没合并进来的分支 |
| 范围下拉的其余条目 | 某条本地分支的历史（`ref=<分支名>`） |
| `作者` | `--author=`，大小写不敏感的子串 |
| `提交信息` | `--regexp-ignore-case --grep=` |
| `重置` | 一次清掉以上全部 |
| 文件行上的 `历史` 按钮 | `-- <path>`：只看动过这个文件的提交（同样支持翻页；这是 git 的默认路径简化，只把文件内容改掉的提交才算，纯合并通常不出现） |

列表头写「N 条，可继续向前加载」，滚到底部自动加载下一页（`IntersectionObserver` 哨兵），也可以点 `加载更早的提交`；到最早一条时显示「N 条（已到最初）」。每页 `HISTORY_PAGE = 50` 条，`skip` 递增，后一页不会与前一页重叠（断言过：两页 hash 集合不相交且时间不倒挂）。

**右侧是提交详情**：点一行后给出该提交动过的文件（状态字母 + ±行数），点文件即渲染它的 diff —— **复用同一套 diff 渲染器**，行号栏、语法着色、gap 展开全部照旧；区别只是目标里带上 `hash`，host 从那个提交读文件（`git show <hash>:<path>`）而不是从工作区读，**避免在旧提交的 diff 旁边显示今天的代码**。

**合并提交要指名父提交**：`git show <merge>` 默认不打印任何 patch，文件列表也是空的，所以面板会在 `合并提交 · 2 个父提交` 标签旁给出 `对比 ^1 ^2` 两个按钮，默认 `^1`，host 用 `git diff <hash>^<n> <hash>` 读文件列表与 diff（`/show?parent=` / `/diff?parent=`）。切换父提交会**重新请求**而不是复用上一次的结果，没有改动时明确写「与第 N 个父提交相比没有改动。」，不再笼统地说「这个提交没有文件改动」。父提交序号限 1..8（八爪鱼合并），越界 400。

## 分支视图（M5）

标题栏第三个视图列出**本地分支**：当前分支在最上面（`HEAD` 标签 + 高亮），每条给出上游名与 `[ahead/behind]`、tip 短 hash、tip 时间与标题。右上角仍可用 `Fetch` 刷新。「看历史」按钮把该分支交给历史视图（等价于把范围下拉切到那条分支）。

**切换分支（M8 起）**：每条非当前分支行尾有 `切换`（**二次确认**），顶部有 `新分支名` + `新建并切换`（`git checkout -b`）。护栏：

- 动作要走 `allowRepoWrites` 开关 + `confirm: true`（否则 428）；分支名过 `safeRef` 校验（`-x` 之类一律 400）；
- 真正拦人的是 git 自己：会覆盖本地改动/未跟踪文件的切换被 git 拒下并**点名文件**，操作日志原文展示；清掉冲突后同一动作放行（smoke/live 各验证一遍）；
- 两分支对某文件内容一致时 git 本来就会带着本地改动过去，面板不拦 git 不拦的事；
- 切换后 `.git/HEAD` 变动触发既有监听，分支名/状态/历史自动刷新。

## AI 写提交信息（M4 / M9 / M10）

**流式生成（M9）**：点「AI 写信息」后消息**逐字填入**输入框（不再是等全量返回一次性出现）。写完的提示只有一条安静行（模型 + 可改写；未暂存时顺带指路），截断/未跟踪文件排除等警告只在需要时追加；token 用量留在 host 响应里，不进提示（噪声）。传输是同头防护的 `POST /commit-message/stream`（SSE 帧 `begin`（模型将读到什么）→ `delta`（原文片段）→ `done`（清洗后的最终稿）/ `error`；客户端用 `fetch` 读流而非 EventSource，自定义头保留，跨站页面无法烧钱）。生成中按钮变成「停止」——中止同时停掉模型调用（已写出的部分保留）；流式端点 404 时自动回退老的 `POST /commit-message`。

**模型记忆 = 插件配置（M10）**：下拉里选一个模型，面板经 `POST /prefs` 通过 **settings 服务**把它写进插件自己的配置（`aiCommitProvider`/`aiCommitModel`，schema 里标了 `volatile()`，所以可在线合并不重挂载）——跨浏览器生效，也会出现在设置页里。没有 settings 服务的 profile 回退 localStorage（`persisted: false` 如实返回）。草稿的优先级：请求显式指定 > 记忆的选择（live describe，回退 apply-time config）> profile 默认模型。`GET /models` 带 `remembered` 字段。

**草稿也是模型工具（M10）**：`git_commit_message` 注册给 agent——只产出文本，绝不暂存/提交/推送，注明一次模型调用的成本；`git_status`/`git_diff`/`git_commit_message` 三个工具都由 smoke 断言注册与执行。

## AI 写提交信息（M4 原始说明）

提交框里有一个 `✨ AI 写信息`：host 读当前改动、调当前默认模型、把**中文提交信息填进输入框**。AI 到此为止——暂存、提交、推送都还是你点。

- **谁来做**：提交框里有一个「写信息模型」下拉，列的是这个 profile 真实挂载的 provider 与它们各自广告的模型（`GET /models`，host 缓存 5 分钟；某个 provider 读不到就显示成空的「读取失败」分组，不影响其它）。默认项是「跟随默认」= `agentDefaultModel.currentSelection()`（界面上选的默认模型）；**选过就记住**（浏览器 `localStorage`，刷新/重开面板后还在；客户端会核对它是否仍在列表里，不在就回到默认并说明）。优先级：面板里选的 > 插件配置 `aiCommitProvider`/`aiCommitModel` > profile 默认模型。
- **读什么**：有已暂存改动就读**已暂存**（`git diff --cached`），那正是 `git commit` 会记录的内容；一个都没有时读整个工作区，并在界面上直说「提交前先『全部暂存』」。文件列表只列出会进入提交的文件，未暂存的改动和未跟踪文件单独列为「不会进入本次提交」，避免模型替一个不会被提交的文件写信息。
- **护栏**：diff 有行/字节预算（默认 1200 行 / 64 KB，超了明确告知模型和界面「已截断」）；调用**不带 tools**，模型只能产出文本，无法自己 stage/commit/push；回复经清洗（去代码围栏、去「这是你的提交信息：」开场白、去思考块、去包裹引号、压空行、超 4000 字符截断）才填入；失败（模型报错/无模型/超时）在输入框下方给出可读原因，面板不会坏。
- **配置**：`aiCommitEnabled`（整体开关）、`aiCommitProvider`、`aiCommitModel`、`aiCommitReasoningEffort`（推理等级；**留空 = 省略该选项**，不是 `off`——见上面「思考等级」一条）、`aiCommitLanguage`（默认 `zh`）、`aiCommitMaxDiffLines`、`aiCommitMaxDiffBytes`、`aiCommitTimeoutMs`、`aiCommitExtraPrompt`。
- **写完怎么提交**：AI 写的是「全部未提交改动」时索引里还是空的，`提交（N）` 自然点不动。所以提交框在「有改动但已暂存 0 项」时多给一个 **`暂存全部并提交`**：一次 `git add -- .` + `git commit -m <这条信息>`，一键落地；已暂存了就回到原来的 `提交（N）`（只提交已暂存内容）。两者都只是把按钮递给你，**推送依旧要你自己点 Push**。
- **框的尺寸**：提交信息框 4 行起步并按内容自动增高（封顶 220px）；按钮行在窄列里换行而不是裁掉；左栏宽度 `clamp(320px, 27vw, 460px)`。
- **路由**：`POST /commit-message`，body `{ dir, staged?, provider?, model?, reasoningEffort? }`（provider/model 为单行 ≤120 字符，非法即 400），与写操作同一套护栏（`x-dsh-git-panel` 头、工作区白名单）；响应含 `message`、`provider`、`model`、`source`、`files`、`added`、`deleted`、`untracked`、`truncated`、`inputTokens`。它是纯读操作：不动索引、不写盘。

## 暴露给 agent（M3-D）

面板的读路径同时以 **`ctx.gitPanel` 服务**对外开放，其他插件直接调用（`ctx.inject(['gitPanel'])`）：

```ts
interface GitPanelService {
  overview(): Promise<{ ok: true; entries: OverviewEntry[] }>
  status(dir: string, lineCounts?: boolean): Promise<StatusPayload>
  diff(dir: string, target: { path: string; staged?: boolean; untracked?: boolean; hash?: string }): Promise<string>
  log(dir: string, limit?: number): Promise<CommitEntry[]>
  show(dir: string, hash: string): Promise<{ commit: CommitEntry | null; files: CommitFile[] }>
}
```

**服务只有读**：写操作（stash/discard/commit…）刻意不对外，因为服务调用背后没有「按下按钮的人」，而这些操作会毁掉未提交的工作。所有 `dir` 依旧过工作区白名单，越界直接抛错。

模型面是两个只读工具（走 `ctx.inject(['tools'])` 注册，所以没有 tools 服务的 profile 里面板照常加载）：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `git_status` | `dir?`（缺省 = 列出全部工作区）、`line_counts?` | 无 `dir` 时返回每个工作区的分支/上游/ahead-behind/计数；给了 `dir` 就返回该仓库的 `repo` + `counts` + 文件列表 |
| `git_diff` | `dir`、`path`、`staged?`、`untracked?`、`hash?`、`max_lines?` | 返回该文件的 unified diff 行，默认截到 400 行（1..2000），**显式**给出 `total_lines` / `truncated` / `note`，模型不会误以为看到了全文 |

## 实时更新

面板**订阅仓库而不是轮询**：打开时对每个可见仓库 `GET /api/git-panel/events?dir=…` 开一条 SSE 流，host 用 `fs.watch` 盯住该仓库的 `.git`（自身 + `refs` 递归 + `logs` 递归）。commit、切分支、`git add`、fetch、pull、push 一落地，卡片或仓库页立刻重读——不用等下一次轮询。

- **过滤**：`objects/`、`*.lock`、`gc.*`、`maintenance`、`COMMIT_EDITMSG`、`tmp_*` 全部丢弃。一次 fetch 会在 `.git/objects` 下写几百个对象，转发它等于把一次 fetch 变成刷新风暴。
- **去抖**：同一仓库 300ms 合并成一帧；`.git/HEAD` 与 `refs/heads/x` 一次提交同时变，面板只刷一次。
- **降级**：事件流开不起来（配置关掉、inotify 用尽、后端不支持）时面板照旧按 15s/20s 轮询；流打开时轮询拉长到 60s 只作兜底。标题栏的 `● 实时` / `● 轮询` 就是当前状态（`data-live` 供自动化断言）。
- **工作区文件编辑不在监听范围**：`fs.watch` 看不见"未暂存的编辑"（既不写 index 也不碰 refs），为此递归监听整棵工作树会带来 node_modules 级别的开销。这类变化仍靠轮询与窗口获焦刷新兜住。host 自己的读操作设了 `GIT_OPTIONAL_LOCKS=0`，不会写 `.git/index`，因此不会自激。
- **一键同步**：总览标题栏的 `全部 Fetch（N）` 对每个有上游的仓库**依次** `git fetch --prune`（按钮上显示 `Fetch 3/12 · 项目名…`，当前仓库的卡片显示自己的忙碌态），顺序与进度由 `src/client/queue.ts` 保证并被 `diff-test.mjs` 断言。

| 动作 | 命令 | 出现时机 |
|---|---|---|
| Fetch | `git fetch --prune` | 一直可用（更新远端引用，不动工作区） |
| Pull | `git fetch --prune` → `git pull --ff-only` | 卡片上 `↓>0` 时出现；仓库页一直可用 |
| Push | `git push` | 卡片上 `↑>0` 时出现；仓库页一直可用 |

**Push 永远不是一次点击**：按钮先进入「确认 push → origin/main」待命态（8 秒后自动解除），再点才执行；确认以 `confirm: true` 发给 host，host 没收到就拒绝（428）。

面板**不做**：stage / commit / stash / reset / checkout / force push / 改上游设置。M1 的只读保证仍然成立——只读接口从不写仓库，写接口只有上表三条。

## 差异视图

diff 由 `src/client/diff.ts` 解析成行模型后渲染，视觉语言参考 `DSH-better-sidebar` 的共享 diff 渲染器：

- **双行号栏 + sign 列**：旧侧 / 新侧行号各一列（等宽、右对齐），加 `+` / `-` / 空格的标记列；只有被计数的 hunk 体行会推进行号。
- **文件头不进正文**：`diff --git` / `index` / `---` / `+++` / mode / rename 都不是行——面板标题已经写明文件，这些只会是噪音。面板右上角改显示 `+28 −2`。
- **hunk 之间的省略**：git 裁掉的行合成一个 chip `⋯ 74 行未显示`，旁边以更淡的字给出下一段的 git section note（通常是所属函数）。
- **行级 tint + 行内高亮**：新增 / 删除行有 8% 底色；被改写的行按「公共前后缀」只高亮真正改动的字符（26% 底色），所以 `Current` → `Longest` 只亮 `Curren` / `Longes`。
- **长行折叠**：超过 120 字符的行先折成一行，**再用实测宽度确认它真的溢出**才保留折叠与 `159 字符` chip——文本其实放得下的行不会谎称被折叠。chip 放在文本 span 之外（`flex: none`），行被裁时也不会把 chip 一起裁掉。
- **上限**：单文件最多渲染 2000 行，其余收在「展开其余 N 行」按钮后，避免几 MB 的 bundle diff 卡住 React。

解析器按 **hunk 头的行数** 判定 hunk 体，而不是只看首字符：这样「删除一行内容本身是 `-- x`」（在 diff 里长得像 `--- x`）不会被当成下一个文件的头，多文件文本也不会跨文件算省略行数。

配色只用本机主题**真实存在**的 14 个 alias token（`label-primary/secondary`、`state-success/error/warn/idle-primary`、`brand-primary`、`border-l1/l2`、`bg-base/layer-1/layer-2/overlay`、`specific-sidebar-fill`），其余色值用 `color-mix` 从它们派生。参考项目用的 `--dsw-alias-label-tertiary`、`--dsw-alias-state-business-primary`、`--dsw-alias-interactive-bg-hover`、`--ds-font-family-code` 在本机主题里**不存在**（已用 Theme inspect provider 核对），照抄会让行号继承行色、`mod` 行连色和底色一起失效。**未采纳**的是它的语法着色：那套 token 色大多依赖不存在的 token，且要按语言写词法器，写错比不写更花，留作后续可选项。

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | host 半边：`/api/git-panel/{overview,status,diff,context,log,show,branches,models}` 只读路由 + `GET /events`（SSE）+ `POST /action`、`POST /commit-message`；`fs.watch` 监听 `.git`；`ctx.subprocess` 跑 git；路径白名单、ref/path/parent 校验与写操作护栏 |
| `src/client/index.ts` | client 半边：两处 slot 注册（`main` + `sidebar.panellist`） |
| `src/client/panel.tsx` | 页面：总览/仓库页（`变更 · 历史 · 分支`）、提交框与模型下拉、diff 渲染（行模型、行内高亮、折叠、`data-kind` / `data-pane` 等自动化钩子） |
| `src/client/icons.tsx` | 整套 16×16 线性 SVG 图标（统一 `viewBox`、`stroke-width 1.4`、`currentColor`、`data-icon`）；**面板里没有任何 emoji 或字体符号图标** |
| `src/client/styles.ts` | 注入式设计系统（`<style>` 元素，卸载即移除）：hover/focus-visible/transition、按钮/chip/行/卡片/分段 tabs 的共享类；只引用实测存在的 runtime token |
| `src/client/graph.ts` | 纯逻辑：提交列表 → 泳道布局（`buildGraph` / `graphWidth`，无 React，可被脚本直接测） |
| `src/client/diff.ts` | 纯逻辑：unified diff → 行模型、行内差异、改写行配对（无 React，可被脚本直接测） |
| `src/client/queue.ts` | 纯逻辑：依次执行 + 进度回报（「全部 Fetch」的时序保证，无 React） |
| `src/client/highlight.ts` | 纯逻辑：保守行级 tokenizer（注释/字符串/关键字/数字）+ 与行内差异标记的叠加 |
| `src/client/api.ts` | 与 host 的 JSON 契约 + fetch 封装 |
| `scripts/smoke.mjs` | host 冒烟测试：对真实 git 驱动路由处理器，328 项断言（含真远端上的 fetch/pull/push 与拒绝路径、SSE 帧与噪声过滤、卸载关流、context 路由与边界、五个本地写动作用真 git 落盘验证、log/show/单提交 diff、`gitPanel` 服务与两个模型工具的注册与执行、AI 提交信息的 prompt/清洗/护栏与全部失败路径、**真建一条分支 + 真做一次 `--no-ff` 合并**后的分页/`skip` 回显/过滤/`--all`/ref 校验、父提交 id 与提交 id 写法一致的泳道不变式、`/branches` 的当前分支/上游 track/detached HEAD/非仓库、合并提交按父提交读文件列表与 diff、**贮藏全生命周期**（列表含 baseline、自定义信息、apply 保留条目、会踩本地文件的 apply 如实失败、pop 成功后移除条目、drop 的 428/200、ref 校验、只读开关 403、对不存在条目的 pop 报失败、模型不报 token 用量时如实标注、**真冲突合并的操作态**（MERGE_HEAD 检测、冲突计数、未完成冲突时拒绝继续并报数量、abort 的 428/200、无操作时如实回答、解决→暂存→`commit --no-edit` 完成合并并产出真合并提交、只读开关 403、冲突文件 combined diff 含冲突标记、**分支切换**（428/400/403、真切换后 HEAD 与 status 同步、两分支一致的文件本地改动被 git 合理携带、未跟踪文件会被覆盖时 git 点名拒绝、清掉后放行、`checkout -b` 创建即切换、重名创建如实失败、**流式草稿**（begin/delta/done 帧序、流前错误仍是 JSON、模型中途失败变成 error 帧）、**prefs**（settings stub 的写/ns/patch、remembered 回读、显式选择优先、无服务时 persisted:false、写失败如实报、403/400）、**git_commit_message 工具**注册与执行、**blame**（逐行归属与 git blame 逐行对齐、行号连续、404/400/非仓库、service）、**范围读**（/show 与 /diff 的 base 与 git 逐文件逐字节对齐、base/parent 互斥 400、自比对空列表）、**项目总结**（编号解析、后行覆盖前行、一次调用总结全部、磁盘 store 落盘、零模型调用的第二次、单项目失效只重写它、损坏 store 自愈、离开注册表的工作区被修剪、force 全量、403/无头、AI 开关、**批量失败时按仓库结算**（抛异常与失败帧两条路径都保留已存简介并报 `error`/`failed`，一条都没有时才 502）、**推理等级**（配置与请求体两条来源都真的到达模型调用，留空是省略而不是 `off`，非单行 400））、bundle 契约：`dsh.client.platform`/`exports["./client"]`/`dsh.bundle.patch` 指向的 patch 文件存在且真的 insert 了 `git-panel` 行） |
| `scripts/live-check.mjs` | 对运行中的 harness 做线上验证：在一个**非仓库工作区**里自建沙盒远端，112 项断言（含真开一条 SSE 流 + 真提交触发 change 帧、context 两条来源、log/show、在沙盒克隆里真跑 stage/unstage/discard/commit/stash、**真调两次模型**（默认模型 + 下拉里挑的另一个 provider 的模型）生成提交信息并验证它没有动索引、模型目录如实列出挂载的 provider、未知模型给可读 502、以及「暂存全部并提交」的同一请求体真跑一次 commit 并确认没有 push、历史分页与 `path`/`author` 过滤与 `git log` 逐条对齐、`/branches` 的每个字段与 `for-each-ref` 对齐、真实合并提交按父提交读出带 hunk 的 patch、贮藏在沙盒克隆里真跑 stash→list→apply→drop 全程并核对文件内容与条目数、在沙盒克隆里真制造合并冲突并走「检测→拒绝继续→abort」与「冲突→解决→暂存→继续」两条全程、沙盒克隆里真跑分支创建/切换/碰撞拒绝全程、真模型上的流式草稿（帧序/begin 内容/delta 拼回最终稿/usage 如实标注）、**真 settings 服务上的 prefs**（探测写入→回读→恢复，全程回滚）、真实仓库的 blame（行数与 git 一致、作者非空、未提交文件 404）与范围读（与 git diff 逐文件逐字节对齐）、**真模型上的项目总结**（中文一句话、命名 provider/model、磁盘持久化 store：第二次全缓存、变更单个项目只重写它、损坏的 store 读空重写、force 全量）），跑完自删 |
| `scripts/diff-test.mjs` | client 纯逻辑测试：把构建产物当模块加载，喂真实 `git diff` 输出，115 项断言（解析器 + gap 行号区间 + 行内差异 + 批量队列时序 + tokenizer 与叠加不变式 + 提交图泳道：线性/合并/交叉/重复泳道折叠/父提交已在页面上/满哈希与缩写混用/父提交排在子提交之前的错乱历史不长泳道 + 相对时间阈值（刚刚/分钟/小时/天/绝对/不可解析原样透传）+ 日期分组阈值（今天/昨天按日历日、最近 7 天、更早、不可解析归更早）+ 真冲突仓库的 combined diff：七行全解析、冲突标记在行内、只有结果侧行号、计数正确、普通提交 diff 不标 combined） |
| `scripts/rail-check.mjs` | 左栏体检：真 Chromium 打开一个全新页面，断言左栏有 Git 图标、点开就是面板、页面开着 8 秒后图标还在、没有未捕获脚本错误（4 项断言）。它专治「插件没被装配成 bundle」这种界面外的问题 |
| `scripts/visual-check.mjs` | 视觉/端到端检查：真 Chromium 登录 harness、点开面板走到 diff，141 项断言（行号栏、tint、行内高亮、gap 点击展开/收起、折叠 chip、未跟踪文件、`● 实时`、`全部 Fetch（N）`、语法着色与开关、提交框与按钮状态、未跟踪文件只给暂存、`✨ AI 写信息` 真点一次并把中文信息填进输入框、模型下拉的分组与「记住上次选择」（含刷新页面后仍是它）、提交框内所有控件都不越界、AI 写完信息后暂存控件仍可用且「暂存全部并提交」就位、历史视图三段、**图形化历史**：每行一条图行且都有节点与连线、连线用主题色、范围下拉有「当前分支/所有 ref」、作者与提交信息过滤真的过滤（空结果给出文案）、重置还原、路径过滤与其清除、分支页的 `HEAD` 标记与只读声明、「看历史」交接、在 deepseek-harness 上真正加载下一页并把 100+ 条合并历史画在有限宽度内、合并提交的 `^1/^2` 切换真的重读、真实仓库上的贮藏区（行数与按钮一一对应、每个按钮的 title 写着它跑的确切 git 命令、`删除` 的两步确认只武装不执行）、无操作在进行时横幅确实不出现、分支切换在单分支与多分支仓库上的供给与两步确认（只武装不执行）、新分支输入与按钮的联动（填名后仍不执行）、流式草稿的停止按钮与完成态回归、**模型记忆写入真实 profile 配置并回滚**（localStorage 镜像 + /models remembered + 恢复）、**blame 视图**（逐行行数/归属、HEAD 声明、切回 diff）、**范围对比**（武装提示、chip `基准..目标`、文件列表、范围 diff、清除回归）、**批量暂存**（勾选→批量条计数→减选→清除，全程不执行暂存）、**设计系统**（样式表注入、分段 tabs 的 role/aria-selected、行 hover 真变色、Tab 真按出焦点环、j/k 移动选中、Space 只勾选不暂存、暗色主题跟随且无硬编码颜色、1100px 窄窗无溢出、Ctrl+Enter 空信息纪律 + 按钮标题广告快捷键、分栏拖拽真拖 +120px 且双击复位、总览筛选的收窄/计数/无匹配清除/恢复、列表/diff/分隔线全到底边的布局不变式、提交动作同一行 + 模型在说明行、卡片上的 AI 项目一句话（非空且为中文；另有一条把总结路由打回 502，断言卡片显示「简介暂不可用」的原因而不是永远闪的骨架条）、历史日期分组分隔行存在、合并标记存在、主题字重 500 压过元信息、**全干净日也能跑**（没有脏工作区时套件自己通过「添加工作区」弹窗注册一个确定性脏 fixture 并在 finally 移除工作区与目录）），截图落在 `.visual-out/` |

## HTTP 接口

| 路由 | 作用 |
|---|---|
| `GET /overview` | 所有已注册工作区各一张卡片的数据（每仓库 2 条 git 命令，限并发 `overviewConcurrency`，单个仓库读不到只降级成一张「不可用」卡片） |
| `GET /status?dir=` | 单仓库：分支/上游/ahead-behind + 文件列表 + 行数统计 + `operation`（进行中的 merge/cherry-pick/revert/rebase 与未解决冲突数，无则 null） |
| `GET /diff?dir=&path=&staged=&untracked=&hash=&parent=&base=` | 单文件 unified diff；带 `hash` 时从该提交读（`git show`），再带 `parent` 读 `git diff <hash>^<n> <hash>`，带 `base` 读 `git diff <base> <hash>` |
| `GET /log?dir=&limit=&skip=&all=&ref=&path=&author=&grep=` | 提交历史（新→旧，`--topo-order`）。`limit` 1..200（默认 30）、`skip` 0..100000，两者都回显在响应里；`all=1` 走 `--all`；`ref=` 指定分支/ref（非法字符或负数开头 400，不存在 404）；`path=`/`author=`/`grep=` 过滤（`grep` 大小写不敏感；文本上限 500 字符、含控制字符 400）。每条含 `hash/short/parents/author/date/refs/subject`，`parents` 与 `short` 用同一套缩写规则（泳道布局依赖这一点）。**没有提交**的仓库返回空列表，不是错误 |
| `GET /branches?dir=` | 本地分支列表（tip 新→旧，当前分支在最前）：`name/short/current/upstream/track/date/subject` + 顶层 `current`（detached HEAD 时为 `null`）。只读，不切分支 |
| `GET /show?dir=&hash=&parent=&base=` | 单个提交：元信息 + 它动过的文件。`parent=1..8` 按 `git diff <hash>^<n> <hash>` 读（合并提交的唯一可行读法）；`base=<40hex>` 按 `git diff <base> <hash>` 读（范围对比）；两者互斥 |
| `GET /context?dir=&path=&staged=&untracked=&hash=&start=&count=` | 读一个文件某段**未变更**行，用来展开 diff 里收起的 gap。`start ≥ 1`、`1 ≤ count ≤ 400`；要读 index / HEAD / 工作区由 host 按 `staged`/`untracked` 决定；文件缺失返回 `missing: true`（200）、二进制返回 `binary: true` |
| `GET /events?dir=…&dir=…` | SSE：`hello` 帧告知真正在监听什么，之后每仓库每次去抖一帧 `change`（`{dir, files, at}`），空闲时只发注释心跳。需 `watchEnabled`；`dir` 同样过白名单（403），最多 64 个 |
| `POST /project-summaries` | 全部工作区的一句话项目简介（一次模型调用 + 指纹缓存）；`{force?}` 绕过缓存，`{provider?, model?, reasoningEffort?}` 覆盖本次调用。模型调用失败时，store 里已有的简介照常返回并附 `error` + `failed`；一条都没有才 502（超时 504） |
| `POST /commit-message/stream` | 流式草稿（SSE 帧 begin/delta/done/error）；与 `POST /commit-message` 同头同参数 |
| `POST /prefs` | 记忆写信息模型：`{provider?, model?}`（空则清除），经 settings 服务写插件自身配置；`persisted: false` 表示无设置服务，回退浏览器记忆 |
| `POST /action` | body `{dir, action, confirm?, paths?, message?, ref?}`。需 `content-type: application/json` 与 `x-dsh-git-panel` 头。远端动作：`fetch`/`pull`/`push`（push 需 `confirm: true`，否则 428）；本地动作：`stage`/`unstage`/`discard`/`stash`/`commit`（需 `allowRepoWrites`）、`stashApply`/`stashPop`/`stashDrop`（`ref` 限 `stash@{N}`，`stashDrop` 需 `confirm: true`）、`continueOperation`/`abortOperation`（按实际进行中的操作决定命令；`abortOperation` 需 `confirm: true`）、`checkout`（`ref` 为分支名，`create: true` 时 `git checkout -b`；需 `confirm: true`）。同一仓库同时只允许一个动作（否则 409） |
| `GET /stashes?dir=` | 贮藏列表（新→旧）：`ref/hash/short/date/subject`。非仓库返回 `repo: null` |
| `GET /blame?dir=&path=` | 逐行追溯（`git blame --line-porcelain HEAD`）：`line/hash/short/author/time/summary/text`。文件未提交 404，非仓库 `repo: null` |

配置项（`Config`）：`timeoutMs`（只读命令超时，默认 20s）、`actionTimeoutMs`（fetch/pull/push 超时，默认 60s）、`outputMaxBytes`（stdout 上限，默认 4 MiB）、`actionOutputMaxBytes`（动作回传给面板的每个流上限，默认 32 KiB）、`contextLines`（diff 上下文，默认 3）、`overviewConcurrency`（总览并发，默认 4）、`allowPush`（是否允许 push，默认 true；关掉后 fetch/pull 照常）、`allowRepoWrites`（是否允许 stage/unstage/discard/stash/commit，默认 true；关掉后这些一律 403，读操作不受影响）、`watchEnabled`（是否允许事件流，默认 true；关掉后 `/events` 返 503，面板自动退回轮询）、`fetchBeforePull`（pull 前是否先 `fetch --prune`，默认 true）。

## HTTP 接口补充：错误与降级

- 路径白名单在**任何** git 命令之前执行：不在任何已注册工作区内的 `dir` 一律 403。
- 只读路由超时 504；动作超时 504 且**不因浏览器断开而中止**（绑定插件生命周期）。
- `/events` 在 `watchEnabled: false` 时 503；SSE 头一旦发出，后续异常只关流、不再改写成 JSON 错误。

## 设计要点

- **位置**：不占用 `sidebar`/`sidebar.workspaces`（那是官方 UI 的座位），只用官方"左栏图标 + 中列整页"范式，与 `plugins` / `schedules` / `usage-stats` 同构。
- **数据面**：`git status --porcelain=v2 --branch -z` 一条命令拿全分支、上游、ahead/behind 与全部文件状态；`--numstat -z` 补行数；diff 走 `git diff -U3 -- <path>`，未跟踪文件走 `--no-index /dev/null <abs>`。
- **安全**：客户端目录先对 `workspaceRegistry.list()` 校验（403），路径禁止绝对路径与 `..`（400）；git 以 argv 数组启动、非交互环境（`GIT_TERMINAL_PROMPT=0` 等）、单命令超时 + stdout 上限；所有读操作从不写仓库。
- **写操作**：`fetch --prune` / `pull --ff-only`（用户选定的策略，绝不产生合并提交；分叉或本地冲突时 git 自己拒绝）/ `push`（argv 里永远没有 `--force`、`--tags`、`--set-upstream`）。动作子进程绑定插件生命周期与 `actionTimeoutMs`，**不绑定浏览器请求**——刷新页面或关标签不会把 push 掐断。
- **刷新**：打开时拉一次；有事件流时由 `.git` 变化驱动（轮询拉长到 60s 兜底），没有事件流时页面可见期每 15s（总览 20s）一次；另有手动刷新；动作结束后两屏都会自动重读。

## 构建 / 测试 / 装载

```bash
npm run build:all                                           # = scripts/build.sh + npm run build:client
# ⚠️ scripts/build.sh 只编译 host 并类型检查 client，**不**打包 lib/client.js；
#    改了 src/client/** 必须再跑 npm run build:client（或直接用 build:all），
#    否则浏览器加载的还是旧 bundle（类型检查会通过，界面却是旧的）。
DSH_CHECKOUT=/root/deepseek-harness bash scripts/build.sh   # 仅 host tsc + client 类型检查
npm run build:client                                        # tsdown → lib/client.js
node scripts/smoke.mjs                                      # host 冒烟（需 git）
node scripts/diff-test.mjs                                  # 差异解析器（需先 build:client）
node scripts/live-check.mjs                                 # 对运行中的 harness 发真实请求（需 git）
node scripts/visual-check.mjs                               # 真浏览器走一遍 UI + 截图（需 harness 在 3080 且环境有 playwright）
node scripts/rail-check.mjs                                 # 只查左栏图标在不在、面板能不能开（几秒钟）
```

从干净 clone 构建若报 `TS7006: Parameter 'args' implicitly has an 'any' type`，说明 `@deepseek-ai/dsh-tools` 没解析到（`defineTool` 的回调因此丢了上下文类型）：`scripts/build.sh` 会从 `DSH_CHECKOUT` 链接它，确认 `DSH_CHECKOUT` 指向一个已构建的 DSH checkout。

`visual-check.mjs` 从 `/root/deepseek-harness` 解析 playwright、用 `~/.cache/ms-playwright` 里的 chromium；两者缺任一个就打印 SKIP 退出 0，不会影响其余测试。它读 profile 的登录凭据只为走一遍登录表单，凭据不落盘、不打印。

### 它是一个 bundle（这一点踩过坑）

profile 的启动方式是「按 `dsh.profile.bundles` 顺序叠 patch 层，再叠你自己的 `cordis.patch.yml`」，而**每个 bundle 的 loader 行只能来自它自己包内的 `cordis.patch.yml`**（由 package.json 的 `dsh.bundle.patch` 指过去，见本包的 `cordis.patch.yml`）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", ... } }
```

本包一开始**只有 `dsh.client`、没有 `dsh.bundle.patch`**：靠运行时注入（`loader.create`）也能跑起来，界面一切正常——直到 profile 被重新装配（本环境里注入器自愈会触发）或重启，那一行就没了，**host 路由 404、左栏图标一起消失**，而 `dsh.profile.bundles` 里的包名看上去毫无问题。这次就是这么丢的，所以：

- `cordis.patch.yml` 现在是仓库的一部分（也列进 `files`），`smoke` 有 4 条断言盯着这份契约；
- `scripts/rail-check.mjs` 用真浏览器在几秒内回答「左栏到底有没有 Git」，比跑完整套视觉检查快得多；
- 想确认「干净启动会装配它」而不重启正在跑的服务：

```bash
node /root/deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config | grep -A2 git-panel
```

装载（免重启；现在这条路和干净启动走的是同一份 bundle 层，两边一致）：

```
dev_install_package { "dir": "/root/dsh-git-panel" }   # 首次装配
dev_reload_package  { "packageName": "dsh-git-panel" } # 改了 host 代码后热更新（清 loader 缓存 + 重建 fiber）
```

`dev_install_package` 在 entry 已存在时**跳过重建**，所以首次装配之后改 host 代码要用 `dev_reload_package`（它才会清缓存并重新 import）；改 client 代码不需要动 loader，只需 `npm run build:client` 后刷新页面。改用例、改 README 都不需要重载。

> 注意 `dev_reload_package` 只认「loader 缓存里还有这个模块」的行。整行都没了的时候它会回一句 `缓存中无匹配且磁盘降级失败`——那时要的是**重新装配**（`dev_install_package`），不是重载。

卸载：`dev_uninject_plugin { "match": "dsh-git-panel" }`（或从 Plugins 页禁用）。
