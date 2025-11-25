// =================================================================================
//  项目: eye2-2api (Cloudflare Worker 终极完美版)
//  版本: 4.4.0 (代号: Chimera Silent - Universal Compatibility)
//  作者: 首席AI执行官
//  日期: 2025-11-26
//
//  [v4.4.0 修复日志]
//  1. [Compatibility] 修复 Cherry Studio "AI_TypeValidationError"。
//     - 机制: 引入 "Silent Mode"。默认情况下不发送任何 debug 日志。
//     - 逻辑: 只有当请求体包含 `is_web_ui: true` 时，才推送调试数据。
//     - 结果: 第三方客户端只接收标准的 OpenAI 格式流，Web UI 接收全量日志。
//  2. [Core] 保留 v4.3.0 的 Cookie 透传修复，确保连接不中断。
//  3. [Stability] 增强了错误处理，确保向标准客户端返回正确的 Error JSON。
// =================================================================================

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "eye2-2api-universal",
  PROJECT_VERSION: "4.4.0",

  // 安全配置 (如果不需要密码，保持为 "1" 或留空)
  API_MASTER_KEY: "1",

  // 上游服务配置
  API_BASE: "https://sio.eye2.ai",
  ORIGIN: "https://www.eye2.ai",
  REFERER: "https://www.eye2.ai/",

  // 模型列表
  MODELS: [
    "chat_gpt", "claude", "gemini", "grok_ai", "mistral_ai", 
    "qwen", "deepseek", "llama", "ai21", "amazon_nova", "glm", "moonshot"
  ],
  DEFAULT_MODEL: "chat_gpt",

  // 统一请求头
  HEADERS: {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://www.eye2.ai",
    "Referer": "https://www.eye2.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    try {
        const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') return handleCorsPreflight();
        if (url.pathname === '/') return handleUI(request, apiKey);
        if (url.pathname.startsWith('/v1/')) return handleApi(request, apiKey);

        return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
    } catch (e) {
        return createErrorResponse(`Worker Fatal Error: ${e.message}`, 500, 'internal_error');
    }
  }
};

// --- [第三部分: API 路由逻辑] ---
async function handleApi(request, apiKey) {
  const authHeader = request.headers.get('Authorization');
  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== apiKey) {
      return createErrorResponse('Unauthorized', 401, 'unauthorized');
    }
  }

  const url = new URL(request.url);
  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request);
  
  return createErrorResponse('Not Found', 404, 'not_found');
}

function handleModelsRequest() {
  const models = CONFIG.MODELS.map(id => ({
    id: id, object: "model", created: Math.floor(Date.now()/1000), owned_by: "eye2"
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- [第四部分: 核心业务逻辑 (Silent Mode + Cookie Fix)] ---
async function handleChatCompletions(request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 状态标记：是否为 Web UI 请求
  let isWebUI = false;

  // 辅助函数：发送标准 SSE 数据 (Cherry Studio 需要这个)
  const sendSSE = async (data) => {
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch(e) {}
  };
  
  // 辅助函数：发送调试日志 (Cherry Studio 会忽略这个，因为我们加了判断)
  const sendDebug = async (step, type, data) => {
    // [关键修复] 如果不是 Web UI，直接返回，不发送任何脏数据
    if (!isWebUI) return;

    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const logEntry = { timestamp, step, type, data, is_debug: true };
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(logEntry)}\n\n`)); } catch(e) {}
  };

  (async () => {
    let serverWs = null;
    let isFinished = false;

    try {
      const body = await request.json();
      
      // [关键] 检测客户端类型
      isWebUI = body.is_web_ui === true;

      const messages = body.messages || [];
      const model = body.model || CONFIG.DEFAULT_MODEL;
      const requestId = `chatcmpl-${crypto.randomUUID()}`;

      await sendDebug("Init", "Info", { model, msgCount: messages.length });

      // --- Step 1: 获取 Share ID ---
      const lastMessage = messages[messages.length - 1]?.content || "Hello";
      await sendDebug("Step 1", "Request", "Getting Share ID...");
      
      let shareId;
      try {
          shareId = await getShareId(lastMessage);
      } catch (e) {
          await sendDebug("Step 1", "Warn", `Retry ShareID: ${e.message}`);
          shareId = await getShareId("Hello");
      }
      
      if (!shareId) throw new Error("Failed to obtain Share ID");
      await sendDebug("Step 1", "Success", { shareId });

      // --- Step 2: HTTP 握手 (获取 SID 和 Cookie) ---
      await sendDebug("Step 2", "Request", "Socket.io Handshake...");
      const { sid, cookie } = await socketHttpHandshake();
      await sendDebug("Step 2", "Success", { sid, cookie: cookie ? "Yes" : "No" });

      // --- Step 3: WebSocket 连接 (带 Cookie) ---
      const wsUrl = `${CONFIG.API_BASE}/socket.io/?EIO=4&transport=websocket&sid=${sid}`;
      await sendDebug("Step 3", "Connecting", wsUrl);

      const wsHeaders = {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "User-Agent": CONFIG.HEADERS["User-Agent"],
        "Origin": CONFIG.ORIGIN,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" 
      };

      if (cookie) wsHeaders["Cookie"] = cookie;

      const wsResp = await fetch(wsUrl, { headers: wsHeaders });

      if (wsResp.status !== 101) {
        throw new Error(`WS Upgrade Failed: ${wsResp.status} ${wsResp.statusText}`);
      }

      serverWs = wsResp.webSocket;
      serverWs.accept();
      await sendDebug("Step 3", "Success", "WebSocket Connected");

      // --- Step 4: WebSocket 事件处理 ---
      serverWs.addEventListener('message', async (event) => {
        try {
            let packet = event.data;
            if (typeof packet !== 'string') packet = new TextDecoder().decode(packet);
            
            // 心跳
            if (packet === '2') { serverWs.send('3'); return; }

            // 握手确认
            if (packet === '3probe') {
                serverWs.send('5'); 
                await sendDebug("WS", "Info", "Protocol Upgraded");
                
                setTimeout(() => { serverWs.send(`40${JSON.stringify({ shareId })}`); }, 50);
                setTimeout(() => {
                    const reqPayload = ["llm:conversation:request", { "shareId": shareId, "llmList": [model] }];
                    serverWs.send(`42${JSON.stringify(reqPayload)}`);
                    sendDebug("WS", "Sent", "Request Sent");
                }, 100);
                return;
            }

            // 业务数据
            if (packet.startsWith('42')) {
              const jsonStr = packet.substring(2);
              const [eventName, payload] = JSON.parse(jsonStr);

              if (eventName === 'llm:conversation:response') {
                if (payload.llm === model && payload.data?.data) {
                  const content = payload.data.data;
                  // 发送标准数据给 Cherry Studio
                  await sendSSE({
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now()/1000),
                    model: model,
                    choices: [{ index: 0, delta: { content }, finish_reason: null }]
                  });
                }
              } else if (eventName === 'llm:conversation:end') {
                if (!payload.llm || payload.llm === model) {
                  isFinished = true;
                  await sendDebug("WS", "End", "Stream Finished");
                  
                  await sendSSE({
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now()/1000),
                    model: model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                  });
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                  serverWs.close();
                  await writer.close();
                }
              }
            }
        } catch (e) {
            await sendDebug("WS", "ParseError", e.message);
        }
      });

      serverWs.addEventListener('close', async () => {
        if (!isFinished) {
          await sendDebug("WS", "Close", "Connection closed unexpectedly");
          try { await writer.close(); } catch(e) {}
        }
      });

      serverWs.addEventListener('error', async (e) => {
        await sendDebug("WS", "Error", e.message);
        try { await writer.close(); } catch(e) {}
      });

      serverWs.send('2probe');

    } catch (e) {
      // 错误处理：如果是 WebUI，发送 Debug 日志；如果是 Cherry Studio，发送标准 Error 对象
      if (isWebUI) {
          await sendDebug("Fatal", "Error", e.message);
      } else {
          // Cherry Studio 需要这个格式
          await sendSSE({
              error: {
                  message: e.message || "Internal Server Error",
                  type: "internal_error",
                  code: 500
              }
          });
      }
      
      try { await writer.close(); } catch(err) {}
      if (serverWs) try { serverWs.close(); } catch(err) {}
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
  });
}

// --- [第五部分: 辅助函数] ---

async function getShareId(text) {
  const url = `${CONFIG.API_BASE}/api/v1/conversation/share-id`;
  const res = await fetch(url, {
    method: "POST",
    headers: CONFIG.HEADERS,
    body: JSON.stringify({ text })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ShareID ${res.status}: ${errText.substring(0, 100)}`);
  }
  
  const data = await res.json();
  return data.share_id;
}

async function socketHttpHandshake() {
  const t = Math.random().toString(36).substring(2);
  const url = `${CONFIG.API_BASE}/socket.io/?EIO=4&transport=polling&t=${t}`;
  
  const res = await fetch(url, { method: "GET", headers: CONFIG.HEADERS });
  
  if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Handshake ${res.status}: ${txt.substring(0, 100)}`);
  }
  
  const cookie = res.headers.get("set-cookie");
  const text = await res.text();
  const jsonStartIndex = text.indexOf('{');
  if (jsonStartIndex === -1) throw new Error("Invalid Handshake Response");
  
  const jsonStr = text.substring(jsonStartIndex);
  const data = JSON.parse(jsonStr);
  
  return { sid: data.sid, cookie };
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第六部分: 开发者驾驶舱 UI (Web UI)] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #f8fafc; --text-dim: #94a3b8; --primary: #3b82f6; --accent: #10b981; --error: #ef4444; --font: 'Segoe UI', monospace; }
      * { box-sizing: border-box; }
      body { font-family: var(--font); background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .container { display: flex; width: 100%; height: 100%; }
      .sidebar { width: 320px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; position: relative; }
      .logs-panel { width: 400px; background: #020617; border-left: 1px solid var(--border); display: flex; flex-direction: column; font-size: 12px; }
      
      .box { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; border: 1px solid var(--border); }
      .label { font-size: 12px; color: var(--text-dim); margin-bottom: 6px; display: block; font-weight: bold; }
      .val { background: #0f172a; padding: 8px; border-radius: 4px; word-break: break-all; cursor: pointer; }
      .val:hover { color: var(--primary); }
      
      select, textarea { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); padding: 10px; border-radius: 6px; resize: none; }
      button { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
      button:disabled { background: var(--border); cursor: not-allowed; opacity: 0.5; }
      
      .chat-window { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 12px 16px; border-radius: 8px; line-height: 1.6; font-size: 14px; }
      .msg.user { align-self: flex-end; background: var(--primary); color: white; }
      .msg.ai { align-self: flex-start; background: var(--panel); border: 1px solid var(--border); color: #ddd; }
      
      .logs-header { padding: 10px; border-bottom: 1px solid var(--border); font-weight: bold; display: flex; justify-content: space-between; }
      .logs-content { flex: 1; overflow-y: auto; padding: 10px; font-family: 'Consolas', monospace; }
      .log-entry { margin-bottom: 8px; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
      .log-time { color: #64748b; margin-right: 8px; }
      .log-step { color: var(--accent); font-weight: bold; }
      .log-type { color: var(--primary); margin-left: 5px; }
      .log-data { color: #94a3b8; margin-top: 4px; white-space: pre-wrap; }
      .log-error { color: var(--error); }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #475569; }
    </style>
</head>
<body>
    <div class="container">
        <div class="sidebar">
            <h2 style="margin:0; color:var(--primary)">👁️ ${CONFIG.PROJECT_NAME}</h2>
            <div class="box"><span class="label">API Key</span><div class="val" onclick="copy('${apiKey}')">${apiKey}</div></div>
            <div class="box"><span class="label">Endpoint</span><div class="val" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div></div>
            <div class="box">
                <span class="label">Model</span>
                <select id="model">${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
            </div>
            <div class="box" style="flex:1; display:flex; flex-direction:column;"><span class="label">Input</span><textarea id="prompt" style="flex:1" placeholder="输入问题...">你好，请介绍一下你自己。</textarea></div>
            <button id="btn-send">发送请求</button>
        </div>
        <div class="main">
            <div class="chat-window" id="chat">
                <div style="color:var(--text-dim); text-align:center; margin-top:100px;">
                    <h3>Eye2 Neural Link Ready</h3>
                    <p>WebSocket 协议已激活。<br>支持 GPT-4, Claude, Gemini 等全模型。</p>
                </div>
            </div>
        </div>
        <div class="logs-panel">
            <div class="logs-header"><span>📡 神经链路日志</span><span style="cursor:pointer" onclick="document.getElementById('logs').innerHTML=''">清空</span></div>
            <div class="logs-content" id="logs"></div>
        </div>
    </div>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) { navigator.clipboard.writeText(text); alert('已复制'); }

        function appendLog(entry) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
            const isError = entry.type === 'Error' || entry.type === 'Fatal';
            div.innerHTML = \`<div><span class="log-time">[\${entry.timestamp}]</span><span class="log-step">\${entry.step}</span><span class="log-type" style="\${isError ? 'color:var(--error)' : ''}">\${entry.type}</span></div><div class="log-data \${isError ? 'log-error' : ''}">\${dataStr}</div>\`;
            const logs = document.getElementById('logs');
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            const chat = document.getElementById('chat');
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }

        window.send = async function() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return;
            
            const btn = document.getElementById('btn-send');
            btn.disabled = true;
            btn.innerText = '请求中...';

            if(document.querySelector('.chat-window h3')) document.getElementById('chat').innerHTML = '';
            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '...');
            let fullText = "";

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: "user", content: prompt }],
                        stream: true,
                        is_web_ui: true // 开启调试日志的关键开关
                    })
                });

                const reader = res.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const data = JSON.parse(dataStr);
                                if (data.is_debug) { appendLog(data); continue; }
                                if (data.error) { 
                                    aiMsg.innerText = '❌ ' + data.error.message; 
                                    appendLog({timestamp: new Date().toLocaleTimeString(), step: "Client", type: "Error", data: data.error.message});
                                    continue;
                                }
                                const content = data.choices?.[0]?.delta?.content;
                                if (content) { fullText += content; aiMsg.innerText = fullText; }
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {
                aiMsg.innerText = '❌ ' + e.message;
                appendLog({ timestamp: new Date().toLocaleTimeString(), step: "Client", type: "Error", data: e.message });
            } finally {
                btn.disabled = false;
                btn.innerText = "发送请求";
            }
        };

        document.getElementById('btn-send').addEventListener('click', window.send);
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
