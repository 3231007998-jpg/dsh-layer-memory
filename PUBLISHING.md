# 发布与分享指南

本目录是 `dsh-layer-memory` 的可发布副本（已把本机绝对路径替换为占位符）。
本地安装版本位于工作区 `dsh-layer-memory/`，包名是 `@local/dsh-layer-memory`；
本副本改成了 npm 可用的包名 `dsh-layer-memory`，方便发布后由他人安装。

## 方案 A：GitHub 仓库（最常用，他人可查看）

1. 打开 https://github.com/new ，Repository name 填 `dsh-layer-memory`，
   不要勾选 "Initialize this repository with a README"。
2. 在本目录执行（把 3231007998-jpg 换成实际值）：

```bash
git init
git add -A
git commit -m "feat: layered long-term memory plugin for DeepSeek Harness v1.9.0"
git branch -M main
git remote add origin https://github.com/3231007998-jpg/dsh-layer-memory.git
git push -u origin main
```

3. 得到的项目链接：`https://github.com/3231007998-jpg/dsh-layer-memory`。
4. 仓库里的 package.json 已经填好账号（3231007998-jpg）与项目链接，无需再改。

## 方案 B：Gitee 仓库（国内访问更快）

1. 打开 https://gitee.com/projects/new 新建仓库 `dsh-layer-memory`（不要初始化）。
2. 命令同上，把 remote 换成 `https://gitee.com/3231007998-jpg/dsh-layer-memory.git`。
3. 链接：`https://gitee.com/3231007998-jpg/dsh-layer-memory`。

## 方案 C：npm 包（他人可一条命令安装）

包名 `dsh-layer-memory` 在 npm registry 上当前未被占用（已确认）。

```bash
npm login          # 需要 npm 账号
npm publish --access public
```

发布后包页：`https://www.npmjs.com/package/dsh-layer-memory`
其他人安装：

```bash
dsh plugin --profile <profile> add dsh-layer-memory
```

## 方案 D：把 README 变成可浏览网页（可选）

- GitHub Pages：GitHub 仓库 Settings → Pages → Source 选 `Deploy from a branch`，
  Branch 选 `main` / `(root)`，保存后访问
  `https://3231007998-jpg.github.io/dsh-layer-memory/`（需要仓库根目录有 `index.md` 或 `index.html`）。
- 最简单：直接把 README 的渲染页面当作项目介绍，GitHub/Gitee 仓库首页即渲染 README。

## 分享前检查

- [ ] 仓库里没有本机数据目录（`$DSH_HOME/layer-memory`）、会话日志、个人文档。
- [ ] 搜索本机绝对路径（`C:\Users\<用户名>`）、学号、简历等私密信息应为 0 命中。
- [ ] 版本号、README 截图、示例路径已替换为占位符。
- [ ] 如果只想让指定的人查看，把仓库设为 Private 并邀请 collaborator（链接需登录且被授权才能访问）。

## 数据隐私说明（写进 README 宣传时有用）

插件所有记忆数据只写入本机 `$DSH_HOME/layer-memory`（可用 `DSH_LAYER_MEMORY_DIR` 覆盖），
不上传、不联网；"从其他对话导入记忆"只读本机会话日志，不会有网络请求。
