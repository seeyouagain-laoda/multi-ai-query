#!/usr/bin/env node
/**
 * Multi-AI Query v2.0 — 模块化重构版
 * 改进：config.json配置、错误隔离、可选AI、外网AI默认禁用
 */
const WebSocket = require('ws');
const http = require('http');
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

// ========== 加载配置 ==========
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
if(!CONFIG) { console.error('❌ 找不到 config.json'); process.exit(1); }

const CDP = CONFIG.browser.cdpPort;
const CHROME = CONFIG.browser.executablePath;
const UDATA = CONFIG.browser.userDataDir;
const Q = process.argv[2] || process.env.QUERY || '你好';

// 获取启用的AI列表（按order排序）
const ENABLED_AIS = Object.values(CONFIG.ais).filter(a => a.enabled).sort((a, b) => (a.order || 99) - (b.order || 99));
if(ENABLED_AIS.length === 0) { console.error('❌ 没有启用的AI，请检查 config.json'); process.exit(1); }

console.log(`\n🔍 多AI查询 V2: "${Q}"`);
console.log(`   启用的AI: ${ENABLED_AIS.map(a => a.name).join(', ')}\n`);

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

// ========== 浏览器管理 ==========
async function ensureChrome() {
  try { await httpG('/json/version'); return }
  catch {}
  process.stdout.write('  [Chrome] 启动中...');
  try { spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' }); await slp(2000) } catch {}
  const urls = ENABLED_AIS.map(a => a.url);
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${UDATA}`, '--no-first-run', '--no-default-browser-check', ...urls], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await slp(1000); try { await httpG('/json/version'); console.log(' ✅'); return } catch {} }
  throw new Error('Chrome启动超时');
}

async function ensureTabs() {
  const found = [];
  const tabs = JSON.parse(await httpG('/json'));
  for (const ai of ENABLED_AIS) {
    const domain = new URL(ai.url).hostname;
    let tab = tabs.filter(t => t.type === 'page' && t.url?.includes(domain)).pop();
    if (!tab) {
      try { await httpPut('/json/new?' + encodeURIComponent(ai.url)); await slp(8000); const ntabs = JSON.parse(await httpG('/json')); tab = ntabs.filter(t => t.type === 'page' && t.url?.includes(domain)).pop() } catch {}
    }
    if (tab) found.push({ ...ai, wsUrl: tab.webSocketDebuggerUrl });
  }
  // 轮询等页面加载
  for (const f of found) {
    try {
      const ws = new WebSocket(f.wsUrl); ws.setMaxListeners(0);
      await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 8000) });
      await cdp(ws, 'Runtime.enable', {}, 3000).catch(() => {});
      for (let i = 0; i < 30; i++) {
        const rs = await ev(ws, 'document.readyState', 3000);
        if (rs === 'complete') {
          const hasInput = !!await ev(ws, "document.querySelector('textarea') || document.querySelector('[contenteditable=true]')", 3000);
          if (hasInput) break;
        }
        await slp(1000);
      }
      ws.close();
    } catch {}
  }
  await slp(3000);
  return found;
}

// ========== AI发送逻辑 ==========
async function sendOne(ai, q) {
  const res = { name: ai.name, wsUrl: ai.wsUrl, sent: false, error: '' };
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

    // === AI特定设置 ===
    if (ai.name === '千问' && !configured) {
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
      await ev(ws, "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if((e.innerText||'').trim()==='Qwen3-Max-Thinking'&&e.offsetParent){e.click();return}})()", 8000); await slp(300);
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
      await ev(ws, "(function(){var e=document.querySelector('[class*=model-name]');if(e&&e.offsetParent){e.click();return'OK'}return'NO'})()", 5000); await slp(2000);
      await ev(ws, "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.children.length===0&&(e.innerText||'').trim()==='K2.6 思考'&&e.offsetParent){e.click();return'selected'}}return'not_found'})()", 8000); await slp(500);
      await ev(ws, "window.__model_configured=true", 3000);
    }

    if (ai.name === 'Perplexity' && !configured) {
      await ev(ws, "(function(){var sel=document.querySelector('[class*=select]');if(sel&&sel.offsetParent&&sel.click){sel.click();return'OK'}return'NO'})()", 5000); await slp(2000);
      await ev(ws, "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.children.length===0&&(e.innerText||'').trim().includes('GPT-5.4')&&e.offsetParent){e.click();return'selected'}}return'not_found'})()", 8000); await slp(500);
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
      if (ai.name === '千问') {
        const at = await ev(ws, 'document.body.innerText||""', 8000) || '';
        const idx = at.indexOf('深度思考已完成');
        if (idx > -1) {
          const after = at.substring(idx + 7);
          const lines = after.split('\n').map(l => l.trim()).filter(l => l.length > 10 && !['任务助理', 'PPT创作', 'HappyHorse', 'AI生图', 'AI写作', '录音纪要', '内容由AI生成'].some(k => l.includes(k)));
          if (lines.length > 0) r = lines.join('\n').substring(0, 5000);
          if (r.length > 10) return r;
        }
        // 兜底
        const parts = at.split('\n').map(l => l.trim()).filter(l => l.length > 40 && !['任务助理', 'PPT创作', 'HappyHorse', 'AI生图', 'AI写作', '录音纪要'].some(k => l.includes(k)));
        for (let i = parts.length - 1; i >= 0; i--) { if (parts[i].length > 30 && parts[i] !== '千问 - 阿里旗下全能AI助手') { r = parts[i]; return r } }
        return '';
      }
      // 通用提取
      const body = await ev(ws, 'document.body.innerText||""', 8000) || '';
      const parts = body.split('\n\n').map(p => p.trim()).filter(p => p.length > 40 && !p.includes('跳至内容') && !p.includes('历史聊天记录') && !p.includes('历史会话'));
      if (parts.length > 0) r = parts[parts.length - 1].substring(0, 5000);
      else { const ls = body.split('\n').filter(l => l.trim().length > 30); if (ls.length > 0) r = ls[ls.length - 1].substring(0, 5000) }
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

  // 检测登录
  console.log('[2.5/3] 检测登录...');
  const okTabs = [];
  for (const t of tabs) {
    let ws = null;
    try {
      ws = new WebSocket(t.wsUrl); ws.setMaxListeners(0);
      await new Promise((r, rej) => { ws.once('open', r); ws.once('error', e => rej(e.message)); setTimeout(() => rej('超时'), 8000) });
      await cdp(ws, 'Runtime.enable', {}, 5000).catch(() => {});
      const hasInput = !!await ev(ws, "document.querySelector('textarea') || document.querySelector('[contenteditable=true]')", 5000);
      console.log(`  [${t.name}] ${hasInput ? '✅' : '❌ 需登录'}`);
      if (hasInput) okTabs.push(t);
    } catch { console.log(`  [${t.name}] ❌ 连接失败`) }
    finally { if (ws) try { ws.close() } catch {} }
  }

  if (okTabs.length === 0) { console.log('\n  ❌ 没有可用的AI网站'); return }
  console.log(`\n  ✅ ${okTabs.length} 个网站已登录\n`);

  // 阶段1: 串行发送
  console.log('[3/3] 发送问题...');
  const sendData = [];
  for (let i = 0; i < okTabs.length; i++) {
    process.stdout.write(`  [${i + 1}/${okTabs.length}] ${okTabs[i].name} 发送...`);
    const r = await sendOne(okTabs[i], Q);
    sendData.push(r);
    await slp(2000);
    console.log(r.sent ? ' ✅' : ' ⚠️ ' + r.error);
  }

  // 阶段2: 并行提取
  process.stdout.write('\n  提取回复...');
  const results = await Promise.allSettled(
    sendData.filter(d => d.sent).map(d => extractOne(d))
  );
  const successes = results.filter(r => r.status === 'fulfilled' && r.value.status === 'success').map(r => r.value);
  const failures = results.filter(r => r.status === 'rejected' || r.value.status !== 'success');

  // 输出
  console.log(`\n\n  📊 多AI查询汇总 (V2)`);
  console.log('='.repeat(58));
  for (const x of [...successes, ...failures.map(f => f.value || { name: '?', status: 'error', response: '失败', duration: 0 })]) {
    const ic = x.status === 'success' ? '✅' : '❌';
    console.log(`\n  ${ic} ${x.name}  (${x.duration || 0}ms)`);
    console.log('  ' + '-'.repeat(50));
    console.log(((x.response || '(无)') || '').split('\n').slice(0, 40).map(l => '    ' + l).join('\n'));
    console.log('');
  }
  console.log(`  ✔ ${successes.length} 成功  ✘ ${failures.length} 失败`);
  console.log('='.repeat(58) + '\n');

  // 总结（用千问，如果可用）
  if (successes.length > 0) {
    const qwTab = okTabs.find(t => t.name === '千问') || okTabs[0];
    process.stdout.write('  🤖 正在生成综合总结...');
    const summaryPrompt = '请综合总结以下来自不同AI对同一问题的回答，提取共同观点和核心内容，用中文输出一份详细完整的汇总报告：\n\n问题：' + Q + '\n\n各AI回答：\n' + successes.map(x => '--- ' + x.name + ' ---\n' + (x.response || '').substring(0, 1200)).join('\n\n');
    try {
      const w3 = new WebSocket(qwTab.wsUrl); w3.setMaxListeners(0);
      await new Promise((r2, rej2) => { w3.once('open', r2); w3.once('error', e => rej2(e.message)); setTimeout(() => rej2('超时'), 8000) });
      await cdp(w3, 'Page.bringToFront', {}, 5000).catch(() => {});
      w3.close();
    } catch {}
    const sumRes = await sendOne(qwTab, summaryPrompt);
    if (sumRes.sent) {
      await slp(CONFIG.summary.waitMs);
      const sumExt = await extractOne({ ...qwTab, name: '总结' });
      if (sumExt.status === 'success' && sumExt.response.length > 50) {
        console.log(' ✅\n');
        console.log('  📋 综合总结');
        console.log('  ' + '-'.repeat(58));
        console.log((sumExt.response || '').split('\n').map(l => '    ' + l).join('\n'));
      }
    }
  }
}
main().catch(e => { console.error('\n❌', e.message); process.exit(1) });
