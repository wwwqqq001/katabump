# Katabump Server Auto-Renewal Tool

基于 [zv201413/katabump](https://github.com/zv201413/katabump) 维护，保留原续期逻辑，并接入 Cloudflare 签到调度平台。GitHub Actions 只支持平台或人工通过 `workflow_dispatch` 触发，不再内置 Cron，也不再直接发送 Telegram 等第三方通知。


## GitHub Actions 接入调度平台

平台通过 GitHub Actions `workflow_dispatch` 触发续期任务，脚本结束后统一 POST 回调到 Cloudflare 调度平台。

1. **Fork 本仓库** 到你的 GitHub 账号。
2. 进入你的仓库，点击 **Settings** -> **Secrets and variables** -> **Actions**。
3. 添加以下 Repository Secrets：
   - `USERS_JSON`：Katabump 账号列表。
   - `PROXY_URL`：推荐。sing-box 代理链接；GitHub 直连常被 Turnstile 拦截，住宅/SOCKS 代理成功率更高。
   - `WEBHOOK_TOKEN`：调度平台 webhook 密钥。
   - `KATABUMP_SERVER_IDS`（可选）：账号 → 服务器 ID 映射，直达续期页，避免依赖脆弱的 “See” 文案。
   - `KATABUMP_SERVER_ID`（可选）：全局默认 server_id。
4. `USERS_JSON` 的格式必须是 JSON 数组（请尽量压缩为一行）：
   ```json
   [{"username": "your_email@example.com", "password": "your_password"}, {"username": "another@example.com", "password": "pwd"}]
   ```
   也可在账号对象里直接写 `server_id`：
   ```json
   [{"username":"a@x.com","password":"pwd","server_id":"335120"}]
   ```
5. **(可选) 配置代理**:

  添加名为 `PROXY_URL` 的 Secret，支持 vmess、vless、hy2、tuic、socks5 等。
  脚本会自动下载 sing-box 并在本地启动 HTTP 代理。
  - **格式示例**:
    - socks5 标准: `socks5://user:pass@host:port`
    - socks5 面板简写（已支持）: `socks5://host:port:user:pass`
    - vmess: `vmess://base64EncodedJSON`
    - vless: `vless://uuid@host:port?security=tls&type=ws&...#name`
    - hy2: `hy2://password@host:port?sni=xxx`

6. Cloudflare 调度平台任务建议配置：
   - `job_id`: `katabump-renew`
   - `workflow_id`: `renew.yml`
   - `ref`: `master`
   - `callback_url`: `https://checkin-cron-worker.wwwqqq001.workers.dev/webhook/checkin`

### workflow_dispatch inputs

```yaml
job_id:
  required: true
  type: string
run_id:
  required: true
  type: string
callback_url:
  required: false
  type: string
use_proxy:
  required: false
  type: boolean
  default: true
skip_webhook:
  required: false
  type: boolean
  default: false   # 仅手动调试时可设 true
```

如果 `callback_url` 为空，脚本会回退到：

```text
https://checkin-cron-worker.wwwqqq001.workers.dev/webhook/checkin
```

### 回调结果

脚本会保留所有账号在同一次 GitHub Actions job 内串行执行，不会按账号拆分 job。结果统一回调：

- `status=success`：所有账号续期成功，或仅存在“未到续期时间”等跳过结果。
- `status=failed`：至少一个账号登录、页面流程、验证码、代理或配置失败。
- `data.summary`：包含 `success`、`failed`、`duplicate`、`skipped`、`warning`。
- `data.accounts`：每个账号包含脱敏 ID、脱敏账号名、状态、奖励、余额、备注和角色数组。
- `data.details_markdown`：平台通知使用的可读摘要。

### 运行结果与截图

- **运行日志**: 在 Actions 中的 `Run Renew Script` 步骤查看。
- **截图留存**: 每次运行（无论成功与否），通过 `Upload Screenshots` 步骤自动上传截图。
  - 你可以在 Workflow 运行详情页的 **Artifacts** 区域下载 `screenshots` 压缩包。
  - 截图文件名使用账号 hash，不包含完整邮箱或密码。

你也可以在 Actions 页面手动点击 "Run workflow" 测试，但真实平台回调要求 `run_id` 已由平台创建。手动测试时可以临时填入测试回调地址。

---

## 💻 Windows 本地运行指南

如果你想在本地观察运行过程或进行调试，请按以下步骤操作。

### 1. 环境准备

确保你已经安装了 [Node.js](https://nodejs.org/) (建议版本 v18+)。

### 2. 安装依赖

在项目根目录打开终端 (PowerShell 或 CMD)，运行：

```bash
npm install
```

### 3. 配置账号

项目中有一个 `login.json.template` 模板文件。

1. 将其**重命名**为 `login.json`。
2. 用记事本或编辑器打开，填入你的账号密码：
   ```json
   [
       {
           "username": "myemail@gmail.com",
           "password": "mypassword123"
       }
   ]
   ```

   > **注意**: `login.json` 已被加入 `.gitignore`，不会被上传到 GitHub，请放心使用。
   >

### 4. 配置 Chrome 路径

打开 `renew.js` 文件，找到第 11-12 行：

```javascript
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const HEADLESS = true;
```

* **CHROME_PATH**: 这是你本地 Chrome 浏览器的安装路径。如果你的安装位置不同，请务必修改！
* **USER_DATA_DIR**:
  * 这是一个用于存放 Script 运行时产生的浏览器数据（缓存、Cookie、登录状态等）的文件夹。
  * **作用**: 它能让你的登录状态保持更久，不需要每次运行都重新输入密码。
  * **能不能删？**: **可以删**。如果你想要重置所有状态（彻底清除缓存），只需删除这个文件夹即可。脚本下次运行时会自动重新创建它。
* **HEADLESS**:
  * `false`: 脚本运行时会弹出一个 Chrome 窗口，你可以看到它在做什么。
  * `true`: (默认)脚本在后台无头运行，界面不可见（适合只想静默完成任务时开启）。

### 3. 运行脚本

如果你需要使用代理运行脚本，请设置环境变量 `HTTP_PROXY`：

**Powershell:**
```powershell
$env:HTTP_PROXY="http://user:pass@127.0.0.1:7890"
node renew.js
```

**CMD:**
```cmd
set HTTP_PROXY=http://user:pass@127.0.0.1:7890
node renew.js
```

如果不设置代理，直接运行：
```bash
node renew.js
```

脚本会自动启动 Chrome (如果需要)，逐个处理账号，并在根目录下的 `photo/` 文件夹中保存每个账号运行结束时的截图（`账号名.png`）。窗口（默认无头模式为 false，你可以看到操作过程），并依次为列表中的用户续期。

---

## 🛠️ 项目结构

* `renew.js`: Windows 本地运行的主程序。
* `action_renew.js`: 专门用于 GitHub Actions 环境的脚本（适配 Linux/Headless），支持随机延迟和 sing-box 代理。
* `proxy_handler.py`: 代理协议解析器，将 vmess/vless/hy2/tuic/socks5 等协议转换为 sing-box 配置。
* `.github/workflows/renew.yml`: GitHub Actions 手动触发 workflow，由 Cloudflare 调度平台调用。
* `login.json`: (需手动创建) 存放本地运行的账号信息。
