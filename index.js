#!/usr/bin/env node
/**
 * Multi-AI Query v2.2 — 优化版
 * v2.2: Chrome 151 兼容(--remote-allow-origins / /json/new 修复) + DeepSeek API 总结 + 发送重试 + CF 检测
 * 改进：config.json配置、错误隔离、可选AI、权重排序、多输出格式
 * 借鉴了 msij/Multi-AI-Aggregator-- 的配置化和输出格式设计
 */
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

// ========== 加载配置 ==========
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
if(!CONFIG) { console.error('❌ 找不到 config.json'); process.exit(1); }

const CDP = CONFIG.browser.cdpPort;
const CHROME = CONFIG.browser.executablePath;
const UDATA = CONFIG.browser.userDataDir;

// CLI参数解析：支持 --format 和查询文本
let Q = '你好';
let OUTPUT_FORMAT = CONFIG.output?.format || 'summary';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--format' && i + 1 < process.argv.length) {
    OUTPUT_FORMAT = process.argv[i + 1];
    i++;
  } else if (!process.argv[i].startsWith('--')) {
    Q = process.argv[i];
  }
}

// 获取启用的AI列表（按order排序）
const ENABLED_AIS = Object.values(CONFIG.ais).filter(a => a.enabled).sort((a, b) => (a.order || 99) - (b.order || 99));
if(ENABLED_AIS.length === 0) { console.error('❌ 没有启用的AI，请检查 config.json'); process.exit(1); }

console.log(`\n🔍 多AI查询 V2.2: "${Q}"`);
console.log(`   启用的AI: ${ENABLED_AIS.map(a => a.name).join(', ')}`);

// 提示已自动禁用的AI
const autoDisabled = Object.values(CONFIG.ais).filter(a => a.autoDisabled);
if (autoDisabled.length > 0) {
  console.log(`   ⚠️ 上次自动禁用: ${autoDisabled.map(a => a.name).join(', ')} (网络恢复后删除 config.json 中 autoDisabled 即可重新启用)`);
}
console.log('');

// ========== 工具函数 ==========
const slp = ms => new Promise(r => setTimeout(r, ms));

function httpG(p) {
  return new Promise((r, rej) => {
    const q = http.get(`http://127.0.0.1:${CDP}${p}`, rr => { let d = ''; rr.on('data', c => d += c); rr.on('end', () => r(d)); });
    q.on('error', rej); q.setTimeout(10000, () => { q.destroy(); rej('timeout') });
  });
}

function httpPut(p) {
  return new Promise((r, rej) => {
    const q = http.request(`http://127.0.0.1:${CDP}${p}`, { method: 'PUT' }, rr => { let d = ''; rr.on('data', c => d += c); rr.on('end', () => r(d)); });
    q.on('error', rej); q.setTimeout(10000, () => { q.destroy(); rej('timeout') }); q.end();
  });
}

function cdp(ws, m, p = {}, t = 20000) {
  return new Promise((r, rej) => {
    const id = Math.floor(Math.random() * 1e6);
    const to = setTimeout(() => rej('T:' + m), t);
    const h = d => { try { const x = JSON.parse(d); if (x.id === id) { ws.removeListener('message', h); clearTimeout(to); r(x); } } catch {} };
    ws.on('message', h); ws.once('error', e => { clearTimeout(to); rej(e); });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
}

async function ev(ws, e, t = 20000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true }, t).catch(() => null);
  return r?.result?.result?.value;
}

// ========== DeepSeek API 总结（v2.2，秒回且稳定） ==========
// key 从环境变量 DEEPSEEK_API_KEY 读取（避免写进代码/仓库）；未配置时回退网页操作
async function summaryWithAPI(question, answers) {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return null;
  const prompt = '请综合总结以下来自不同AI对同一问题的回答，提取共同观点和核心内容，用中文输出一份详细完整的汇总报告：\n\n问题：' + question + '\n\n各AI回答：\n' + answers.map(x => '--- ' + x.name + ' ---\n' + (x.response || '').substring(0, 1200)).join('\n\n');
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2000 });
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
      req.on('error', reject); req.setTimeout(60000, () => { req.destroy(); reject(new Error('DeepSeek API 超时')); }); req.write(body); req.end();
    });
    if (resp.status === 200) {
      const j = JSON.parse(resp.body);
      return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content.trim() : '';
    }
    return null;
  } catch { return null; }
}

// ========== 浏览器管理 ==========
async function ensureChrome() {
  try { await httpG('/json/version'); return }  // Chrome已在运行，不复重启
  catch {}
  process.stdout.write('  [Chrome] 启动中...');
  const urls = ENABLED_AIS.map(a => a.url);
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--remote-allow-origins=*', `--user-data-dir=${UDATA}`, '--no-first-run', '--no-default-browser-check', ...urls], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await slp(1000); try { await httpG('/json/version'); console.log(' ✅'); return } catch {} }
  throw new Error('Chrome启动超时');
}

async function ensureTabs() {
  const found = [];
  const tabs = JSON.parse(await httpG('/json'));
  for (const ai of ENABLED_AIS) {
    process.stdout.write('  ['+ai.name+']');
    const domain = new URL(ai.url).hostname;
    let tab = tabs.filter(t => t.type === 'page' && t.url?.includes(domain)).pop();
    if (!tab) {
      process.stdout.write('创建...');
      try {
        // Chrome 151: /json/new?url= 参数已失效（创建的是 about:blank），改为创建后 Page.navigate
        await httpPut('/json/new');
        await slp(1500);
        let ntabs = JSON.parse(await httpG('/json'));
        tab = ntabs.filter(t => t.type === 'page' && (t.url === 'about:blank' || !t.url)).pop() || ntabs.filter(t => t.type === 'page').pop();
        if (tab) {
          const ws = new WebSocket(tab.webSocketDebuggerUrl); ws.setMaxListeners(0);
          await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 8000) });
          await cdp(ws, 'Runtime.enable', {}, 5000).catch(() => {});
          await cdp(ws, 'Page.navigate', { url: ai.url }, 15000).catch(() => {});
          ws.close();
          await slp(3000);
          ntabs = JSON.parse(await httpG('/json'));
          const navTab = ntabs.filter(t => t.type === 'page' && t.url?.includes(domain)).pop();
          if (navTab) tab = navTab;
        }
      } catch {}
    }
    if (tab) {
      found.push({ ...ai, wsUrl: tab.webSocketDebuggerUrl });
      console.log(' ✅');
    } else {
      console.log(' ⚠️ 找不到标签页');
    }
  }
  // 快速检查页面就绪（最多5秒/个，并行）
  process.stdout.write('  等待加载...');
  await Promise.all(found.map(async f => {
    try {
      const ws = new WebSocket(f.wsUrl); ws.setMaxListeners(0);
      await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 5000) });
      await cdp(ws, 'Runtime.enable', {}, 3000).catch(() => {});
      for (let i = 0; i < 5; i++) {
        const rs = await ev(ws, 'document.readyState', 3000);
        if (rs === 'complete') break;
        await slp(1000);
      }
      ws.close();
    } catch {}
  }));
  await slp(3000);
  console.log(' ✅');
  return found;
}

// ========== AI发送逻辑 ==========
async function sendOne(ai, q) {
  const res = { name: ai.name, wsUrl: ai.wsUrl, sent: false, error: '', beforeBody: '' };
  let ws = null;
  try {
    ws = new WebSocket(ai.wsUrl); ws.setMaxListeners(0);
    await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 10000) });
    await cdp(ws, 'Runtime.enable', {}, 5000).catch(() => {});

    // 等页面加载
    let ready = false;
    for (let i = 0; i < 20; i++) { if ((await ev(ws, 'document.readyState', 5000)) === 'complete') { ready = true; break } await slp(1000) }
    if (!ready) { res.error = '页面加载超时'; return res }
    await slp(4000);

    // CDP防后台节流
    await cdp(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }, 5000).catch(() => {});
    await cdp(ws, 'Page.setWebLifecycleState', { state: 'active' }, 5000).catch(() => {});

    // 检查是否已配置
    const configured = ai.needsRefresh ? false : await ev(ws, "window.__model_configured===true", 3000);

    // === AI特定设置（模型名从 config.json 的 model 字段读取，不再硬编码） ===
    if (ai.name === '千问' && !configured) {
      const modelName = ai.model || 'Qwen3-Max-Thinking';
      // 刷新页面
      await cdp(ws, 'Page.navigate', { url: ai.url }, 15000);
      for (let i = 0; i < 30; i++) { if ((await ev(ws, 'document.readyState', 5000)) === 'complete') break; await slp(1000) }
      await slp(4000);
      // 可见性补丁
      await ev(ws, "(function(){Object.defineProperty(document,'hidden',{get:()=>false});Object.defineProperty(document,'visibilityState',{get:()=>'visible'});var o=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,l,op){if(t==='visibilitychange')return;return o.call(this,t,l,op)}})()", 5000);
      // 关弹窗
      for (let ci = 0; ci < 3; ci++) { const cr = await ev(ws, "(function(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){var t=(btns[i].innerText||'').trim();if((t==='×'||t==='✕'||t==='X')&&btns[i].offsetParent){btns[i].click();return'X'}}var icons=document.querySelectorAll('[data-icon-type=qwpcicon-close]');for(var i=0;i<icons.length;i++){var ic=icons[i];if(ic.offsetParent){var btn=ic.closest('button');if(btn){btn.click();return'ICON'}ic.click();return'ICON_DIRECT'}}return'NONE'})()", 5000); if (cr === 'NONE') break; await slp(500) }
      // 选模型
      await ev(ws, "(function(){var s=document.querySelector('[data-icon-type=qwpcicon-down]');if(s){var b=s.closest('button')||s.parentElement;if(b&&b.click)b.click()}})()", 5000); await slp(1000);
      const qwenSel = await ev(ws, `(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if((e.innerText||'').trim()===${JSON.stringify(modelName)}&&e.offsetParent){e.click();return'selected'}}return'not_found'})()`, 8000); await slp(300);
      if (qwenSel !== 'selected') res.warn = `模型 ${modelName} 未在下拉中找到（可能已更新），使用默认模型`;
      // 开思考
      for (let ti = 0; ti < 3; ti++) { const tk = await ev(ws, "(function(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){if((btns[i].innerText||'').trim()==='思考'&&btns[i].offsetParent){btns[i].click();return'clicked'}}return'NO'})()", 5000); if (tk === 'clicked') break; await slp(300) }
    }

    if (ai.name === 'DeepSeek' && !configured) {
      const ds = await ev(ws, "(function(){var b=Array.from(document.querySelectorAll('.ds-toggle-button')).find(function(x){return(x.innerText||'').trim()==='深度思考'});if(!b)return'NO';return b.getAttribute('aria-pressed')})()", 5000);
      if (ds === 'false') { await ev(ws, "(function(){var b=Array.from(document.querySelectorAll('.ds-toggle-button')).find(function(x){return(x.innerText||'').trim()==='深度思考'});if(b)b.click();return'OK'})()", 5000); await slp(300) }
      const ss = await ev(ws, "(function(){var b=Array.from(document.querySelectorAll('.ds-toggle-button')).find(function(x){return(x.innerText||'').trim()==='智能搜索'});if(!b)return'NO';return b.getAttribute('aria-pressed')})()", 5000);
      if (ss !== 'true') { await ev(ws, "(function(){var b=Array.from(document.querySelectorAll('.ds-toggle-button')).find(function(x){return(x.innerText||'').trim()==='智能搜索'});if(b)b.click();return'OK'})()", 5000); await slp(300) }
      await ev(ws, "window.__model_configured=true", 3000);
    }

    if (ai.name === 'Kimi' && !configured) {
      const modelName = ai.model || 'K2.6 思考';
      await ev(ws, "(function(){var e=document.querySelector('[class*=model-name]');if(e&&e.offsetParent){e.click();return'OK'}return'NO'})()", 5000); await slp(2000);
      const kimiSel = await ev(ws, `(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.children.length===0&&(e.innerText||'').trim()===${JSON.stringify(modelName)}&&e.offsetParent){e.click();return'selected'}}return'not_found'})()`, 8000); await slp(500);
      if (kimiSel !== 'selected') res.warn = `模型 ${modelName} 未找到（可能已更新），使用默认模型`;
      await ev(ws, "window.__model_configured=true", 3000);
    }

    if (ai.name === 'Perplexity' && !configured) {
      const modelName = ai.model || 'GPT-5.4';
      await ev(ws, "(function(){var sel=document.querySelector('[class*=select]');if(sel&&sel.offsetParent&&sel.click){sel.click();return'OK'}return'NO'})()", 5000); await slp(2000);
      const pplxSel = await ev(ws, `(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.children.length===0&&(e.innerText||'').trim().includes(${JSON.stringify(modelName)})&&e.offsetParent){e.click();return'selected'}}return'not_found'})()`, 8000); await slp(500);
      if (pplxSel !== 'selected') res.warn = `模型 ${modelName} 未找到（可能已更新），使用默认模型`;
      await ev(ws, "window.__model_configured=true", 3000);
    }

    // 聚焦输入框
    if (ai.name === '千问') {
      await ev(ws, "(function(){var ces=document.querySelectorAll('[contenteditable=true]');var best=null,maxW=0;for(var i=0;i<ces.length;i++){var ce=ces[i];var side=false,p=ce;for(var j=0;j<5;j++){p=p.parentElement;if(!p)break;if((p.className||'').toLowerCase().includes('sidebar')){side=true;break}}if(side)continue;if(ce.offsetWidth>maxW){maxW=ce.offsetWidth;best=ce}}if(best){best.focus();best.click()}})()", 5000);
    } else {
      const sel = ai.inputType === 'textarea' ? 'textarea' : '[contenteditable=true]';
      for (let fi = 0; fi < 3; fi++) {
        const f = await ev(ws, `(function(){var e=document.querySelector('${sel}');if(!e)return'NO';e.focus();e.click();return'OK'})()`, 5000);
        if (f && f !== 'NO') break;
        const alt = ai.inputType === 'textarea' ? '[contenteditable=true]' : 'textarea';
        const fa = await ev(ws, `(function(){var e=document.querySelector('${alt}');if(!e)return'NO';e.focus();return'OK'})()`, 5000);
        if (fa && fa !== 'NO') break;
        await slp(2000);
      }
    }
    await slp(400);

    // 记录body快照（长度 + 尾部文本），用于增量提取
    const beforeSnapshot = await ev(ws, '(function(){var t=document.body.innerText||"";return t.length+"|"+t.substring(Math.max(0,t.length-100))})()', 5000) || '';
    res.beforeBody = beforeSnapshot;

    // 输入
    await cdp(ws, 'Input.insertText', { text: q }, 8000);
    await slp(500);

    // 发送
    if (ai.name === '千问') {
      await ev(ws, "(function(){var ic=document.querySelector('[data-icon-type=qwpcicon-sendChat]');if(ic){var btn=ic.closest('button');if(btn)btn.click()}})()", 5000);
    } else {
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, 5000).catch(() => {});
      await slp(50);
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, 5000).catch(() => {});
    }
    await slp(1500);

    res.sent = true;
  } catch (e) { res.error = '发送异常:' + (e.message || e) }
  finally { if (ws) try { ws.close() } catch {} }
  return res;
}

// ========== AI提取逻辑 ==========
async function extractOne(ai) {
  const res = { name: ai.name, status: 'error', response: '', duration: 0 };
  const t0 = Date.now();
  let ws = null;
  try {
    ws = new WebSocket(ai.wsUrl); ws.setMaxListeners(0);
    await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 10000) });
    await cdp(ws, 'Runtime.enable', {}, 5000).catch(() => {});
    for (let i = 0; i < 10; i++) { if ((await ev(ws, 'document.readyState', 5000)) === 'complete') break; await slp(1000) }
    await slp(2000);

    // 千问必须bringToFront激活
    if (ai.name === '千问') { await cdp(ws, 'Page.bringToFront', {}, 5000).catch(() => {}); await slp(3000) }

    // 提取函数
    async function tryExtract() {
      let r = '';
      const at = await ev(ws, 'document.body.innerText||""', 8000) || '';

      if (ai.name === '千问') {
        // 先取"深度思考已完成"之后的内容
        const idx = at.indexOf('深度思考已完成');
        if (idx > -1) {
          let after = at.substring(idx + 7);
          // 截到工具栏/模型选择之前就停
          const endMarkers = ['千问 -', '向千问提问', 'Qwen3', '模型', '创建于'];
          let end = after.length;
          for (const m of endMarkers) { const p = after.indexOf(m); if (p > -1 && p < end) end = p; }
          after = after.substring(0, end);
          const lines = after.split('\n').map(l => l.trim()).filter(l => l.length > 15 && !['任务助理','PPT创作','HappyHorse','AI生图','AI写作','录音纪要','内容由AI生成'].some(k => l.includes(k)));
          if (lines.length > 0) r = lines.join('\n').substring(0, 5000);
          if (r.length > 30) return r;
        }
        // 兜底：按body长度截取新增内容
        const beforeLen = parseInt((ai.beforeBody||'').split('|')[0]) || 0;
        if (beforeLen > 0 && at.length > beforeLen + 50) {
          const newPart = at.substring(beforeLen);
          // 去掉最前面的提示词部分（找"各AI回答"为标记，取其之后的长段落）
          const promptEnd = newPart.indexOf('各AI回答');
          const contentPart = promptEnd > -1 ? newPart.substring(promptEnd + 5) : newPart;
          const nps = contentPart.split('\n').map(l => l.trim()).filter(l => l.length > 30 && !['任务助理','PPT创作','HappyHorse','AI生图','AI写作','录音纪要','千问 -','Qwen3','创建于','向千问提问','请综合总结','各AI回答','问题：'].some(k => l.includes(k)));
          // 取最后几个段落（AI回答在末尾）
          if (nps.length > 3) { r = nps.slice(-3).join('\n').substring(0, 5000); return r }
          if (nps.length > 0) { r = nps.join('\n').substring(0, 5000); return r }
        }
        return '';
      }

      // 优先用配置中的 responseClass CSS 选择器提取
      if (ai.responseClass && ai.name !== '千问') {
        const sel = ai.responseClass.replace(/"/g, '\\"');
        const msg = await ev(ws, `(function(){var e=document.querySelectorAll("${sel}");if(!e||!e.length)return'';for(var i=e.length-1;i>=0;i--){var t=(e[i].innerText||'').trim();if(t.length>50)return t.substring(0,5000)}return''})()`, 8000) || '';
        if (msg.length > 50) r = msg;
      }

      // 通用提取（带body快照增量检测）
      let body = await ev(ws, 'document.body.innerText||""', 8000) || '';

      if (ai.name === 'DeepSeek') {
        // DeepSeek: 消息区域
        const msg = await ev(ws, "(function(){var e=document.querySelectorAll('[class*=\"message\"]');if(!e||!e.length)return'';for(var i=e.length-1;i>=0;i--){var t=(e[i].innerText||'').trim();if(t.length>50)return t.substring(0,5000)}return''})()", 8000) || '';
        if (msg.length > 50) r = msg;
      } else if (ai.name === 'ChatGPT') {
        const msg = await ev(ws, "(function(){var e=document.querySelectorAll('[data-message-author-role=\"assistant\"]');if(!e||!e.length)return'';for(var i=e.length-1;i>=0;i--){var t=(e[i].innerText||'').trim();if(t.length>80)return t.substring(0,5000)}return''})()", 8000) || '';
        if (msg.length > 80) {
          // 用beforeBody确认是新内容
          const oldLen = parseInt((ai.beforeBody||'').split('|')[0]) || 0;
          if (body.length > oldLen + 30 || !ai.beforeBody) r = msg;
        }
        // 兜底：从新增body中提取
        if (!r || r.length < 50) {
          const segs = body.split('\n\n').filter(p => p.trim().length > 80 && !p.includes('ChatGPT can make mistakes') && !p.includes('OpenAI'));
          if (segs.length > 0) r = segs[segs.length - 1].substring(0, 5000);
        }
      } else if (ai.name === 'Perplexity') {
        // Perplexity: 用 prose 选择器精准取AI回答区域
        const pp = await ev(ws, "(function(){var e=document.querySelectorAll('[class*=\"prose\"]');if(!e||!e.length)return'';for(var i=e.length-1;i>=0;i--){var t=(e[i].innerText||'').trim();if(t.length>50)return t.substring(0,5000)}return''})()", 8000) || '';
        if (pp.length > 50) r = pp;
      } else if (ai.name === 'Kimi') {
        // Kimi: 暴力枚举长文本叶子元素
        const km = await ev(ws, "(function(){var all=document.querySelectorAll('*');var best='';for(var i=0;i<all.length;i++){var t=(all[i].innerText||'').trim();if(t.length>100&&!t.includes('K2.6')&&!t.includes('{')&&all[i].children.length<5){if(t.length>best.length)best=t}}return best.substring(0,5000)})()", 8000) || '';
        if (km.length > 100 && !km.includes('}')) r = km;
        // 兜底：body长度差值
        if (!r || r.length < 60) {
          const oldLen = parseInt((ai.beforeBody||'').split('|')[0]) || 0;
          if (oldLen > 0 && body.length > oldLen + 30) {
            const np = body.substring(oldLen).split('\n').map(l => l.trim()).filter(l => l.length > 30 && !l.includes('K2.6') && !l.includes('AI-generated'));
            if (np.length > 0) r = np.join('\n').substring(0, 5000);
          }
        }
        // 兜底: body末尾新增内容
        if (!r || r.length < 60) {
          const oldLen = parseInt((ai.beforeBody||'').split('|')[0]) || 0;
          if (body.length > oldLen + 100) {
            const newPart = body.substring(oldLen);
            const np = newPart.split('\n').map(l => l.trim()).filter(l => l.length > 30 && !l.includes('K2.6') && !l.includes('AI-generated'));
            if (np.length > 0) r = np.join('\n').substring(0, 5000);
          }
        }
      }

      if (!r || r.length < 50) {
        const parts = body.split('\n\n').map(p => p.trim()).filter(p => p.length > 40);
        if (parts.length > 0) r = parts[parts.length - 1].substring(0, 5000);
        else { const ls = body.split('\n').filter(l => l.trim().length > 30); if (ls.length > 0) r = ls[ls.length - 1].substring(0, 5000) }
      }
      return r;
    }

    await slp(CONFIG.extraction.initialWaitMs);
    let resp = '', lastContent = '', stableCount = 0;
    const wt = Date.now();
    while (Date.now() - wt < CONFIG.extraction.maxWaitMs) {
      resp = await tryExtract();
      if (resp && resp.length > 30 && !resp.includes('跳至内容') && !resp.includes('历史聊天记录') && !resp.includes('历史会话')) {
        if (resp === lastContent) {
          stableCount++;
          if (stableCount >= CONFIG.extraction.stabilityChecks) break;
        } else { stableCount = 0 }
        lastContent = resp;
      }
      await slp(CONFIG.extraction.checkIntervalMs);
    }
    if (!resp || resp.length <= 30 || stableCount < 1) { resp = await tryExtract(); await slp(2000); const r2 = await tryExtract(); if (r2 && r2.length > resp.length) resp = r2 }

    // 登录页内容过滤：提取到登录/注册引导 → 标记无效并明确提示
    const LOGIN_RE = /log in|sign in|sign up|立即注册|继续使用 Google|继续使用 Apple|解锁.*全部功能|登录.{0,6}解锁/i;
    if (resp && resp.length < 300 && LOGIN_RE.test(resp)) {
      res.status = 'empty';
      res.response = '⚠️ 该网站可能未登录（提取到登录引导内容），请在浏览器中登录后重试';
      res.duration = Date.now() - t0;
      if (ws) try { ws.close() } catch {}
      return res;
    }

    res.status = (resp && resp.length > 30) ? 'success' : 'empty';
    res.response = (resp || '未能获取回复').substring(0, 5000);
    res.duration = Date.now() - t0;
  } catch (e) { res.response = '提取错误:' + (e.message || e); res.duration = Date.now() - t0 }
  finally { if (ws) try { ws.close() } catch {} }
  return res;
}

// ========== 主流程 ==========
async function main() {
  process.stdout.write('[1/3] 浏览器'); await ensureChrome(); console.log('  [1/3] ✅\n');

  console.log('[2/3] 打开 AI 网站...');
  const tabs = await ensureTabs();
  if (tabs.length === 0) { console.log('  ❌ 没有可用的AI标签页'); return }
  console.log(`  → ${tabs.length} 个标签页已就绪\n`);

  // 检测登录（简单检查页面有内容即可）
  console.log('[2.5/3] 检测登录...');
  const okTabs = [];
  for (const t of tabs) {
    let ws = null;
    try {
      ws = new WebSocket(t.wsUrl); ws.setMaxListeners(0);
      await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 8000) });
      await cdp(ws, 'Runtime.enable', {}, 5000).catch(() => {});
      const cfBlocked = await ev(ws, '/verify you are human|checking your browser|just a moment|cf-browser-verification/i.test((document.body.innerText||""))', 5000);
      if (cfBlocked) { console.log(`  [${t.name}] ⚠️ Cloudflare 验证页（请手动过验证后重试）`); continue; }
      const hasBody = (await ev(ws, '(document.body.innerText||"").length', 5000) || 0) > 50;
      // 未登录检测：页面含登录/注册关键词 + 无聊天输入框 → 判定未登录
      const loginHit = await ev(ws, '/log in|sign in|sign up|log in to continue|立即登录|立即注册|继续使用 Google|继续使用 Apple|解锁.*全部功能/i.test((document.body.innerText||""))', 5000);
      const hasChatInput = await ev(ws, '!!(document.querySelector("textarea")||document.querySelector("[contenteditable=true]"))', 5000);
      if (loginHit && !hasChatInput) {
        console.log(`  [${t.name}] ⚠️ 未登录（检测到登录引导页，请在浏览器中登录后重试）`);
        continue;
      }
      console.log(`  [${t.name}] ${hasBody ? '✅' : '⚠️ 内容少'}`);
      if (hasBody) okTabs.push(t);
    } catch { console.log(`  [${t.name}] ❌ 连接失败`) }
    finally { if (ws) try { ws.close() } catch {} }
  }

  if (okTabs.length === 0) { console.log('\n  ❌ 没有可用的AI网站'); return }
  console.log(`\n  ✅ ${okTabs.length} 个网站已登录\n`);

  // 阶段1: 串行发送（失败自动重试 1 次）
  console.log('[3/3] 发送问题...');
  const sendData = [];
  for (let i = 0; i < okTabs.length; i++) {
    process.stdout.write(`  [${i + 1}/${okTabs.length}] ${okTabs[i].name} 发送...`);
    let r = await sendOne(okTabs[i], Q);
    if (!r.sent && r.error) {
      process.stdout.write(' 重试...');
      await slp(2500);
      const r2 = await sendOne(okTabs[i], Q);
      if (r2.sent) { r = r2; console.log(' ✅(重试成功)'); } else { r.error = r2.error || r.error; console.log(' ⚠️ ' + r.error); }
    } else {
      console.log(r.sent ? ' ✅' + (r.warn ? ' (' + r.warn + ')' : '') : ' ⚠️ ' + r.error);
    }
    sendData.push(r);
    await slp(2000);
  }

  // 阶段2: 并行提取
  process.stdout.write('\n  提取回复...');
  const results = await Promise.allSettled(
    sendData.filter(d => d.sent).map(d => extractOne(d))
  );
  const successes = results.filter(r => r.status === 'fulfilled' && r.value.status === 'success').map(r => r.value);
  const failures = results.filter(r => r.status === 'rejected' || r.value.status !== 'success');
  const failedNames = results.map((r, i) => {
    if (r.status === 'rejected') return sendData.filter(d => d.sent)[i]?.name || '?';
    if (r.value.status !== 'success') return r.value.name;
    return null;
  }).filter(Boolean);

  // 输出
  console.log(`\n\n  📊 多AI查询汇总 (V2.1)`);
  console.log('='.repeat(58));
  for (const x of [...successes, ...failures.map((f, i) => f.value || { name: (sendData.filter(d => d.sent)[i]?.name || '?'), status: 'error', response: f.reason || '失败', duration: 0 })]) {
    const ic = x.status === 'success' ? '✅' : '❌';
    console.log(`\n  ${ic} ${x.name}  (${x.duration || 0}ms)`);
    console.log('  ' + '-'.repeat(50));
    console.log(((x.response || '(无)') || '').split('\n').slice(0, 40).map(l => '    ' + l).join('\n'));
    console.log('');
  }
  console.log(`  ✔ ${successes.length} 成功  ✘ ${failures.length} 失败`);
  console.log('='.repeat(58) + '\n');

  // 总结：优先 DeepSeek API（秒回稳定），无 key 或失败时回退网页操作
  if (successes.length > 0) {
    process.stdout.write('  🤖 正在生成综合总结...');
    const summaryPrompt = '请综合总结以下来自不同AI对同一问题的回答，提取共同观点和核心内容，用中文输出一份详细完整的汇总报告：\n\n问题：' + Q + '\n\n各AI回答：\n' + successes.map(x => '--- ' + x.name + ' ---\n' + (x.response || '').substring(0, 1200)).join('\n\n');
    let summaryText = await summaryWithAPI(Q, successes);
    if (summaryText && summaryText.length > 50) {
      console.log(' ✅ (DeepSeek API)\n');
      console.log('  📋 综合总结');
      console.log('  ' + '-'.repeat(58));
      console.log(summaryText.split('\n').map(l => '    ' + l).join('\n'));
    } else {
      // 回退：网页操作 DeepSeek
      console.log(' (API 不可用，回退网页)...');
      const sumTab = okTabs.find(t => t.name === 'DeepSeek') || okTabs[0];
      try {
        const w3 = new WebSocket(sumTab.wsUrl); w3.setMaxListeners(0);
        await new Promise((r2, rej2) => { w3.once('open', r2); w3.once('error', e => rej2(e.message)); setTimeout(() => rej2('超时'), 8000) });
        await cdp(w3, 'Page.bringToFront', {}, 5000).catch(() => {});
        w3.close();
      } catch {}
      const sumRes = await sendOne(sumTab, summaryPrompt);
      if (sumRes.sent) {
        await slp(CONFIG.summary.waitMs);
        const sumExt = await extractOne({ ...sumTab, name: 'DeepSeek', beforeBody: sumRes.beforeBody });
        if (sumExt.status === 'success' && sumExt.response.length > 50) {
          console.log(' ✅\n');
          console.log('  📋 综合总结');
          console.log('  ' + '-'.repeat(58));
          console.log((sumExt.response || '').split('\n').map(l => '    ' + l).join('\n'));
        }
      }
    }
  }

  // 自动禁用持续失败的AI（仅ChatGPT/Perplexity需要外网的）
  const netAIs = failedNames.filter(n => ['ChatGPT', 'Perplexity'].includes(n));
  if (netAIs.length > 0) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    let changed = false;
    for (const name of netAIs) {
      const key = name === 'ChatGPT' ? 'chatgpt' : 'perplexity';
      if (cfg.ais[key] && cfg.ais[key].enabled) {
        cfg.ais[key].enabled = false;
        cfg.ais[key].autoDisabled = true;
        cfg.ais[key].reason = '连续失败，已自动禁用（网络恢复后删除此标记可重新启用）';
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log(`  ⚠️ 已自动禁用: ${netAIs.join(', ')} (config.json 已更新)`);
      console.log('     恢复方法：打开 config.json，将 enabled 改为 true，删除 autoDisabled 标记\n');
    }
  }
}
main().catch(e => { console.error('\n❌', e.message); process.exit(1) });
