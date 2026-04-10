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

// 使用命名空间导入：即使某些名字在用户的酒馆版本里没导出，
// 模块也能正常加载（不会在解析阶段崩掉拖累其他扩展）
import * as Extensions from '../../../extensions.js';
import * as Script from '../../../../script.js';

const extension_settings  = Extensions.extension_settings  || {};
const saveSettingsDebounced = Script.saveSettingsDebounced || (() => {});
const eventSource         = Script.eventSource             || { on: () => {} };
const event_types         = Script.event_types             || {};
const getRequestHeaders   = Script.getRequestHeaders       || (() => ({ 'Content-Type': 'application/json' }));

console.log('[VercelHelper] 模块加载');

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
    enabled: true,                // 总开关
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
    activeKeyId: '',          // 当前使用中的 key id
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

// 酒馆"包括主体参数"要的是 YAML，不是 JSON
function toYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    let out = '';
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) {
            out += `${pad}${k}:\n`;
            for (const item of v) out += `${pad}  - ${item}\n`;
        } else if (v !== null && typeof v === 'object') {
            out += `${pad}${k}:\n` + toYaml(v, indent + 1);
        } else {
            out += `${pad}${k}: ${v}\n`;
        }
    }
    return out;
}

function buildYaml() {
    return toYaml(buildBodyParams()).trim();
}

// ---------- 请求拦截：直接注入参数到发出去的请求 ----------
let _interceptInstalled = false;

function installFetchInterceptor() {
    if (_interceptInstalled) return;
    _interceptInstalled = true;

    const _origFetch = window.fetch;
    window.fetch = async function(url, options) {
        try {
            const s = getSettings();
            if (s.enabled !== false && options?.method === 'POST' && typeof url === 'string') {
                // 匹配酒馆发到后端的聊天补全请求
                if (url.includes('/generate') || url.includes('/chat/completions')) {
                    const body = JSON.parse(options.body);
                    // 只在有 messages 字段的请求里注入（确保是聊天请求）
                    if (body.messages) {
                        const params = buildBodyParams();
                        if (Object.keys(params).length > 0) {
                            Object.assign(body, params);
                            options = { ...options, body: JSON.stringify(body) };
                            console.log('[VercelHelper] 已注入参数:', Object.keys(params).join(', '));
                        }
                    }
                }
            }
        } catch (_) {}
        return _origFetch.call(this, url, options);
    };
    console.log('[VercelHelper] fetch 拦截器已安装');
}

function syncToBody() {
    // 不再需要写 textarea，参数通过 fetch 拦截器自动注入
}

function applyToCustomBody() {
    const yaml = buildYaml();
    if (!yaml) { toast('当前没有任何要写入的参数', 'warning'); return; }
    navigator.clipboard.writeText(yaml).then(
        () => toast('已复制到剪贴板（参数会自动注入请求，无需手动粘贴）', 'success'),
        () => toast('复制失败', 'error'),
    );
}

function copyJsonToClipboard() {
    const yaml = buildYaml();
    navigator.clipboard.writeText(yaml || '').then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error'),
    );
}

// ---------- 余额 / 判活 ----------
async function fetchCredits(apiKey) {
    const url = `${GATEWAY_BASE}/credits`;
    const authHeaders = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    let resp;
    try {
        // 先直连
        resp = await fetch(url, { method: 'GET', headers: authHeaders });
    } catch (_directErr) {
        // 直连失败（CORS），走酒馆后端代理
        try {
            resp = await fetch('/api/extensions/fetch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ url, method: 'GET', headers: authHeaders }),
            });
        } catch (_proxyErr) {
            const e = new Error('直连和代理均失败（可能是 CORS）');
            e.kind = 'network';
            throw e;
        }
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
    let ok = false;
    // 方法1: API 写入
    try {
        const resp = await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', value: apiKey }),
        });
        if (resp.ok) { ok = true; }
        else { console.error('[VercelHelper] writeSecret HTTP', resp.status); }
    } catch (e) {
        console.error('[VercelHelper] writeSecret fetch 失败', e);
    }
    // 方法2: DOM 直写（兜底）
    try {
        const input = document.querySelector('#api_key_custom')
            || document.querySelector('input[name="api_key_custom"]');
        if (input) {
            input.value = apiKey;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            ok = true;
        }
    } catch (_) {}
    if (ok) { console.log('[VercelHelper] key 已写入酒馆'); }
    else { console.error('[VercelHelper] key 写入全部失败！'); }
    return ok;
}

function markActiveKey(id) {
    const s = getSettings();
    s.activeKeyId = id;
    save();
    // 刷新高亮
    document.querySelectorAll('.vgh-active-row').forEach(el => el.classList.remove('vgh-active-row'));
    const row = document.querySelector(`[data-keyrow="${id}"]`);
    if (row) row.classList.add('vgh-active-row');
}

async function rotateNow() {
    const k = pickNextAliveKey();
    if (!k) { toast('没有可用的活 key', 'error'); return null; }
    await writeApiKeyToST(k.key);
    k.lastUsed = Date.now();
    markActiveKey(k.id);
    renderKeyTable();
    return k;
}

async function onGenerationHook() {
    const s = getSettings();
    if (s.enabled === false) return;
    if (!s.rotationEnabled || s.keys.length === 0) return;
    const k = pickNextAliveKey();
    if (!k) { console.warn('[VercelHelper] 轮询：没有活 key'); return; }
    await writeApiKeyToST(k.key);
    k.lastUsed = Date.now();
    markActiveKey(k.id);
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

// 每次增删后重排编号：活 key → key_1, key_2, …
function renumberKeys() {
    const s = getSettings();
    s.keys.filter(k => !k.trashed).forEach((k, i) => { k.name = `key_${i + 1}`; });
    save();
}

function addKey(apiKey) {
    const s = getSettings();
    apiKey = (apiKey || '').trim();
    if (!apiKey) { toast('请填写 key', 'warning'); return; }
    if (s.keys.some(k => k.key === apiKey)) { toast('key 已存在', 'warning'); return; }
    const newK = makeKey('_tmp', apiKey);
    s.keys.push(newK);
    renumberKeys();
    renderKeyTable();
    checkOneKey(newK.id);   // 添加后自动检查
}

function batchImport(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast('没有输入内容', 'warning'); return; }
    const s = getSettings();
    let added = 0, dup = 0;
    for (const line of lines) {
        const key = line;
        if (!key) continue;
        if (s.keys.some(k => k.key === key)) { dup++; continue; }
        s.keys.push(makeKey('_tmp', key));
        added++;
    }
    renumberKeys();
    renderKeyTable();
    toast(`新增 ${added} 个，跳过重复 ${dup} 个，开始检查…`, 'success');
    if (added > 0) checkAllKeys(false);  // 批量导入后自动检查全部
}

function removeKey(id) {
    const s = getSettings();
    s.keys = s.keys.filter(k => k.id !== id);
    renumberKeys();
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
    renumberKeys();
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

          <div class="vgh-row vgh-master">
            <label class="vgh-checkbox"><input type="checkbox" id="vgh-enabled" ${s.enabled !== false ? 'checked' : ''}/> 启用扩展</label>
          </div>

          <div id="vgh-body" style="${s.enabled === false ? 'display:none' : ''}">

          <details class="vgh-drawer" open>
            <summary class="vgh-title">1. 模型预设 / 供应商勾选</summary>
            <div class="vgh-section-body">
              <div class="vgh-row">
                <label>模型商</label>
                <select id="vgh-model-select">${presetOptions}</select>
              </div>
              <details class="vgh-batch-details">
                <summary>编辑预设 JSON</summary>
                <div class="vgh-batch-body">
                  <textarea id="vgh-preset-text" rows="10" placeholder="模型商名: providers 列表 + defaultOrder 列表"></textarea>
                  <div class="vgh-row">
                    <button class="menu_button" id="vgh-preset-save">保存</button>
                    <button class="menu_button" id="vgh-preset-reset">恢复默认</button>
                  </div>
                </div>
              </details>
              <div class="vgh-row">
                <label>路由模式</label>
                <label class="vgh-radio"><input type="radio" name="vgh-route" value="order" ${s.routeMode === 'order' ? 'checked' : ''}/> order（按序回退）</label>
                <label class="vgh-radio"><input type="radio" name="vgh-route" value="only" ${s.routeMode === 'only' ? 'checked' : ''}/> only（只用这些）</label>
              </div>
              <div class="vgh-row vgh-providers" id="vgh-providers"></div>
            </div>
          </details>

          <details class="vgh-drawer">
            <summary class="vgh-title">2. 思考模式 (reasoning)</summary>
            <div class="vgh-section-body">
              <div class="vgh-row">
                <label class="vgh-checkbox"><input type="checkbox" id="vgh-reasoning" ${s.enableReasoning ? 'checked' : ''}/> 开启思考</label>
              </div>
              <div class="vgh-row">${effortRadios}</div>
              <div class="vgh-row">
                <label class="vgh-checkbox"><input type="checkbox" id="vgh-use-maxtok" ${s.useMaxTokensInsteadOfEffort ? 'checked' : ''}/> 改用 max_tokens（与 effort 互斥）</label>
                <input type="number" id="vgh-maxtok" min="0" step="64" value="${s.reasoningMaxTokens || 0}" style="width:110px"/>
              </div>
            </div>
          </details>

          <details class="vgh-drawer">
            <summary class="vgh-title">3. 缓存 (caching)</summary>
            <div class="vgh-section-body">
              <div class="vgh-row">
                <label class="vgh-checkbox"><input type="checkbox" id="vgh-cache" ${s.enableCaching ? 'checked' : ''}/> 开启缓存（Anthropic 等需要主动开）</label>
                <input type="text" id="vgh-cache-mode" value="${s.cachingMode || 'auto'}" style="width:90px"/>
              </div>
            </div>
          </details>

          <details class="vgh-drawer">
            <summary class="vgh-title">4. 参数预览（自动注入，无需手动）</summary>
            <div class="vgh-section-body">
              <pre id="vgh-preview" class="vgh-preview"></pre>
              <div class="vgh-row">
                <button class="menu_button" id="vgh-copy">复制 YAML</button>
              </div>
            </div>
          </details>

          <details class="vgh-drawer" open>
            <summary class="vgh-title">5. Key 池 / 余额 / 轮询</summary>
            <div class="vgh-section-body">
              <div class="vgh-row">
                <input type="text" id="vgh-newkey" placeholder="vercel ai gateway key" style="flex:1"/>
                <button class="menu_button" id="vgh-add">添加</button>
              </div>

              <details class="vgh-batch-details">
                <summary>批量添加</summary>
                <div class="vgh-batch-body">
                  <textarea id="vgh-batch-text" rows="6" placeholder="每行粘贴一个 key：&#10;vck-xxxx&#10;vck-yyyy&#10;vck-zzzz"></textarea>
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
          </details>

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
            filterModelDropdown();
        });
    });
}

function renderPreview() {
    const pre = document.getElementById('vgh-preview');
    if (!pre) return;
    pre.textContent = buildYaml() || '(无)';
    syncToBody();
}

// ---------- 过滤酒馆"可用模型"下拉框 ----------
function getModelDropdown() {
    // 酒馆不同版本/分叉的选择器可能不同，逐个尝试
    return document.querySelector('#model_custom_select')
        || document.querySelector('#custom_model_id_select')
        || document.querySelector('select[data-for="custom_model"]')
        // 回退：找所有 select，看哪个选项包含 "provider/model" 格式
        || [...document.querySelectorAll('select')].find(sel =>
            sel.options.length > 5 &&
            [...sel.options].some(opt => /^\w+\/\w/.test(opt.value))
        )
        || null;
}

function filterModelDropdown() {
    const s = getSettings();
    if (s.enabled === false) return;   // 总开关关了不过滤
    const sel = getModelDropdown();
    if (!sel) return;
    const providers = s.selectedProviders.filter(Boolean);
    let visibleCount = 0;
    for (const opt of sel.options) {
        if (!opt.value || opt.value === '') {
            opt.style.display = '';
            continue;
        }
        if (providers.length === 0) {
            opt.style.display = '';
            visibleCount++;
        } else {
            const matches = providers.some(p =>
                opt.value.startsWith(p + '/') || opt.textContent.startsWith(p + '/')
            );
            opt.style.display = matches ? '' : 'none';
            if (matches) visibleCount++;
        }
    }
}

function unfilterModelDropdown() {
    const sel = getModelDropdown();
    if (!sel) return;
    for (const opt of sel.options) { opt.style.display = ''; }
}

let _modelObserver = null;
function watchModelDropdown() {
    if (_modelObserver) return;
    const sel = getModelDropdown();
    if (!sel) {
        // 下拉框还没加载，稍后重试
        setTimeout(watchModelDropdown, 3000);
        return;
    }
    _modelObserver = new MutationObserver(() => filterModelDropdown());
    _modelObserver.observe(sel, { childList: true });
    filterModelDropdown();
}

function rowFor(k, isTrash) {
    const s = getSettings();
    const meta = STATUS_META[k.status] || STATUS_META.unknown;
    const statusText = k.paused ? '暂停' : meta.text;
    const last = k.lastCheck ? new Date(k.lastCheck).toLocaleTimeString() : '-';
    const isActive = !isTrash && k.id === s.activeKeyId;
    // key 预览：前8 + ... + 后4
    const kv = k.key || '';
    const keyPreview = kv.length > 14 ? kv.slice(0, 8) + '…' + kv.slice(-4) : kv;
    const actions = isTrash
        ? `<button class="menu_button vgh-mini" data-act="restore" data-id="${k.id}">恢复</button>
           <button class="menu_button vgh-mini" data-act="del" data-id="${k.id}">删除</button>`
        : `<button class="menu_button vgh-mini" data-act="check" data-id="${k.id}">查</button>
           <button class="menu_button vgh-mini" data-act="pause" data-id="${k.id}">${k.paused ? '恢复' : '停'}</button>`;
    return `<tr data-keyrow="${k.id}" class="${isActive ? 'vgh-active-row' : ''}">
      <td>
        ${escapeHtml(k.name)}${isActive ? ' ⬅' : ''}
        <div class="vgh-key-preview">${escapeHtml(keyPreview)} <button class="vgh-copy-btn" data-act="copykey" data-id="${k.id}" title="复制 key">⧉</button></div>
      </td>
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
                else if (act === 'copykey') {
                    const s = getSettings();
                    const k = s.keys.find(x => x.id === id);
                    if (k) navigator.clipboard.writeText(k.key).then(() => toast('已复制', 'success'));
                }
                else if (act === 'del') {
                    if (confirm('确定删除这个 key?')) removeKey(id);
                }
            });
        });
    });
}

function bindEvents() {
    const s = getSettings();

    // 总开关
    document.getElementById('vgh-enabled')?.addEventListener('change', e => {
        s.enabled = e.target.checked;
        save();
        const body = document.getElementById('vgh-body');
        if (body) body.style.display = s.enabled ? '' : 'none';
        if (s.enabled) {
            filterModelDropdown();
            toast('已开启，参数将自动注入请求', 'success');
        } else {
            unfilterModelDropdown();
            toast('已关闭，所有功能已停用', 'info');
        }
    });

    document.getElementById('vgh-model-select')?.addEventListener('change', e => {
        s.activeModel = e.target.value;
        const p = s.presets[s.activeModel];
        s.selectedProviders = (p?.defaultOrder || []).slice();
        save();
        renderProviderCheckboxes();
        renderPreview();
        filterModelDropdown();
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
        const key = document.getElementById('vgh-newkey').value;
        addKey(key);
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

    document.getElementById('vgh-preset-save')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-preset-text');
        if (!ta || !ta.value.trim()) { toast('请先在文本框里粘贴预设 JSON', 'warning'); return; }
        try {
            const parsed = JSON.parse(ta.value);
            s.presets = parsed;
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
            toast('预设已保存', 'success');
        } catch (e) {
            toast('JSON 解析失败: ' + e.message, 'error');
        }
    });
    document.getElementById('vgh-preset-reset')?.addEventListener('click', () => {
        const ta = document.getElementById('vgh-preset-text');
        if (ta) ta.value = JSON.stringify(DEFAULT_PRESETS, null, 2);
    });
}

// ---------- 入口 ----------
jQuery(async () => {
    try {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host) {
            console.error('[VercelHelper] 找不到扩展设置容器 extensions_settings2');
            return;
        }
        const node = el(buildHTML());
        if (!node) {
            console.error('[VercelHelper] buildHTML 返回的节点为空');
            return;
        }
        host.appendChild(node);

        renderProviderCheckboxes();
        renderPreview();
        renumberKeys();
        renderKeyTable();
        bindEvents();

        // 核心：安装请求拦截器，自动注入参数
        installFetchInterceptor();

        // 启动模型下拉框过滤 + 监听
        filterModelDropdown();
        watchModelDropdown();

        // 预填预设编辑器
        const presetTa = document.getElementById('vgh-preset-text');
        if (presetTa) presetTa.value = JSON.stringify(getSettings().presets, null, 2);

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
    } catch (err) {
        console.error('[VercelHelper] 初始化失败:', err);
    }
});
