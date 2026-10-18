/**
 * dsh-kicad-tool — browser half.
 *
 * Two jobs:
 *
 * 1. **Auto-open.** The Host produces preview URLs; only the Client can open a Sidebar tab. One
 *    Server-Sent-Events stream to `/plugin/kicad-tool/events` delivers them, and each is opened in
 *    the in-app browser.
 * 2. **Settings page.** A `settings.section` that edits the two install paths and drives
 *    install / update / reinstall / remove for the managed checkouts. The backend is this plugin's
 *    own routes (`/plugin/kicad-tool/state|config|action|purge`); the Settings wire only serves a
 *    hard-coded namespace allowlist.
 *
 * Bundle shape: `window.__ModuleLoader__.load({ id, factory })` with a lazy CJS factory whose
 * `require` resolves against the shell's frozen module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-kicad-tool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /** Host routes. */
    var EVENTS_PATH = '/plugin/kicad-tool/events'
    var STATE_PATH = '/plugin/kicad-tool/state'
    var CONFIG_PATH = '/plugin/kicad-tool/config'
    var ACTION_PATH = '/plugin/kicad-tool/action'
    var PURGE_PATH = '/plugin/kicad-tool/purge'

    /**
     * Open one preview URL in the Sidebar's browser tab.
     * @param ctx - client plugin context.
     * @param url - loopback preview URL produced by the Host tool.
     */
    function openPreview(ctx, url) {
      var sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
      if (sidebar === undefined) return false
      try {
        if (typeof sidebar.openTab === 'function') {
          sidebar.openTab('browser', { params: { url: url } })
          return true
        }
        if (typeof sidebar.openTabFromTarget === 'function' && typeof sidebar.commandTarget === 'function') {
          var target = sidebar.commandTarget(document.activeElement ?? document.body)
          if (target !== undefined) {
            sidebar.openTabFromTarget('browser', target)
            return true
          }
        }
      } catch (error) {
        console.warn('[kicad-tool] could not open preview', error)
      }
      return false
    }

    /* ---------------- settings page ---------------- */

    var cardStyle = {
      margin: '4px 16px 16px',
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.05))',
    }
    var titleStyle = { fontSize: '13px', fontWeight: '600', marginBottom: '2px' }
    var subStyle = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)', marginBottom: '12px' }
    var rowStyle = { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }
    var inputStyle = {
      flex: '1 1 320px',
      minWidth: '220px',
      height: '30px',
      padding: '0 9px',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
      borderRadius: '6px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }
    var buttonStyle = {
      height: '28px',
      padding: '0 10px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
    }
    var dangerStyle = {
      ...buttonStyle,
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      borderColor: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }
    var okColor = 'var(--dsw-alias-state-success-primary, #30a46c)'
    var warnColor = 'var(--dsw-alias-state-warning-primary, #f5a623)'
    var errColor = 'var(--dsw-alias-state-error-primary, #e5484d)'

    async function call(path, options) {
      var response = await fetch(path, {
        method: (options && options.method) || 'GET',
        headers: options && options.body ? { 'content-type': 'application/json' } : undefined,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
      })
      var payload = await response.json().catch(function () {
        return {}
      })
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
      return payload
    }

    function RepoCard(props) {
      var repo = props.repo
      var busy = props.busy
      var onAction = props.onAction
      var installed = repo.installed
      var statusText = installed ? repo.version || 'installed' : repo.exists ? '目录存在，但不是该仓库' : '未安装'
      return React.createElement(
        'div',
        { style: cardStyle },
        React.createElement('div', { style: titleStyle }, repo.label),
        React.createElement(
          'div',
          { style: subStyle },
          repo.url,
          ' · ',
          React.createElement('span', { style: { color: installed ? okColor : warnColor } }, statusText),
          repo.commit ? ' · ' + repo.commit : '',
        ),
        React.createElement('div', { style: { ...subStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, repo.path),
        repo.artifact
          ? React.createElement('div', { style: { ...subStyle, fontSize: '11px', wordBreak: 'break-all' } }, repo.artifact)
          : null,
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement(
            'button',
            { style: buttonStyle, disabled: busy, onClick: function () { onAction(repo.id, installed ? 'reinstall' : 'install') } },
            installed ? '重新安装' : '安装',
          ),
          React.createElement(
            'button',
            { style: buttonStyle, disabled: busy || !installed, onClick: function () { onAction(repo.id, 'update') } },
            '更新',
          ),
          React.createElement(
            'button',
            { style: dangerStyle, disabled: busy || !repo.exists, onClick: function () { onAction(repo.id, 'remove') } },
            '删除',
          ),
        ),
      )
    }

    function KicadToolSection() {
      var [state, setState] = React.useState(null)
      var [error, setError] = React.useState('')
      var [notice, setNotice] = React.useState('')
      var [kctPath, setKctPath] = React.useState('')
      var [canvasPath, setCanvasPath] = React.useState('')
      var [saving, setSaving] = React.useState(false)

      var refresh = React.useCallback(async function () {
        try {
          var next = await call(STATE_PATH)
          setState(next)
          setError('')
          setKctPath(function (current) { return current === '' ? next.config.kicadToolsDir : current })
          setCanvasPath(function (current) { return current === '' ? next.config.kicanvasDir : current })
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }, [])

      React.useEffect(function () {
        refresh()
        var timer = setInterval(refresh, 2500)
        return function () { clearInterval(timer) }
      }, [refresh])

      async function savePaths() {
        setSaving(true)
        setNotice('')
        try {
          var next = await call(CONFIG_PATH, { method: 'PUT', body: { kicadToolsDir: kctPath, kicanvasDir: canvasPath } })
          setState(next)
          setNotice('路径已保存')
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setSaving(false)
        }
      }

      async function runAction(target, action) {
        setNotice('')
        setError('')
        try {
          await call(ACTION_PATH, { method: 'POST', body: { target: target, action: action } })
          setNotice(action + ' 已开始：' + target)
          refresh()
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }

      async function purge() {
        if (!window.confirm('删除两个安装目录？此操作不可撤销。')) return
        setNotice('')
        setError('')
        try {
          var result = await call(PURGE_PATH, { method: 'POST' })
          setNotice(
            '已删除：' + (result.removed.length ? result.removed.join('、') : '（无目录）') + '；卸载命令：' + result.uninstallCommand,
          )
          refresh()
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }

      if (state === null) {
        return React.createElement('div', { style: cardStyle }, error || '正在读取 KiCad 工具状态…')
      }

      var operation = state.operation || {}
      var busy = operation.running === true
      var deps = state.dependencies || {}

      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { style: cardStyle },
          React.createElement('div', { style: titleStyle }, '安装路径'),
          React.createElement('div', { style: subStyle }, '改动会立即生效，无需重启。'),
          React.createElement(
            'div',
            { style: rowStyle },
            React.createElement(
              'span',
              { style: { fontSize: '12px', width: '110px', color: 'var(--dsw-alias-label-secondary, #999)' } },
              'kicad-tools',
            ),
            React.createElement('input', {
              style: inputStyle,
              value: kctPath,
              spellCheck: false,
              onChange: function (event) { setKctPath(event.target.value) },
            }),
          ),
          React.createElement(
            'div',
            { style: rowStyle },
            React.createElement(
              'span',
              { style: { fontSize: '12px', width: '110px', color: 'var(--dsw-alias-label-secondary, #999)' } },
              'KiCanvas',
            ),
            React.createElement('input', {
              style: inputStyle,
              value: canvasPath,
              spellCheck: false,
              onChange: function (event) { setCanvasPath(event.target.value) },
            }),
          ),
          React.createElement(
            'div',
            { style: rowStyle },
            React.createElement('button', { style: buttonStyle, disabled: saving, onClick: savePaths }, saving ? '保存中…' : '保存路径'),
            React.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #999)' } },
              '依赖：git ' + (deps.git ? '✓' : '✗') + ' · uv ' + (deps.uv ? '✓' : '✗') + ' · npm ' + (deps.npm ? '✓' : '✗'),
            ),
          ),
        ),
        Object.keys(state.repos || {}).map(function (key) {
          return React.createElement(RepoCard, { key: key, repo: state.repos[key], busy: busy, onAction: runAction })
        }),
        busy
          ? React.createElement(
              'div',
              { style: { ...cardStyle, borderColor: warnColor } },
              React.createElement('div', { style: titleStyle }, '正在进行：' + operation.action + ' ' + operation.target),
              React.createElement('div', { style: { ...subStyle, marginBottom: 0 } }, '完成后状态会自动刷新。'),
            )
          : null,
        error ? React.createElement('div', { style: { ...cardStyle, color: errColor, whiteSpace: 'pre-wrap' } }, error) : null,
        notice ? React.createElement('div', { style: { ...cardStyle, color: okColor, whiteSpace: 'pre-wrap' } }, notice) : null,
        React.createElement(
          'div',
          { style: cardStyle },
          React.createElement('div', { style: titleStyle }, '最近日志'),
          React.createElement(
            'pre',
            {
              style: {
                margin: 0,
                maxHeight: '180px',
                overflow: 'auto',
                fontSize: '11px',
                lineHeight: '16px',
                whiteSpace: 'pre-wrap',
                color: 'var(--dsw-alias-label-secondary, #999)',
              },
            },
            (state.log || []).slice(-40).join('\n') || '（暂无）',
          ),
        ),
        React.createElement(
          'div',
          { style: cardStyle },
          React.createElement('div', { style: titleStyle }, '卸载'),
          React.createElement('div', { style: subStyle }, '先删除两个安装目录，再执行卸载命令并重启：'),
          React.createElement(
            'div',
            { style: { ...subStyle, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' } },
            state.uninstallCommand || '',
          ),
          React.createElement('button', { style: dangerStyle, disabled: busy, onClick: purge }, '删除数据并卸载'),
        ),
      )
    }

    /* ---------------- plugin entry ---------------- */

    /** Subscribe to Host preview pushes and register the Settings page. */
    function apply(ctx) {
      var disposers = []

      if (typeof EventSource !== 'undefined') {
        var disposed = false
        var source = new EventSource(EVENTS_PATH)
        source.onmessage = function (event) {
          if (disposed) return
          var payload
          try {
            payload = JSON.parse(event.data)
          } catch (error) {
            return
          }
          if (payload && typeof payload.url === 'string') openPreview(ctx, payload.url)
        }
        source.onerror = function () {}
        disposers.push(function () {
          disposed = true
          source.close()
        })
      }

      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'kicad-tool', order: 110, label: function () { return 'KiCad 工具' } },
            KicadToolSection,
          )
        })
      }

      return function () {
        for (var index = 0; index < disposers.length; index += 1) disposers[index]()
      }
    }

    exports.name = 'dsh-kicad-tool'
    exports.inject = ['slots']
    exports.apply = apply
    exports.internals = { openPreview: openPreview, KicadToolSection: KicadToolSection, EVENTS_PATH: EVENTS_PATH }

    return module.exports
  },
})
