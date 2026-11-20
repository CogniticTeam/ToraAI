# 工作执行同题评测

先运行 `npm run eval:baseline`，确认三个任务在初始状态都无法通过独立验收。评测工具不会调用模型，也不会修改真实项目文件。

准备好要评测的 Agent 后，用 JSON 数组指定可执行程序及参数，`{prompt}` 会替换成任务描述：

```sh
node scripts/eval-work-execution.mjs --name Tora --runner '["node","/绝对路径/Tora/packages/cli/src/index.js","{prompt}"]'
```

Tora CLI 在评测中使用独立的 `TORA_HOME`。可在上述命令后加 `--model-from-config`：评测进程读取现有 Tora 模型配置，只通过子进程环境变量传给 Agent，不复制配置文件或将密钥写入报告。也可自行配置 `TORA_BASE_URL`、`TORA_API_KEY`、`TORA_MODEL`。`--task strict-port` 可先跑一题。其他产品也应配置好认证，并使用相同的任务和超时。每题在仓库外的系统临时目录运行，结束后将工作区副本、日志与 `report.json` 保存到被 Git 忽略的 `output/agent-eval/` 下，避免继承 Tora 父仓库的项目指令和 Git 状态。

DeepSeek Harness 的同题入口可使用安装后的 `dsh --profile headless`，并加 `--runner-kind dsh --model-from-config`。评测器仅在本机配置为官方 `deepseek-flash` 时传入同一把 API 凭证；每题使用独立 `DSH_HOME`，关闭遥测，并为无人值守运行设置 `danger-full-access`。该模式的进程权限不受临时工作区限制，只应使用合成题目或额外的系统隔离。两者使用同一模型、任务、验证器和超时；Tora 走 OpenAI 兼容端点，dsh 官方适配器走 Messages 端点，协议差异仍须在解读结果时注明。

桌面会话使用的 `/official/v1` 网关不是 CLI 的自接入模型接口；如果当前配置指向该地址，`--model-from-config` 会提前报错。请先接入 CLI 可调用的模型，再进行真实 Tora 测评。

分数是三题通过率，不是模型能力排名。三题分别检查严格输入处理、跨文件交付，以及修复失败测试。验收代码不放进 Agent 的工作区；Agent 自称“已完成”不能代替通过验收。当前题量很小，适合作为回归基线，不能代表大规模工程性能。

## 公开数据评测

首轮使用 QuixBugs 的 `find_in_sorted`、`mergesort` 和 `wrap`。工作区用上游缺陷实现和测试初始化，独立验收只取候选改动的目标文件，并在另一临时目录运行原始 pytest 测试。报告记录上游提交、参与文件的 SHA-256，以及修复前后的官方测试数。[QuixBugs 数据](https://github.com/jkoppel/QuixBugs/tree/4257f44b0ff1181dedaedee6a447e133219fcebf)

准备上述提交的检出目录和装有 pytest 的 Python 解释器。先运行离线基线检查，再用相同的数据参数启用各客户端。

```sh
node scripts/eval-work-execution.mjs --check-fixtures --dataset quixbugs \
  --dataset-dir /absolute/path/QuixBugs \
  --dataset-revision 4257f44b0ff1181dedaedee6a447e133219fcebf \
  --python /absolute/path/venv/bin/python
```

- `--runner-kind tora-desktop` 用 `scripts/eval-suite/tora-desktop.mjs` 接收任务，在桌面 ASAPI 执行链运行。配合 `--model-from-config` 使用已有自定义模型。开始任务时使用隔离的会话，文件工具限制在临时工作区，Bash 禁网并只接受当前目录查询与指定测试命令。
- `--runner-kind codex` 读取 `codex exec --json` 的结构化日志。DeepSeek 同模型组通过官方 Responses 适配器使用 `--model-from-config`，模型目录与提供商由单次运行的 CLI 配置指定。[DeepSeek 接入 Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
- `--runner-kind claude-code` 读取 `claude -p --output-format stream-json --verbose` 的结构化日志。DeepSeek 同模型组也可用 `--model-from-config`，凭证只传给指向 DeepSeek 官方接口的子进程环境。[DeepSeek 接入 Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)

单题用时统计到客户端退出为止。官方测试通过数、客户端终止状态和模型用量独立记录。跨客户端仍存在工具定义、API 协议与缓存差异，小样本适合观察执行行为。

Tora Desktop 的评测还记录 `modelWaitMs` 和 `toolBatchMs`，可将模型请求等待与本地工具批次开销对应到每道题。比较优化前后时使用相同数据版本、模型、权限与测试命令。
