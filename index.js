/*
 * Vercel AI Gateway 助手  for SillyTavern
 * --------------------------------------------------
 * 1. 一键勾选 providerOptions / reasoning / caching，写入"包含主体参数"
 * 2. 内置主流模型预设（默认只连官方供应商，可自行编辑）
 * 3. Key 池：单加 / 批量加 / 余额查询 / 判活 / 自动轮询 / 垃圾盒
 *
 * 判活规则:
 *   200 + 余额充足  -> alive
 *   200 + 余额低    -> lowbalance
 *   401 / 403       -> dead   (进垃圾盒)
 *   429             -> ratelimited (临时跳过, 不进垃圾盒)
 *   5xx / 网络错误  -> error  (临时跳过, 不进垃圾盒)
 *   其他非2xx       -> dead   (进垃圾盒)
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';

const MODULE = 'vercel_gateway_helper';
const GATEWAY_BASE = 'https://ai-gateway.vercel.sh/v1';

// ---------- 默认配置 ----------
// 默认只列官方供应商；如需多家可在面板里点 ⚙ 编辑预设
const DEFAULT_PRESETS = {
    'Gemini':   { providers: ['google'],    defaultOrder: ['google'] },
    'Claude':   { providers: ['anthropic'], defaultOrder: ['anthropic'] },
    'GPT':      { providers: ['openai'],    defaultOrder: ['openai'] },
    'DeepSeek': { providers: ['deepseek'],  defaultOrder: ['deepseek'] },
    'GLM':      { providers: ['zai'],       defaultOrder: ['zai'] },
    'Qwen':     { providers: ['alibaba'],   defaultOrder: ['alibaba'] },
};

const EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const DEFAULT_SETTINGS = {
    activeModel: 'Gemini',
    selectedProviders: ['google'],
    routeMode: 'only',            // 默认 only：要么官方要么不用
    enableReasoning: false,
    reasoningEffort: 'medium',
    useMaxTokensInsteadOfEffort: false,
    reasoningMaxTokens: 0,
    enableCaching: false,
    cachingMode: 'auto',
    keys: [],                     // [{id, name, key, balance, totalUsed, status, lastErr, lastCheck, paused, trashed, lastUsed}]
    minBalance: 0.10,
    rotationEnabled: false,
    rotationCursor: 0,
    presets: DEFAULT_PRESETS,
};

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    // per-key 字段迁移
    for (const k of s.keys) {
        if (k.trashed === undefined) k.trashed = false;
        if (k.status === undefined) k.status = 'unknown';
    }
    return s;
}

function save() { saveSettingsDebounced(); }

// ---------- providerOptions 构造 ----------
function buildBodyParams() {
    const s = getSettings();
    const out = {};

    const providers = s.selectedProviders.filter(Boolean);
    if (providers.length > 0) {
        const gw = {};
        if (s.routeMode === 'only') gw.only = providers;
        else gw.order = providers;
        if (s.enableCaching) gw.caching = s.cachingMode || 'auto';
        out.providerOptions = { gateway: gw };
    } else if (s.enableCaching) {
        out.providerOptions = { gateway: { caching: s.cachingMode || 'auto' } };
    }

    if (s.enableReasoning) {
        const r = { enabled: true };
        if (s.useMaxTokensInsteadOfEffort && s.reasoningMaxTokens > 0) {
            r.max_tokens = Number(s.reasoningMaxTokens);
        } else {
            r.effort = s.reasoningEffort || 'medium';
        }
        out.reasoning = r;
    }

    return out;
}

function applyToCustomBody() {
    const json = buildBodyParams();
    if (Object.keys(json).length === 0) {
        toast('当前没有任何要写入的参数', 'warning');
        return;
    }
    const textarea = document.querySelector('#custom_include_body');
    if (!textarea) {
        toast('找不到 #custom_include_body，请先在 API 面板选 "Chat Completion → Custom"', 'error');
        return;
    }
    textarea.value = JSON.stringify(json, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    toast('已写入 包含主体参数', 'success');
}

function copyJsonToClipboard() {
    const text = JSON.stringify(buildBodyParams(), null, 2);
    navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error'),
    );
}

// ---------- 余额 / 判活 ----------
async function fetchCredits(apiKey) {
    let resp;
    try {
        resp = await fetch(`${GATEWAY_BASE}/credits`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (netErr) {
        const e = new Error('网络错误: ' + (netErr.message || netErr));
        e.kind = 'network';
        throw e;
    }
    const text = await resp.text();
    if (!resp.ok) {
        const e = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        e.status = resp.status;
        throw e;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回不是 JSON: ' + text.slice(0, 100)); }
    const balance = parseFloat(String(data.balance ?? '').trim());
    const totalUsed = parseFloat(String(data.total_used ?? '').trim());
    if (Number.isNaN(balance) || Number.isNaN(totalUsed)) {
        throw new Error('balance / total_used 解析失败');
    }
    return { balance, totalUsed };
}

async function checkOneKey(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.lastCheck = Date.now();
    k.status = 'checking';
    renderKeyTable();
    try {
        const { balance, totalUsed } = await fetchCredits(k.key);
        k.balance = balance;
        k.totalUsed = totalUsed;
        k.lastErr = '';
        k.status = balance >= s.minBalance ? 'alive' : 'lowbalance';
        // 检查通过后从垃圾盒拉回来（万一是手动放进去的）
        if (k.trashed) k.trashed = false;
    } catch (e) {
        k.lastErr = String(e.message || e);
        const status = e.status || 0;
        if (status === 401 || status === 403) {
            // 真死：未授权 / 禁止
            k.status = 'dead';
            k.trashed = true;
        } else if (status === 429) {
            // 卡了，不是死
            k.status = 'ratelimited';
        } else if (status >= 500 || e.kind === 'network') {
            // 上游或网络问题，不是 key 的锅
            k.status = 'error';
        } else {
            // 其他非 2xx：保守判死
            k.status = 'dead';
            k.trashed = true;
        }
    }
    save();
    renderKeyTable();
}

async function checkAllKeys(includeTrash = false) {
    const s = getSettings();
    const targets = s.keys.filter(k => includeTrash || !k.trashed);
    if (targets.length === 0) { toast('没有可检查的 key', 'warning'); return; }
    toast(`正在检查 ${targets.length} 个 key…`, 'info');
    const POOL = 5;
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
        while (queue.length) {
            const k = queue.shift();
            await checkOneKey(k.id);
        }
    });
    await Promise.all(workers);
    toast('检查完成', 'success');
}

// ---------- 轮询 ----------
function pickNextAliveKey() {
    const s = getSettings();
    // 可用：未暂停 + 没进垃圾盒 + 状态是 alive 或 unknown
    const alive = s.keys.filter(k =>
        !k.paused && !k.trashed && (k.status === 'alive' || k.status === 'unknown')
    );
    if (alive.length === 0) return null;
    const start = s.rotationCursor % alive.length;
    s.rotationCursor = (start + 1) % alive.length;
    save();
    return alive[start];
}

async function writeApiKeyToST(apiKey) {
    try {
        await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', value: apiKey }),
        });
    } catch (e) {
        console.error('[VercelHelper] writeSecret 失败', e);
    }
}

async function rotateNow() {
    const k = pickNextAliveKey();
    if (!k) { toast('没有可用的活 key', 'error'); return null; }
    await writeApiKeyToST(k.key);
    k.lastUsed = Date.now();
    save();
    renderKeyTable();
    return k;
}

async function onGenerationHook() {
    const s = getSettings();
    if (!s.rotationEnabled || s.keys.length === 0) return;
    const k = pickNextAliveKey();
    if (!k) { console.warn('[VercelHelper] 轮询：没有活 key'); return; }
    await writeApiKeyToST(k.key);
    console.log(`[VercelHelper] 轮询切到: ${k.name}`);
}

// ---------- Key 池增删 ----------
function makeKey(name, apiKey) {
    return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        key: apiKey.trim(),
        balance: 0,
        totalUsed: 0,
        status: 'unknown',
        lastErr: '',
        lastCheck: 0,
        paused: false,
        trashed: false,
        lastUsed: 0,
    };
}

function addKey(name, apiKey) {
    const s = getSettings();
    name = (name || '').trim();
    apiKey = (apiKey || '').trim();
    if (!name || !apiKey) { toast('名称和 key 都要填', 'warning'); return; }
    if (s.keys.some(k => k.name === name)) { toast('名称重复', 'warning'); return; }
    s.keys.push(makeKey(name, apiKey));
    save();
    renderKeyTable();
}

function batchImport(text) {
    // 一行一个：name=key 或 name,key 或 纯 key（自动取名）
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast('没有输入内容', 'warning'); return; }
    const s = getSettings();
    let added = 0, dup = 0;
    for (const line of lines) {
        let name, key;
        const m = line.match(/^([^=,\s]+)\s*[=,]\s*(.+)$/);
        if (m) { name = m[1].trim(); key = m[2].trim(); }
        else { key = line; name = `key_${s.keys.length + added + 1}`; }
        if (!key) continue;
        if (s.keys.some(k => k.key === key)) { dup++; continue; }
        // 自动改名避免重复
        let finalName = name, n = 1;
        while (s.keys.some(k => k.name === finalName)) { finalName = `${name}_${++n}`; }
        s.keys.push(makeKey(finalName, key));
        added++;
    }
    save();
    renderKeyTable();
    toast(`新增 ${added} 个，跳过重复 ${dup} 个`, 'success');
}

function removeKey(id) {
    const s = getSettings();
    s.keys = s.keys.filter(k => k.id !== id);
    save();
    renderKeyTable();
}

function togglePause(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.paused = !k.paused;
    save();
    renderKeyTable();
}

function restoreFromTrash(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.trashed = false;
    k.status = 'unknown';
    k.lastErr = '';
    save();
    renderKeyTable();
}

function emptyTrash() {
    const s = getSettings();
    const before = s.keys.length;
    s.keys = s.keys.filter(k => !k.trashed);
    save();
    renderKeyTable();
    toast(`已清空 ${before - s.keys.length} 个`, 'success');
}

// ---------- UI ----------
function toast(msg, kind = 'info') {
    if (window.toastr) {
        (window.toastr[kind] || window.toastr.info)(msg, 'Vercel Helper');
    } else {
        console.log('[VercelHelper]', msg);
    }
}

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildHTML() {
    const s = getSettings();
    const presetOptions = Object.keys(s.presets).map(name =>
        `<option value="${name}" ${name === s.activeModel ? 'selected' : ''}>${name}</option>`
    ).join('');
    const effortRadios = EFFORT_OPTIONS.map(opt =>
        `<label class="vgh-radio"><input type="radio" name="vgh-effort" value="${opt}" ${opt === s.reasoningEffort ? 'checked' : ''}/> ${opt}</label>`
    ).join('');

    return `
    <div id="vgh-panel" class="vgh-root">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Vercel AI Gateway 助手</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <div class="vgh-section">
            <div class="vgh-title">1. 模型预设 / 供应商勾选</div>
            <div class="vgh-row">
              <label>模型族</label>
              <select id="vgh-model-select">${presetOptions}</select>
              <button class="menu_button" id="vgh-edit-presets" title="编辑预设 JSON">⚙ 编辑预设</button>
            </div>
            <div class="vgh-preset-editor" id="vgh-preset-editor" style="display:none">
              <textarea id="vgh-preset-text" rows="10" placeholder='{"模型族": {"providers": [...], "defaultOrder": [...]}}'></textarea>
              <div class="vgh-row">
                <button class="menu_button" id="vgh-preset-save">保存</button>
                <button class="menu_button" id="vgh-preset-cancel">取消</button>
                <button class="menu_button" id="vgh-preset-reset">恢复默认</button>
              </div>
            </div>
            <div class="vgh-row">
              <label>路由模式</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="order" ${s.routeMode === 'order' ? 'checked' : ''}/> order（按序回退）</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="only" ${s.routeMode === 'only' ? 'checked' : ''}/> only（只用这些）</label>
            </div>
            <div class="vgh-row vgh-providers" id="vgh-providers"></div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">2. 思考模式 (reasoning)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-reasoning" ${s.enableReasoning ? 'checked' : ''}/> 开启思考</label>
            </div>
            <div class="vgh-row">${effortRadios}</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-use-maxtok" ${s.useMaxTokensInsteadOfEffort ? 'checked' : ''}/> 改用 max_tokens（与 effort 互斥）</label>
              <input type="number" id="vgh-maxtok" min="0" step="64" value="${s.reasoningMaxTokens || 0}" style="width:110px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">3. 缓存 (caching)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-cache" ${s.enableCaching ? 'checked' : ''}/> 开启缓存（Anthropic 等需要主动开）</label>
              <input type="text" id="vgh-cache-mode" value="${s.cachingMode || 'auto'}" style="width:90px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">4. 生成 JSON</div>
            <pre id="vgh-preview" class="vgh-preview"></pre>
            <div class="vgh-row">
              <button class="menu_button" id="vgh-apply">写入"包含主体参数"</button>
              <button class="menu_button" id="vgh-copy">复制 JSON</button>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">5. Key 池 / 余额 / 轮询</div>

            <div class="vgh-row">
              <input type="text" id="vgh-newname" placeholder="名称"/>
              <input type="text" id="vgh-newkey" placeholder="vercel ai gateway key"/>
              <button class="menu_button" id="vgh-add">添加</button>
            </div>

            <details class="vgh-batch-details">
              <summary>批量添加</summary>
              <div class="vgh-batch-body">
                <textarea id="vgh-batch-text" rows="6" placeholder="每行一个：&#10;name=vck-xxxx&#10;name,vck-xxxx&#10;vck-xxxx       (无名则自动取名)"></textarea>
                <button class="menu_button" id="vgh-batch-go">导入</button>
              </div>
            </details>

            <div class="vgh-row">
              <button class="menu_button" id="vgh-checkall">检查全部余额</button>
              <button class="menu_button" id="vgh-rotate">手动轮询一次</button>
            </div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-rot-enable" ${s.rotationEnabled ? 'checked' : ''}/> 自动轮询（每次生成前切下一个活 key）</label>
            </div>
            <div class="vgh-row">
              <label>余额阈值（&lt; 此值视为低）</label>
              <input type="number" id="vgh-minbal" min="0" step="0.01" value="${s.minBalance}" style="width:90px"/>
            </div>

            <div id="vgh-keytable-wrap"></div>
            <div id="vgh-trash-wrap"></div>
          </div>

        </div>
      </div>
    </div>`;
}

const STATUS_META = {
    alive:       { cls: 'vgh-ok',    text: '正常' },
    lowbalance:  { cls: 'vgh-warn',  text: '余额低' },
    ratelimited: { cls: 'vgh-warn',  text: '限流(429)' },
    error:       { cls: 'vgh-warn',  text: '上游错误' },
    dead:        { cls: 'vgh-bad',   text: '死' },
    checking:    { cls: 'vgh-muted', text: '检查中…' },
    unknown:     { cls: 'vgh-muted', text: '未检查' },
};

function renderProviderCheckboxes() {
    const s = getSettings();
    const preset = s.presets[s.activeModel];
    const wrap = document.getElementById('vgh-providers');
    if (!wrap || !preset) return;
    wrap.innerHTML = preset.providers.map(p => {
        const checked = s.selectedProviders.includes(p) ? 'checked' : '';
        return `<label class="vgh-checkbox vgh-provider"><input type="checkbox" data-prov="${p}" ${checked}/> ${p}</label>`;
    }).join('');
    wrap.querySelectorAll('input[data-prov]').forEach(cb => {
        cb.addEventListener('change', () => {
            const prov = cb.dataset.prov;
            const set = new Set(getSettings().selectedProviders);
            if (cb.checked) set.add(prov); else set.delete(prov);
            getSettings().selectedProviders = preset.providers.filter(p => set.has(p));
            save();
            renderPreview();
        });
    });
}

function renderPreview() {
    const pre = document.getElementById('vgh-preview');
    if (!pre) return;
    pre.textContent = JSON.stringify(buildBodyParams(), null, 2) || '{}';
}

function rowFor(k, isTrash) {
    const meta = STATUS_META[k.status] || STATUS_META.unknown;
    const statusText = k.paused ? '暂停' : meta.text;
    const last = k.lastCheck ? new Date(k.lastCheck).toLocaleTimeString() : '-';
    const actions = isTrash
        ? `<button class="menu_button vgh-mini" data-act="restore" data-id="${k.id}">恢复</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删除</button>`
        : `<button class="menu_button vgh-mini" data-act="check" data-id="${k.id}">查</button>
           <button class="menu_button vgh-mini" data-act="pause" data-id="${k.id}">${k.paused ? '恢复' : '停'}</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删</button>`;
    return `<tr>
      <td>${escapeHtml(k.name)}</td>
      <td>$${(k.balance || 0).toFixed(2)}</td>
      <td>$${(k.totalUsed || 0).toFixed(2)}</td>
      <td class="${meta.cls}">${statusText}</td>
      <td class="vgh-muted">${last}</td>
      <td class="vgh-bad vgh-errcell">${escapeHtml(k.lastErr || '')}</td>
      <td>${actions}</td>
    </tr>`;
}

function renderKeyTable() {
    const wrap = document.getElementById('vgh-keytable-wrap');
    const trashWrap = document.getElementById('vgh-trash-wrap');
    if (!wrap || !trashWrap) return;

    const s = getSettings();
    const active = s.keys.filter(k => !k.trashed);
    const trashed = s.keys.filter(k => k.trashed);

    // 活动 key 表
    if (active.length === 0) {
        wrap.innerHTML = '<div class="vgh-muted">（暂无 key）</div>';
    } else {
        const rows = active.map(k => rowFor(k, false)).join('');
        wrap.innerHTML = `<table class="vgh-table"><thead><tr>
            <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
          </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // 垃圾盒
    if (trashed.length === 0) {
        trashWrap.innerHTML = '';
    } else {
        const rows = trashed.map(k => rowFor(k, true)).join('');
        trashWrap.innerHTML = `
          <details class="vgh-trash-details">
            <summary>🗑 垃圾盒 (${trashed.length})</summary>
            <div class="vgh-row" style="margin-top:6px">
              <button class="menu_button vgh-mini" id="vgh-empty-trash">清空垃圾盒</button>
            </div>
            <table class="vgh-table"><thead><tr>
                <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
              </tr></thead><tbody>${rows}</tbody></table>
          </details>`;
        document.getElementById('vgh-empty-trash')?.addEventListener('click', () => {
            if (confirm('彻底删除垃圾盒里所有 key？此操作不可恢复。')) emptyTrash();
        });
    }

    // 绑定行内按钮
    [wrap, trashWrap].forEach(container => {
        container.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const act = btn.dataset.act;
                if (act === 'check') checkOneKey(id);
                else if (act === 'pause') togglePause(id);
                else if (act === 'restore') restoreFromTrash(id);
                else if (act === 'del') {
                    if (confirm('确定删除这个 key?')) removeKey(id);
                }
            });
        });
    });
}

function bindEvents() {
    const s = getSettings();

    document.getElementById('vgh-model-select')?.addEventListener('change', e => {
        s.activeModel = e.target.value;
        const p = s.presets[s.activeModel];
        s.selectedProviders = (p?.defaultOrder || []).slice();
        save();
        renderProviderCheckboxes();
        renderPreview();
    });

    document.querySelectorAll('input[name="vgh-route"]').forEach(r => {
        r.addEventListener('change', e => { s.routeMode = e.target.value; save(); renderPreview(); });
    });

    document.getElementById('vgh-reasoning')?.addEventListener('change', e => {
        s.enableReasoning = e.target.checked; save(); renderPreview();
    });
    document.querySelectorAll('input[name="vgh-effort"]').forEach(r => {
        r.addEventListener('change', e => { s.reasoningEffort = e.target.value; save(); renderPreview(); });
    });
    document.getElementById('vgh-use-maxtok')?.addEventListener('change', e => {
        s.useMaxTokensInsteadOfEffort = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-maxtok')?.addEventListener('input', e => {
        s.reasoningMaxTokens = parseInt(e.target.value || '0', 10) || 0; save(); renderPreview();
    });

    document.getElementById('vgh-cache')?.addEventListener('change', e => {
        s.enableCaching = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-cache-mode')?.addEventListener('input', e => {
        s.cachingMode = e.target.value || 'auto'; save(); renderPreview();
    });

    document.getElementById('vgh-apply')?.addEventListener('click', applyToCustomBody);
    document.getElementById('vgh-copy')?.addEventListener('click', copyJsonToClipboard);

    document.getElementById('vgh-add')?.addEventListener('click', () => {
        const name = document.getElementById('vgh-newname').value;
        const key = document.getElementById('vgh-newkey').value;
        addKey(name, key);
        document.getElementById('vgh-newname').value = '';
        document.getElementById('vgh-newkey').value = '';
    });
    document.getElementById('vgh-batch-go')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-batch-text');
        if (!ta) return;
        batchImport(ta.value);
        ta.value = '';
    });
    document.getElementById('vgh-checkall')?.addEventListener('click', () => checkAllKeys(false));
    document.getElementById('vgh-rotate')?.addEventListener('click', async () => {
        const k = await rotateNow();
        if (k) toast(`已切到: ${k.name}`, 'success');
    });
    document.getElementById('vgh-rot-enable')?.addEventListener('change', e => {
        s.rotationEnabled = e.target.checked; save();
        toast(s.rotationEnabled ? '自动轮询已开启' : '自动轮询已关闭', 'info');
    });
    document.getElementById('vgh-minbal')?.addEventListener('input', e => {
        s.minBalance = parseFloat(e.target.value || '0') || 0; save();
    });

    document.getElementById('vgh-edit-presets')?.addEventListener('click', () => {
        const editor = document.getElementById('vgh-preset-editor');
        const ta = document.getElementById('vgh-preset-text');
        if (!editor || !ta) return;
        if (editor.style.display === 'none') {
            ta.value = JSON.stringify(s.presets, null, 2);
            editor.style.display = 'block';
        } else {
            editor.style.display = 'none';
        }
    });
    document.getElementById('vgh-preset-save')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-preset-text');
        if (!ta) return;
        try {
            const parsed = JSON.parse(ta.value);
            s.presets = parsed;
            // 当前选中的模型族如果被删了，回退到第一个
            if (!s.presets[s.activeModel]) {
                s.activeModel = Object.keys(s.presets)[0] || '';
                s.selectedProviders = (s.presets[s.activeModel]?.defaultOrder || []).slice();
            }
            save();
            const sel = document.getElementById('vgh-model-select');
            if (sel) {
                sel.innerHTML = Object.keys(s.presets).map(n =>
                    `<option value="${n}" ${n === s.activeModel ? 'selected' : ''}>${n}</option>`).join('');
            }
            renderProviderCheckboxes();
            renderPreview();
            document.getElementById('vgh-preset-editor').style.display = 'none';
            toast('预设已保存', 'success');
        } catch (e) {
            toast('JSON 解析失败: ' + e.message, 'error');
        }
    });
    document.getElementById('vgh-preset-cancel')?.addEventListener('click', () => {
        document.getElementById('vgh-preset-editor').style.display = 'none';
    });
    document.getElementById('vgh-preset-reset')?.addEventListener('click', () => {
        if (!confirm('恢复内置预设？将覆盖当前的编辑内容。')) return;
        const ta = document.getElementById('vgh-preset-text');
        if (ta) ta.value = JSON.stringify(DEFAULT_PRESETS, null, 2);
    });
}

// ---------- 入口 ----------
jQuery(async () => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        console.error('[VercelHelper] 找不到扩展设置容器');
        return;
    }
    host.appendChild(el(buildHTML()));

    renderProviderCheckboxes();
    renderPreview();
    renderKeyTable();
    bindEvents();

    try {
        const evt = event_types?.GENERATE_BEFORE_COMBINE_PROMPTS
            || event_types?.GENERATION_STARTED
            || 'GENERATION_STARTED';
        eventSource.on(evt, onGenerationHook);
        console.log('[VercelHelper] 已挂钩事件:', evt);
    } catch (e) {
        console.error('[VercelHelper] 挂钩事件失败', e);
    }

    console.log('[VercelHelper] 加载完成');
});
    activeModel: 'Gemini',
    selectedProviders: ['google'],
    routeMode: 'only',            // 默认 only：要么官方要么不用
    enableReasoning: false,
    reasoningEffort: 'medium',
    useMaxTokensInsteadOfEffort: false,
    reasoningMaxTokens: 0,
    enableCaching: false,
    cachingMode: 'auto',
    keys: [],                     // [{id, name, key, balance, totalUsed, status, lastErr, lastCheck, paused, trashed, lastUsed}]
    minBalance: 0.10,
    rotationEnabled: false,
    rotationCursor: 0,
    presets: DEFAULT_PRESETS,
};

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    // per-key 字段迁移
    for (const k of s.keys) {
        if (k.trashed === undefined) k.trashed = false;
        if (k.status === undefined) k.status = 'unknown';
    }
    return s;
}

function save() { saveSettingsDebounced(); }

// ---------- providerOptions 构造 ----------
function buildBodyParams() {
    const s = getSettings();
    const out = {};

    const providers = s.selectedProviders.filter(Boolean);
    if (providers.length > 0) {
        const gw = {};
        if (s.routeMode === 'only') gw.only = providers;
        else gw.order = providers;
        if (s.enableCaching) gw.caching = s.cachingMode || 'auto';
        out.providerOptions = { gateway: gw };
    } else if (s.enableCaching) {
        out.providerOptions = { gateway: { caching: s.cachingMode || 'auto' } };
    }

    if (s.enableReasoning) {
        const r = { enabled: true };
        if (s.useMaxTokensInsteadOfEffort && s.reasoningMaxTokens > 0) {
            r.max_tokens = Number(s.reasoningMaxTokens);
        } else {
            r.effort = s.reasoningEffort || 'medium';
        }
        out.reasoning = r;
    }

    return out;
}

function applyToCustomBody() {
    const json = buildBodyParams();
    if (Object.keys(json).length === 0) {
        toast('当前没有任何要写入的参数', 'warning');
        return;
    }
    const textarea = document.querySelector('#custom_include_body');
    if (!textarea) {
        toast('找不到 #custom_include_body，请先在 API 面板选 "Chat Completion → Custom"', 'error');
        return;
    }
    textarea.value = JSON.stringify(json, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    toast('已写入 包含主体参数', 'success');
}

function copyJsonToClipboard() {
    const text = JSON.stringify(buildBodyParams(), null, 2);
    navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error'),
    );
}

// ---------- 余额 / 判活 ----------
async function fetchCredits(apiKey) {
    let resp;
    try {
        resp = await fetch(`${GATEWAY_BASE}/credits`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (netErr) {
        const e = new Error('网络错误: ' + (netErr.message || netErr));
        e.kind = 'network';
        throw e;
    }
    const text = await resp.text();
    if (!resp.ok) {
        const e = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        e.status = resp.status;
        throw e;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回不是 JSON: ' + text.slice(0, 100)); }
    const balance = parseFloat(String(data.balance ?? '').trim());
    const totalUsed = parseFloat(String(data.total_used ?? '').trim());
    if (Number.isNaN(balance) || Number.isNaN(totalUsed)) {
        throw new Error('balance / total_used 解析失败');
    }
    return { balance, totalUsed };
}

async function checkOneKey(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.lastCheck = Date.now();
    k.status = 'checking';
    renderKeyTable();
    try {
        const { balance, totalUsed } = await fetchCredits(k.key);
        k.balance = balance;
        k.totalUsed = totalUsed;
        k.lastErr = '';
        k.status = balance >= s.minBalance ? 'alive' : 'lowbalance';
        // 检查通过后从垃圾盒拉回来（万一是手动放进去的）
        if (k.trashed) k.trashed = false;
    } catch (e) {
        k.lastErr = String(e.message || e);
        const status = e.status || 0;
        if (status === 401 || status === 403) {
            // 真死：未授权 / 禁止
            k.status = 'dead';
            k.trashed = true;
        } else if (status === 429) {
            // 卡了，不是死
            k.status = 'ratelimited';
        } else if (status >= 500 || e.kind === 'network') {
            // 上游或网络问题，不是 key 的锅
            k.status = 'error';
        } else {
            // 其他非 2xx：保守判死
            k.status = 'dead';
            k.trashed = true;
        }
    }
    save();
    renderKeyTable();
}

async function checkAllKeys(includeTrash = false) {
    const s = getSettings();
    const targets = s.keys.filter(k => includeTrash || !k.trashed);
    if (targets.length === 0) { toast('没有可检查的 key', 'warning'); return; }
    toast(`正在检查 ${targets.length} 个 key…`, 'info');
    const POOL = 5;
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
        while (queue.length) {
            const k = queue.shift();
            await checkOneKey(k.id);
        }
    });
    await Promise.all(workers);
    toast('检查完成', 'success');
}

// ---------- 轮询 ----------
function pickNextAliveKey() {
    const s = getSettings();
    // 可用：未暂停 + 没进垃圾盒 + 状态是 alive 或 unknown
    const alive = s.keys.filter(k =>
        !k.paused && !k.trashed && (k.status === 'alive' || k.status === 'unknown')
    );
    if (alive.length === 0) return null;
    const start = s.rotationCursor % alive.length;
    s.rotationCursor = (start + 1) % alive.length;
    save();
    return alive[start];
}

async function writeApiKeyToST(apiKey) {
    try {
        await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', value: apiKey }),
        });
    } catch (e) {
        console.error('[VercelHelper] writeSecret 失败', e);
    }
}

async function rotateNow() {
    const k = pickNextAliveKey();
    if (!k) { toast('没有可用的活 key', 'error'); return null; }
    await writeApiKeyToST(k.key);
    k.lastUsed = Date.now();
    save();
    renderKeyTable();
    return k;
}

async function onGenerationHook() {
    const s = getSettings();
    if (!s.rotationEnabled || s.keys.length === 0) return;
    const k = pickNextAliveKey();
    if (!k) { console.warn('[VercelHelper] 轮询：没有活 key'); return; }
    await writeApiKeyToST(k.key);
    console.log(`[VercelHelper] 轮询切到: ${k.name}`);
}

// ---------- Key 池增删 ----------
function makeKey(name, apiKey) {
    return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        key: apiKey.trim(),
        balance: 0,
        totalUsed: 0,
        status: 'unknown',
        lastErr: '',
        lastCheck: 0,
        paused: false,
        trashed: false,
        lastUsed: 0,
    };
}

function addKey(name, apiKey) {
    const s = getSettings();
    name = (name || '').trim();
    apiKey = (apiKey || '').trim();
    if (!name || !apiKey) { toast('名称和 key 都要填', 'warning'); return; }
    if (s.keys.some(k => k.name === name)) { toast('名称重复', 'warning'); return; }
    s.keys.push(makeKey(name, apiKey));
    save();
    renderKeyTable();
}

function batchImport(text) {
    // 一行一个：name=key 或 name,key 或 纯 key（自动取名）
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast('没有输入内容', 'warning'); return; }
    const s = getSettings();
    let added = 0, dup = 0;
    for (const line of lines) {
        let name, key;
        const m = line.match(/^([^=,\s]+)\s*[=,]\s*(.+)$/);
        if (m) { name = m[1].trim(); key = m[2].trim(); }
        else { key = line; name = `key_${s.keys.length + added + 1}`; }
        if (!key) continue;
        if (s.keys.some(k => k.key === key)) { dup++; continue; }
        // 自动改名避免重复
        let finalName = name, n = 1;
        while (s.keys.some(k => k.name === finalName)) { finalName = `${name}_${++n}`; }
        s.keys.push(makeKey(finalName, key));
        added++;
    }
    save();
    renderKeyTable();
    toast(`新增 ${added} 个，跳过重复 ${dup} 个`, 'success');
}

function removeKey(id) {
    const s = getSettings();
    s.keys = s.keys.filter(k => k.id !== id);
    save();
    renderKeyTable();
}

function togglePause(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.paused = !k.paused;
    save();
    renderKeyTable();
}

function restoreFromTrash(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.trashed = false;
    k.status = 'unknown';
    k.lastErr = '';
    save();
    renderKeyTable();
}

function emptyTrash() {
    const s = getSettings();
    const before = s.keys.length;
    s.keys = s.keys.filter(k => !k.trashed);
    save();
    renderKeyTable();
    toast(`已清空 ${before - s.keys.length} 个`, 'success');
}

// ---------- UI ----------
function toast(msg, kind = 'info') {
    if (window.toastr) {
        (window.toastr[kind] || window.toastr.info)(msg, 'Vercel Helper');
    } else {
        console.log('[VercelHelper]', msg);
    }
}

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildHTML() {
    const s = getSettings();
    const presetOptions = Object.keys(s.presets).map(name =>
        `<option value="${name}" ${name === s.activeModel ? 'selected' : ''}>${name}</option>`
    ).join('');
    const effortRadios = EFFORT_OPTIONS.map(opt =>
        `<label class="vgh-radio"><input type="radio" name="vgh-effort" value="${opt}" ${opt === s.reasoningEffort ? 'checked' : ''}/> ${opt}</label>`
    ).join('');

    return `
    <div id="vgh-panel" class="vgh-root">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Vercel AI Gateway 助手</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <div class="vgh-section">
            <div class="vgh-title">1. 模型预设 / 供应商勾选</div>
            <div class="vgh-row">
              <label>模型族</label>
              <select id="vgh-model-select">${presetOptions}</select>
              <button class="menu_button" id="vgh-edit-presets" title="编辑预设 JSON">⚙ 编辑预设</button>
            </div>
            <div class="vgh-preset-editor" id="vgh-preset-editor" style="display:none">
              <textarea id="vgh-preset-text" rows="10" placeholder='{"模型族": {"providers": [...], "defaultOrder": [...]}}'></textarea>
              <div class="vgh-row">
                <button class="menu_button" id="vgh-preset-save">保存</button>
                <button class="menu_button" id="vgh-preset-cancel">取消</button>
                <button class="menu_button" id="vgh-preset-reset">恢复默认</button>
              </div>
            </div>
            <div class="vgh-row">
              <label>路由模式</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="order" ${s.routeMode === 'order' ? 'checked' : ''}/> order（按序回退）</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="only" ${s.routeMode === 'only' ? 'checked' : ''}/> only（只用这些）</label>
            </div>
            <div class="vgh-row vgh-providers" id="vgh-providers"></div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">2. 思考模式 (reasoning)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-reasoning" ${s.enableReasoning ? 'checked' : ''}/> 开启思考</label>
            </div>
            <div class="vgh-row">${effortRadios}</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-use-maxtok" ${s.useMaxTokensInsteadOfEffort ? 'checked' : ''}/> 改用 max_tokens（与 effort 互斥）</label>
              <input type="number" id="vgh-maxtok" min="0" step="64" value="${s.reasoningMaxTokens || 0}" style="width:110px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">3. 缓存 (caching)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-cache" ${s.enableCaching ? 'checked' : ''}/> 开启缓存（Anthropic 等需要主动开）</label>
              <input type="text" id="vgh-cache-mode" value="${s.cachingMode || 'auto'}" style="width:90px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">4. 生成 JSON</div>
            <pre id="vgh-preview" class="vgh-preview"></pre>
            <div class="vgh-row">
              <button class="menu_button" id="vgh-apply">写入"包含主体参数"</button>
              <button class="menu_button" id="vgh-copy">复制 JSON</button>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">5. Key 池 / 余额 / 轮询</div>

            <div class="vgh-row">
              <input type="text" id="vgh-newname" placeholder="名称"/>
              <input type="text" id="vgh-newkey" placeholder="vercel ai gateway key"/>
              <button class="menu_button" id="vgh-add">添加</button>
            </div>

            <details class="vgh-batch-details">
              <summary>批量添加</summary>
              <div class="vgh-batch-body">
                <textarea id="vgh-batch-text" rows="6" placeholder="每行一个：&#10;name=vck-xxxx&#10;name,vck-xxxx&#10;vck-xxxx       (无名则自动取名)"></textarea>
                <button class="menu_button" id="vgh-batch-go">导入</button>
              </div>
            </details>

            <div class="vgh-row">
              <button class="menu_button" id="vgh-checkall">检查全部余额</button>
              <button class="menu_button" id="vgh-rotate">手动轮询一次</button>
            </div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-rot-enable" ${s.rotationEnabled ? 'checked' : ''}/> 自动轮询（每次生成前切下一个活 key）</label>
            </div>
            <div class="vgh-row">
              <label>余额阈值（&lt; 此值视为低）</label>
              <input type="number" id="vgh-minbal" min="0" step="0.01" value="${s.minBalance}" style="width:90px"/>
            </div>

            <div id="vgh-keytable-wrap"></div>
            <div id="vgh-trash-wrap"></div>
          </div>

        </div>
      </div>
    </div>`;
}

const STATUS_META = {
    alive:       { cls: 'vgh-ok',    text: '正常' },
    lowbalance:  { cls: 'vgh-warn',  text: '余额低' },
    ratelimited: { cls: 'vgh-warn',  text: '限流(429)' },
    error:       { cls: 'vgh-warn',  text: '上游错误' },
    dead:        { cls: 'vgh-bad',   text: '死' },
    checking:    { cls: 'vgh-muted', text: '检查中…' },
    unknown:     { cls: 'vgh-muted', text: '未检查' },
};

function renderProviderCheckboxes() {
    const s = getSettings();
    const preset = s.presets[s.activeModel];
    const wrap = document.getElementById('vgh-providers');
    if (!wrap || !preset) return;
    wrap.innerHTML = preset.providers.map(p => {
        const checked = s.selectedProviders.includes(p) ? 'checked' : '';
        return `<label class="vgh-checkbox vgh-provider"><input type="checkbox" data-prov="${p}" ${checked}/> ${p}</label>`;
    }).join('');
    wrap.querySelectorAll('input[data-prov]').forEach(cb => {
        cb.addEventListener('change', () => {
            const prov = cb.dataset.prov;
            const set = new Set(getSettings().selectedProviders);
            if (cb.checked) set.add(prov); else set.delete(prov);
            getSettings().selectedProviders = preset.providers.filter(p => set.has(p));
            save();
            renderPreview();
        });
    });
}

function renderPreview() {
    const pre = document.getElementById('vgh-preview');
    if (!pre) return;
    pre.textContent = JSON.stringify(buildBodyParams(), null, 2) || '{}';
}

function rowFor(k, isTrash) {
    const meta = STATUS_META[k.status] || STATUS_META.unknown;
    const statusText = k.paused ? '暂停' : meta.text;
    const last = k.lastCheck ? new Date(k.lastCheck).toLocaleTimeString() : '-';
    const actions = isTrash
        ? `<button class="menu_button vgh-mini" data-act="restore" data-id="${k.id}">恢复</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删除</button>`
        : `<button class="menu_button vgh-mini" data-act="check" data-id="${k.id}">查</button>
           <button class="menu_button vgh-mini" data-act="pause" data-id="${k.id}">${k.paused ? '恢复' : '停'}</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删</button>`;
    return `<tr>
      <td>${escapeHtml(k.name)}</td>
      <td>$${(k.balance || 0).toFixed(2)}</td>
      <td>$${(k.totalUsed || 0).toFixed(2)}</td>
      <td class="${meta.cls}">${statusText}</td>
      <td class="vgh-muted">${last}</td>
      <td class="vgh-bad vgh-errcell">${escapeHtml(k.lastErr || '')}</td>
      <td>${actions}</td>
    </tr>`;
}

function renderKeyTable() {
    const wrap = document.getElementById('vgh-keytable-wrap');
    const trashWrap = document.getElementById('vgh-trash-wrap');
    if (!wrap || !trashWrap) return;

    const s = getSettings();
    const active = s.keys.filter(k => !k.trashed);
    const trashed = s.keys.filter(k => k.trashed);

    // 活动 key 表
    if (active.length === 0) {
        wrap.innerHTML = '<div class="vgh-muted">（暂无 key）</div>';
    } else {
        const rows = active.map(k => rowFor(k, false)).join('');
        wrap.innerHTML = `<table class="vgh-table"><thead><tr>
            <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
          </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // 垃圾盒
    if (trashed.length === 0) {
        trashWrap.innerHTML = '';
    } else {
        const rows = trashed.map(k => rowFor(k, true)).join('');
        trashWrap.innerHTML = `
          <details class="vgh-trash-details">
            <summary>🗑 垃圾盒 (${trashed.length})</summary>
            <div class="vgh-row" style="margin-top:6px">
              <button class="menu_button vgh-mini" id="vgh-empty-trash">清空垃圾盒</button>
            </div>
            <table class="vgh-table"><thead><tr>
                <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
              </tr></thead><tbody>${rows}</tbody></table>
          </details>`;
        document.getElementById('vgh-empty-trash')?.addEventListener('click', () => {
            if (confirm('彻底删除垃圾盒里所有 key？此操作不可恢复。')) emptyTrash();
        });
    }

    // 绑定行内按钮
    [wrap, trashWrap].forEach(container => {
        container.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const act = btn.dataset.act;
                if (act === 'check') checkOneKey(id);
                else if (act === 'pause') togglePause(id);
                else if (act === 'restore') restoreFromTrash(id);
                else if (act === 'del') {
                    if (confirm('确定删除这个 key?')) removeKey(id);
                }
            });
        });
    });
}

function bindEvents() {
    const s = getSettings();

    document.getElementById('vgh-model-select')?.addEventListener('change', e => {
        s.activeModel = e.target.value;
        const p = s.presets[s.activeModel];
        s.selectedProviders = (p?.defaultOrder || []).slice();
        save();
        renderProviderCheckboxes();
        renderPreview();
    });

    document.querySelectorAll('input[name="vgh-route"]').forEach(r => {
        r.addEventListener('change', e => { s.routeMode = e.target.value; save(); renderPreview(); });
    });

    document.getElementById('vgh-reasoning')?.addEventListener('change', e => {
        s.enableReasoning = e.target.checked; save(); renderPreview();
    });
    document.querySelectorAll('input[name="vgh-effort"]').forEach(r => {
        r.addEventListener('change', e => { s.reasoningEffort = e.target.value; save(); renderPreview(); });
    });
    document.getElementById('vgh-use-maxtok')?.addEventListener('change', e => {
        s.useMaxTokensInsteadOfEffort = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-maxtok')?.addEventListener('input', e => {
        s.reasoningMaxTokens = parseInt(e.target.value || '0', 10) || 0; save(); renderPreview();
    });

    document.getElementById('vgh-cache')?.addEventListener('change', e => {
        s.enableCaching = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-cache-mode')?.addEventListener('input', e => {
        s.cachingMode = e.target.value || 'auto'; save(); renderPreview();
    });

    document.getElementById('vgh-apply')?.addEventListener('click', applyToCustomBody);
    document.getElementById('vgh-copy')?.addEventListener('click', copyJsonToClipboard);

    document.getElementById('vgh-add')?.addEventListener('click', () => {
        const name = document.getElementById('vgh-newname').value;
        const key = document.getElementById('vgh-newkey').value;
        addKey(name, key);
        document.getElementById('vgh-newname').value = '';
        document.getElementById('vgh-newkey').value = '';
    });
    document.getElementById('vgh-batch-go')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-batch-text');
        if (!ta) return;
        batchImport(ta.value);
        ta.value = '';
    });
    document.getElementById('vgh-checkall')?.addEventListener('click', () => checkAllKeys(false));
    document.getElementById('vgh-rotate')?.addEventListener('click', async () => {
        const k = await rotateNow();
        if (k) toast(`已切到: ${k.name}`, 'success');
    });
    document.getElementById('vgh-rot-enable')?.addEventListener('change', e => {
        s.rotationEnabled = e.target.checked; save();
        toast(s.rotationEnabled ? '自动轮询已开启' : '自动轮询已关闭', 'info');
    });
    document.getElementById('vgh-minbal')?.addEventListener('input', e => {
        s.minBalance = parseFloat(e.target.value || '0') || 0; save();
    });

    document.getElementById('vgh-edit-presets')?.addEventListener('click', () => {
        const editor = document.getElementById('vgh-preset-editor');
        const ta = document.getElementById('vgh-preset-text');
        if (!editor || !ta) return;
        if (editor.style.display === 'none') {
            ta.value = JSON.stringify(s.presets, null, 2);
            editor.style.display = 'block';
        } else {
            editor.style.display = 'none';
        }
    });
    document.getElementById('vgh-preset-save')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-preset-text');
        if (!ta) return;
        try {
            const parsed = JSON.parse(ta.value);
            s.presets = parsed;
            // 当前选中的模型族如果被删了，回退到第一个
            if (!s.presets[s.activeModel]) {
                s.activeModel = Object.keys(s.presets)[0] || '';
                s.selectedProviders = (s.presets[s.activeModel]?.defaultOrder || []).slice();
            }
            save();
            const sel = document.getElementById('vgh-model-select');
            if (sel) {
                sel.innerHTML = Object.keys(s.presets).map(n =>
                    `<option value="${n}" ${n === s.activeModel ? 'selected' : ''}>${n}</option>`).join('');
            }
            renderProviderCheckboxes();
            renderPreview();
            document.getElementById('vgh-preset-editor').style.display = 'none';
            toast('预设已保存', 'success');
        } catch (e) {
            toast('JSON 解析失败: ' + e.message, 'error');
        }
    });
    document.getElementById('vgh-preset-cancel')?.addEventListener('click', () => {
        document.getElementById('vgh-preset-editor').style.display = 'none';
    });
    document.getElementById('vgh-preset-reset')?.addEventListener('click', () => {
        if (!confirm('恢复内置预设？将覆盖当前的编辑内容。')) return;
        const ta = document.getElementById('vgh-preset-text');
        if (ta) ta.value = JSON.stringify(DEFAULT_PRESETS, null, 2);
    });
}

// ---------- 入口 ----------
jQuery(async () => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        console.error('[VercelHelper] 找不到扩展设置容器');
        return;
    }
    host.appendChild(el(buildHTML()));

    renderProviderCheckboxes();
    renderPreview();
    renderKeyTable();
    bindEvents();

    try {
        const evt = event_types?.GENERATE_BEFORE_COMBINE_PROMPTS
            || event_types?.GENERATION_STARTED
            || 'GENERATION_STARTED';
        eventSource.on(evt, onGenerationHook);
        console.log('[VercelHelper] 已挂钩事件:', evt);
    } catch (e) {
        console.error('[VercelHelper] 挂钩事件失败', e);
    }

    console.log('[VercelHelper] 加载完成');
});
    activeModel: 'Gemini',
    selectedProviders: ['google'],
    routeMode: 'only',            // 默认 only：要么官方要么不用
    enableReasoning: false,
    reasoningEffort: 'medium',
    useMaxTokensInsteadOfEffort: false,
    reasoningMaxTokens: 0,
    enableCaching: false,
    cachingMode: 'auto',
    keys: [],                     // [{id, name, key, balance, totalUsed, status, lastErr, lastCheck, paused, trashed, lastUsed}]
    minBalance: 0.10,
    rotationEnabled: false,
    rotationCursor: 0,
    presets: DEFAULT_PRESETS,
};

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    // per-key 字段迁移
    for (const k of s.keys) {
        if (k.trashed === undefined) k.trashed = false;
        if (k.status === undefined) k.status = 'unknown';
    }
    return s;
}

function save() { saveSettingsDebounced(); }

// ---------- providerOptions 构造 ----------
function buildBodyParams() {
    const s = getSettings();
    const out = {};

    const providers = s.selectedProviders.filter(Boolean);
    if (providers.length > 0) {
        const gw = {};
        if (s.routeMode === 'only') gw.only = providers;
        else gw.order = providers;
        if (s.enableCaching) gw.caching = s.cachingMode || 'auto';
        out.providerOptions = { gateway: gw };
    } else if (s.enableCaching) {
        out.providerOptions = { gateway: { caching: s.cachingMode || 'auto' } };
    }

    if (s.enableReasoning) {
        const r = { enabled: true };
        if (s.useMaxTokensInsteadOfEffort && s.reasoningMaxTokens > 0) {
            r.max_tokens = Number(s.reasoningMaxTokens);
        } else {
            r.effort = s.reasoningEffort || 'medium';
        }
        out.reasoning = r;
    }

    return out;
}

function applyToCustomBody() {
    const json = buildBodyParams();
    if (Object.keys(json).length === 0) {
        toast('当前没有任何要写入的参数', 'warning');
        return;
    }
    const textarea = document.querySelector('#custom_include_body');
    if (!textarea) {
        toast('找不到 #custom_include_body，请先在 API 面板选 "Chat Completion → Custom"', 'error');
        return;
    }
    textarea.value = JSON.stringify(json, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    toast('已写入 包含主体参数', 'success');
}

function copyJsonToClipboard() {
    const text = JSON.stringify(buildBodyParams(), null, 2);
    navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error'),
    );
}

// ---------- 余额 / 判活 ----------
async function fetchCredits(apiKey) {
    let resp;
    try {
        resp = await fetch(`${GATEWAY_BASE}/credits`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (netErr) {
        const e = new Error('网络错误: ' + (netErr.message || netErr));
        e.kind = 'network';
        throw e;
    }
    const text = await resp.text();
    if (!resp.ok) {
        const e = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        e.status = resp.status;
        throw e;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回不是 JSON: ' + text.slice(0, 100)); }
    const balance = parseFloat(String(data.balance ?? '').trim());
    const totalUsed = parseFloat(String(data.total_used ?? '').trim());
    if (Number.isNaN(balance) || Number.isNaN(totalUsed)) {
        throw new Error('balance / total_used 解析失败');
    }
    return { balance, totalUsed };
}

async function checkOneKey(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.lastCheck = Date.now();
    k.status = 'checking';
    renderKeyTable();
    try {
        const { balance, totalUsed } = await fetchCredits(k.key);
        k.balance = balance;
        k.totalUsed = totalUsed;
        k.lastErr = '';
        k.status = balance >= s.minBalance ? 'alive' : 'lowbalance';
        // 检查通过后从垃圾盒拉回来（万一是手动放进去的）
        if (k.trashed) k.trashed = false;
    } catch (e) {
        k.lastErr = String(e.message || e);
        const status = e.status || 0;
        if (status === 401 || status === 403) {
            // 真死：未授权 / 禁止
            k.status = 'dead';
            k.trashed = true;
        } else if (status === 429) {
            // 卡了，不是死
            k.status = 'ratelimited';
        } else if (status >= 500 || e.kind === 'network') {
            // 上游或网络问题，不是 key 的锅
            k.status = 'error';
        } else {
            // 其他非 2xx：保守判死
            k.status = 'dead';
            k.trashed = true;
        }
    }
    save();
    renderKeyTable();
}

async function checkAllKeys(includeTrash = false) {
    const s = getSettings();
    const targets = s.keys.filter(k => includeTrash || !k.trashed);
    if (targets.length === 0) { toast('没有可检查的 key', 'warning'); return; }
    toast(`正在检查 ${targets.length} 个 key…`, 'info');
    const POOL = 5;
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
        while (queue.length) {
            const k = queue.shift();
            await checkOneKey(k.id);
        }
    });
    await Promise.all(workers);
    toast('检查完成', 'success');
}

// ---------- 轮询 ----------
function pickNextAliveKey() {
    const s = getSettings();
    // 可用：未暂停 + 没进垃圾盒 + 状态是 alive 或 unknown
    const alive = s.keys.filter(k =>
        !k.paused && !k.trashed && (k.status === 'alive' || k.status === 'unknown')
    );
    if (alive.length === 0) return null;
    const start = s.rotationCursor % alive.length;
    s.rotationCursor = (start + 1) % alive.length;
    save();
    return alive[start];
}

async function writeApiKeyToST(apiKey) {
    try {
        await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', value: apiKey }),
        });
    } catch (e) {
        console.error('[VercelHelper] writeSecret 失败', e);
    }
}

async function rotateNow() {
    const k = pickNextAliveKey();
    if (!k) { toast('没有可用的活 key', 'error'); return null; }
    await writeApiKeyToST(k.key);
    k.lastUsed = Date.now();
    save();
    renderKeyTable();
    return k;
}

async function onGenerationHook() {
    const s = getSettings();
    if (!s.rotationEnabled || s.keys.length === 0) return;
    const k = pickNextAliveKey();
    if (!k) { console.warn('[VercelHelper] 轮询：没有活 key'); return; }
    await writeApiKeyToST(k.key);
    console.log(`[VercelHelper] 轮询切到: ${k.name}`);
}

// ---------- Key 池增删 ----------
function makeKey(name, apiKey) {
    return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        key: apiKey.trim(),
        balance: 0,
        totalUsed: 0,
        status: 'unknown',
        lastErr: '',
        lastCheck: 0,
        paused: false,
        trashed: false,
        lastUsed: 0,
    };
}

function addKey(name, apiKey) {
    const s = getSettings();
    name = (name || '').trim();
    apiKey = (apiKey || '').trim();
    if (!name || !apiKey) { toast('名称和 key 都要填', 'warning'); return; }
    if (s.keys.some(k => k.name === name)) { toast('名称重复', 'warning'); return; }
    s.keys.push(makeKey(name, apiKey));
    save();
    renderKeyTable();
}

function batchImport(text) {
    // 一行一个：name=key 或 name,key 或 纯 key（自动取名）
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast('没有输入内容', 'warning'); return; }
    const s = getSettings();
    let added = 0, dup = 0;
    for (const line of lines) {
        let name, key;
        const m = line.match(/^([^=,\s]+)\s*[=,]\s*(.+)$/);
        if (m) { name = m[1].trim(); key = m[2].trim(); }
        else { key = line; name = `key_${s.keys.length + added + 1}`; }
        if (!key) continue;
        if (s.keys.some(k => k.key === key)) { dup++; continue; }
        // 自动改名避免重复
        let finalName = name, n = 1;
        while (s.keys.some(k => k.name === finalName)) { finalName = `${name}_${++n}`; }
        s.keys.push(makeKey(finalName, key));
        added++;
    }
    save();
    renderKeyTable();
    toast(`新增 ${added} 个，跳过重复 ${dup} 个`, 'success');
}

function removeKey(id) {
    const s = getSettings();
    s.keys = s.keys.filter(k => k.id !== id);
    save();
    renderKeyTable();
}

function togglePause(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.paused = !k.paused;
    save();
    renderKeyTable();
}

function restoreFromTrash(id) {
    const s = getSettings();
    const k = s.keys.find(x => x.id === id);
    if (!k) return;
    k.trashed = false;
    k.status = 'unknown';
    k.lastErr = '';
    save();
    renderKeyTable();
}

function emptyTrash() {
    const s = getSettings();
    const before = s.keys.length;
    s.keys = s.keys.filter(k => !k.trashed);
    save();
    renderKeyTable();
    toast(`已清空 ${before - s.keys.length} 个`, 'success');
}

// ---------- UI ----------
function toast(msg, kind = 'info') {
    if (window.toastr) {
        (window.toastr[kind] || window.toastr.info)(msg, 'Vercel Helper');
    } else {
        console.log('[VercelHelper]', msg);
    }
}

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildHTML() {
    const s = getSettings();
    const presetOptions = Object.keys(s.presets).map(name =>
        `<option value="${name}" ${name === s.activeModel ? 'selected' : ''}>${name}</option>`
    ).join('');
    const effortRadios = EFFORT_OPTIONS.map(opt =>
        `<label class="vgh-radio"><input type="radio" name="vgh-effort" value="${opt}" ${opt === s.reasoningEffort ? 'checked' : ''}/> ${opt}</label>`
    ).join('');

    return `
    <div id="vgh-panel" class="vgh-root">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Vercel AI Gateway 助手</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <div class="vgh-section">
            <div class="vgh-title">1. 模型预设 / 供应商勾选</div>
            <div class="vgh-row">
              <label>模型族</label>
              <select id="vgh-model-select">${presetOptions}</select>
              <button class="menu_button" id="vgh-edit-presets" title="编辑预设 JSON">⚙</button>
            </div>
            <div class="vgh-row">
              <label>路由模式</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="order" ${s.routeMode === 'order' ? 'checked' : ''}/> order（按序回退）</label>
              <label class="vgh-radio"><input type="radio" name="vgh-route" value="only" ${s.routeMode === 'only' ? 'checked' : ''}/> only（只用这些）</label>
            </div>
            <div class="vgh-row vgh-providers" id="vgh-providers"></div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">2. 思考模式 (reasoning)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-reasoning" ${s.enableReasoning ? 'checked' : ''}/> 开启思考</label>
            </div>
            <div class="vgh-row">${effortRadios}</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-use-maxtok" ${s.useMaxTokensInsteadOfEffort ? 'checked' : ''}/> 改用 max_tokens（与 effort 互斥）</label>
              <input type="number" id="vgh-maxtok" min="0" step="64" value="${s.reasoningMaxTokens || 0}" style="width:110px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">3. 缓存 (caching)</div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-cache" ${s.enableCaching ? 'checked' : ''}/> 开启缓存（Anthropic 等需要主动开）</label>
              <input type="text" id="vgh-cache-mode" value="${s.cachingMode || 'auto'}" style="width:90px"/>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">4. 生成 JSON</div>
            <pre id="vgh-preview" class="vgh-preview"></pre>
            <div class="vgh-row">
              <button class="menu_button" id="vgh-apply">写入"包含主体参数"</button>
              <button class="menu_button" id="vgh-copy">复制 JSON</button>
            </div>
          </div>

          <div class="vgh-section">
            <div class="vgh-title">5. Key 池 / 余额 / 轮询</div>

            <div class="vgh-row">
              <input type="text" id="vgh-newname" placeholder="名称"/>
              <input type="text" id="vgh-newkey" placeholder="vercel ai gateway key"/>
              <button class="menu_button" id="vgh-add">添加</button>
            </div>

            <details class="vgh-batch-details">
              <summary>批量添加</summary>
              <div class="vgh-batch-body">
                <textarea id="vgh-batch-text" rows="6" placeholder="每行一个：&#10;name=vck-xxxx&#10;name,vck-xxxx&#10;vck-xxxx       (无名则自动取名)"></textarea>
                <button class="menu_button" id="vgh-batch-go">导入</button>
              </div>
            </details>

            <div class="vgh-row">
              <button class="menu_button" id="vgh-checkall">检查全部余额</button>
              <button class="menu_button" id="vgh-rotate">手动轮询一次</button>
            </div>
            <div class="vgh-row">
              <label class="vgh-checkbox"><input type="checkbox" id="vgh-rot-enable" ${s.rotationEnabled ? 'checked' : ''}/> 自动轮询（每次生成前切下一个活 key）</label>
            </div>
            <div class="vgh-row">
              <label>余额阈值（&lt; 此值视为低）</label>
              <input type="number" id="vgh-minbal" min="0" step="0.01" value="${s.minBalance}" style="width:90px"/>
            </div>

            <div id="vgh-keytable-wrap"></div>
            <div id="vgh-trash-wrap"></div>
          </div>

        </div>
      </div>
    </div>`;
}

const STATUS_META = {
    alive:       { cls: 'vgh-ok',    text: '正常' },
    lowbalance:  { cls: 'vgh-warn',  text: '余额低' },
    ratelimited: { cls: 'vgh-warn',  text: '限流(429)' },
    error:       { cls: 'vgh-warn',  text: '上游错误' },
    dead:        { cls: 'vgh-bad',   text: '死' },
    checking:    { cls: 'vgh-muted', text: '检查中…' },
    unknown:     { cls: 'vgh-muted', text: '未检查' },
};

function renderProviderCheckboxes() {
    const s = getSettings();
    const preset = s.presets[s.activeModel];
    const wrap = document.getElementById('vgh-providers');
    if (!wrap || !preset) return;
    wrap.innerHTML = preset.providers.map(p => {
        const checked = s.selectedProviders.includes(p) ? 'checked' : '';
        return `<label class="vgh-checkbox vgh-provider"><input type="checkbox" data-prov="${p}" ${checked}/> ${p}</label>`;
    }).join('');
    wrap.querySelectorAll('input[data-prov]').forEach(cb => {
        cb.addEventListener('change', () => {
            const prov = cb.dataset.prov;
            const set = new Set(getSettings().selectedProviders);
            if (cb.checked) set.add(prov); else set.delete(prov);
            getSettings().selectedProviders = preset.providers.filter(p => set.has(p));
            save();
            renderPreview();
        });
    });
}

function renderPreview() {
    const pre = document.getElementById('vgh-preview');
    if (!pre) return;
    pre.textContent = JSON.stringify(buildBodyParams(), null, 2) || '{}';
}

function rowFor(k, isTrash) {
    const meta = STATUS_META[k.status] || STATUS_META.unknown;
    const statusText = k.paused ? '暂停' : meta.text;
    const last = k.lastCheck ? new Date(k.lastCheck).toLocaleTimeString() : '-';
    const actions = isTrash
        ? `<button class="menu_button vgh-mini" data-act="restore" data-id="${k.id}">恢复</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删除</button>`
        : `<button class="menu_button vgh-mini" data-act="check" data-id="${k.id}">查</button>
           <button class="menu_button vgh-mini" data-act="pause" data-id="${k.id}">${k.paused ? '恢复' : '停'}</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删</button>`;
    return `<tr>
      <td>${escapeHtml(k.name)}</td>
      <td>$${(k.balance || 0).toFixed(2)}</td>
      <td>$${(k.totalUsed || 0).toFixed(2)}</td>
      <td class="${meta.cls}">${statusText}</td>
      <td class="vgh-muted">${last}</td>
      <td class="vgh-bad vgh-errcell">${escapeHtml(k.lastErr || '')}</td>
      <td>${actions}</td>
    </tr>`;
}

function renderKeyTable() {
    const wrap = document.getElementById('vgh-keytable-wrap');
    const trashWrap = document.getElementById('vgh-trash-wrap');
    if (!wrap || !trashWrap) return;

    const s = getSettings();
    const active = s.keys.filter(k => !k.trashed);
    const trashed = s.keys.filter(k => k.trashed);

    // 活动 key 表
    if (active.length === 0) {
        wrap.innerHTML = '<div class="vgh-muted">（暂无 key）</div>';
    } else {
        const rows = active.map(k => rowFor(k, false)).join('');
        wrap.innerHTML = `<table class="vgh-table"><thead><tr>
            <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
          </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // 垃圾盒
    if (trashed.length === 0) {
        trashWrap.innerHTML = '';
    } else {
        const rows = trashed.map(k => rowFor(k, true)).join('');
        trashWrap.innerHTML = `
          <details class="vgh-trash-details">
            <summary>🗑 垃圾盒 (${trashed.length})</summary>
            <div class="vgh-row" style="margin-top:6px">
              <button class="menu_button vgh-mini" id="vgh-empty-trash">清空垃圾盒</button>
            </div>
            <table class="vgh-table"><thead><tr>
                <th>名称</th><th>余额</th><th>累计</th><th>状态</th><th>上次</th><th>错误</th><th>操作</th>
              </tr></thead><tbody>${rows}</tbody></table>
          </details>`;
        document.getElementById('vgh-empty-trash')?.addEventListener('click', () => {
            if (confirm('彻底删除垃圾盒里所有 key？此操作不可恢复。')) emptyTrash();
        });
    }

    // 绑定行内按钮
    [wrap, trashWrap].forEach(container => {
        container.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const act = btn.dataset.act;
                if (act === 'check') checkOneKey(id);
                else if (act === 'pause') togglePause(id);
                else if (act === 'restore') restoreFromTrash(id);
                else if (act === 'del') {
                    if (confirm('确定删除这个 key?')) removeKey(id);
                }
            });
        });
    });
}

function bindEvents() {
    const s = getSettings();

    document.getElementById('vgh-model-select')?.addEventListener('change', e => {
        s.activeModel = e.target.value;
        const p = s.presets[s.activeModel];
        s.selectedProviders = (p?.defaultOrder || []).slice();
        save();
        renderProviderCheckboxes();
        renderPreview();
    });

    document.querySelectorAll('input[name="vgh-route"]').forEach(r => {
        r.addEventListener('change', e => { s.routeMode = e.target.value; save(); renderPreview(); });
    });

    document.getElementById('vgh-reasoning')?.addEventListener('change', e => {
        s.enableReasoning = e.target.checked; save(); renderPreview();
    });
    document.querySelectorAll('input[name="vgh-effort"]').forEach(r => {
        r.addEventListener('change', e => { s.reasoningEffort = e.target.value; save(); renderPreview(); });
    });
    document.getElementById('vgh-use-maxtok')?.addEventListener('change', e => {
        s.useMaxTokensInsteadOfEffort = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-maxtok')?.addEventListener('input', e => {
        s.reasoningMaxTokens = parseInt(e.target.value || '0', 10) || 0; save(); renderPreview();
    });

    document.getElementById('vgh-cache')?.addEventListener('change', e => {
        s.enableCaching = e.target.checked; save(); renderPreview();
    });
    document.getElementById('vgh-cache-mode')?.addEventListener('input', e => {
        s.cachingMode = e.target.value || 'auto'; save(); renderPreview();
    });

    document.getElementById('vgh-apply')?.addEventListener('click', applyToCustomBody);
    document.getElementById('vgh-copy')?.addEventListener('click', copyJsonToClipboard);

    document.getElementById('vgh-add')?.addEventListener('click', () => {
        const name = document.getElementById('vgh-newname').value;
        const key = document.getElementById('vgh-newkey').value;
        addKey(name, key);
        document.getElementById('vgh-newname').value = '';
        document.getElementById('vgh-newkey').value = '';
    });
    document.getElementById('vgh-batch-go')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-batch-text');
        if (!ta) return;
        batchImport(ta.value);
        ta.value = '';
    });
    document.getElementById('vgh-checkall')?.addEventListener('click', () => checkAllKeys(false));
    document.getElementById('vgh-rotate')?.addEventListener('click', async () => {
        const k = await rotateNow();
        if (k) toast(`已切到: ${k.name}`, 'success');
    });
    document.getElementById('vgh-rot-enable')?.addEventListener('change', e => {
        s.rotationEnabled = e.target.checked; save();
        toast(s.rotationEnabled ? '自动轮询已开启' : '自动轮询已关闭', 'info');
    });
    document.getElementById('vgh-minbal')?.addEventListener('input', e => {
        s.minBalance = parseFloat(e.target.value || '0') || 0; save();
    });

    document.getElementById('vgh-edit-presets')?.addEventListener('click', () => {
        const cur = JSON.stringify(s.presets, null, 2);
        const next = prompt('编辑预设 JSON（结构: {"模型族": {providers:[], defaultOrder:[]}}）', cur);
        if (!next) return;
        try {
            s.presets = JSON.parse(next);
            save();
            const sel = document.getElementById('vgh-model-select');
            if (sel) {
                sel.innerHTML = Object.keys(s.presets).map(n =>
                    `<option value="${n}" ${n === s.activeModel ? 'selected' : ''}>${n}</option>`).join('');
            }
            renderProviderCheckboxes();
            toast('预设已保存', 'success');
        } catch (e) {
            toast('JSON 解析失败: ' + e.message, 'error');
        }
    });
}

// ---------- 入口 ----------
jQuery(async () => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        console.error('[VercelHelper] 找不到扩展设置容器');
        return;
    }
    host.appendChild(el(buildHTML()));

    renderProviderCheckboxes();
    renderPreview();
    renderKeyTable();
    bindEvents();

    try {
        const evt = event_types?.GENERATE_BEFORE_COMBINE_PROMPTS
            || event_types?.GENERATION_STARTED
            || 'GENERATION_STARTED';
        eventSource.on(evt, onGenerationHook);
        console.log('[VercelHelper] 已挂钩事件:', evt);
    } catch (e) {
        console.error('[VercelHelper] 挂钩事件失败', e);
    }

    console.log('[VercelHelper] 加载完成');
});
