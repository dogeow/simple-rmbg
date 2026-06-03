# 去背景 (Next.js + RMBG-2.0)

一个去图片背景的 Web 应用。所有推理在服务端本地完成，使用 [`briaai/RMBG-2.0`](https://huggingface.co/briaai/RMBG-2.0)（通过 [transformers.js](https://github.com/huggingface/transformers.js) 运行），可离线、隐私友好。同时提供 REST API，网页和外部调用共用同一处理逻辑。

## 技术栈

- **Next.js 15** (App Router) + React 19 + TypeScript
- **Tailwind CSS v4**
- **@huggingface/transformers** (transformers.js) 加载 RMBG-2.0
- **sharp** 把模型输出的 mask 作为 alpha 通道合成透明 PNG

## 处理流程

1. 使用 RMBG-2.0 生成前景/背景 mask
2. 将 mask 写入原图 alpha 通道，输出透明或纯色背景 PNG

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:3000 ，拖拽或选择一张图片即可去背景。

> 首次处理图片时会自动下载模型到本地 `.cache/` 目录，需要联网一次，之后可离线运行。

RMBG-2.0 在 Hugging Face 上需要先登录并接受模型条款。接受后用 token 启动：

```bash
HF_TOKEN="hf_..." npm run dev
```

### 网络受限时（通过代理下载模型）

项目已支持出站代理，优先读取以下环境变量：
- `MODEL_PROXY_URL`（推荐，专用于模型下载）
- `HTTPS_PROXY`
- `HTTP_PROXY`
- `HF_ENDPOINT`（可选，替换默认 `https://huggingface.co/`，例如镜像站）

例如：

```bash
export MODEL_PROXY_URL="http://user:pass@proxy-host:3128"
npm run dev
```

若代理链路仍不稳定（如 `ECONNRESET`），可以同时切到镜像源：

```bash
MODEL_PROXY_URL="http://user:pass@proxy-host:3128" \
HF_ENDPOINT="https://hf-mirror.com/" \
npm run dev
```

服务端已内置模型下载重试（指数退避），可自动应对瞬时网络抖动。
同时内置了**多源自动切换**（`HF_ENDPOINT`/`MODEL_REMOTE_HOST` -> `hf-mirror` -> 官方源），当某一源失败会自动换下一源重试。

### 强制离线模式（推荐）

如果网络环境不稳定，建议直接使用本地模型目录：

- 默认本地目录：`models/RMBG-2.0`
- 可通过 `MODEL_LOCAL_PATH` 或 `MODEL_2_0_LOCAL_PATH` 自定义
- 开启 `MODEL_LOCAL_ONLY=true` 后，服务**只从本地加载**，不会请求外网

启动示例：

```bash
MODEL_LOCAL_ONLY=true npm run dev
```

或自定义目录：

```bash
MODEL_LOCAL_PATH="/absolute/path/to/RMBG-2.0" MODEL_LOCAL_ONLY=true npm run dev
```

如果服务器无法访问 Hugging Face，先把 RMBG-2.0 权重下载到 `models/RMBG-2.0`，再启动：

```bash
MODEL_LOCAL_ONLY=true npm run dev
```

`GET /api/remove-bg` 会返回 `runtime.localOnly`、`runtime.localPath`、`runtime.localPathExists`，可用于确认离线模式是否生效。

## 网页功能

- 拖拽 / 点击上传（JPEG / PNG / WebP，最大 15MB）
- 原图与结果并排预览，结果区用棋盘格底显示透明
- 背景切换：透明或白底
- 一键下载 PNG

## API

### `POST /api/remove-bg`

请求方式（任选其一）：

**1. multipart/form-data（上传文件）**

```bash
curl -F "image=@photo.jpg" \
  "http://localhost:3000/api/remove-bg" \
  -o result.png
```

**2. application/json（远程图片 URL）**

```bash
curl -X POST "http://localhost:3000/api/remove-bg" \
  -H "Content-Type: application/json" \
  -d '{"image_url":"https://example.com/photo.jpg"}' \
  -o result.png
```

**3. 原始二进制 body**

```bash
curl -X POST "http://localhost:3000/api/remove-bg" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@photo.jpg" \
  -o result.png
```

#### 参数

| 参数 | 位置 | 说明 |
| --- | --- | --- |
| `image` | form-data | 上传的图片文件 |
| `image_url` | JSON body | 远程图片地址 |
| `bg` | form-data / JSON / query | 背景：`transparent`（默认）、`white`、`black` 或 CSS 颜色（如 `#ff0000`） |
| `format` | form-data / JSON / query | `png`（默认，返回二进制）或 `json`（返回 base64 data URL） |

#### 返回

- 默认返回 `image/png` 二进制
- `format=json` 时返回：

```json
{
  "width": 800,
  "height": 600,
  "format": "png",
  "data": "data:image/png;base64,...."
}
```

#### 示例：白底 + JSON 输出

```bash
curl -F "image=@photo.jpg" -F "bg=white" \
  "http://localhost:3000/api/remove-bg?format=json"
```

### `GET /api/remove-bg`

健康检查 / 模型预热：

```bash
curl "http://localhost:3000/api/remove-bg"
# {"status":"ready","model":"briaai/RMBG-2.0"}
```

## 脚本

```bash
npm run dev          # 开发服务器
npm run build        # 生产构建
npm run start        # 启动生产服务
npm run lint         # ESLint
npm run type-check   # TypeScript 类型检查
```

## 部署 / 自托管说明

- 模型在 Node 服务端运行，建议自托管（本地 / VPS / Docker），内存充足（建议 ≥ 1GB 可用）。
- 模型缓存目录为项目根下 `.cache/`，已在 `.gitignore` 中忽略。预热模型可在首次部署后请求一次 `GET /api/remove-bg`。
- 处理大图较耗时，API 路由 `maxDuration` 设为 120s。

## 许可

RMBG-2.0 模型由 BRIA AI 提供，使用前请在 Hugging Face 接受其许可条款；商业使用请参考其官方许可。
