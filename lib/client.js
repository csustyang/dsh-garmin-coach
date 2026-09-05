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
    // 同步回看天数上限 30（与 src/storage.ts SYNC_DAYS_BACK_MAX 保持一致）
    var SYNC_DAYS_BACK_MAX = 30;
    var EMPTY = {
      email: '',
      password: '',
      isCn: true,
      status: 'disconnected',
      displayName: '',
      lastSyncAt: '',
      syncDaysBack: SYNC_DAYS_BACK_MAX,
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
      // 全量同步默认起点：距今 90 天前（与 src/index.ts FULL_SYNC_DEFAULT_DAYS 一致）
      var defaultFullSyncFrom = (function () {
        var d = new Date();
        d.setDate(d.getDate() - 90 + 1);
        return d.toISOString().slice(0, 10);
      })();
      var [fullSyncFrom, setFullSyncFrom] = useState(defaultFullSyncFrom);
      var [fullSyncBusy, setFullSyncBusy] = useState(false);
      var [fullSyncMsg, setFullSyncMsg] = useState('');

      var load = useCallback(function () {
        setBusy(true); setError('');
        return api()
          .then(function (snap) {
            setSnapshot(snap);
            var value = (snap && snap.settings && snap.settings.value) || EMPTY;
            // 从看板数据源补真实同步时间（garmin.json 的 lastSyncAt 是权威值）
            return fetch('/garmin-settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ action: 'dashboard' }),
            })
              .then(function (r) { return r.json(); })
              .then(function (db) {
                var dbSync = db && db.data && db.data.overview && db.data.overview.lastSyncAt;
                if (dbSync) value.lastSyncAt = dbSync;
                setDraft(Object.assign({}, EMPTY, value));
              })
              .catch(function () {
                // dashboard 拉取失败不影响 settings 展示
                setDraft(Object.assign({}, EMPTY, value));
              });
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
        // 安全：email/password 只保存在内存（draft）用于本次登录，绝不写入 settings
        var value = {
          isCn: !!draft.isCn,
          status: draft.status,
          displayName: draft.displayName,
          lastSyncAt: draft.lastSyncAt,
          syncDaysBack: Number(draft.syncDaysBack) || SYNC_DAYS_BACK_MAX,
        };
        api('save', { value: value, expectedRevision: rev })
          .then(function (snap) {
            setSnapshot(snap);
            if (snap && snap.accountChanged) {
              setMessage('配置已保存 ✓ 账号区域已变更，请重新点击「重新连接（验证 token）」');
            } else {
              setMessage('配置已保存 ✓');
            }
          })
          .catch(function (e) {
            setError(e && e.message ? e.message : String(e));
          })
          .finally(function () { setBusy(false); });
      };

      var doSync = function () {
        // 前端短路：未连接直接提示，不发请求（避免"同步完成 0 条"误导）
        if (draft.status !== 'connected') {
          setError('未连接佳明账号，请先点击「连接佳明」');
          return;
        }
        setBusy(true); setError(''); setMessage('');
        api('sync', {})
          .then(function (body) {
            if (body && body.ok) {
              var result = body.result || {};
              // 服务端同步失败（sync.ts 返回 synced:false）的兼容处理
              if (result && result.synced === false) {
                setError('同步失败：' + (result.error || '未知错误'));
              } else {
                setMessage('同步完成：新增活动 ' + (result.activitiesAdded || 0) + ' 条，健康数据 ' + (result.dailiesAdded || 0) + ' 天');
              }
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

      // 全量同步：从指定日期起，后台每 100 天一批拉取活动
      // 全量同步：启动后台任务 + 轮询进度实时显示
      var doSyncAll = function () {
        if (!fullSyncFrom) { setFullSyncMsg('请先选择起始日期'); return; }
        setFullSyncBusy(true); setFullSyncMsg('正在启动全量同步…');
        api('syncAll', { from: fullSyncFrom })
          .then(function (body) {
            if (body && body.ok) {
              if (body.message && body.message.indexOf('已在运行') !== -1) {
                setFullSyncMsg('全量同步已在运行中，继续等待…');
              }
              // 轮询进度（每 2 秒一次）
              var pollTimer = setInterval(function () {
                api('syncAllProgress', {})
                  .then(function (pb) {
                    if (!pb || !pb.ok || !pb.progress) return
                    var p = pb.progress
                    if (p.status === 'running') {
                      setFullSyncMsg('全量同步中… 第 ' + p.processed + '/' + p.total + ' 个窗口（每 100 天一批，随机间隔防限流）');
                      setFullSyncBusy(true)
                    } else if (p.status === 'done') {
                      clearInterval(pollTimer)
                      setFullSyncMsg('✅ 全量同步完成：已处理 ' + p.processed + '/' + p.total + ' 个窗口，新增活动 ' + (p.activitiesAdded || 0) + ' 条（共 ' + (p.activitiesTotal || 0) + ' 条）');
                      setFullSyncBusy(false)
                      load()
                    } else if (p.status === 'error' || p.status === 'paused') {
                      clearInterval(pollTimer)
                      setFullSyncMsg('⚠️ ' + (p.error || '全量同步中断') + '（30 分钟后可从断点续拉）');
                      setFullSyncBusy(false)
                    }
                  })
                  .catch(function () { /* 忽略轮询错误 */ })
              }, 2000)
              // 超时保护：10 分钟还没结束就停
              setTimeout(function () { clearInterval(pollTimer); }, 600000)
            } else {
              setFullSyncMsg(body && body.message ? ('全量同步失败：' + body.message) : '全量同步失败');
              setFullSyncBusy(false)
            }
          })
          .catch(function (e) {
            setFullSyncMsg(e && e.message ? ('全量同步失败：' + e.message) : '全量同步失败');
            setFullSyncBusy(false)
          });
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
              // 把 displayName + status 写回 settings（避免"已连接"但"当前用户"显示空）。
              // 安全：只写非敏感字段，email/password 绝不写回 settings
              var safeConnected = {
                isCn: !!draft.isCn,
                status: 'connected',
                displayName: body.displayName || draft.displayName || '',
                lastSyncAt: snapshot && snapshot.lastSyncAt ? snapshot.lastSyncAt : '',
                syncDaysBack: Number(draft.syncDaysBack) || SYNC_DAYS_BACK_MAX,
              };
              api('save', { value: safeConnected, expectedRevision: snapshot ? snapshot.revision : undefined })
                .then(function () { load(); })
                .catch(function (e) { console.error('写回连接状态失败:', e); load(); });
            } else if (body && body.mfaRequired) {
              setMfaRequired(true);
              setMessage('需要验证码：请查收手机短信，输入验证码后再次点击连接');
            } else {
              var msg = body && (body.message || (body.error && body.error.message));
              // 验证码失败：清空 mfaCode，提示用户可重新连接（重新连接才会再发一次验证码）
              if (mfaRequired || mfaCode) {
                setMfaRequired(false);
                setMfaCode('');
                setError((msg || '验证码验证失败') + '。如需重新发送验证码，请再次点击"连接佳明"。');
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

      var isConnected = draft.status === 'connected';

      return jsxs('div', {
        className: 'garmin-coach-settings-card',
        children: [
          // ─── 头部 ───
          jsxs('div', { className: 'garmin-card-header', children: [
            jsx('h3', { children: 'Garmin Coach' }),
            jsxs('div', { className: 'garmin-status-chip ' + (isConnected ? 'on' : 'off'), children: [
              jsx('span', { className: 'garmin-status-dot' }),
              jsx('span', { children: isConnected ? '已连接' : '未连接' }),
            ] }),
          ] }),

          // ─── KPI 行 ───
          jsx('div', { className: 'garmin-kpi-row', children: [
            jsxs('div', { className: 'garmin-kpi', children: [
              jsx('div', { className: 'garmin-kpi-label', children: '当前用户' }),
              jsx('div', { className: 'garmin-kpi-value', children: draft.displayName || '—' }),
            ] }),
            jsxs('div', { className: 'garmin-kpi', children: [
              jsx('div', { className: 'garmin-kpi-label', children: '上次同步' }),
              jsx('div', { className: 'garmin-kpi-value', children: draft.lastSyncAt ? fmtSyncTime(draft.lastSyncAt) : '—' }),
            ] }),
          ] }),

          jsx('div', { className: 'garmin-fade-divider' }),

          // ─── 账号区 ───
          jsx('div', { className: 'garmin-section-header', children: '账号' }),

          // 区域单选（segmented control 风格）
          jsx('div', { className: 'garmin-segmented', children: [
            jsx('button', {
              type: 'button',
              className: 'garmin-segment' + (draft.isCn ? ' active' : ''),
              onClick: function () { update({ isCn: true }); },
              children: '中国区',
            }),
            jsx('button', {
              type: 'button',
              className: 'garmin-segment' + (!draft.isCn ? ' active' : ''),
              onClick: function () { update({ isCn: false }); },
              children: '国际区',
            }),
          ] }),

          // 账号 + 密码 横排（island 输入框）
          jsx('div', { className: 'garmin-account-row', children: [
            jsxs('div', { className: 'garmin-field', children: [
              jsx('label', { htmlFor: 'garmin-email', children: 'Garmin 账号' }),
              jsx('input', {
                id: 'garmin-email', type: 'text', value: draft.email,
                placeholder: 'you@example.com',
                onChange: function (e) { update({ email: e.target.value }); },
              }),
            ] }),
            jsxs('div', { className: 'garmin-field', children: [
              jsx('label', { htmlFor: 'garmin-password', children: '密码' }),
              jsx('div', { className: 'garmin-input-with-action', children: [
                jsx('input', {
                  id: 'garmin-password', type: showPassword ? 'text' : 'password', value: draft.password,
                  placeholder: 'Garmin 账号密码',
                  onChange: function (e) { update({ password: e.target.value }); },
                }),
                jsx('button', {
                  type: 'button',
                  className: 'garmin-input-action',
                  onClick: function () { setShowPassword(!showPassword); },
                  title: showPassword ? '隐藏密码' : '显示密码',
                  'aria-label': showPassword ? '隐藏密码' : '显示密码',
                  children: showPassword
                    ? jsx('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
                        children: [
                          jsx('path', { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' }),
                          jsx('path', { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68' }),
                          jsx('path', { d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' }),
                          jsx('line', { x1: '2', y1: '2', x2: '22', y2: '22' }),
                        ] })
                    : jsx('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
                        children: [
                          jsx('path', { d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z' }),
                          jsx('circle', { cx: '12', cy: '12', r: '3' }),
                        ] }),
                }),
              ] }),
            ] }),
          ] }),
          jsx('div', { className: 'garmin-hint', children: '🔒 账号/密码仅用于本次登录，不会保存到本地；token 过期后需重新输入。' }),

          // MFA 验证码（连接需要时显示）
          mfaRequired ? jsxs('div', { className: 'garmin-field', style: { marginTop: '10px' }, children: [
            jsx('label', { htmlFor: 'garmin-mfa', children: '短信验证码' }),
            jsx('input', {
              id: 'garmin-mfa', type: 'text', value: mfaCode,
              placeholder: '输入手机收到的验证码',
              onChange: function (e) { setMfaCode(e.target.value); },
            }),
          ] }) : null,

          jsx('div', { className: 'garmin-fade-divider' }),

          // ─── 同步设置 ───
          jsx('div', { className: 'garmin-section-header', children: '同步' }),
          jsx('div', { className: 'garmin-sync-config-row', children: [
            jsxs('div', { className: 'garmin-field-inline', children: [
              jsx('label', { htmlFor: 'garmin-days', children: '同步最近天数' }),
              jsx('input', {
                id: 'garmin-days', type: 'number', min: '1', max: String(SYNC_DAYS_BACK_MAX), value: draft.syncDaysBack,
                onChange: function (e) { update({ syncDaysBack: e.target.value }); },
              }),
            ] }),
            jsx('button', {
              onClick: doSave, disabled: busy,
              className: 'garmin-btn garmin-btn-ghost',
              children: '保存配置',
            }),
            jsx('button', {
              onClick: doConnect,
              disabled: busy,
              className: 'garmin-btn garmin-btn-solid',
              children: busy ? '处理中…' : (mfaRequired ? '提交验证码' : (isConnected ? '重新连接' : '连接佳明')),
            }),
          ] }),

          jsx('div', { className: 'garmin-fade-divider' }),

          // ─── 数据区 ───
          jsx('div', { className: 'garmin-section-header', children: '数据' }),
          jsx('div', { className: 'garmin-sync-data-row', children: [
            jsx('button', {
              onClick: doSync, disabled: busy,
              className: 'garmin-btn garmin-btn-ghost',
              children: '立即同步（最近 ' + (draft.syncDaysBack || SYNC_DAYS_BACK_MAX) + ' 天）',
            }),
            jsxs('div', { className: 'garmin-field-inline', children: [
              jsx('label', { children: '全量起始' }),
              jsx('input', {
                type: 'date',
                value: fullSyncFrom,
                onChange: function (e) { setFullSyncFrom(e.target.value); },
              }),
            ] }),
            jsx('button', {
              onClick: doSyncAll, disabled: fullSyncBusy,
              className: 'garmin-btn garmin-btn-ghost',
              children: fullSyncBusy ? '同步中…' : '开始全量同步',
            }),
          ] }),
          jsx('div', { className: fullSyncMsg && fullSyncMsg.indexOf('失败') !== -1 ? 'garmin-sync-status error' : (fullSyncMsg ? 'garmin-sync-status success' : 'garmin-sync-status'), children: fullSyncMsg || ' ' }),

          jsx('div', { className: 'garmin-message-area', children: [
            error ? jsx('p', { className: 'garmin-msg error', children: error }) : null,
            message ? jsx('p', { className: 'garmin-msg success', children: message }) : null,
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
      '.garmin-dash-table th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);position:sticky;top:0;z-index:1}' +
      '.garmin-dash-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}' +
      '.garmin-dash-loading{color:var(--dsw-alias-label-tertiary);padding:40px;text-align:center}' +
      // ───────────  Settings card (方案 Y · 分层卡片)  ───────────
      '.garmin-coach-settings-card{background:var(--dsw-alias-bg-layer-2);border:none;border-radius:16px;padding:22px 24px;display:flex;flex-direction:column;gap:18px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.04)}' +
      // 头部：标题 + 状态 chip
      '.garmin-card-header{display:flex;align-items:center;justify-content:space-between;gap:12px}' +
      '.garmin-card-header h3{margin:0;font-size:17px;font-weight:700;letter-spacing:-.2px;color:var(--dsw-alias-label-primary)}' +
      '.garmin-status-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}' +
      '.garmin-status-chip .garmin-status-dot{width:7px;height:7px;border-radius:50%;background:#9aa0a6}' +
      '.garmin-status-chip.on{color:var(--dsw-alias-label-primary)}' +
      '.garmin-status-chip.on .garmin-status-dot{background:#46a758;box-shadow:0 0 0 3px rgba(70,167,88,.18)}' +
      '.garmin-status-chip.off .garmin-status-dot{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}' +
      // KPI 横排
      '.garmin-kpi-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.garmin-kpi{background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}' +
      '.garmin-kpi-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:500}' +
      '.garmin-kpi-value{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      // 渐隐分割线
      '.garmin-fade-divider{height:1px;background:linear-gradient(to right,transparent,var(--dsw-alias-border-l1) 18%,var(--dsw-alias-border-l1) 82%,transparent);margin:0}' +
      // Section header（大写小标题）
      '.garmin-section-header{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:1px;margin-top:-4px}' +
      // Segmented control（账号区域）
      '.garmin-segmented{display:inline-flex;background:var(--dsw-alias-bg-layer-1);border-radius:9px;padding:3px;gap:2px;width:fit-content}' +
      '.garmin-segment{padding:5px 14px;border:0;background:transparent;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary);border-radius:7px;transition:all .15s ease;font-weight:500}' +
      '.garmin-segment:hover{color:var(--dsw-alias-label-primary)}' +
      '.garmin-segment.active{background:var(--dsw-alias-bg-layer-3,#3a3d42);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
      // 输入框 island
      '.garmin-field{display:flex;flex-direction:column;gap:6px}' +
      '.garmin-field label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}' +
      '.garmin-field input{width:100%;padding:9px 12px;box-sizing:border-box;border:1px solid transparent;border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.04);transition:border-color .15s ease,box-shadow .15s ease}' +
      '.garmin-field input::placeholder{color:var(--dsw-alias-label-tertiary)}' +
      '.garmin-field input:hover{border-color:var(--dsw-alias-border-l1)}' +
      '.garmin-field input:focus{border-color:var(--dsw-alias-accent-color,#4a7dff);box-shadow:inset 0 1px 2px rgba(0,0,0,.04),0 0 0 3px rgba(74,125,255,.12)}' +
      // 输入框内嵌操作（密码眼睛）
      '.garmin-input-with-action{position:relative}' +
      '.garmin-input-with-action input{padding-right:34px}' +
      '.garmin-input-action{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:24px;height:24px;padding:0;cursor:pointer;background:transparent;border:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);border-radius:5px}' +
      '.garmin-input-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      // 账号密码横排
      '.garmin-account-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
      // 提示
      '.garmin-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:-2px}' +
      // 同步配置行
      '.garmin-sync-config-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}' +
      '.garmin-field-inline{display:flex;flex-direction:column;gap:6px;min-width:0}' +
      '.garmin-field-inline label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}' +
      '.garmin-field-inline input{padding:9px 12px;box-sizing:border-box;border:1px solid transparent;border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.04);transition:border-color .15s ease,box-shadow .15s ease}' +
      '.garmin-field-inline input[type=number]{width:72px}' +
      '.garmin-field-inline input[type=date]{width:150px;color-scheme:dark light}' +
      '.garmin-field-inline input:focus{border-color:var(--dsw-alias-accent-color,#4a7dff);box-shadow:inset 0 1px 2px rgba(0,0,0,.04),0 0 0 3px rgba(74,125,255,.12)}' +
      // 数据行（立即同步 + 全量）
      '.garmin-sync-data-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.garmin-sync-data-row .garmin-field-inline{flex-direction:row;align-items:center;gap:8px}' +
      '.garmin-sync-data-row .garmin-field-inline label{font-size:12px;color:var(--dsw-alias-label-secondary)}' +
      '.garmin-sync-data-row .garmin-field-inline input[type=date]{width:auto}' +
      // 按钮（三档）
      '.garmin-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid transparent;transition:transform .12s ease,background .15s ease,border-color .15s ease,opacity .15s ease;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);line-height:1}' +
      '.garmin-btn:hover:not(:disabled){transform:translateY(-1px)}' +
      '.garmin-btn:active:not(:disabled){transform:translateY(0)}' +
      '.garmin-btn:disabled{opacity:.45;cursor:not-allowed}' +
      // ghost（保存配置 / 立即同步 / 全量同步）
      '.garmin-btn-ghost{background:transparent;border-color:var(--dsw-alias-border-l1)}' +
      '.garmin-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}' +
      // solid（连接佳明 · 主操作）
      '.garmin-btn-solid{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent}' +
      '.garmin-btn-solid:hover:not(:disabled){filter:brightness(1.1)}' +
      // 状态文字
      '.garmin-sync-status{font-size:12px;color:var(--dsw-alias-label-secondary);min-height:16px;margin-top:-4px}' +
      '.garmin-sync-status.error{color:#e5484d}' +
      '.garmin-sync-status.success{color:#46a758}' +
      // 顶/底部消息区
      '.garmin-message-area{display:flex;flex-direction:column;gap:2px}' +
      '.garmin-msg{font-size:12px;margin:0;line-height:1.5}' +
      '.garmin-msg.error{color:#e5484d}' +
      '.garmin-msg.success{color:#46a758}' +
      // 旧元素隐藏（防止旧 className 残留样式干扰）
      '.garmin-settings-row,.garmin-settings-divider,.garmin-settings-section,.garmin-settings-section-title,.garmin-settings-actions,.garmin-sync-all-line,.garmin-mfa-row{display:none}';

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
      // Esc 关闭详情浮层
      useEffect(function () {
        var onKey = function (e) {
          if (e.key === 'Escape') {
            setDetailOpenId(null);
            setHealthDetailOpen(null);
            setHealthColEditor(false);
          }
        };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, []);
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(true);
      var [error, setError] = useState('');
      var [insights, setInsights] = useState(null);
      var [activityTab, setActivityTab] = useState(null);          // 最近活动 tab（按 parentTypeId 分组，null=读取 localStorage 或默认跑步）
      var [detailOpenId, setDetailOpenId] = useState(null);       // 最近活动详情展开的活动 id（null=收起）
      var [activitySort, setActivitySort] = useState('date');      // 排序：date/distance/pace/hr
      var [showLimit, setShowLimit] = useState(50);                // 最近活动显示条数（防卡顿，默认 50）
      var [showCols, setShowCols] = useState(null);                // 最近活动显示字段（null=默认）
      var [colEditor, setColEditor] = useState(false);             // 字段编辑面板开关
      var [planOpen, setPlanOpen] = useState(trainingPlan && trainingPlan.progress && trainingPlan.progress.done > 0);  // 训练计划折叠状态
      var [loadVisible, setLoadVisible] = useState(20);            // 训练负荷周表可见条数（增量加载）
      var [loadOpen, setLoadOpen] = useState(false);              // 训练负荷折叠（默认折叠）
      var [calVisible, setCalVisible] = useState(20);             // 卡路里效率趋势可见条数（增量加载）
      var [calOpen, setCalOpen] = useState(false);                // 卡路里效率折叠（默认折叠）
      var [weekdayOpen, setWeekdayOpen] = useState(true);         // 星期分布折叠（默认展开）
      var [sportOpen, setSportOpen] = useState(true);             // 运动类型分布折叠（默认展开）
      var [planTaskVisible, setPlanTaskVisible] = useState(20);   // 训练计划任务可见条数（增量滚动）
      var [mileageVisible, setMileageVisible] = useState(20);     // 跑量按月可见条数（增量滚动）
      var [healthVisible, setHealthVisible] = useState(20);       // 健康趋势可见条数（增量滚动）
      var [healthDetailOpen, setHealthDetailOpen] = useState(null); // 健康趋势详情浮层（null=关，值为日期字符串）
      var [healthColEditor, setHealthColEditor] = useState(false); // 健康趋势列编辑面板开关
      var [healthCols, setHealthCols] = useState(null);            // 健康趋势显示列（null=默认全部）

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
        fishing: '钓鱼', hunting: '狩猎', other: '其他',
        aerobic: '有氧', cardio: '有氧', indoor_cardio: '有氧', fitness: '健身', functional_fitness: '功能性训练',
        badminton: '羽毛球', squash: '壁球', table_tennis: '乒乓球', pickleball: '匹克球',
        volleyball: '排球', handball: '手球', boxing: '拳击', martial_arts: '武术',
        dance: '舞蹈', jump_rope: '跳绳', stair_stepper: '爬楼机', indoor_cycling: '室内骑行',
        treadmill_running: '跑步机', treadmill: '跑步机', track_running: '跑道跑', virtual_run: '虚拟跑步',
        stair_climbing: '爬楼梯', elliptical_training: '椭圆机', rowing_machine: '划船机',
        indoor_walking: '室内步行', indoor_running: '室内跑步', indoor_rowing: '室内划船'
      };
      var sportZH = function (s) {
        if (!s) return '—';
        return SPORT_ZH[s] || s.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      };

      // 轻量 Markdown 渲染（训练计划等 AI 生成内容）：支持 #/##/### 标题、- 列表、**加粗**、--- 分隔、普通段落
      var inlineMd = function (t) {
        // **加粗** → strong
        var parts = String(t).split(/\*\*([^*]+)\*\*/g)
        var out = []
        for (var i = 0; i < parts.length; i++) {
          if (parts[i] === '') continue
          if (i % 2 === 1) out.push(jsx('strong', { key: i, children: parts[i] }))
          else out.push(parts[i])
        }
        return out
      }
      var renderMarkdown = function (md) {
        if (!md) return null
        var lines = String(md).split('\n')
        var blocks = []
        var list = []
        var flushList = function () {
          if (list.length === 0) return
          blocks.push(jsx('ul', { key: blocks.length, style: { margin: '4px 0 8px', paddingLeft: '18px' }, children: list.map(function (li, i) { return jsx('li', { key: i, children: inlineMd(li) }) }) }))
          list = []
        }
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          var t = line.trim()
          if (t === '') { flushList(); continue }
          if (t === '---' || t === '***') { flushList(); blocks.push(jsx('div', { key: 'hr' + i, style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '8px 0' } })); continue }
          var h = t.match(/^(#{1,3})\s+(.*)$/)
          if (h) { flushList(); blocks.push(jsx('h' + h[1].length, { key: 'h' + i, style: { margin: '8px 0 4px', fontSize: h[1].length === 1 ? '15px' : (h[1].length === 2 ? '14px' : '13px'), fontWeight: '700', color: 'var(--dsw-alias-label-primary)' }, children: inlineMd(h[2]) })); continue }
          var li = t.match(/^[-*]\s+(.*)$/)
          if (li) { list.push(li[1]); continue }
          flushList()
          blocks.push(jsx('p', { key: 'p' + i, style: { margin: '4px 0', fontSize: '13px', lineHeight: '1.6', color: 'var(--dsw-alias-label-primary)' }, children: inlineMd(t) }))
        }
        flushList()
        return jsxs(React.Fragment, { children: blocks })
      }

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

      // ─── 最近活动可显示字段注册表（含爬升）───
      var COL_FIELDS = [
        { key: 'name',      label: '活动名称',   fixed: true,  render: function (a) { return jsxs(React.Fragment, { children: [
          a.isPR && jsx('span', { style: { marginRight: '4px', fontSize: '13px' }, title: '个人纪录（PR）', children: '🏅' }),
          jsx('span', { children: a.activityName || '—' }),
        ] }) } },
        { key: 'date',      label: '日期',       fixed: true,  render: function (a) { return fmtDate(a.startTime) } },
        { key: 'sport',     label: '类型',       fixed: true,  render: function (a) { return sportZH(a.sport) } },
        { key: 'duration',  label: '时间',       fixed: true,  render: function (a) { return a.durationSec ? fmtTime(a.durationSec) : '—' } },
        { key: 'distance',  label: '距离',       fixed: false, render: function (a) { return fmtKm((a.distanceMeters || 0) / 1000) + 'km' } },
        { key: 'pace',      label: '平均配速',   fixed: false, render: function (a) { return a.avgPaceSecPerKm ? paceStr(a.avgPaceSecPerKm) : '—' } },
        { key: 'speed',     label: '平均速度',   fixed: false, render: function (a) { return a.avgSpeedMps ? (a.avgSpeedMps * 3.6).toFixed(1) + ' km/h' : '—' } },
        { key: 'bestPace',  label: '最佳配速',   fixed: false, render: function (a) { return a.bestPaceSecPerKm ? paceStr(a.bestPaceSecPerKm) : '—' } },
        { key: 'gradePace', label: '坡度调整配速', fixed: false, render: function (a) { return a.gradeAdjustedPaceSecPerKm ? paceStr(a.gradeAdjustedPaceSecPerKm) : '—' } },
        { key: 'hr',        label: '平均心率',   fixed: false, render: function (a) { return a.avgHr ? String(a.avgHr) : '—' } },
        { key: 'maxHr',     label: '最大心率',   fixed: false, render: function (a) { return a.maxHr ? String(a.maxHr) : '—' } },
        { key: 'calories',  label: '热量消耗',   fixed: false, render: function (a) { return a.calories ? String(a.calories) : '—' } },
        { key: 'elevation', label: '累计爬升',   fixed: false, render: function (a) { return a.elevationGainMeters != null ? Math.round(a.elevationGainMeters) + 'm' : '—' } },
        { key: 'elevLoss',  label: '累计下降',   fixed: false, render: function (a) { return a.elevationLossMeters != null ? Math.round(a.elevationLossMeters) + 'm' : '—' } },
        { key: 'avgCadence', label: '平均步频',  fixed: false, render: function (a) { return a.avgCadence ? Math.round(a.avgCadence) + ' spm' : '—' } },
        { key: 'maxCadence', label: '最高步频',  fixed: false, render: function (a) { return a.maxCadence ? a.maxCadence + ' spm' : '—' } },
        { key: 'aerobic',   label: '有氧效果',   fixed: false, render: function (a) { return a.trainingEffect ? a.trainingEffect.toFixed(1) : '—' } },
        { key: 'stride',    label: '平均步长',   fixed: false, render: function (a) { return a.strideLengthCm != null ? a.strideLengthCm.toFixed(1) + ' cm' : '—' } },
        { key: 'vertOsc',   label: '平均垂直摆动', fixed: false, render: function (a) { return a.verticalOscillationCm != null ? a.verticalOscillationCm.toFixed(1) + ' cm' : '—' } },
        { key: 'vertRatio', label: '垂直步幅比', fixed: false, render: function (a) { return a.verticalRatioPct != null ? a.verticalRatioPct.toFixed(1) + ' %' : '—' } },
        { key: 'vo2max',   label: '最大摄氧量', fixed: false, render: function (a) { return a.vO2Max ? String(a.vO2Max) + ' ml/kg/min' : '—' } },
        { key: 'gct',      label: '平均触地时间', fixed: false, render: function (a) { return a.groundContactTimeMs != null ? Math.round(a.groundContactTimeMs) + ' ms' : '—' } },
        { key: 'anaero',   label: '无氧训练效果', fixed: false, render: function (a) { return a.anaerobicEffect ? a.anaerobicEffect.toFixed(1) : '—' } },
        { key: 'load',     label: '训练负荷',   fixed: false, render: function (a) { return a.trainingLoad ? String(Math.round(a.trainingLoad)) : '—' } },
        { key: 'avgPower', label: '平均功率',   fixed: false, render: function (a) { return a.avgPower ? a.avgPower + ' W' : '—' } },
        { key: 'maxPower', label: '最大功率',   fixed: false, render: function (a) { return a.maxPower ? a.maxPower + ' W' : '—' } },
        { key: 'normPower', label: '标准化功率', fixed: false, render: function (a) { return a.normPower ? a.normPower + ' W' : '—' } },
        { key: 'vigorous', label: '高强度时长', fixed: false, render: function (a) { return a.vigorousMinutes ? a.vigorousMinutes + ' min' : '—' } },
        { key: 'moderate', label: '中等强度时长', fixed: false, render: function (a) { return a.moderateMinutes ? a.moderateMinutes + ' min' : '—' } },
        { key: 'minTemp',  label: '最低温度',   fixed: false, render: function (a) { return a.minTemperature != null ? a.minTemperature + '°C' : '—' } },
        { key: 'maxTemp',  label: '最高温度',   fixed: false, render: function (a) { return a.maxTemperature != null ? a.maxTemperature + '°C' : '—' } },
      ];
      // 默认显示字段（8 个常用）：名称/日期/类型/时间/距离/平均配速/平均心率/平均步频
      // ── 活动详情分组配置（行尾 📊 按钮展开，按语义分类展示所有指标）──
      // 每项: { label 显示名, get 取值函数（返回格式化字符串或 '—'）}
      var DETAIL_GROUPS = [
        { label: '配速', items: [
          { label: '平均配速', dep: 'avgPaceSecPerKm', get: function (a) { return a.avgPaceSecPerKm ? paceStr(a.avgPaceSecPerKm) : '—' } },
          { label: '最佳配速', dep: 'bestPaceSecPerKm', get: function (a) { return a.bestPaceSecPerKm ? paceStr(a.bestPaceSecPerKm) : '—' } },
          { label: '平均坡度调整配速', dep: 'gradeAdjustedPaceSecPerKm', get: function (a) { return a.gradeAdjustedPaceSecPerKm ? paceStr(a.gradeAdjustedPaceSecPerKm) : '—' } },
        ] },
        { label: '速度', items: [
          { label: '平均速度', dep: 'avgSpeedMps', get: function (a) { return a.avgSpeedMps ? (a.avgSpeedMps * 3.6).toFixed(1) + ' km/h' : '—' } },
          { label: '最大速度', dep: 'maxSpeed', get: function (a) { return a.maxSpeed ? (a.maxSpeed * 3.6).toFixed(1) + ' km/h' : '—' } },
        ] },
        { label: '计时', items: [
          { label: '总时长', dep: 'durationSec', get: function (a) { return a.durationSec ? fmtTime(a.durationSec) : '—' } },
          { label: '移动时间', dep: 'movingDuration', get: function (a) { return a.movingDuration ? fmtTime(a.movingDuration) : '—' } },
          { label: '全程耗时', dep: 'elapsedDuration', get: function (a) { return a.elapsedDuration ? fmtTime(a.elapsedDuration) : '—' } },
        ] },
        { label: '心率', items: [
          { label: '平均心率', dep: 'avgHr', get: function (a) { return a.avgHr ? a.avgHr + ' bpm' : '—' } },
          { label: '最大心率', dep: 'maxHr', get: function (a) { return a.maxHr ? a.maxHr + ' bpm' : '—' } },
        ] },
        { label: '跑步动态', items: [
          { label: '平均步频', dep: 'avgCadence', get: function (a) { return a.avgCadence ? Math.round(a.avgCadence) + ' 步/分' : '—' } },
          { label: '最高步频', dep: 'maxCadence', get: function (a) { return a.maxCadence ? a.maxCadence + ' 步/分' : '—' } },
          { label: '平均步幅', dep: 'strideLengthCm', get: function (a) { return a.strideLengthCm ? (a.strideLengthCm / 100).toFixed(2) + ' m' : '—' } },
          { label: '平均垂直振幅', dep: 'verticalOscillationCm', get: function (a) { return a.verticalOscillationCm ? a.verticalOscillationCm.toFixed(1) + ' cm' : '—' } },
          { label: '平均垂直振幅比', dep: 'verticalRatioPct', get: function (a) { return a.verticalRatioPct ? a.verticalRatioPct.toFixed(1) + ' %' : '—' } },
          { label: '平均触地时间', dep: 'groundContactTimeMs', get: function (a) { return a.groundContactTimeMs != null ? Math.round(a.groundContactTimeMs) + ' ms' : '—' } },
        ] },
        { label: '海拔', items: [
          { label: '累计爬升', dep: 'elevationGainMeters', get: function (a) { return a.elevationGainMeters != null ? Math.round(a.elevationGainMeters) + ' m' : '—' } },
          { label: '累计下降', dep: 'elevationLossMeters', get: function (a) { return a.elevationLossMeters != null ? Math.round(a.elevationLossMeters) + ' m' : '—' } },
          { label: '最低海拔', dep: 'minElevation', get: function (a) { return a.minElevation != null ? Math.round(a.minElevation) + ' m' : '—' } },
          { label: '最高海拔', dep: 'maxElevation', get: function (a) { return a.maxElevation != null ? Math.round(a.maxElevation) + ' m' : '—' } },
        ] },
        { label: '训练效果', items: [
          { label: '有氧效果', dep: 'trainingEffect', get: function (a) { return a.trainingEffect ? a.trainingEffect.toFixed(1) : '—' } },
          { label: '无氧效果', dep: 'anaerobicEffect', get: function (a) { return a.anaerobicEffect ? a.anaerobicEffect.toFixed(1) : '—' } },
          { label: '训练负荷', dep: 'trainingLoad', get: function (a) { return a.trainingLoad ? String(Math.round(a.trainingLoad)) : '—' } },
        ] },
        { label: '功率', items: [
          { label: '平均功率', dep: 'avgPower', get: function (a) { return a.avgPower ? a.avgPower + ' W' : '—' } },
          { label: '最大功率', dep: 'maxPower', get: function (a) { return a.maxPower ? a.maxPower + ' W' : '—' } },
          { label: '标准化功率', dep: 'normPower', get: function (a) { return a.normPower ? a.normPower + ' W' : '—' } },
        ] },
        { label: '营养', items: [
          { label: '静息消耗', dep: 'bmrCalories', get: function (a) { return a.bmrCalories ? a.bmrCalories + ' 千卡' : '—' } },
          { label: '活动消耗', dep: 'calories', get: function (a) { return a.calories ? a.calories + ' 千卡' : '—' } },
        ] },
        { label: '强度活动', items: [
          { label: '适中', dep: 'moderateMinutes', get: function (a) { return a.moderateMinutes ? a.moderateMinutes + ' min' : '—' } },
          { label: '高强度', dep: 'vigorousMinutes', get: function (a) { return a.vigorousMinutes ? a.vigorousMinutes + ' min' : '—' } },
        ] },
        { label: '温度', items: [
          { label: '最低温度', dep: 'minTemperature', get: function (a) { return a.minTemperature != null ? a.minTemperature + '°C' : '—' } },
          { label: '最高温度', dep: 'maxTemperature', get: function (a) { return a.maxTemperature != null ? a.maxTemperature + '°C' : '—' } },
        ] },
      ];

      // ── 健康详情分组配置（行尾 📊 按钮展开，按语义分类展示所有健康指标）──
      // 每项: { label 显示名, items [{ label, dep, get }] }
      var HEALTH_DETAIL_GROUPS = [
        { label: '活动量', items: [
          { label: '步数', dep: 'steps', get: function (d) { return d.steps != null ? d.steps.toLocaleString() : '—' } },
          { label: '距离', dep: 'distanceMeters', get: function (d) { return d.distanceMeters != null ? (d.distanceMeters / 1000).toFixed(2) + ' km' : '—' } },
          { label: '活动消耗', dep: 'activeKilocalories', get: function (d) { return d.activeKilocalories != null ? Math.round(d.activeKilocalories) + ' 千卡' : '—' } },
          { label: '高强度时长', dep: 'highlyActiveSeconds', get: function (d) { return d.highlyActiveSeconds != null ? fmtTime(d.highlyActiveSeconds) : '—' } },
          { label: '活动时长', dep: 'activeSeconds', get: function (d) { return d.activeSeconds != null ? fmtTime(d.activeSeconds) : '—' } },
          { label: '久坐时长', dep: 'sedentarySeconds', get: function (d) { return d.sedentarySeconds != null ? fmtTime(d.sedentarySeconds) : '—' } },
          { label: '累计楼层', dep: 'floorsAscendedMeters', get: function (d) { return d.floorsAscendedMeters != null ? Math.round(d.floorsAscendedMeters) + ' m' : '—' } },
        ] },
        { label: '心率', items: [
          { label: '静息心率', dep: 'restingHeartRate', get: function (d) { return d.restingHeartRate != null ? d.restingHeartRate + ' bpm' : '—' } },
          { label: '最低心率', dep: 'minHeartRate', get: function (d) { return d.minHeartRate != null ? d.minHeartRate + ' bpm' : '—' } },
          { label: '最高心率', dep: 'maxHeartRate', get: function (d) { return d.maxHeartRate != null ? d.maxHeartRate + ' bpm' : '—' } },
          // 移除"平均心率"：Garmin 没直接给全天平均，旧代码用 minAvgHeartRate 是错的（minAvgHeartRate 是"最低活动段"平均）
        ] },
        { label: '压力', items: [
          { label: '平均压力', dep: 'stressAvg', get: function (d) { return (d.stressAvg != null && d.stressAvg > 0) ? d.stressAvg + ' /100' : '—' } },
          { label: '最大压力', dep: 'maxStressLevel', get: function (d) { return (d.maxStressLevel != null && d.maxStressLevel > 0) ? d.maxStressLevel + ' /100' : '—' } },
          // Garmin stressQualifier = 'UNKNOWN' 跟 stressAvg=-1 配套，表示"未检测到压力"，显示成 —
          { label: '压力状态', dep: 'stressQualifier', get: function (d) { return (d.stressQualifier && d.stressQualifier !== 'UNKNOWN') ? d.stressQualifier : '—' } },
        ] },
        { label: 'Body Battery', items: [
          { label: '当前电量', dep: 'bodyBattery', get: function (d) { return d.bodyBattery != null ? d.bodyBattery + ' /100' : '—' } },
        ] },
        { label: '睡眠', items: [
          { label: '睡眠时长', dep: 'sleepSeconds', get: function (d) { return d.sleepSeconds != null ? fmtTime(d.sleepSeconds) : '—' } },
          { label: '睡眠分', dep: 'sleepScore', get: function (d) { return d.sleepScore != null ? d.sleepScore + ' /100' : '—' } },
          { label: '深睡', dep: 'deepSleepSeconds', get: function (d) { return d.deepSleepSeconds != null ? fmtTime(d.deepSleepSeconds) : '—' } },
          { label: '浅睡', dep: 'lightSleepSeconds', get: function (d) { return d.lightSleepSeconds != null ? fmtTime(d.lightSleepSeconds) : '—' } },
          { label: 'REM 睡眠', dep: 'remSleepSeconds', get: function (d) { return d.remSleepSeconds != null ? fmtTime(d.remSleepSeconds) : '—' } },
          { label: '睡眠中清醒', dep: 'awakeSleepSeconds', get: function (d) { return d.awakeSleepSeconds != null ? fmtTime(d.awakeSleepSeconds) : '—' } },
          { label: '清醒次数', dep: 'awakeCount', get: function (d) { return d.awakeCount != null ? d.awakeCount + ' 次' : '—' } },
          { label: '午睡时长', dep: 'napSeconds', get: function (d) { return d.napSeconds != null ? fmtTime(d.napSeconds) : '—' } },
          { label: '夜间平均心率', dep: 'sleepAvgHeartRate', get: function (d) { return d.sleepAvgHeartRate != null ? d.sleepAvgHeartRate + ' bpm' : '—' } },
          { label: '静息心率', dep: 'restingHeartRate', get: function (d) { return d.restingHeartRate != null ? d.restingHeartRate + ' bpm' : '—' } },
          { label: '平均呼吸频率', dep: 'avgRespiration', get: function (d) { return d.avgRespiration != null ? d.avgRespiration + ' 次/分' : '—' } },
          { label: '最低呼吸频率', dep: 'lowestRespiration', get: function (d) { return d.lowestRespiration != null ? d.lowestRespiration + ' 次/分' : '—' } },
          { label: '平均夜间 HRV', dep: 'avgOvernightHrv', get: function (d) { return d.avgOvernightHrv != null ? d.avgOvernightHrv + ' ms' : '—' } },
          { label: '睡眠血氧均值', dep: 'averageSpO2', get: function (d) { return d.averageSpO2 != null ? d.averageSpO2 + ' %' : '—' } },
          { label: '睡眠血氧最低', dep: 'lowestSpO2', get: function (d) { return d.lowestSpO2 != null ? d.lowestSpO2 + ' %' : '—' } },
        ] },
      ];

      // 健康表默认显示列 + 全部可选列
      var HEALTH_DEFAULT_COLS = ['steps', 'restingHeartRate', 'minHeartRate', 'sleepSeconds'];
      var HEALTH_ALL_COLS = [
        { key: 'steps', label: '步数' },
        { key: 'restingHeartRate', label: '静息心率' },
        { key: 'minHeartRate', label: '最低心率' },
        { key: 'maxHeartRate', label: '最高心率' },
        { key: 'sleepSeconds', label: '睡眠时长' },
        { key: 'distanceMeters', label: '距离' },
        { key: 'activeKilocalories', label: '活动消耗' },
        { key: 'stressAvg', label: '压力' },
        { key: 'bodyBattery', label: 'Body Battery' },
        { key: 'sleepScore', label: '睡眠分' },
        // HRV/训练准备度 字段已停用（用户决定不存）—— 列编辑不再展示
        // 原 hrvStatus / hrvWeeklyAvg / readinessScore 3 行已删除
      ];
      var healthColKeys = healthCols || HEALTH_DEFAULT_COLS;

      // 健康表单元格渲染（按列 key 取值）
      var renderHealthCell = function (key, dd) {
        switch (key) {
          case 'steps': return dd.steps != null ? dd.steps.toLocaleString() : '—';
          case 'restingHeartRate': return dd.restingHeartRate != null ? String(dd.restingHeartRate) : '—';
          case 'stressAvg': return (dd.stressAvg != null && dd.stressAvg > 0) ? String(dd.stressAvg) : '—';
          case 'bodyBattery': return dd.bodyBattery != null ? String(dd.bodyBattery) : '—';
          case 'distanceMeters': return dd.distanceMeters != null ? (dd.distanceMeters / 1000).toFixed(2) + ' km' : '—';
          case 'activeKilocalories': return dd.activeKilocalories != null ? Math.round(dd.activeKilocalories) + ' kcal' : '—';
          case 'minHeartRate': return dd.minHeartRate != null ? String(dd.minHeartRate) : '—';
          case 'maxHeartRate': return dd.maxHeartRate != null ? String(dd.maxHeartRate) : '—';
          case 'sleepSeconds': return dd.sleepSeconds != null ? fmtTime(dd.sleepSeconds) : '—';
          case 'sleepScore': return dd.sleepScore != null ? String(dd.sleepScore) : '—';
          // HRV/readiness 已停用，原 case 移除
          default: return '—';
        }
      };

      // ── 最近活动 Tab 配置（按 parentTypeId 分组）──
      // 每个 tab 定义：分组名、图标、匹配的 parentTypeId（数组）、默认显示列
      var ACTIVITY_TABS = [
        // 按 parentTypeId 分组 + availableCols（该 tab 可用字段白名单，编辑面板只显示这些）
        { id: 'run',     label: '跑步',   icon: '🏃', parentIds: [17, 1], sports: ['running', 'treadmill_running', 'trail_running'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'pace', 'hr'], availableCols: ['name','date','sport','duration','distance','pace','bestPace','gradePace','speed','maxSpeed','hr','maxHr','calories','elevation','elevLoss','avgCadence','maxCadence','aerobic','anaero','stride','vertOsc','vertRatio','gct','load','avgPower','maxPower','normPower','vo2max','vigorous','moderate'], availableGroups: ['配速','速度','计时','心率','跑步动态','海拔','训练效果','功率','营养','强度活动'] },
        { id: 'walk',    label: '步行',   icon: '🚶', parentIds: [17], sports: ['walking'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'pace', 'hr', 'calories'], availableCols: ['name','date','sport','duration','distance','pace','bestPace','speed','maxSpeed','hr','maxHr','calories','elevation','elevLoss','avgCadence','maxCadence','stride','aerobic','anaero','load','vo2max','vigorous','moderate','minTemp','maxTemp'], availableGroups: ['配速','速度','计时','心率','跑步动态','海拔','训练效果','营养','强度活动','温度'] },
        { id: 'hike',    label: '徒步',   icon: '🏔️', parentIds: [17], sports: ['hiking'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'pace', 'hr', 'calories', 'elevation'], availableCols: ['name','date','sport','duration','distance','pace','bestPace','speed','maxSpeed','hr','maxHr','calories','elevation','elevLoss','avgCadence','maxCadence','stride','aerobic','anaero','load','vigorous','moderate','minTemp','maxTemp'], availableGroups: ['配速','速度','计时','心率','跑步动态','海拔','训练效果','营养','强度活动','温度'] },
        { id: 'ride',    label: '骑行',   icon: '🚴', parentIds: [17], sports: ['cycling'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'speed', 'hr', 'calories'], availableCols: ['name','date','sport','duration','distance','speed','maxSpeed','hr','maxHr','calories','elevation','elevLoss','aerobic','anaero','load','vigorous','moderate','minTemp','maxTemp'], availableGroups: ['速度','计时','心率','海拔','训练效果','营养','强度活动','温度'] },
        { id: 'mountain', label: '登山',   icon: '⛰️', parentIds: [4], sports: ['mountaineering'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'pace', 'hr', 'elevation'], availableCols: ['name','date','sport','duration','distance','pace','bestPace','speed','maxSpeed','hr','maxHr','calories','elevation','elevLoss','avgCadence','maxCadence','stride','aerobic','anaero','load','vigorous','moderate','minTemp','maxTemp'], availableGroups: ['配速','速度','计时','心率','跑步动态','海拔','训练效果','营养','强度活动','温度'] },
        { id: 'cardio',  label: '有氧',   icon: '🔥', parentIds: [29], sports: ['indoor_cardio'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'speed', 'hr', 'calories'], availableCols: ['name','date','sport','duration','distance','speed','hr','maxHr','calories','aerobic','anaero','load','vigorous','moderate','minTemp','maxTemp'], availableGroups: ['速度','计时','心率','训练效果','营养','强度活动','温度'] },
        { id: 'ball',    label: '球类',   icon: '🏸', parentIds: [219], sports: ['badminton'], defaultCols: ['name', 'date', 'sport', 'duration', 'distance', 'pace', 'hr', 'calories'], availableCols: ['name','date','sport','duration','distance','pace','bestPace','speed','maxSpeed','hr','maxHr','calories','avgCadence','maxCadence','stride','aerobic','anaero','load','vigorous','moderate'], availableGroups: ['配速','速度','计时','心率','跑步动态','训练效果','营养','强度活动'] },
      ];
      // 从数据动态检测存在的 tab（有活动才显示）
      var recentTabs = ACTIVITY_TABS.filter(function (tab) {
        return (recent || []).some(function (a) {
          return tab.parentIds.indexOf(a.parentTypeId) !== -1 && tab.sports.indexOf(a.sport) !== -1
        })
      });
      // 当前 tab：优先显式设置；否则 localStorage；否则第一个（默认跑步）
      var curTab = activityTab;
      if (!curTab) {
        var savedTab = null;
        try { savedTab = localStorage.getItem('garmin_activity_tab'); } catch (e) { savedTab = null; }
        var found = recentTabs.filter(function (t) { return t.id === savedTab })[0];
        curTab = found || recentTabs[0] || ACTIVITY_TABS[0];
      }
      var curTabObj = recentTabs.filter(function (t) { return t.id === curTab.id })[0] || curTab;
      var setTab = function (id) {
        var t = recentTabs.filter(function (x) { return x.id === id })[0];
        if (!t) return;
        setActivityTab(t);
        try { localStorage.setItem('garmin_activity_tab', t.id); } catch (e) {}
      };
      // 显示字段解析：按当前 tab 独立保存（garmin_dash_cols_<tabId>），无则用该 tab 默认列
      var tabColsKey = 'garmin_dash_cols_' + curTabObj.id;
      var colKeys = showCols;
      if (!colKeys) {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(tabColsKey) || 'null'); } catch (e) { saved = null; }
        colKeys = Array.isArray(saved) && saved.length > 0 ? saved : curTabObj.defaultCols.slice();
      }
      // 剔除不存在的 key（字段表变了也能兜底）+ 只保留当前 tab 可用字段
      colKeys = colKeys.filter(function (k) {
        return COL_FIELDS.some(function (f) { return f.key === k }) && curTabObj.availableCols.indexOf(k) !== -1
      });
      // 若过滤后为空，回退到该 tab 默认列
      if (colKeys.length === 0) colKeys = curTabObj.defaultCols.slice();
      // 编辑面板只展示当前 tab 可用字段
      var editableCols = COL_FIELDS.filter(function (f) { return curTabObj.availableCols.indexOf(f.key) !== -1 });
      var colMeta = colKeys.map(function (k) {
        for (var i = 0; i < COL_FIELDS.length; i++) if (COL_FIELDS[i].key === k) return COL_FIELDS[i];
        return null;
      }).filter(Boolean);
      var saveCols = function (keys) { setShowCols(keys); try { localStorage.setItem(tabColsKey, JSON.stringify(keys)); } catch (e) {} };
      // 拖拽排序
      var dragCol = null;
      var colDragStart = function (idx, e) { dragCol = idx; if (e && e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; };
      var colDrop = function (targetIdx, e) {
        e.preventDefault();
        if (dragCol === null || dragCol === targetIdx) { dragCol = null; return; }
        var keys = colKeys.slice();
        var moved = keys.splice(dragCol, 1)[0];
        keys.splice(targetIdx, 0, moved);
        saveCols(keys);
        dragCol = null;
      };
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
        // null/undefined 才算"无数据"，0 是合法值（"用户没动/没睡"）
        if (sec == null) return '—';
        if (sec === 0) return '0';
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
      // 按日期倒序（最新在上）—— 后端按 i=89→0 是升序，前端反转一下
      var dailyRecentDesc = dailyRecent.slice().sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      });
      var healthKPI = (function () {
        if (!healthHas) return null;
        var steps = [], rhr = [], stress = [], bb = [];
        dailyRecent.forEach(function (dd) {
          if (dd.steps) steps.push(dd.steps);
          if (dd.restingHeartRate) rhr.push(dd.restingHeartRate);
          // 过滤 -1（Garmin 压力未检测到的合法占位），不参与平均计算
          if (dd.stressAvg && dd.stressAvg !== -1) stress.push(dd.stressAvg);
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
            (trainingPlan.tasks && trainingPlan.tasks.length > 0) && jsxs(React.Fragment, { children: [
              jsx('div', {
                onScroll: function (e) {
                  var el = e.currentTarget
                  if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                    if (planTaskVisible < trainingPlan.tasks.length) {
                      setPlanTaskVisible(Math.min(planTaskVisible + 20, trainingPlan.tasks.length))
                    }
                  }
                },
                style: { maxHeight: '360px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', marginTop: '8px' },
                children: jsx('table', { className: 'garmin-dash-table', children: [
                  jsx('thead', { children: jsx('tr', { children: [
                    jsx('th', { children: '✓' }),
                    jsx('th', { children: '周' }),
                    jsx('th', { children: '训练' }),
                    jsx('th', { children: '内容' }),
                  ] }) }),
                  jsx('tbody', { children: trainingPlan.tasks.slice(0, planTaskVisible).map(function (task) {
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
              }),
              trainingPlan.tasks.length > 20 && jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(planTaskVisible, trainingPlan.tasks.length) + ' / ' + trainingPlan.tasks.length + ' 个任务（下拉加载更多）' }),
            ] }),
            jsx('details', { style: { marginTop: '8px' }, children: [
              jsx('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: '查看完整计划' }),
              jsx('div', { style: { fontSize: '13px', lineHeight: '1.6', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', padding: '12px' }, children: renderMarkdown(trainingPlan.plan) }),
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
          jsx('div', {
            onScroll: function (e) {
              var el = e.currentTarget
              if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                if (mileageVisible < distanceByMonth.length) {
                  setMileageVisible(Math.min(mileageVisible + 20, distanceByMonth.length))
                }
              }
            },
            style: { maxHeight: '320px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
            children: jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '月份' }), jsx('th', { children: '次数' }), jsx('th', { children: '距离(km)' })] }) }),
              jsx('tbody', { children: distanceByMonth.slice(0, mileageVisible).map(function (d) {
                return jsx('tr', { children: [
                  jsx('td', { children: d.month }),
                  jsx('td', { children: String(d.runs) }),
                  jsx('td', { children: String(d.km) }),
                ] });
              }) }),
            ] }),
          }),
          distanceByMonth.length > 20 && jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(mileageVisible, distanceByMonth.length) + ' / ' + distanceByMonth.length + ' 个月（下拉加载更多）' }),
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
          jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }, children: [
            jsx('h3', { className: 'garmin-dash-section-title', style: { margin: 0 }, children: '📈 健康趋势（最近 ' + healthKPI.days + ' 天）' }),
            // 编辑按钮（健康表显示列）
            jsx('button', {
              onClick: function () { setHealthColEditor(true); },
              title: '自定义显示列',
              style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: '15px', padding: '2px 6px', opacity: 0.75 },
              children: '✏️',
            }),
          ] }),
          jsx('div', {
            onScroll: function (e) {
              var el = e.currentTarget
              if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                if (healthVisible < dailyRecent.length) {
                  setHealthVisible(Math.min(healthVisible + 20, dailyRecent.length))
                }
              }
            },
            style: { maxHeight: '320px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
            children: jsx('table', { className: 'garmin-dash-table', children: [
              // 表头：日期 + 用户选的列 + 操作列
              jsx('thead', { children: jsx('tr', { children: [].concat(
                [jsx('th', { children: '日期' })],
                healthColKeys.map(function (k) {
                  var col = HEALTH_ALL_COLS.filter(function (c) { return c.key === k })[0];
                  return jsx('th', { children: col ? col.label : k });
                }),
                [jsx('th', { style: { textAlign: 'center', width: '40px' }, children: '' })]
              ) }) }),
              jsx('tbody', { children: dailyRecentDesc.slice(0, healthVisible).map(function (dd) {
                return jsx('tr', { children: [].concat(
                  [jsx('td', { children: fmtDate(dd.date) })],
                  healthColKeys.map(function (k) {
                    return jsx('td', { children: renderHealthCell(k, dd) });
                  }),
                  // 行尾：详情按钮
                  [jsx('td', { style: { textAlign: 'center' }, children: jsx('button', {
                    onClick: function () { setHealthDetailOpen(dd.date); },
                    title: '查看当日全部健康指标',
                    style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: '15px', padding: '2px 6px', opacity: 0.75 },
                    children: '📊',
                  }) })]
                ) });
              }) }),
            ] }),
          }),
          dailyRecent.length > 20 && jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(healthVisible, dailyRecent.length) + ' / ' + dailyRecent.length + ' 天（下拉加载更多）' }),
        ] }),

        // ============ 最近活动（Tab 切换 + 排序）============
        jsxs('div', { className: 'garmin-dash-section', children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }, children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [
              jsx('h3', { style: { margin: '0', fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-secondary)' }, children: '📅 最近活动' }),
              // 编辑按钮（自定义显示字段）
              jsx('button', {
                onClick: function () { setColEditor(true); },
                title: '自定义显示字段',
                style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: '15px', padding: '2px 6px', opacity: 0.75 },
                children: '✏️',
              }),
            ] }),
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
          // Tab 栏（图标在下方一行，只显示有数据的分组）
          recentTabs.length > 0 && jsx('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }, children: recentTabs.map(function (tab) {
            var active = curTabObj.id === tab.id
            return jsx('button', {
              key: tab.id,
              onClick: function () { setTab(tab.id); },
              style: {
                padding: '6px 14px', borderRadius: '20px', cursor: 'pointer', fontSize: '13px',
                border: active ? '1px solid var(--dsw-alias-accent-color,#4a7dff)' : '1px solid var(--dsw-alias-border-l1)',
                background: active ? 'var(--dsw-alias-accent-color,#4a7dff)' : 'var(--dsw-alias-bg-layer-2)',
                color: active ? '#fff' : 'var(--dsw-alias-label-primary)',
                fontWeight: active ? '600' : '400',
              },
              children: tab.icon + ' ' + tab.label,
            })
          }) }),
          // 筛选 + 排序后的列表
          (function () {
            var filtered = (recent || []).filter(function (a) {
              return curTabObj.parentIds.indexOf(a.parentTypeId) !== -1 && curTabObj.sports.indexOf(a.sport) !== -1
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
            var colSpanTotal = colMeta.length;
            return jsxs(React.Fragment, { children: [
            jsx('div', {
              onScroll: function (e) {
                var el = e.currentTarget
                if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                  if (showLimit < sorted.length) {
                    setShowLimit(Math.min(showLimit + 50, sorted.length))
                  }
                }
              },
              style: { maxHeight: '420px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
              children: jsx('table', { className: 'garmin-dash-table', children: [
              jsx('thead', { children: jsx('tr', { children: [
                colMeta.map(function (f) { return jsx('th', { key: f.key, children: f.label }) }),
              ] }) }),
              jsx('tbody', { children: sorted.slice(0, showLimit).map(function (a) {
                var det = data.hrZoneBreakdown && data.hrZoneBreakdown.details && data.hrZoneBreakdown.details.find(function (d) { return d.activityId === a.activityId })
                return jsxs(React.Fragment, { children: [
                  jsx('tr', { children: [
                    colMeta.map(function (f) {
                      // 时长字段保留 + 展开（开始/结束时间）
                      if (f.key === 'duration') {
                        return jsx('td', { key: f.key, children: a.durationSec ? jsxs(React.Fragment, { children: [
                          jsx('span', { children: fmtTime(a.durationSec) }),
                          jsx('span', { onClick: function () {
                            var el = document.getElementById('time-detail-' + a.activityId)
                            if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'table-row' : 'none'
                          }, style: { cursor: 'pointer', marginLeft: '6px', padding: '0 4px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px', fontSize: '11px' }, children: '+' }),
                        ] }) : '—' })
                      }
                      // 心率字段保留 + 展开（心率区间）
                      if (f.key === 'hr') {
                        return jsx('td', { key: f.key, children: a.avgHr ? jsxs(React.Fragment, { children: [
                          jsx('span', { children: String(a.avgHr) }),
                          jsx('span', { onClick: function () {
                            var el = document.getElementById('hr-detail-' + a.activityId)
                            if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'table-row' : 'none'
                          }, style: { cursor: 'pointer', marginLeft: '6px', padding: '0 4px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px', fontSize: '11px' }, children: '+' }),
                        ] }) : '—' })
                      }
                      return jsx('td', { key: f.key, children: f.render(a) })
                    }),
                    // 详情按钮（行尾）——打开页面中间浮层展示分组指标
                    jsx('td', { style: { textAlign: 'center' }, children: jsx('button', {
                      onClick: function () { setDetailOpenId(a.activityId); },
                      title: '查看详细指标',
                      style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: '15px', padding: '2px 6px', opacity: 0.75 },
                      children: '📊',
                    }) }),
                  ] }),
                  // 时间详情行（点击 + 时展开，显示开始-结束时间）
                  jsx('tr', { id: 'time-detail-' + a.activityId, style: { display: 'none', background: 'var(--dsw-alias-bg-layer-2)' }, children: jsx('td', { colSpan: colSpanTotal, style: { padding: '8px 12px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }, children: (function () {
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
                  det && jsx('tr', { id: 'hr-detail-' + a.activityId, style: { display: 'none', background: 'var(--dsw-alias-bg-layer-3)' }, children: jsx('td', { colSpan: colSpanTotal, style: { padding: '8px 12px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }, children: jsxs(React.Fragment, { children: [
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
              ] })
            }),
            jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(showLimit, sorted.length) + ' / ' + sorted.length + ' 条活动（下拉加载更多）' }),
            ] })
          })()
        ] }),

        // ============ 活动详情浮层（行尾 📊 点击，页面中间展示分组指标）============
        detailOpenId && (function () {
          var detailAct = (recent || []).filter(function (x) { return String(x.activityId) === String(detailOpenId) })[0]
          if (!detailAct) return null
          var closeDetail = function () { setDetailOpenId(null) }
          return jsx('div', {
            style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
            onClick: function (e) { if (e.target === e.currentTarget) closeDetail(); },
            children: jsx('div', {
              style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px', padding: '18px', width: '560px', maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
              children: [
                jsx('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }, children: [
                  jsx('h3', { style: { margin: '0', fontSize: '15px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }, children: (detailAct.isPR ? '🏅 ' : '') + (detailAct.activityName || '活动详情') + ' · ' + sportZH(detailAct.sport) }),
                  jsx('span', { onClick: closeDetail, style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '20px', lineHeight: '1' }, children: '✕' }),
                ] }),
                jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '10px' }, children: DETAIL_GROUPS.filter(function (g) { return curTabObj.availableGroups.indexOf(g.label) !== -1 }).map(function (g) {
                  // 只展示该活动实际同步到的字段（无该字段的 item 直接隐藏）
                  var items = g.items.filter(function (it) { return detailAct[it.dep] != null })
                  if (items.length === 0) return null
                  return jsx('div', { key: g.label, style: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px', padding: '10px 12px' }, children: [
                    jsx('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }, children: g.label }),
                    items.map(function (it) {
                      return jsx('div', { key: it.label, style: { fontSize: '13px', display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0' }, children: [
                        jsx('span', { style: { color: 'var(--dsw-alias-label-secondary)' }, children: it.label }),
                        jsx('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: '600' }, children: it.get(detailAct) }),
                      ] })
                    }),
                  ] })
                }) }),
                jsx('div', { style: { marginTop: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, children: '点击遮罩或 ✕ 关闭' }),
              ],
            }),
          })
        })(),

        // ============ 字段编辑面板（最近活动自定义显示字段 + 拖拽排序）============
        colEditor && jsx('div', {
          style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
          onClick: function (e) { if (e.target === e.currentTarget) setColEditor(false); },
          children: jsx('div', {
            style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px', padding: '18px', width: '420px', maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' },
            children: [
              jsx('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }, children: [
                jsx('h3', { style: { margin: '0', fontSize: '15px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }, children: '✏️ 自定义显示字段' }),
                jsx('span', { onClick: function () { setColEditor(false); }, style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '18px' }, children: '✕' }),
              ] }),
              jsx('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: '0 0 12px' }, children: '勾选要显示的指标，拖动 ≡ 调整顺序' }),
              jsx('div', { children: editableCols.map(function (f, idx) {
                var on = colKeys.indexOf(f.key) !== -1
                return jsx('div', {
                  key: f.key,
                  draggable: on ? true : undefined,
                  onDragStart: on ? function (e) { colDragStart(idx, e); } : undefined,
                  onDragOver: on ? function (e) { e.preventDefault(); } : undefined,
                  onDrop: on ? function (e) { colDrop(idx, e); } : undefined,
                  style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '8px', marginBottom: '4px', background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', border: '1px solid ' + (on ? 'var(--dsw-alias-border-l1)' : 'transparent'), cursor: on ? 'grab' : 'default', opacity: on ? 1 : 0.55 },
                  children: [
                    jsx('span', { style: { cursor: 'grab', color: 'var(--dsw-alias-label-tertiary)' }, children: '≡' }),
                    jsx('input', {
                      type: 'checkbox',
                      checked: on,
                      onChange: function () {
                        var keys = colKeys.slice()
                        if (on) {
                          keys.splice(keys.indexOf(f.key), 1)
                        } else {
                          keys.push(f.key)
                        }
                        saveCols(keys)
                      },
                    }),
                    jsx('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }, children: f.label }),
                  ],
                })
              }) }),
              jsx('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end' }, children: [
                jsx('button', {
                  onClick: function () {
                    saveCols(curTabObj.defaultCols.slice())
                  },
                  style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', cursor: 'pointer' },
                  children: '恢复默认',
                }),
                jsx('button', {
                  onClick: function () { setColEditor(false); },
                  style: { padding: '6px 14px', borderRadius: '8px', border: 'none', background: 'var(--dsw-alias-accent-color, #4a7dff)', color: '#fff', fontSize: '13px', cursor: 'pointer' },
                  children: '完成',
                }),
              ] }),
            ],
          }),
        }),

        // ============ 健康详情浮层（行尾 📊 点击，页面中间展示分组指标）============
        healthDetailOpen && (function () {
          var dd = (data && data.dailyRecent || []).filter(function (x) { return x.date === healthDetailOpen })[0];
          if (!dd) { setHealthDetailOpen(null); return null; }
          return jsx('div', {
            onClick: function (e) { if (e.target === e.currentTarget) setHealthDetailOpen(null); },
            style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' },
            children: jsx('div', {
              style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px', padding: '18px', width: '560px', maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
              children: jsxs('div', { children: [
                jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }, children: [
                  jsx('h3', { style: { margin: '0', fontSize: '15px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }, children: '❤️ 健康详情 · ' + fmtDate(dd.date) }),
                  jsx('span', { onClick: function () { setHealthDetailOpen(null); }, style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '18px' }, children: '✕' }),
                ] }),
                jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }, children: HEALTH_DETAIL_GROUPS.map(function (g) {
                  // 仅显示该组有至少 1 个真实值的项
                  var visibleItems = g.items.filter(function (it) {
                    var v = dd[it.dep];
                    // stressAvg / maxStressLevel：<= 0 是 Garmin UNKNOWN 占位，不算有值
                    if (it.dep === 'stressAvg' || it.dep === 'maxStressLevel') return v != null && v > 0;
                    // stressQualifier='UNKNOWN' 也是"未检测到压力"，不算有值
                    if (it.dep === 'stressQualifier') return v != null && v !== 'UNKNOWN';
                    return v != null;
                  });
                  if (visibleItems.length === 0) return null;
                  return jsxs('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '10px', background: 'var(--dsw-alias-bg-layer-2)' }, children: [
                    jsx('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' }, children: g.label }),
                    jsx('div', { style: { display: 'grid', gap: '4px' }, children: visibleItems.map(function (it) {
                      return jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' }, children: [
                        jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary)' }, children: it.label }),
                        jsx('span', { style: { fontWeight: '500', color: 'var(--dsw-alias-label-primary)' }, children: it.get(dd) }),
                      ] });
                    }) }),
                  ] });
                }) }),
              ] }),
            }),
          });
        })(),

        // ============ 健康列编辑面板（自定义健康表显示列）============
        healthColEditor && jsx('div', {
          onClick: function (e) { if (e.target === e.currentTarget) setHealthColEditor(false); },
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' },
          children: jsx('div', {
            style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px', padding: '18px', width: '420px', maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' },
            children: jsxs('div', { children: [
              jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }, children: [
                jsx('h3', { style: { margin: '0', fontSize: '15px', fontWeight: '600' }, children: '✏️ 自定义健康表显示列' }),
                jsx('span', { onClick: function () { setHealthColEditor(false); }, style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '18px' }, children: '✕' }),
              ] }),
              jsx('div', { style: { display: 'grid', gap: '6px', marginBottom: '12px' }, children: HEALTH_ALL_COLS.map(function (c) {
                var checked = healthColKeys.indexOf(c.key) !== -1;
                return jsx('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', background: checked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' }, children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: checked,
                    onChange: function (e) {
                      var next = healthColKeys.slice();
                      if (e.target.checked) {
                        if (next.indexOf(c.key) === -1) next.push(c.key);
                      } else {
                        // 至少保留 1 列
                        if (next.length > 1) next = next.filter(function (k) { return k !== c.key });
                      }
                      setHealthCols(next);
                    },
                  }),
                  jsx('span', { style: { fontSize: '13px' }, children: c.label }),
                ] });
              }) }),
              jsxs('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end' }, children: [
                jsx('button', {
                  onClick: function () { setHealthCols(null); },
                  style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', cursor: 'pointer' },
                  children: '恢复默认',
                }),
                jsx('button', {
                  onClick: function () { setHealthColEditor(false); },
                  style: { padding: '6px 14px', borderRadius: '8px', border: 'none', background: 'var(--dsw-alias-accent-color, #4a7dff)', color: '#fff', fontSize: '13px', cursor: 'pointer' },
                  children: '完成',
                }),
              ] }),
            ] }),
          }),
        }),

        // ============ 周环比 ===========
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
          jsx('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, onClick: function () { setLoadOpen(!loadOpen); }, children: [
            jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: loadOpen ? '▼' : '▶' }),
            jsx('h3', { className: 'garmin-dash-section-title', children: '🔥 训练负荷（TRIMP）' }),
          ] }),
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
          loadOpen && tLoad.weeklyLoad.length > 0 && jsxs(React.Fragment, { children: [
            jsx('div', {
              onScroll: function (e) {
                var el = e.currentTarget
                // 接近底部（剩余 <40px）且还有未加载数据 → 增量加载 20 条
                if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                  if (loadVisible < tLoad.weeklyLoad.length) {
                    setLoadVisible(Math.min(loadVisible + 20, tLoad.weeklyLoad.length))
                  }
                }
              },
              style: { maxHeight: '320px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
              children: jsx('table', { className: 'garmin-dash-table', children: [
                jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '周' }), jsx('th', { children: '训练负荷' }), jsx('th', { children: '总时长(分)' })] }) }),
                jsx('tbody', { children: tLoad.weeklyLoad.slice(0, loadVisible).map(function (w) {
                  return jsx('tr', { children: [
                    jsx('td', { children: w.week }),
                    jsx('td', { children: String(w.load) }),
                    jsx('td', { children: String(w.durationMin) }),
                  ] });
                }) }),
              ] }),
            }),
            jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(loadVisible, tLoad.weeklyLoad.length) + ' / ' + tLoad.weeklyLoad.length + ' 周（下拉加载更多）' }),
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
          jsx('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, onClick: function () { setCalOpen(!calOpen); }, children: [
            jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: calOpen ? '▼' : '▶' }),
            jsx('h3', { className: 'garmin-dash-section-title', children: '🔥 卡路里效率' }),
          ] }),
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
          calOpen && cals.trend.length > 0 && jsxs(React.Fragment, { children: [
            jsx('div', {
              onScroll: function (e) {
                var el = e.currentTarget
                if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                  if (calVisible < cals.trend.length) {
                    setCalVisible(Math.min(calVisible + 20, cals.trend.length))
                  }
                }
              },
              style: { maxHeight: '320px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
              children: jsx('table', { className: 'garmin-dash-table', children: [
                jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: '月份' }), jsx('th', { children: '千卡/km' })] }) }),
                jsx('tbody', { children: cals.trend.slice(0, calVisible).map(function (t) {
                  return jsx('tr', { children: [
                    jsx('td', { children: t.month }),
                    jsx('td', { children: t.calPerKm !== null ? String(t.calPerKm) : '—' }),
                  ] });
                }) }),
              ] }),
            }),
            jsx('div', { style: { textAlign: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: '已显示 ' + Math.min(calVisible, cals.trend.length) + ' / ' + cals.trend.length + ' 个月（下拉加载更多）' }),
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
            jsx('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '12px' }, onClick: function () { setWeekdayOpen(!weekdayOpen); }, children: [
              jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: weekdayOpen ? '▼' : '▶' }),
              jsx('h4', { style: { margin: '0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' }, children: '📅 星期分布' }),
            ] }),
            weekdayOpen && jsx('table', { className: 'garmin-dash-table', children: [
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
          jsx('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, onClick: function () { setSportOpen(!sportOpen); }, children: [
            jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, children: sportOpen ? '▼' : '▶' }),
            jsx('h3', { className: 'garmin-dash-section-title', children: '📊 运动类型分布' }),
          ] }),
          sportOpen && jsx('table', { className: 'garmin-dash-table', children: [
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
