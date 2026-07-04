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
 */

const API_BASE = '/api/plugins/claude-model-patcher';
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

function defaultState() {
    return {
        enabled: true,
        patchFrontend: true,
        openrouterMaxEffort: true,
        backendFile: '',
        frontendFile: '',
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

function syncGlobalControls() {
    const enabled = document.getElementById('cmp-enabled');
    const patchFe = document.getElementById('cmp-patch-frontend');
    const orMax = document.getElementById('cmp-openrouter-max');
    if (enabled) enabled.checked = state.enabled !== false;
    if (patchFe) patchFe.checked = state.patchFrontend !== false;
    if (orMax) orMax.checked = state.openrouterMaxEffort !== false;
}

async function loadFromServer() {
    try {
        const data = await apiGet('/config');
        serverAvailable = true;
        state = data.config && typeof data.config === 'object' ? data.config : defaultState();
        if (!Array.isArray(state.models)) state.models = [];
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
        const changed = (data.result?.backend?.changed || data.result?.frontend?.changed);
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

function buildPanel() {
    const container = el('div', { class: 'cmp-settings' });

    // drawer header (collapsible, ST native style)
    const inline = el('div', { class: 'inline-drawer' });
    const toggle = el('div', { class: 'inline-drawer-toggle inline-drawer-header' });
    toggle.append(
        el('b', { text: 'Claude Model Patcher' }),
        el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
    );
    const content = el('div', { class: 'inline-drawer-content' });

    // status line
    content.append(el('div', { id: 'cmp-status', class: 'cmp-status cmp-status-info', text: '加载中…' }));

    content.append(el('small', {
        class: 'cmp-desc',
        html: '为新发布 / 自定义的 Claude 模型（如 <code>claude-opus-4-8</code>）设置正确的思考模式。' +
            '保存后会自动给后端打补丁，<b>需重启 SillyTavern 生效</b>。',
    }));

    // global toggles
    const globals = el('div', { class: 'cmp-globals' });
    const enabledLbl = el('label', { class: 'checkbox_label', title: '关闭后不打任何补丁' });
    const enabledCb = el('input', { type: 'checkbox', id: 'cmp-enabled' });
    enabledCb.addEventListener('change', () => { state.enabled = enabledCb.checked; });
    enabledLbl.append(enabledCb, el('span', { text: '启用补丁' }));

    const feLbl = el('label', { class: 'checkbox_label', title: '同时给前端 openai.js 打补丁（1M 上下文上限）' });
    const feCb = el('input', { type: 'checkbox', id: 'cmp-patch-frontend' });
    feCb.addEventListener('change', () => { state.patchFrontend = feCb.checked; });
    feLbl.append(feCb, el('span', { text: '补丁前端 (1M 上下文)' }));

    const orLbl = el('label', { class: 'checkbox_label', title: 'OpenRouter 选“极高”时保留 max 思考（而非降级成 high），并把 verbosity 兜底设为 max' });
    const orCb = el('input', { type: 'checkbox', id: 'cmp-openrouter-max' });
    orCb.addEventListener('change', () => { state.openrouterMaxEffort = orCb.checked; });
    orLbl.append(orCb, el('span', { text: 'OpenRouter 极高思考' }));

    globals.append(enabledLbl, feLbl, orLbl);
    content.append(globals);

    // model list
    content.append(el('div', { id: 'cmp-model-list', class: 'cmp-model-list' }));

    // buttons
    const btns = el('div', { class: 'cmp-buttons' });
    const addBtn = el('div', {
        class: 'menu_button menu_button_icon',
        onclick: () => { state.models.push(defaultModel()); renderModels(); },
    }, [el('i', { class: 'fa-solid fa-plus' }), el('span', { text: '添加模型' })]);
    const saveBtn = el('div', {
        class: 'menu_button menu_button_icon',
        onclick: () => save(),
    }, [el('i', { class: 'fa-solid fa-floppy-disk' }), el('span', { text: '保存并打补丁' })]);
    const reloadBtn = el('div', {
        class: 'menu_button menu_button_icon',
        title: '从后端重新读取配置',
        onclick: () => loadFromServer(),
    }, [el('i', { class: 'fa-solid fa-rotate' }), el('span', { text: '重新加载' })]);
    btns.append(addBtn, saveBtn, reloadBtn);
    content.append(btns);

    toggle.addEventListener('click', () => {
        content.classList.toggle('cmp-open');
        const icon = toggle.querySelector('.inline-drawer-icon');
        if (icon) icon.classList.toggle('up'), icon.classList.toggle('down');
        content.style.display = content.style.display === 'none' ? '' : 'none';
    });

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
