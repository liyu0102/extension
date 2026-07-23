import { getRequestHeaders } from '../../../../script.js';

/**
 * Claude Model Patcher - front-end settings panel.
 *
 * This UI talks to the companion SERVER PLUGIN (id: claude-model-patcher) via
 * its API endpoints:
 *   GET  /api/plugins/claude-model-patcher/config
 *   PUT  /api/plugins/claude-model-patcher/config
 *   GET  /api/plugins/claude-model-patcher/        (status)
 *
 * The server plugin is what actually patches ST's source so new Claude models
 * (e.g. claude-opus-4-8) use the correct thinking mode. This panel just edits
 * the plugin's config.json without touching files by hand.
 *
 * Collapsing is handled by ST's native .inline-drawer-toggle handler in
 * script.js — do NOT add our own click handler, the two would cancel out.
 */

const API_BASE = '/api/plugins/claude-model-patcher';
const LAST_DEPTH_KEY = 'cmpLastCacheDepth';
const THINKING_OPTIONS = [
    { value: 'adaptive', label: 'Adaptive (自适应思考, 4.7/4.8)' },
    { value: 'extended', label: 'Extended (扩展/预算思考)' },
    { value: 'none', label: 'None (不思考)' },
];
const FLAGS = [
    { key: 'context1m', label: '1M 上下文', hint: '允许最大上下文拉到 1M' },
    { key: 'noSampling', label: '禁用采样', hint: '删除 temperature/top_p/top_k (4.7/4.8 需要)' },
    { key: 'noPrefill', label: '禁用预填充', hint: '不发送 assistant 预填充' },
    { key: 'verbosity', label: 'Verbosity', hint: '支持 verbosity / effort' },
    { key: 'webSearch', label: 'Web Search', hint: '内置网络搜索工具' },
    { key: 'limitedSampling', label: '受限采样', hint: 'top_p<1 时去掉 temperature (一般别和"禁用采样"同开)' },
];

let state = null; // current config object
let serverAvailable = false;

function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c) e.append(c);
    }
    return e;
}

function toast(msg, type = 'info') {
    if (window.toastr) {
        (window.toastr[type] || window.toastr.info)(msg, 'Claude Model Patcher');
    } else {
        console.log('[claude-model-patcher]', msg);
    }
}

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`, { headers: getRequestHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function apiPut(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

function defaultModel() {
    return {
        id: '',
        thinking: 'adaptive',
        context1m: true,
        noSampling: true,
        noPrefill: true,
        verbosity: true,
        webSearch: true,
        limitedSampling: false,
    };
}

function defaultCaching() {
    return {
        manage: false,
        enableSystemPromptCache: true,
        cachingAtDepth: 12,
        extendedTTL: true,
        patchCustomSource: false,
    };
}

function defaultState() {
    return {
        enabled: true,
        patchFrontend: true,
        openrouterMaxEffort: true,
        backendFile: '',
        frontendFile: '',
        configYamlFile: '',
        caching: defaultCaching(),
        models: [
            {
                id: 'claude-opus-4-8',
                thinking: 'adaptive',
                context1m: true,
                noSampling: true,
                noPrefill: true,
                verbosity: true,
                webSearch: true,
                limitedSampling: false,
            },
        ],
    };
}

function isCacheMasterOn() {
    const c = state?.caching || {};
    return c.enableSystemPromptCache !== false || Number(c.cachingAtDepth) !== -1;
}

function rememberDepth() {
    const d = Number(state?.caching?.cachingAtDepth);
    if (Number.isInteger(d) && d >= 0) {
        try { localStorage.setItem(LAST_DEPTH_KEY, String(d)); } catch { /* ignore */ }
    }
}

function recallDepth() {
    try {
        const d = parseInt(localStorage.getItem(LAST_DEPTH_KEY), 10);
        if (Number.isInteger(d) && d >= 0) return d;
    } catch { /* ignore */ }
    return 12;
}

function renderModelCard(model, index) {
    const card = el('div', { class: 'cmp-model-card' });

    const head = el('div', { class: 'cmp-model-head' });
    const idInput = el('input', {
        class: 'text_pole cmp-model-id',
        type: 'text',
        placeholder: 'claude-opus-4-8',
        value: model.id || '',
        oninput: (e) => { model.id = e.target.value.trim(); },
    });
    const del = el('div', {
        class: 'menu_button fa-solid fa-trash-can cmp-del',
        title: '删除该模型',
        onclick: () => { state.models.splice(index, 1); renderModels(); },
    });
    head.append(el('label', { class: 'cmp-label', text: '模型名' }), idInput, del);
    card.append(head);

    // thinking select
    const tRow = el('div', { class: 'cmp-row' });
    const sel = el('select', {
        class: 'text_pole cmp-thinking',
        onchange: (e) => { model.thinking = e.target.value; },
    });
    for (const opt of THINKING_OPTIONS) {
        const o = el('option', { value: opt.value, text: opt.label });
        if ((model.thinking || 'adaptive') === opt.value) o.selected = true;
        sel.append(o);
    }
    tRow.append(el('label', { class: 'cmp-label', text: '思考模式' }), sel);
    card.append(tRow);

    // capability flags
    const flagWrap = el('div', { class: 'cmp-flags' });
    for (const f of FLAGS) {
        const id = `cmp-${index}-${f.key}`;
        const cb = el('input', { type: 'checkbox', id });
        cb.checked = Boolean(model[f.key]);
        cb.addEventListener('change', () => { model[f.key] = cb.checked; });
        const lbl = el('label', { class: 'checkbox_label cmp-flag', for: id, title: f.hint });
        lbl.append(cb, el('span', { text: f.label }));
        flagWrap.append(lbl);
    }
    card.append(flagWrap);

    return card;
}

function renderModels() {
    const list = document.getElementById('cmp-model-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.models.length) {
        list.append(el('small', { class: 'cmp-empty', text: '还没有模型，点下面的“添加模型”。' }));
    }
    state.models.forEach((m, i) => list.append(renderModelCard(m, i)));
}

/** 根据 manage / 缓存总开关 的状态给缓存区块的子项加/去灰色禁用样式 */
function updateCacheUIState() {
    const c = state.caching || defaultCaching();
    const manageOn = Boolean(c.manage);
    const masterOn = isCacheMasterOn();
    const masterRow = document.getElementById('cmp-cache-master-row');
    const subWrap = document.getElementById('cmp-cache-sub');
    if (masterRow) masterRow.classList.toggle('cmp-disabled', !manageOn);
    if (subWrap) subWrap.classList.toggle('cmp-disabled', !manageOn || !masterOn);
}

function syncGlobalControls() {
    const enabled = document.getElementById('cmp-enabled');
    const patchFe = document.getElementById('cmp-patch-frontend');
    const orMax = document.getElementById('cmp-openrouter-max');
    if (enabled) enabled.checked = state.enabled !== false;
    if (patchFe) patchFe.checked = state.patchFrontend !== false;
    if (orMax) orMax.checked = state.openrouterMaxEffort !== false;
    const c = state.caching || defaultCaching();
    const manage = document.getElementById('cmp-cache-manage');
    const master = document.getElementById('cmp-cache-master');
    const sys = document.getElementById('cmp-cache-system');
    const depth = document.getElementById('cmp-cache-depth');
    const ttl = document.getElementById('cmp-cache-ttl');
    const custom = document.getElementById('cmp-cache-custom');
    if (manage) manage.checked = Boolean(c.manage);
    if (master) master.checked = isCacheMasterOn();
    if (sys) sys.checked = c.enableSystemPromptCache !== false;
    if (depth) depth.value = Number.isInteger(Number(c.cachingAtDepth)) ? c.cachingAtDepth : 12;
    if (ttl) ttl.checked = c.extendedTTL !== false;
    if (custom) custom.checked = Boolean(c.patchCustomSource);
    updateCacheUIState();
}

async function loadFromServer() {
    try {
        const data = await apiGet('/config');
        serverAvailable = true;
        state = data.config && typeof data.config === 'object' ? data.config : defaultState();
        if (!Array.isArray(state.models)) state.models = [];
        if (!state.caching || typeof state.caching !== 'object') state.caching = defaultCaching();
        setStatus('已连接后端插件 ✓', 'ok');
    } catch (e) {
        serverAvailable = false;
        state = defaultState();
        setStatus('未检测到后端插件 (server plugin)。请确认已安装 claude-model-patcher 插件并在 config.yaml 设 enableServerPlugins: true，然后重启 ST。', 'err');
    }
    syncGlobalControls();
    renderModels();
}

async function save() {
    if (!serverAvailable) {
        toast('后端插件不可用，无法保存。请先安装 server plugin。', 'error');
        return;
    }
    try {
        const data = await apiPut('/config', state);
        state = data.config || state;
        renderModels();
        syncGlobalControls();
        const changed = (data.result?.backend?.changed || data.result?.frontend?.changed || data.result?.configYaml?.changed);
        if (changed) {
            toast('已保存并打补丁。请重启 SillyTavern 使其生效。', 'success');
            setStatus('已保存并打补丁 ✓ — 需重启 SillyTavern 生效', 'warn');
        } else {
            toast('已保存。无需新增补丁（已是最新）。', 'success');
            setStatus('已保存 ✓ — 补丁已是最新', 'ok');
        }
    } catch (e) {
        toast(`保存失败: ${e.message}`, 'error');
        setStatus(`保存失败: ${e.message}`, 'err');
    }
}

function setStatus(msg, kind) {
    const s = document.getElementById('cmp-status');
    if (!s) return;
    s.textContent = msg;
    s.className = `cmp-status cmp-status-${kind || 'info'}`;
}

/** 带标题和说明的分区容器 */
function section(title, desc) {
    const wrap = el('div', { class: 'cmp-section' });
    wrap.append(el('div', { class: 'cmp-section-title', text: title }));
    if (desc) wrap.append(el('small', { class: 'cmp-section-desc', text: desc }));
    return wrap;
}

function checkbox(id, label, title, onChange) {
    const lbl = el('label', { class: 'checkbox_label', title });
    const cb = el('input', { type: 'checkbox', id });
    cb.addEventListener('change', () => onChange(cb.checked));
    lbl.append(cb, el('span', { text: label }));
    return lbl;
}

function buildPanel() {
    const container = el('div', { class: 'cmp-settings' });

    // drawer header — 折叠交给 ST 原生 .inline-drawer-toggle 处理，这里不绑事件
    const inline = el('div', { class: 'inline-drawer' });
    const toggle = el('div', { class: 'inline-drawer-toggle inline-drawer-header' });
    toggle.append(
        el('b', { text: 'Claude Model Patcher' }),
        el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
    );
    const content = el('div', { class: 'inline-drawer-content' });

    // status line + master switch
    content.append(el('div', { id: 'cmp-status', class: 'cmp-status cmp-status-info', text: '加载中…' }));
    content.append(checkbox('cmp-enabled', '启用补丁（总开关）', '关闭后不打任何补丁',
        (v) => { state.enabled = v; }));

    // ===== ① 模型思考补丁 =====
    const secModels = section('🧠 ① 模型思考补丁',
        '让 ST 认识新 Claude 模型并用对思考模式。作用于 Claude 官方直连源；保存后需重启 ST。');
    secModels.append(el('div', { id: 'cmp-model-list', class: 'cmp-model-list' }));
    const modelBtns = el('div', { class: 'cmp-buttons' });
    modelBtns.append(el('div', {
        class: 'menu_button menu_button_icon',
        onclick: () => { state.models.push(defaultModel()); renderModels(); },
    }, [el('i', { class: 'fa-solid fa-plus' }), el('span', { text: '添加模型' })]));
    secModels.append(modelBtns);
    secModels.append(checkbox('cmp-patch-frontend', '补丁前端（1M 上下文滑条上限）',
        '同时给前端 openai.js 打补丁，让上下文滑条能拉到 1M',
        (v) => { state.patchFrontend = v; }));
    content.append(secModels);

    // ===== ② 提示词缓存 =====
    const secCache = section('💾 ② 提示词缓存',
        '写入 config.yaml，对 Claude 官方直连和 OpenRouter 同时生效；勾选最后一项后对"自定义(OpenAI兼容)"源也生效。改动需重启 ST。');

    secCache.append(checkbox('cmp-cache-manage', '由插件接管缓存设置',
        '开启后保存时把下面几项写进 config.yaml → claude 段；关闭则完全不碰 config.yaml',
        (v) => { state.caching.manage = v; updateCacheUIState(); }));

    const masterRow = el('div', { id: 'cmp-cache-master-row' });
    masterRow.append(checkbox('cmp-cache-master', '启用提示词缓存（一键开/关）',
        '关闭 = 自动把"缓存系统提示词"取消勾选并把打点深度设为 -1（记住原值）；开启 = 恢复原来的深度',
        (v) => {
            if (v) {
                state.caching.enableSystemPromptCache = true;
                state.caching.cachingAtDepth = recallDepth();
            } else {
                rememberDepth();
                state.caching.enableSystemPromptCache = false;
                state.caching.cachingAtDepth = -1;
            }
            syncGlobalControls();
        }));
    secCache.append(masterRow);

    const subWrap = el('div', { id: 'cmp-cache-sub', class: 'cmp-cache-sub' });
    subWrap.append(checkbox('cmp-cache-system', '缓存系统提示词+角色卡',
        'enableSystemPromptCache：在系统提示词（含角色卡、工具列表）末尾打缓存断点',
        (v) => { state.caching.enableSystemPromptCache = v; }));

    const depthRow = el('div', { class: 'cmp-row' });
    const depthInput = el('input', {
        class: 'text_pole cmp-cache-depth',
        id: 'cmp-cache-depth',
        type: 'number',
        min: '-1',
        step: '1',
        title: '打点深度 (cachingAtDepth)。填"发原文的楼层数+2"：例如正则只放行 10 层内原文就填 12。-1 = 关闭深度打点',
        oninput: (e) => {
            const v = parseInt(e.target.value, 10);
            state.caching.cachingAtDepth = Number.isInteger(v) && v >= -1 ? v : 12;
        },
    });
    depthRow.append(el('label', { class: 'cmp-label', text: '打点深度' }), depthInput);
    subWrap.append(depthRow);
    subWrap.append(el('small', {
        class: 'cmp-section-desc',
        text: '深度 = 发原文的楼层数 + 2（摘要边界外的稳定区）。',
    }));

    subWrap.append(checkbox('cmp-cache-ttl', '1 小时缓存（关=5分钟）',
        'extendedTTL：缓存保留 1 小时。回合间隔常超过 5 分钟就开着',
        (v) => { state.caching.extendedTTL = v; }));

    subWrap.append(checkbox('cmp-cache-custom', '自定义(OpenAI兼容)源也生效',
        '给 ST 的"自定义"源打同样的缓存断点（如 Vercel AI Gateway 等中转）。模型名带 claude 才生效，复用上面的开关和深度',
        (v) => { state.caching.patchCustomSource = v; }));

    secCache.append(subWrap);
    content.append(secCache);

    // ===== ③ OpenRouter 附加 =====
    const secOr = section('🔀 ③ OpenRouter 附加',
        '只影响走 OpenRouter 的 Claude 模型，和上面两块互不相干。');
    secOr.append(checkbox('cmp-openrouter-max', '“极高”思考不降级',
        '选"极高"时保留 max 思考（ST 默认会降成 high），并把 verbosity 兜底设为 max',
        (v) => { state.openrouterMaxEffort = v; }));
    content.append(secOr);

    // ===== 底部按钮 =====
    const btns = el('div', { class: 'cmp-buttons cmp-footer-buttons' });
    const saveBtn = el('div', {
        class: 'menu_button menu_button_icon',
        onclick: () => save(),
    }, [el('i', { class: 'fa-solid fa-floppy-disk' }), el('span', { text: '保存并打补丁' })]);
    const reloadBtn = el('div', {
        class: 'menu_button menu_button_icon',
        title: '从后端重新读取配置',
        onclick: () => loadFromServer(),
    }, [el('i', { class: 'fa-solid fa-rotate' }), el('span', { text: '重新加载' })]);
    btns.append(saveBtn, reloadBtn);
    content.append(btns);

    inline.append(toggle, content);
    container.append(inline);
    return container;
}

function mount() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;
    if (document.querySelector('.cmp-settings')) return true;
    host.append(buildPanel());
    loadFromServer();
    return true;
}

function ready(fn) {
    if (mount()) return;
    const iv = setInterval(() => { if (mount()) clearInterval(iv); }, 500);
    setTimeout(() => clearInterval(iv), 20000);
    void fn;
}

ready();
