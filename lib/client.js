// dsh-garmin-coach client bundle
// 完全参考 dsh-email 的保存方式：
//   - 用 settings.section（侧栏导航）注册卡片
//   - fetch 后端 /garmin-settings route 读取/保存/连接
//   - 不用 settingsScope（dsh-email 用后端 route 保存整个表单）
window.__ModuleLoader__.load({
  id: 'dsh-garmin-coach',
  factory: (require) => {
    var jsxRuntime = require('react/jsx-runtime');
    var React = require('react');
    var ReactDOM = require('react-dom');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var ROUTE = '/garmin-settings';
    var EMPTY = {
      email: '',
      password: '',
      isCn: true,
      status: 'disconnected',
      displayName: '',
      lastSyncAt: '',
      syncDaysBack: 14,
    };

    // 格式化同步时间（ISO → 可读）
    function fmtSyncTime(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso);
        var y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
        var h = String(d.getHours()).padStart(2,'0'), min = String(d.getMinutes()).padStart(2,'0');
        return y + '-' + m + '-' + day + ' ' + h + ':' + min;
      } catch (e) {
        return iso;
      }
    }

    // 调后端 route：action 缺省 = 读
    function api(action, payload) {
      // 后端期望 body 里带 action 字段：{action, ...payload}
      var bodyData = null;
      if (action) {
        bodyData = Object.assign({ action: action }, payload || {});
      }
      return fetch(ROUTE, {
        method: action ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: action ? JSON.stringify(bodyData) : undefined,
      }).then(function (r) {
        // 先读文本，再尝试解析 JSON（确保不丢 message）
        return r.text().then(function (text) {
          var parsed = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch (e) {}
          parsed._status = r.status;
          return parsed;
        });
      });
    }

    function GarminSettingsSection() {
      var [draft, setDraft] = useState(null);
      var [snapshot, setSnapshot] = useState(undefined);
      var [busy, setBusy] = useState(false);
      var [error, setError] = useState('');
      var [message, setMessage] = useState('');
      var [showPassword, setShowPassword] = useState(false);
      var [mfaCode, setMfaCode] = useState('');
      var [mfaRequired, setMfaRequired] = useState(false);

      var load = useCallback(function () {
        setBusy(true); setError('');
        return api()
          .then(function (snap) {
            setSnapshot(snap);
            var value = (snap && snap.settings && snap.settings.value) || EMPTY;
            setDraft(Object.assign({}, EMPTY, value));
          })
          .catch(function (e) {
            setError(e && e.message ? e.message : String(e));
          })
          .finally(function () { setBusy(false); });
      }, []);

      useEffect(function () { load(); }, [load]);

      if (draft === null) {
        return jsx('div', { className: 'garmin-coach-settings-card',
          children: jsx('p', { children: busy ? '加载中…' : (error || '加载中…') }) });
      }

      var update = function (patch) {
        setDraft(function (cur) { return Object.assign({}, cur, patch); });
      };

      var doSave = function () {
        setBusy(true); setError(''); setMessage('');
        var rev = snapshot && snapshot.settings ? snapshot.settings.revision : 0;
        var value = {
          email: draft.email,
          password: draft.password,
          isCn: !!draft.isCn,
          status: draft.status,
          displayName: draft.displayName,
          lastSyncAt: draft.lastSyncAt,
          syncDaysBack: Number(draft.syncDaysBack) || 14,
        };
        api('save', { value: value, expectedRevision: rev })
          .then(function (snap) {
            setSnapshot(snap);
            setMessage('配置已保存 ✓');
            // 保留密码明文展示（用户可确认已保存的密码）
            setDraft(function (cur) { return Object.assign({}, cur); });
          })
          .catch(function (e) {
            setError(e && e.message ? e.message : String(e));
          })
          .finally(function () { setBusy(false); });
      };

      var doSync = function () {
        setBusy(true); setError(''); setMessage('');
        api('sync', {})
          .then(function (body) {
            if (body && body.ok) {
              var result = body.result || {};
              setMessage('同步完成：新增活动 ' + (result.activitiesAdded || 0) + ' 条，健康数据 ' + (result.dailiesAdded || 0) + ' 天');
              load();
            } else {
              setError(body && body.message ? body.message : '同步失败');
            }
          })
          .catch(function (e) {
            setError(e && e.message ? e.message : String(e));
          })
          .finally(function () { setBusy(false); });
      };

      var doConnect = function () {
        setBusy(true); setError(''); setMessage('');
        api('connect', {
          email: draft.email,
          password: draft.password,
          mfaCode: mfaCode || undefined,
        })
          .then(function (body) {
            if (body && body.ok) {
              setMessage(body.alreadyConnected ? '已连接（无需重新登录）' : '已连接：' + (body.displayName || '成功'));
              setMfaRequired(false); setMfaCode('');
              // 连接成功后刷新状态
              load();
            } else if (body && body.mfaRequired) {
              setMfaRequired(true);
              setMessage('需要验证码：请查收手机短信，输入验证码后再次点击连接');
            } else {
              var msg = body && (body.message || (body.error && body.error.message));
              // 验证码失败：清空 mfaCode，提示用户可重新连接（重新连接才会再发一次验证码）
              if (mfaRequired || mfaCode) {
                setMfaRequired(false);
                setMfaCode('');
                setError((msg || '验证码验证失败') + '。如需重新发送验证码，请再次点击"连接 Garmin"。');
              } else if (msg) {
                setError(msg);
              } else if (body && body._status) {
                setError('连接失败（HTTP ' + body._status + '），请稍后重试');
              } else {
                setError('连接失败：请检查网络或稍后重试');
              }
            }
          })
          .catch(function (e) {
            setError(e && e.message ? e.message : String(e));
          })
          .finally(function () { setBusy(false); });
      };

      return jsxs('div', {
        className: 'garmin-coach-settings-card',
        children: [
          jsx('h3', { children: 'Garmin Coach' }),

          jsx('div', { style: { marginBottom: '8px' },
            children: [
              jsx('strong', { children: '连接状态：' }),
              jsx('span', { children: draft.status || 'disconnected' }),
            ] }),
          jsx('div', { style: { marginBottom: '12px' },
            children: [
              jsx('strong', { children: '当前用户：' }),
              jsx('span', { children: draft.displayName || '（未连接）' }),
            ] }),
          jsx('div', { style: { marginBottom: '12px' },
            children: [
              jsx('strong', { children: '上次同步：' }),
              jsx('span', { children: draft.lastSyncAt ? fmtSyncTime(draft.lastSyncAt) : '—（尚未同步）' }),
            ] }),

          // 区域选择
          jsx('label', { children: '账号区域' }),
          jsx('div', { style: { marginBottom: '8px' },
            children: [
              jsx('label', { style: { marginRight: '12px' }, children: [
                jsx('input', { type: 'radio', name: 'garmin-region', checked: !!draft.isCn,
                  onChange: function () { update({ isCn: true }); } }),
                ' 中国区 (garmin.cn)',
              ] }),
              jsx('label', { children: [
                jsx('input', { type: 'radio', name: 'garmin-region', checked: !draft.isCn,
                  onChange: function () { update({ isCn: false }); } }),
                ' 国际区 (garmin.com)',
              ] }),
            ] }),

          jsx('label', { htmlFor: 'garmin-email', children: 'Garmin 邮箱' }),
          jsx('input', {
            id: 'garmin-email', type: 'text', value: draft.email,
            placeholder: 'you@example.com',
            onChange: function (e) { update({ email: e.target.value }); },
            style: { width: '100%', marginBottom: '8px', padding: '6px', boxSizing: 'border-box' },
          }),
          jsx('label', { htmlFor: 'garmin-password', children: 'Garmin 密码' }),
          // 输入框内嵌眼睛（主流交互：眼睛在输入框内部右侧）
          jsx('div', { style: { position: 'relative', marginBottom: '8px' },
            children: [
              jsx('input', {
                id: 'garmin-password', type: showPassword ? 'text' : 'password', value: draft.password,
                placeholder: 'Garmin 账号密码',
                onChange: function (e) { update({ password: e.target.value }); },
                style: { width: '100%', padding: '6px 34px 6px 6px', boxSizing: 'border-box' },
              }),
              jsx('button', {
                type: 'button',
                onClick: function () { setShowPassword(!showPassword); },
                title: showPassword ? '隐藏密码' : '显示密码',
                'aria-label': showPassword ? '隐藏密码' : '显示密码',
                style: {
                  position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)',
                  padding: '2px', cursor: 'pointer', background: 'none', border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#888',
                },
                children: showPassword
                  // 眼睛关闭图标（斜线穿过眼睛）
                  ? jsx('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
                      children: [
                        jsx('path', { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' }),
                        jsx('path', { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68' }),
                        jsx('path', { d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' }),
                        jsx('line', { x1: '2', y1: '2', x2: '22', y2: '22' }),
                      ] })
                  // 眼睛睁开图标
                  : jsx('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
                      children: [
                        jsx('path', { d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z' }),
                        jsx('circle', { cx: '12', cy: '12', r: '3' }),
                      ] }),
              }),
            ] }),
          jsx('label', { htmlFor: 'garmin-days', children: '同步最近天数（1-90）' }),
          jsx('input', {
            id: 'garmin-days', type: 'number', min: '1', max: '90', value: draft.syncDaysBack,
            onChange: function (e) { update({ syncDaysBack: e.target.value }); },
            style: { width: '100%', marginBottom: '8px', padding: '6px', boxSizing: 'border-box' },
          }),
          // MFA 验证码输入（连接需要时显示）
          mfaRequired ? jsxs('div', { style: { marginTop: '12px' },
            children: [
              jsx('label', { htmlFor: 'garmin-mfa', children: '短信验证码' }),
              jsx('input', {
                id: 'garmin-mfa', type: 'text', value: mfaCode,
                placeholder: '输入手机收到的验证码',
                onChange: function (e) { setMfaCode(e.target.value); },
                style: { width: '100%', padding: '6px', boxSizing: 'border-box', marginBottom: '4px' },
              }),
            ] }) : null,

          jsx('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' },
            children: [
              jsx('button', {
                onClick: doConnect,
                disabled: busy || draft.status === 'connected',
                style: { padding: '8px 20px', cursor: 'pointer' },
                children: draft.status === 'connected'
                  ? '已连接 ✓'
                  : (busy ? '处理中…' : (mfaRequired ? '提交验证码' : '连接 Garmin')),
              }),
              jsx('button', {
                onClick: doSync, disabled: busy,
                style: { padding: '8px 20px', cursor: 'pointer' },
                children: '立即同步',
              }),
              jsx('button', {
                onClick: doSave, disabled: busy,
                style: { padding: '8px 20px', cursor: 'pointer' },
                children: '保存配置',
              }),
            ] }),

          jsx('div', { style: { marginTop: '10px' },
            children: [
              error ? jsx('p', { style: { color: '#c33', fontSize: '12px' }, children: error }) : null,
              message ? jsx('p', { style: { color: '#0a7a3a', fontSize: '12px' }, children: message }) : null,
            ] }),
        ],
      });
    }

    // ═══════════════════════════════════════════════════════
    //  Garmin Coach 看板（参考 task-board 的 DOM 覆盖方式）
    // ═══════════════════════════════════════════════════════

    // 看板 CSS
    var DASH_CSS =
      '[data-dsh-garmin-view]{z-index:60;background:var(--dsw-alias-bg-base);display:none;position:absolute;inset:0;overflow:auto}' +
      'html[data-dsh-garmin-active]:not([data-dsh-ssh-active]) [data-dsh-garmin-view]{display:block}' +
      'html[data-dsh-garmin-active]:not([data-dsh-ssh-active]) [data-pane=conversation]>:not([data-dsh-garmin-view]),' +
      'html[data-dsh-garmin-active]:not([data-dsh-ssh-active]) [class*=centerCol]>:not([data-dsh-garmin-view]){display:none!important}' +
      '[data-dsh-garmin-entry]{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 10px;font-size:13px;display:flex}' +
      '[data-dsh-garmin-entry]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
      '[data-dsh-garmin-entry][data-active]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}' +
      '.garmin-dash-entry-icon{flex:none;justify-content:center;align-items:center;width:24px;height:24px;display:inline-flex}' +
      '.garmin-dash-entry-icon svg{width:18px;height:18px;display:block}' +
      '.garmin-dash-entry-label{text-overflow:ellipsis;overflow:hidden}' +
      '[data-dsh-frame][data-sidebar-collapsed] [data-dsh-garmin-entry]{border-radius:50%;justify-content:center;width:36px;height:36px;margin:0 auto 12px;padding:0}' +
      '[data-dsh-frame][data-sidebar-collapsed] .garmin-dash-entry-label{display:none}' +
      '.garmin-dash{box-sizing:border-box;background:var(--dsw-alias-bg-base);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:16px;padding:20px 24px;display:flex;overflow-y:auto}' +
      '.garmin-dash-header{flex:none;align-items:center;gap:12px;display:flex}' +
      '.garmin-dash-title{color:var(--dsw-alias-label-primary);margin:0;font-size:20px;font-weight:700}' +
      '.garmin-dash-kpis{flex:none;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;display:grid}' +
      '.garmin-dash-kpi{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-direction:column;gap:4px;padding:14px;display:flex}' +
      '.garmin-dash-kpi-label{color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.garmin-dash-kpi-value{color:var(--dsw-alias-label-primary);font-size:22px;font-weight:700}' +
      '.garmin-dash-section{flex:none;flex-direction:column;gap:8px;display:flex}' +
      '.garmin-dash-section-title{color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:600;margin:8px 0 0}' +
      '.garmin-dash-table{width:100%;border-collapse:collapse;font-size:13px}' +
      '.garmin-dash-table th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
      '.garmin-dash-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}' +
      '.garmin-dash-loading{color:var(--dsw-alias-label-tertiary);padding:40px;text-align:center}';

    function injectDashCss() {
      var id = 'dsh-garmin-coach-dashboard';
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-garmin-coach';
      tag.dataset.pluginCss = id;
      tag.textContent = DASH_CSS;
      document.head.appendChild(tag);
    }

    // 侧栏根（DOM 注入）
    function dashSidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
    }
    function dashNewSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (var i = 0; i < root.children.length; i++) {
        var c = root.children[i];
        if (c.tagName === 'BUTTON') return c;
      }
      return undefined;
    }
    function dashCreateEntry(label, onToggle) {
      var entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('data-dsh-garmin-entry', '');
      entry.setAttribute('data-dsh-plugin', 'dsh-garmin-coach');
      entry.setAttribute('data-dsh-part', 'sidebar-entry');
      entry.setAttribute('aria-label', label);
      entry.title = label;
      entry.innerHTML = '<span class="garmin-dash-entry-icon"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5c-3.5 0-6-2.5-6.5-6.5.5-4 3-6.5 6.5-6.5s6 2.5 6.5 6.5c-.5 4-3 6.5-6.5 6.5Z"/><path d="M8 4v3l2 2"/></svg></span><span class="garmin-dash-entry-label">' + label + '</span>';
      entry.addEventListener('click', onToggle);
      return entry;
    }
    function dashPlaceEntry(root, entry) {
      var button = dashNewSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement !== root) {
        var row = button.closest('[class*="logoRow"]');
        var base = (row !== null && row.parentElement === root) ? row : button;
        var family = Array.from(root.children).filter(function (el) {
          return el instanceof HTMLElement && el.matches('[data-dsh-garmin-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]');
        });
        var anchor = family.length > 0 ? family[0] : base.nextElementSibling;
        root.insertBefore(entry, anchor);
      }
      return true;
    }
    function dashMountSidebarEntry(isOpen, onToggle) {
      if (typeof document !== 'undefined' && document.querySelector('[data-dsh-garmin-entry]') !== null) return function () {};
      var entry = dashCreateEntry('Garmin Coach', onToggle);
      var root;
      var placed = false;
      var tryPlace = function () {
        if (root !== undefined && !root.isConnected) { root = undefined; placed = false; }
        if (placed) {
          if (document.body.contains(entry)) return;
          root = undefined; placed = false;
        }
        root = root ?? dashSidebarRoot();
        if (root === undefined) return;
        placed = dashPlaceEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };
      var waitObserver = new MutationObserver(tryPlace);
      waitObserver.observe(document.body, { childList: true, subtree: true });
      var rootObserver = new MutationObserver(function () {
        if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
        if (!root.contains(entry)) placed = dashPlaceEntry(root, entry);
      });
      var syncActive = function () {
        if (isOpen()) entry.dataset.active = 'true';
        else delete entry.dataset.active;
      };
      tryPlace();
      return function () {
        waitObserver.disconnect();
        rootObserver.disconnect();
        entry.remove();
      };
    }

    // 看板挂载（覆盖对话区）
    // 看板挂载管理器：打开时创建并渲染，关闭时卸载
    // 这样每次打开都是全新组件，useEffect 重新执行 → 数据总是最新
    function createDashBoardManager() {
      var root = null;
      var container = null;
      var mounted = false;
      var column = null;
      var waitObserver = null;

      var ensureColumn = function () {
        if (column !== null && column.isConnected) return true;
        column = document.querySelector('[data-pane="conversation"], [class*="centerCol"]');
        return column !== null && column !== undefined;
      };

      var mount = function (state, setState) {
        if (mounted) return;
        if (!ensureColumn()) return;
        container = document.createElement('div');
        container.dataset.dshGarminView = '';
        container.dataset.dshPlugin = 'dsh-garmin-coach';
        container.style.position = 'relative';
        column.appendChild(container);
        root = ReactDOM.createRoot(container);
        root.render(React.createElement(GarminDashboard, { state: state, setState: setState }));
        mounted = true;
      };

      var unmount = function () {
        if (!mounted) return;
        if (root) { root.unmount(); root = null; }
        if (container && container.parentElement) container.parentElement.removeChild(container);
        container = null;
        mounted = false;
      };

      // 等对话区挂载后再 mount（首次）
      waitObserver = new MutationObserver(function () {
        // 只在需要时 mount（打开状态）
      });
      waitObserver.observe(document.body, { childList: true, subtree: true });

      return { mount: mount, unmount: unmount, dispose: function () { if (waitObserver) waitObserver.disconnect(); } };
    }

    // ── GarminDashboard React 组件 ──
    function GarminDashboard(props) {
      var state = props.state;
      var setState = props.setState;
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(true);
      var [error, setError] = useState('');
      var [insights, setInsights] = useState(null);
      var [activityFilter, setActivityFilter] = useState('all');   // 运动类型筛选
      var [activitySort, setActivitySort] = useState('date');      // 排序：date/distance/pace/hr
      var [planOpen, setPlanOpen] = useState(trainingPlan && trainingPlan.progress && trainingPlan.progress.done > 0);  // 训练计划折叠状态

      // 运动类型中文化
      var SPORT_ZH = {
        running: '跑步', cycling: '骑行', swimming: '游泳',
        hiking: '徒步', walking: '步行', mountain_biking: '山地骑行',
        trail_running: '越野跑', mountaineering: '登山',
        strength_training: '力量训练', yoga: '瑜伽', pilates: '普拉提',
        elliptical: '椭圆机', rowing: '划船', paddling: '桨板',
        golf: '高尔夫', tennis: '网球', basketball: '篮球',
        soccer: '足球', baseball: '棒球', cross_country_skiing: '越野滑雪',
        alpine_skiing: '高山滑雪', snowboarding: '单板滑雪', snowshoeing: '雪鞋徒步',
        inline_skating: '直排轮', skateboarding: '滑板', climbing: '攀岩',
        sailing: '帆船', kayaking: '皮划艇', rafting: '漂流',
        fishing: '钓鱼', hunting: '狩猎', other: '其他'
      };
      var sportZH = function (s) {
        if (!s) return '—';
        return SPORT_ZH[s] || s.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      };

      // 每次打开看板都重新加载（mounted 标志避免卸载后 setState 警告）
      useEffect(function () {
        var mounted = true;
        fetch('/garmin-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'dashboard' }),
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (!mounted) return;
            if (body && body.ok && body.data) {
              setData(body.data);
            } else {
              setError((body && body.message) || '看板数据加载失败');
            }
          })
          .catch(function (e) { if (mounted) setError(e.message || String(e)); })
          .finally(function () { if (mounted) setLoading(false); });
        return function () { mounted = false; };
      }, []);

      // AI 训练建议（每次打开重新加载）
      useEffect(function () {
        var mounted = true;
        fetch('/garmin-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'insights' }),
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (!mounted) return;
            if (body && body.ok && body.data) {
              setInsights(body.data);
            } else {
              setInsights([]);
            }
          })
          .catch(function () { if (mounted) setInsights([]); });
        return function () { mounted = false; };
      }, []);

      if (loading) return jsx('div', { className: 'garmin-dash', children: jsx('div', { className: 'garmin-dash-loading', children: '加载看板数据…' }) });
      if (error) return jsx('div', { className: 'garmin-dash', children: jsx('div', { className: 'garmin-dash-loading', children: '加载失败：' + error }) });
      if (!data) return null;

      var overview = data.overview || {};
      var recent = data.recent || [];
      var bestPaces = data.bestPaces || {};
      var health = data.health || {};
      var breakdown = data.sportBreakdown || [];
      var dailyRecent = data.dailyRecent || [];
      var paceByDist = data.paceByDistance || [];
      var paceDist = data.paceDistribution || [];
      var hrPace = data.hrPaceRelationship || [];
      var tLoad = data.trainingLoad || { totalLoad: 0, weeklyLoad: [], avgWeeklyLoad: 0 };
      var distDist = data.distanceDistribution || [];
      var wow = data.weekOverWeek || { thisWeek: { km: 0, runs: 0, avgPace: null, avgHr: null, load: 0 }, lastWeek: { km: 0, runs: 0, avgPace: null, avgHr: null, load: 0 }, kmChange: 0, runsChange: 0 };
      var cad = data.cadence || { avgCadence: null, byPace: [], distribution: [], trend: [] };
      var elev = data.elevation || { totalElevation: 0, byElevation: [], paceImpact: { flatPace: null, hillyPace: null, impact: '样本不足' } };
      var cals = data.calories || { totalCalories: 0, avgCalPerKm: null, trend: [] };
      var cons = data.consistency || { weeklyFrequency: [], longestStreak: 0, timeOfDay: [], weekdayDistribution: [] };
      var trainingPlan = data.trainingPlan || null;
      var diary = data.diary || [];

      var fmtPace = function (s) { return s && s !== '—' ? s : '—'; };
      var fmtTime = function (sec) {
        if (!sec) return '—';
        var totalMin = Math.round(sec / 60);
        if (totalMin < 1) return Math.round(sec) + 's';
        if (totalMin < 60) return totalMin + 'm';
        var h = Math.floor(totalMin / 60);
        var m = totalMin % 60;
        return h + 'h' + (m > 0 ? m + 'm' : '');
      };
      var fmtKm = function (v) { return v != null ? (typeof v === 'number' ? v.toFixed(1) : String(v)) : '0'; };
      // 打卡：切换训练任务完成状态，然后刷新看板
      var toggleTask = function (taskId) {
        fetch('/garmin-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'toggleTask', taskId: taskId }),
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body && body.ok) {
              // 直接更新本地 trainingPlan 的任务 done 状态（不重新拉数据，避免空白）
              setData(function (prev) {
                if (!prev || !prev.trainingPlan) return prev;
                var tasks = (prev.trainingPlan.tasks || []).map(function (t) {
                  if (t.id === taskId) return { ...t, done: body.task ? body.task.done : !t.done };
                  return t;
                });
                var doneCount = tasks.filter(function (t) { return t.done }).length;
                return {
                  ...prev,
                  trainingPlan: {
                    ...prev.trainingPlan,
                    tasks: tasks,
                    progress: { done: doneCount, total: tasks.length },
                  },
                };
              });
            } else {
              console.error('打卡失败:', body && body.message);
            }
          })
          .catch(function (e) { console.error('打卡失败:', e); });
      };
      var fmtDate = function (d) { return (d || '').slice(0, 10); };

      // 配速格式化（秒/km → X:XX/km）
      var paceStr = function (s) {
        if (!s) return '—';
        var m = Math.floor(s / 60), sec = Math.round(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec + '/km';
      };

      // PD / 5k / 10k 行
      var bestRow = function (key, label) {
        var b = bestPaces[key];
        if (!b) return null;
        var dist = b.distanceMeters ? fmtKm(b.distanceMeters / 1000) + 'km' : '—';
        var pace = b.avgPaceSecPerKm ? paceStr(b.avgPaceSecPerKm) : '—';
        var time = b.durationSec ? fmtTime(b.durationSec) : '—';
        return jsx('tr', { children: [
          jsx('td', { children: label }),
          jsx('td', { children: dist }),
          jsx('td', { children: time }),
          jsx('td', { children: pace }),
          jsx('td', { children: fmtDate(b.startTime) }),
        ] });
      };

      // 配速趋势（按月，从 recent 取）
      var paceTrend = (function () {
        var byMonth = {};
        recent.concat(data.weekly || []).forEach(function (a) {
          var m = (a.startTime || '').slice(0, 7);
          if (m && a.avgPaceSecPerKm) {
            if (!byMonth[m]) byMonth[m] = { sum: 0, n: 0 };
            byMonth[m].sum += a.avgPaceSecPerKm;
            byMonth[m].n += 1;
          }
        });
        return Object.keys(byMonth).sort().map(function (m) {
          return { month: m, avgPace: Math.round(byMonth[m].sum / byMonth[m].n), runs: byMonth[m].n };
        });
      })();

      // 跑量按月（从 recent）
      var distanceByMonth = (function () {
        var byMonth = {};
        recent.forEach(function (a) {
          var m = (a.startTime || '').slice(0, 7);
          if (m && a.distanceMeters) {
            if (!byMonth[m]) byMonth[m] = { km: 0, runs: 0 };
            byMonth[m].km += a.distanceMeters / 1000;
            byMonth[m].runs += 1;
          }
        });
        return Object.keys(byMonth).sort().map(function (m) {
          return { month: m, km: Math.round(byMonth[m].km * 10) / 10, runs: byMonth[m].runs };
        });
      })();

      // 心率区间统计（基于 avgHr）
      var hrZones = (function () {
        var z = { 'Zone 1 (恢复)': 0, 'Zone 2 (有氧)': 0, 'Zone 3 (节奏)': 0, 'Zone 4 (阈值)': 0, 'Zone 5 (无氧)': 0, '未知': 0 };
        recent.forEach(function (a) {
          var hr = a.avgHr;
          if (!hr) { z['未知']++; return; }
          if (hr < 130) z['Zone 1 (恢复)']++;
          else if (hr < 145) z['Zone 2 (有氧)']++;
          else if (hr < 160) z['Zone 3 (节奏)']++;
          else if (hr < 175) z['Zone 4 (阈值)']++;
          else z['Zone 5 (无氧)']++;
        });
        return Object.entries(z).map(function (e) { return { zone: e[0], count: e[1] }; });
      })();

      // 平均步频（from recent）
      var avgCadence = (function () {
        var c = [], n = 0;
        recent.forEach(function (a) { if (a.avgCadence) { c.push(a.avgCadence); n++; } });
        return n ? Math.round(c.reduce(function (s, x) { return s + x; }, 0) / n) : null;
      })();

      // 累计爬升（from recent）
      var totalElevation = (function () {
        var sum = 0;
        recent.forEach(function (a) { if (a.elevationGainMeters) sum += a.elevationGainMeters; });
        return Math.round(sum);
      })();

      // 健康数据汇总（最近 30 天）
      var healthHas = dailyRecent.length > 0;
      var healthKPI = (function () {
        if (!healthHas) return null;
        var steps = [], rhr = [], stress = [], bb = [];
        dailyRecent.forEach(function (dd) {
          if (dd.steps) steps.push(dd.steps);
          if (dd.restingHeartRate) rhr.push(dd.restingHeartRate);
          if (dd.stressAvg) stress.push(dd.stressAvg);
          if (dd.bodyBattery != null) bb.push(dd.bodyBattery);
        });
        var avg = function (a) { return a.length ? Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length) : null; };
        return {
          days: dailyRecent.length,
          avgSteps: avg(steps),
          avgRhr: avg(rhr),
          avgStress: avg(stress),
          avgBb: avg(bb),
        };
      })();

      return jsxs('div', { className: 'garmin-dash', children: [
        jsx('div', { className: 'garmin-dash-header', children: jsx('h2', { className: 'garmin-dash-title', children: '🏃 Garmin Coach 运动看板（上次同步：' + (overview.lastSyncAt ? fmtSyncTime(overview.lastSyncAt) : '—') + '）' })}),

        // ============ 运动总览 KPI ============
        jsx('div', { className: 'garmin-dash-kpis', children: [
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '总距离' }), jsx('span', { className: 'garmin-dash-kpi-value', children: fmtKm(overview.totalKm) + ' km' })] }),
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '总次数' }), jsx('span', { className: 'garmin-dash-kpi-value', children: String(overview.totalActivities) + ' 次' })] }),
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '跑步' }), jsx('span', { className: 'garmin-dash-kpi-value', children: String(overview.totalRuns) + ' 次' })] }),
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '总时长' }), jsx('span', { className: 'garmin-dash-kpi-value', children: fmtTime(overview.totalTimeSec) })] }),
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '最佳配速' }), jsx('span', { className: 'garmin-dash-kpi-value', children: fmtPace(overview.bestPace) })] }),
          jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '最长距离' }), jsx('span', { className: 'garmin-dash-kpi-value', children: fmtKm(overview.longestKm) + ' km' })] }),
        ] }),

        // ============ 健康数据 KPI（最近 30 天）============
        healthKPI && jsx(React.Fragment, { children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '❤️ 最近 ' + healthKPI.days + ' 天健康数据' }),
          jsx('div', { className: 'garmin-dash-kpis', children: [
            jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '日均步数' }), jsx('span', { className: 'garmin-dash-kpi-value', children: healthKPI.avgSteps ? (healthKPI.avgSteps + ' 步') : '—' })] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '静息心率' }), jsx('span', { className: 'garmin-dash-kpi-value', children: healthKPI.avgRhr ? (healthKPI.avgRhr + ' bpm') : '—' })] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '压力' }), jsx('span', { className: 'garmin-dash-kpi-value', children: healthKPI.avgStress ? (healthKPI.avgStress + ' /100') : '—' })] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: 'Body Battery' }), jsx('span', { className: 'garmin-dash-kpi-value', children: healthKPI.avgBb ? (healthKPI.avgBb + ' /100') : '—' })] }),
          ] }),
        ] }),

        // ============ AI 训练建议 ============
        (insights && insights.length > 0) && jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '🏃 AI 训练建议' }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, children: [
            insights.map(function (ins) {
              var sev = ins.severity || 'tip'
              var emoji = sev === 'warning' ? '🔴' : (sev === 'suggestion' ? '⚠️' : '💡')
              var borderColor = sev === 'warning' ? '#c33' : (sev === 'suggestion' ? '#d4a017' : '#0a7a3a')
              return jsxs('div', { style: {
                borderLeft: '3px solid ' + borderColor,
                background: 'var(--dsw-alias-bg-layer-2)',
                borderRadius: '6px',
                padding: '10px 14px',
                marginBottom: '6px',
              }, children: [
                jsx('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '4px' }, children: emoji + ' ' + ins.title }),
                jsx('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '1.5' }, children: ins.detail }),
              ] });
            }),
          ] }),
        ] }),

        // ============ 训练计划（打卡，可折叠）============
        trainingPlan && jsx('div', { className: 'garmin-dash-section', children: [
          jsxs('div', { onClick: function () { setPlanOpen(!planOpen); }, style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' }, children: [
            jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform 0.2s', transform: planOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block', width: '14px' }, children: '▶' }),
            jsx('span', { style: { fontWeight: '600', fontSize: '14px', color: 'var(--dsw-alias-label-primary)' }, children: '训练计划：' + trainingPlan.goal }),
            jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: '（打卡 ' + trainingPlan.progress.done + '/' + trainingPlan.progress.total + '）' }),
            (trainingPlan.progress.total > 0) && jsx('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, children: '完成率 ' + Math.round(trainingPlan.progress.done / trainingPlan.progress.total * 100) + '%' }),
          ] }),
          planOpen && jsxs(React.Fragment, { children: [
            (trainingPlan.tasks && trainingPlan.tasks.length > 0) && jsx('table', { className: 'garmin-dash-table', style: { marginTop: '8px' }, children: [
              jsx('thead', { children: jsx('tr', { children: [
                jsx('th', { children: '✓' }),
                jsx('th', { children: '周' }),
                jsx('th', { children: '训练' }),
                jsx('th', { children: '内容' }),
              ] }) }),
              jsx('tbody', { children: trainingPlan.tasks.map(function (task) {
                return jsx('tr', { children: [
                  jsx('td', { children: jsx('input', {
                    type: 'checkbox',
                    checked: !!task.done,
                    onChange: function () { toggleTask(task.id); },
                    style: { cursor: 'pointer', accentColor: 'var(--dsw-alias-state-success-primary)' },
                  }) }),
                  jsx('td', { children: '第' + task.week + '周 ' + task.day }),
                  jsx('td', { children: task.type }),
                  jsx('td', { children: task.detail }),
                ] });
              }) }),
            ] }),
            jsx('details', { style: { marginTop: '8px' }, children: [
              jsx('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: '查看完整计划' }),
              jsx('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', padding: '10px' }, children: trainingPlan.plan }),
            ] }),
            (trainingPlan.tips && trainingPlan.tips.length > 0) && jsx('div', { style: { marginTop: '8px' }, children: trainingPlan.tips.map(function (tip) {
              return jsx('p', { style: { margin: '2px 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: '💡 ' + tip });
            }) }),
          ] }),
        ] }),

        // ============ 打卡历史 + 训练日记时间线 ============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '📅 训练打卡与日记' }),
          // 打卡历史（本周）
          trainingPlan && trainingPlan.tasks && trainingPlan.tasks.length > 0 && jsx('div', { style: { marginBottom: '12px' }, children: [
            jsx('div', { style: { fontSize: '12px', fontWeight: '600', marginBottom: '6px', color: 'var(--dsw-alias-label-secondary)' }, children: '本周打卡' }),
            jsx('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, children: trainingPlan.tasks.map(function (task) {
              var emoji = task.done ? '✅' : '⬜';
              return jsx('span', { style: { fontSize: '11px', padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '6px', border: task.done ? '1px solid var(--dsw-alias-state-success-secondary)' : '1px solid var(--dsw-alias-border-l1)' }, children: emoji + ' ' + (task.day || '') + ' ' + task.type });
            }) }),
          ] }),
          // 日记时间线
          diary.length > 0 && jsxs(React.Fragment, { children: [
            jsx('div', { style: { fontSize: '12px', fontWeight: '600', margin: '12px 0 6px', color: 'var(--dsw-alias-label-secondary)' }, children: '训练日记（' + diary.length + ' 条）' }),
            jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '日期' }), jsx('th', { children: '训练' }), jsx('th', { children: '感受' }), jsx('th', { children: '评分' })] }) }),
              jsx('tbody', { children: diary.slice(0, 20).map(function (e) {
                var stars = e.rating ? '★'.repeat(e.rating) + '☆'.repeat(5 - e.rating) : '—';
                return jsx('tr', { children: [
                  jsx('td', { children: fmtDate(e.date) }),
                  jsx('td', { children: e.taskLabel || '—' }),
                  jsx('td', { children: e.feeling }),
                  jsx('td', { children: stars }),
                ] });
              }) }),
            ] }),
          ] }),
          // 无日记提示
          diary.length === 0 && jsx('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '8px' }, children: '还没有训练日记。训练后说"记录今天的训练：跑得怎么样"即可记一条。' }),
        ] }),

        // ============ 最佳成绩（PB）============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '🏆 最佳成绩（PR）' }),
          jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '距离' }), jsx('th', { children: '成绩' }), jsx('th', { children: '时间' }), jsx('th', { children: '配速' }), jsx('th', { children: '日期' })] }) }),
            jsx('tbody', { children: [bestRow('5k', '5 公里'), bestRow('10k', '10 公里'), bestRow('half', '半马')] }),
          ] }),
        ] }),

        // ============ 跑量按月 ============
        distanceByMonth.length > 0 && jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '📊 跑量（按月）' }),
          jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '月份' }), jsx('th', { children: '次数' }), jsx('th', { children: '距离(km)' })] }) }),
            jsx('tbody', { children: distanceByMonth.map(function (d) {
              return jsx('tr', { children: [
                jsx('td', { children: d.month }),
                jsx('td', { children: String(d.runs) }),
                jsx('td', { children: String(d.km) }),
              ] });
            }) }),
          ] }),
        ] }),

        // ============ 心率区间时长（按真实 hrTimeInZone_1~5）============
        data.hrZoneBreakdown && data.hrZoneBreakdown.totalSec > 0 && (function () {
          var hr = data.hrZoneBreakdown
          var zArr = [hr.totals.zone1, hr.totals.zone2, hr.totals.zone3, hr.totals.zone4, hr.totals.zone5]
          // 合并分类：Z1+Z2 = 低强度有氧，Z3+Z4+Z5 = 高强度/无氧
          var aerobicSec = zArr[0] + zArr[1]
          var anaerobicSec = zArr[2] + zArr[3] + zArr[4]
          return jsx('div', { className: 'garmin-dash-section', children: [
            jsx('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' }, children: [
              (function () {
                var pct = hr.totalSec > 0 ? (aerobicSec / hr.totalSec * 100).toFixed(1) : '0'
                return jsx('div', { className: 'garmin-dash-kpi', style: { flex: '1 1 180px', borderLeft: '4px solid #10b981' }, children: [
                  jsx('span', { className: 'garmin-dash-kpi-label', children: '🟢 有氧（Z1+Z2）' }),
                  jsx('span', { className: 'garmin-dash-kpi-value', children: (aerobicSec / 60).toFixed(1) + ' 分钟' }),
                  jsx('span', { className: 'garmin-dash-kpi-label', children: pct + '%' }),
                ] })
              })(),
              (function () {
                var pct = hr.totalSec > 0 ? (anaerobicSec / hr.totalSec * 100).toFixed(1) : '0'
                return jsx('div', { className: 'garmin-dash-kpi', style: { flex: '1 1 180px', borderLeft: '4px solid #ef4444' }, children: [
                  jsx('span', { className: 'garmin-dash-kpi-label', children: '🔴 高强度/无氧（Z3+Z4+Z5）' }),
                  jsx('span', { className: 'garmin-dash-kpi-value', children: (anaerobicSec / 60).toFixed(1) + ' 分钟' }),
                  jsx('span', { className: 'garmin-dash-kpi-label', children: pct + '%' }),
                ] })
              })(),
            ] }),
          ] })
        })(),

        // ============ 步频 & 爬升 ============
        (avgCadence || totalElevation > 0) && jsx(React.Fragment, { children: [
          jsx('div', { className: 'garmin-dash-kpis', children: [
            avgCadence && jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '平均步频' }), jsx('span', { className: 'garmin-dash-kpi-value', children: avgCadence + ' spm' })] }),
            totalElevation > 0 && jsx('div', { className: 'garmin-dash-kpi', children: [jsx('span', { className: 'garmin-dash-kpi-label', children: '累计爬升' }), jsx('span', { className: 'garmin-dash-kpi-value', children: totalElevation + ' m' })] }),
          ] }),
        ] }),

        // ============ 健康趋势（最近 30 天简表）============
        healthHas && jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '📈 健康趋势（最近 ' + healthKPI.days + ' 天）' }),
          jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '日期' }), jsx('th', { children: '步数' }), jsx('th', { children: '静息心率' }), jsx('th', { children: '压力' }), jsx('th', { children: 'Body Battery' })] }) }),
            jsx('tbody', { children: dailyRecent.slice(-14).map(function (dd) {
              return jsx('tr', { children: [
                jsx('td', { children: fmtDate(dd.date) }),
                jsx('td', { children: dd.steps ? dd.steps.toLocaleString() : '—' }),
                jsx('td', { children: dd.restingHeartRate ? String(dd.restingHeartRate) : '—' }),
                jsx('td', { children: dd.stressAvg != null ? String(dd.stressAvg) : '—' }),
                jsx('td', { children: dd.bodyBattery != null ? String(dd.bodyBattery) : '—' }),
              ] });
            }) }),
          ] }),
        ] }),

        // ============ 最近活动（支持筛选 + 排序）============
        jsxs('div', { className: 'garmin-dash-section', children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }, children: [
            jsx('h3', { style: { margin: '0', fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-secondary)' }, children: '📅 最近活动' }),
            // 运动类型筛选
            (function () {
              const sports = Array.from(new Set((recent || []).map(function (a) { return a.sport }).filter(Boolean)))
              return jsx('select', {
                value: activityFilter,
                onChange: function (e) { setActivityFilter(e.target.value); },
                style: { padding: '2px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-l1)' },
                children: [
                  jsx('option', { value: 'all', children: '全部类型' }),
                  sports.map(function (s) { return jsx('option', { value: s, children: sportZH(s) }) }),
                ],
              })
            })(),
            // 排序
            jsx('select', {
              value: activitySort,
              onChange: function (e) { setActivitySort(e.target.value); },
              style: { padding: '2px 6px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-l1)' },
              children: [
                jsx('option', { value: 'date', children: '按日期' }),
                jsx('option', { value: 'distance', children: '按距离' }),
                jsx('option', { value: 'pace', children: '按配速' }),
                jsx('option', { value: 'hr', children: '按心率' }),
              ],
            }),
          ] }),
          // 筛选 + 排序后的列表
          (function () {
            var filtered = (recent || []).filter(function (a) {
              return activityFilter === 'all' || a.sport === activityFilter
            })
            var sorted = filtered.slice().sort(function (a, b) {
              if (activitySort === 'distance') return (b.distanceMeters || 0) - (a.distanceMeters || 0)
              if (activitySort === 'pace') {
                var ap = a.avgPaceSecPerKm || 9999
                var bp = b.avgPaceSecPerKm || 9999
                return ap - bp
              }
              if (activitySort === 'hr') return (b.avgHr || 0) - (a.avgHr || 0)
              return (b.startTime || '').localeCompare(a.startTime || '')  // date 降序
            })
            if (sorted.length === 0) {
              return jsx('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '无符合条件的活动' })
            }
            return jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '日期' }), jsx('th', { children: '类型' }), jsx('th', { children: '时长' }), jsx('th', { children: '距离' }), jsx('th', { children: '配速' }), jsx('th', { children: '心率' }), jsx('th', { children: '卡路里' })] }) }),
              jsx('tbody', { children: sorted.map(function (a) {
                var det = data.hrZoneBreakdown && data.hrZoneBreakdown.details && data.hrZoneBreakdown.details.find(function (d) { return d.activityId === a.activityId })
                return jsxs(React.Fragment, { children: [
                  jsx('tr', { children: [
                    jsx('td', { children: fmtDate(a.startTime) }),
                    jsx('td', { children: sportZH(a.sport) }),
                    jsx('td', { children: a.durationSec ? jsxs(React.Fragment, { children: [
                      jsx('span', { children: fmtTime(a.durationSec) }),
                      jsx('span', { onClick: function () {
                        var el = document.getElementById('time-detail-' + a.activityId)
                        if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'table-row' : 'none'
                      }, style: { cursor: 'pointer', marginLeft: '6px', padding: '0 4px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px', fontSize: '11px' }, children: '+' }),
                    ] }) : '—' }),
                    jsx('td', { children: fmtKm((a.distanceMeters || 0) / 1000) + 'km' }),
                    jsx('td', { children: a.avgPaceSecPerKm ? paceStr(a.avgPaceSecPerKm) : '—' }),
                    jsx('td', { children: a.avgHr ? jsxs(React.Fragment, { children: [
                      jsx('span', { children: String(a.avgHr) }),
                      jsx('span', { onClick: function () {
                        var el = document.getElementById('hr-detail-' + a.activityId)
                        if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'table-row' : 'none'
                      }, style: { cursor: 'pointer', marginLeft: '6px', padding: '0 4px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px', fontSize: '11px' }, children: '+' }),
                    ] }) : '—' }),
                    jsx('td', { children: a.calories ? String(a.calories) : '—' }),
                  ] }),
                  // 时间详情行（点击 + 时展开，显示开始-结束时间）
                  jsx('tr', { id: 'time-detail-' + a.activityId, style: { display: 'none', background: 'var(--dsw-alias-bg-layer-2)' }, children: jsx('td', { colSpan: 7, style: { padding: '8px 12px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }, children: (function () {
                    if (!a.startTime) return '—'
                    var start = new Date(a.startTime)
                    var end = new Date(start.getTime() + (a.durationSec || 0) * 1000)
                    var fmt = function (d) {
                      var h = String(d.getHours()).padStart(2, '0')
                      var m = String(d.getMinutes()).padStart(2, '0')
                      return h + ':' + m
                    }
                    var dateStr = start.toISOString().slice(0, 10)
                    return jsxs(React.Fragment, { children: [
                      jsx('span', { style: { marginRight: '12px' }, children: '🕐 开始: ' + dateStr + ' ' + fmt(start) }),
                      jsx('span', { children: '结束: ' + fmt(end) }),
                    ] })
                  })() }) }),
                  det && jsx('tr', { id: 'hr-detail-' + a.activityId, style: { display: 'none', background: 'var(--dsw-alias-bg-layer-3)' }, children: jsx('td', { colSpan: 7, style: { padding: '8px 12px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }, children: jsxs(React.Fragment, { children: [
                    jsx('span', { style: { marginRight: '12px' }, children: '⏱ ' + (det.totalSec / 60).toFixed(1) + ' 分钟' }),
                    jsx('span', { style: { marginRight: '8px' }, children: 'Z1恢复 ' + (det.zones.zone1/60).toFixed(1) + 'm' }),
                    jsx('span', { style: { marginRight: '8px' }, children: 'Z2有氧 ' + (det.zones.zone2/60).toFixed(1) + 'm' }),
                    jsx('span', { style: { marginRight: '8px' }, children: 'Z3节奏 ' + (det.zones.zone3/60).toFixed(1) + 'm' }),
                    jsx('span', { style: { marginRight: '8px' }, children: 'Z4阈值 ' + (det.zones.zone4/60).toFixed(1) + 'm' }),
                    jsx('span', { children: 'Z5无氧 ' + (det.zones.zone5/60).toFixed(1) + 'm' }),
                  ] }) }) }),
                ] })
              })
            })
            ]})
          })()
        ] }),
        // ============ 周环比 ============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '📅 周环比（本周 vs 上周）' }),
          jsx('div', { className: 'garmin-dash-kpis', children: [
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '本周距离' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: wow.thisWeek.km + ' km' }),
              jsx('span', { className: 'garmin-dash-kpi-label', children: wow.kmChange > 0 ? ('↑ +' + wow.kmChange + '%') : (wow.kmChange < 0 ? ('↓ ' + wow.kmChange + '%') : '→ 0%') }),
            ] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '上周距离' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: wow.lastWeek.km + ' km' }),
            ] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '本周次数' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: String(wow.thisWeek.runs) }),
              jsx('span', { className: 'garmin-dash-kpi-label', children: wow.runsChange > 0 ? ('↑ +' + wow.runsChange) : (wow.runsChange < 0 ? ('↓ ' + wow.runsChange) : '→ 0') }),
            ] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '上周次数' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: String(wow.lastWeek.runs) }),
            ] }),
          ] }),
        ] }),

        // ============ TRIMP 训练负荷 ============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '🔥 训练负荷（TRIMP）' }),
          jsx('div', { className: 'garmin-dash-kpis', children: [
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '累计负荷' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: tLoad.totalLoad + ' TRIMP' }),
            ] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '周均负荷' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: tLoad.avgWeeklyLoad + ' TRIMP' }),
            ] }),
          ] }),
          tLoad.weeklyLoad.length > 0 && jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '周' }), jsx('th', { children: '训练负荷' }), jsx('th', { children: '总时长(分)' })] }) }),
            jsx('tbody', { children: tLoad.weeklyLoad.map(function (w) {
              return jsx('tr', { children: [
                jsx('td', { children: w.week }),
                jsx('td', { children: String(w.load) }),
                jsx('td', { children: String(w.durationMin) }),
              ] });
            }) }),
          ] }),
        ] }),

        // ============ 步频分析 ============
        cad.avgCadence !== null && jsxs(React.Fragment, { children: [
          jsx('div', { className: 'garmin-dash-section', children: [
            jsx('h3', { className: 'garmin-dash-section-title', children: '👟 步频分析' }),
            jsx('div', { className: 'garmin-dash-kpis', children: [
              jsx('div', { className: 'garmin-dash-kpi', children: [
                jsx('span', { className: 'garmin-dash-kpi-label', children: '平均步频' }),
                jsx('span', { className: 'garmin-dash-kpi-value', children: cad.avgCadence + ' spm' }),
              ] }),
            ] }),
            cad.byPace.length > 0 && jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '配速区间' }), jsx('th', { children: '次数' }), jsx('th', { children: '平均步频' })] }) }),
              jsx('tbody', { children: cad.byPace.map(function (c) {
                return jsx('tr', { children: [
                  jsx('td', { children: c.paceRange }),
                  jsx('td', { children: String(c.count) }),
                  jsx('td', { children: c.avgCadence ? (c.avgCadence + ' spm') : '—' }),
                ] });
              }) }),
            ] }),
          ] }),
        ] }),

        // ============ 卡路里效率 ============
        cals.avgCalPerKm !== null && jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '🔥 卡路里效率' }),
          jsx('div', { className: 'garmin-dash-kpis', children: [
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '总卡路里' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: cals.totalCalories + ' 千卡' }),
            ] }),
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '平均效率' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: cals.avgCalPerKm + ' 千卡/km' }),
            ] }),
          ] }),
          cals.trend.length > 0 && jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '月份' }), jsx('th', { children: '千卡/km' })] }) }),
            jsx('tbody', { children: cals.trend.map(function (t) {
              return jsx('tr', { children: [
                jsx('td', { children: t.month }),
                jsx('td', { children: t.calPerKm !== null ? String(t.calPerKm) : '—' }),
              ] });
            }) }),
          ] }),
        ] }),

        // ============ 训练一致性 ============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '🎯 训练一致性' }),
          jsx('div', { className: 'garmin-dash-kpis', children: [
            jsx('div', { className: 'garmin-dash-kpi', children: [
              jsx('span', { className: 'garmin-dash-kpi-label', children: '最长连续训练' }),
              jsx('span', { className: 'garmin-dash-kpi-value', children: cons.longestStreak + ' 天' }),
            ] }),
          ] }),
          cons.timeOfDay.length > 0 && jsxs(React.Fragment, { children: [
            jsx('h4', { style: { marginTop: '12px' }, children: '🕐 时段分布' }),
            jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '时段' }), jsx('th', { children: '次数' })] }) }),
              jsx('tbody', { children: cons.timeOfDay.map(function (t) {
                return jsx('tr', { children: [
                  jsx('td', { children: t.period }),
                  jsx('td', { children: String(t.count) }),
                ] });
              }) }),
            ] }),
          ] }),
          cons.weekdayDistribution.length > 0 && jsxs(React.Fragment, { children: [
            jsx('h4', { style: { marginTop: '12px' }, children: '📅 星期分布' }),
            jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '星期' }), jsx('th', { children: '次数' })] }) }),
              jsx('tbody', { children: cons.weekdayDistribution.map(function (d) {
                return jsx('tr', { children: [
                  jsx('td', { children: d.day }),
                  jsx('td', { children: String(d.count) }),
                ] });
              }) }),
            ] }),
          ] }),
        ] }),

        // ============ 运动类型分布 ============
        jsx('div', { className: 'garmin-dash-section', children: [
          jsx('h3', { className: 'garmin-dash-section-title', children: '📊 运动类型分布' }),
          jsx('table', { className: 'garmin-dash-table', children: [
            jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '类型' }), jsx('th', { children: '次数' }), jsx('th', { children: '距离' })] }) }),
            jsx('tbody', { children: breakdown.map(function (b) {
              return jsx('tr', { children: [jsx('td', { children: sportZH(b.sport) }), jsx('td', { children: String(b.count) }), jsx('td', { children: fmtKm(b.totalKm) + 'km' })] });
            }) }),
          ] }),
        ] })
      ] })
    }

    // ── apply ──
    function apply(rawCtx) {
      try {
        var ctx = rawCtx;
        if (!ctx || !ctx.slots || !ctx.slots.inject) {
          console.warn('[dsh-garmin-coach:client] ctx.slots.inject 不可用');
          return;
        }
        // 参考 dsh-email：注册 settings.section（侧栏导航）
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'garmin-coach',
            order: 50,
            label: function () { return 'Garmin Coach'; },
            locale: 'garmin-coach',
            inject: function () { return {}; },
          }, GarminSettingsSection);
        });
        console.info('[dsh-garmin-coach:client] settings.section registered');
      } catch (e) {
        console.error('[dsh-garmin-coach:client] apply failed', e);
      }

      // ═══ Garmin Coach 看板（侧栏入口 + 对话区覆盖层）═══
      try {
        injectDashCss();
        var dashState = { open: false };
        var dashListeners = [];
        var setDashOpen = function (open) {
          dashState.open = open;
          if (open) {
            document.documentElement.removeAttribute('data-dsh-ssh-active');
            document.documentElement.setAttribute('data-dsh-garmin-active', '');
            // 打开时挂载（每次全新组件 → 重新拉数据）
            dashMgr.mount(dashState, setDashOpen);
          } else {
            document.documentElement.removeAttribute('data-dsh-garmin-active');
            // 关闭时卸载（下次打开重新挂载刷新）
            dashMgr.unmount();
          }
          for (var i = 0; i < dashListeners.length; i++) dashListeners[i]();
        };
        var dashSubscribe = function (fn) {
          dashListeners.push(fn);
          return function () {
            var idx = dashListeners.indexOf(fn);
            if (idx >= 0) dashListeners.splice(idx, 1);
          };
        };
        var isOpen = function () { return dashState.open; };

        // 侧栏入口
        dashMountSidebarEntry(isOpen, function () {
          setDashOpen(!dashState.open);
        });

        // 看板管理器（打开挂载/关闭卸载）
        var dashMgr = createDashBoardManager();

        // 其他面板激活时关闭
        document.addEventListener('dsh-panel-activate', function (e) {
          if (e.detail === 'ssh' && dashState.open) setDashOpen(false);
        });
        document.addEventListener('click', function (e) {
          if (!dashState.open) return;
          var t = e.target;
          if (t && t.closest && t.closest('[class*="sessionRow"], [class*="projectRow"], [class*="newSession"]')) setDashOpen(false);
        }, true);

        console.info('[dsh-garmin-coach:client] 看板已挂载（侧栏入口 + 对话区覆盖层）');
      } catch (e) {
        console.error('[dsh-garmin-coach:client] 看板挂载失败', e);
      }
    }

    exports.apply = apply;
    exports.name = 'dsh-garmin-coach:client';
    exports.inject = ['slots'];
    return module.exports;
  },
});
