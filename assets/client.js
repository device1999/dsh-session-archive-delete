window.__ModuleLoader__.load({
  id: 'dsh-session-archive-delete',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const NS = 'dsh-session-archive-delete'

    // 官方组件库：菜单项图标与按钮样式都从这里取，保证和原生菜单项同源、同尺寸、同对齐
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch {
      primitives = {}
    }

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const SETTINGS_SLOT = 'settings.section'
    const OVERLAY_SLOT = 'shell.overlay'
    const EVENT = 'dsh-session-archive-delete:confirm'

    // 地址栏为空时的提示：此时使用默认位置（工作区下的 DSH-归档会话）
    const DEFAULT_HINT = '默认（工作区\\DSH-归档会话）'

    // 设置页标题与左栏导航文字必须一致，导航图标靠这个文字匹配
    const SETTINGS_LABEL = '备份删除'

    // 会话列表快照（取标题用）：由 apply 时注入的 sessions 服务提供
    let sessionsList = null

    /** 从会话列表快照里读一行的标题 */
    function titleOf(sessionId) {
      try {
        const snap = sessionsList && sessionsList.getSnapshot ? sessionsList.getSnapshot() : null
        const row = snap && snap.byId ? snap.byId[sessionId] : null
        if (row) {
          const t = row.title || row.name || (row.header && row.header.title)
          if (typeof t === 'string' && t.trim()) return t.trim()
        }
      } catch {}
      return ''
    }


    let SETTINGS = { mode: 'both', backupRoot: '', confirm: true, dateStyle: 'default' }
    let EFFECTIVE_ROOT = ''

    // 只打浏览器控制台，不落盘、不上报
    function log(...args) {
      try {
        console.log('[' + NS + ']', ...args)
      } catch {}
    }

    function loadSettings() {
      return fetch('/dsh-session-archive-delete/config')
        .then((r) => r.json())
        .then((d) => {
          if (d && d.ok && d.settings) SETTINGS = { ...SETTINGS, ...d.settings }
          if (d && d.effectiveBackupRoot) EFFECTIVE_ROOT = d.effectiveBackupRoot
          return SETTINGS
        })
        .catch(() => SETTINGS)
    }

    function saveSettings(patch) {
      return fetch('/dsh-session-archive-delete/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...SETTINGS, ...patch } }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.ok) SETTINGS = { ...SETTINGS, ...d.settings }
          if (d && d.effectiveBackupRoot) EFFECTIVE_ROOT = d.effectiveBackupRoot
          return d
        })
    }

    const S = {
      // 与参考实现 dsh-session-menu 的菜单行尺寸一致：min-height 34、padding 6/8、gap 6
      // 颜色用危险色，与原生「删除」类菜单项一致
      item: {
        display: 'flex', alignItems: 'center', gap: '6px', width: '100%', minHeight: '34px',
        padding: '6px 8px', border: '0', borderRadius: 'var(--dsw-radius-md, 6px)',
        background: 'none', color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        font: 'inherit', fontSize: '13px', lineHeight: '20px', textAlign: 'left', cursor: 'pointer',
      },
      // 设置页里「备份目录」行：可点击的文件夹选择块
      picker: {
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '34px',
        padding: '6px 10px', borderRadius: '8px', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '12px',
        textAlign: 'left', cursor: 'pointer',
      },
      pickerPath: {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      pickerHint: {
        flex: 'none', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: '11px',
        borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', paddingLeft: '8px',
      },
      wrap: {
        position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(15,18,24,.32)',
      },
      dialog: {
        width: 'min(460px, calc(100vw - 32px))', padding: '20px 20px 16px', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        boxShadow: '0 20px 64px rgba(0,0,0,.3)', fontSize: '13px', lineHeight: '20px',
      },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px' },
      meta: { color: 'var(--dsw-alias-label-secondary, #8a8a8e)', margin: '0 0 10px', wordBreak: 'break-all' },
      warn: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', margin: '0 0 10px' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #16845b)', margin: '0 0 10px' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' },
      cancel: {
        padding: '6px 14px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer',
      },
      confirm: {
        padding: '6px 14px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)', color: '#fff',
        fontSize: '13px', cursor: 'pointer',
      },
      input: {
        width: '100%', padding: '6px 8px', borderRadius: '6px', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent', color: 'inherit', boxSizing: 'border-box',
      },
    }

    /** 确认框标题文案 */
    function dialogTitle(mode) {
      return mode === 'delete-only' ? '彻底删除会话？（不备份）' : '备份删除会话？'
    }

    // ---------------------------------------------------------------------
    // 确认框：确认后调用宿主 /session 真正备份 + 删除
    // ---------------------------------------------------------------------
    function ConfirmDialog() {
      const [target, setTarget] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [done, setDone] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [backupAt, setBackupAt] = React.useState('')

      React.useEffect(() => {
        const on = (e) => {
          setTarget(e && e.detail ? e.detail : {})
          setBusy(false)
          setDone(null)
          setError(null)
          setBackupAt('')
          // 每次打开都重新取一次生效路径，避免设置改过后仍显示旧值
          loadSettings()
            .then(() => setBackupAt(EFFECTIVE_ROOT))
            .catch(() => setBackupAt(EFFECTIVE_ROOT))
        }
        window.addEventListener(EVENT, on)
        return () => window.removeEventListener(EVENT, on)
      }, [])

      /** 删除成功后刷新侧栏并跳到下一个会话 */
      function afterDeleted(sessionId) {
        const svc = window.__DSH_SESSION_ARCHIVE_DELETE_SESSIONS__ || null
        if (!svc) return
        try {
          const snap = svc.list && svc.list.getSnapshot ? svc.list.getSnapshot() : null
          const removedCurrent = snap && snap.current === sessionId
          const refresh = typeof svc.refresh === 'function' ? svc.refresh() : svc.refreshList ? svc.refreshList() : null
          if (removedCurrent && refresh) {
            Promise.resolve(refresh).then(() => {
              const s2 = svc.list.getSnapshot()
              const next = (s2 && s2.ids ? s2.ids : []).find((x) => x !== sessionId)
              if (next && typeof svc.open === 'function') svc.open(next)
            })
          }
        } catch {}
      }

      function run() {
        if (busy || !target) return
        setBusy(true)
        setError(null)
        fetch('/dsh-session-archive-delete/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: target.sessionId,
            title: target.title || '',
            mode: target.mode,
          }),
        })
          .then(async (r) => {
            let d = {}
            try {
              d = await r.json()
            } catch {}
            if (!r.ok || !d.ok) throw new Error(d.error || 'failed')
            return d
          })
          .then((d) => {
            setBusy(false)
            setDone(d)
            afterDeleted(target.sessionId)
          })
          .catch((err) => {
            setBusy(false)
            setError((err && err.message) || String(err))
          })
      }

      if (!target) return null

      const deleteOnly = (target.mode || SETTINGS.mode) === 'delete-only'
      const close = () => {
        if (busy) return
        setTarget(null)
        setDone(null)
        setError(null)
      }

      if (done) {
        return React.createElement(
          'div',
          { style: S.wrap, onClick: close },
          React.createElement(
            'div',
            { style: S.dialog, onClick: (e) => e.stopPropagation() },
            React.createElement('div', { style: S.title }, deleteOnly ? '已彻底删除' : '已备份删除'),
            React.createElement(
              'div',
              { style: S.ok },
              done.backup && done.backup.name ? '备份：' + done.backup.name : '未备份（直接删除模式）',
            ),
            React.createElement(
              'div',
              { style: S.meta },
              (done.result && done.result.stopped ? '已停止运行中的任务。' : '') +
                (done.result && done.result.ledger ? '已清理归档记录。' : '') +
                (Array.isArray(done.subagents) && done.subagents.length > 0
                  ? '同时处理了 ' + done.subagents.length + ' 个子代理会话' +
                    (done.subagents.some((x) => !x.ok) ? '（其中 ' + done.subagents.filter((x) => !x.ok).length + ' 个失败）' : '') +
                    '。'
                  : ''),
            ),
            React.createElement(
              'div',
              { style: S.footer },
              React.createElement('button', { type: 'button', style: S.confirm, onClick: close }, '完成'),
            ),
          ),
        )
      }

      return React.createElement(
        'div',
        { style: S.wrap, onClick: busy ? undefined : close },
        React.createElement(
          'div',
          { style: S.dialog, onClick: (e) => e.stopPropagation() },
          React.createElement(
            'div',
            { style: S.title },
            React.createElement('div', { style: S.title }, dialogTitle(target.mode || SETTINGS.mode)),
          ),
          React.createElement(
            'div',
            { style: S.meta },
            '会话：' + (target.title || '未命名会话'),
            target.sessionId ? React.createElement('br', null) : null,
            target.sessionId ? 'ID：' + target.sessionId : null,
            deleteOnly ? null : React.createElement('br', null),
            deleteOnly ? null : '备份到：' + (backupAt || '（读取中）'),
          ),
          React.createElement(
            'div',
            { style: deleteOnly ? S.warn : S.meta },
            deleteOnly
              ? '当前模式：直接删除，不备份。此操作不可恢复。'
              : '将先把该会话完整备份到本地，校验通过后才删除原会话；备份失败会中止删除。',
          ),
          error ? React.createElement('div', { style: S.warn }, '失败：' + error) : null,
          React.createElement(
            'div',
            { style: S.footer },
            React.createElement('button', { type: 'button', style: S.cancel, disabled: busy, onClick: close }, '取消'),
            React.createElement(
              'button',
              { type: 'button', style: S.confirm, disabled: busy, onClick: run },
              busy ? '处理中…' : '确认',
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 菜单项：两个组件，按模式显隐
    //   both（默认）          → 两个都显示
    //   backup-then-delete    → 只显示「备份删除」
    //   delete-only           → 只显示「彻底删除」
    // ---------------------------------------------------------------------
    const TrashIcon = primitives.IconTrashOutlineRegular || null

    /** 打开确认框（两个菜单项共用） */
    function openConfirm(closeMenu, sessionId, propTitle, modeOverride) {
      if (typeof closeMenu === 'function') closeMenu(false)
      loadSettings().then(() => {
        const title = titleOf(sessionId) || (typeof propTitle === 'string' ? propTitle : '')
        window.dispatchEvent(
          new CustomEvent(EVENT, {
            detail: {
              sessionId,
              title,
              mode: modeOverride || SETTINGS.mode,
            },
          }),
        )
      })
    }

    function menuIcon() {
      return TrashIcon
        ? React.createElement(TrashIcon, { size: 16 })
        : React.createElement('svg', {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            style: { flex: 'none' },
          })
    }

    /** 「备份删除」项：both 与 backup-then-delete 模式显示 */
    function BackupDeleteMenuItem(props) {
      const sessionId = (props && props.sessionId) || ''
      const propTitle =
        (props && (props.displayTitle || props.title || (props.session && (props.session.title || props.session.name)))) || ''
      const useMenuOpenState = props && props.useMenuOpenState

      let closeMenu
      if (typeof useMenuOpenState === 'function') {
        const state = useMenuOpenState()
        if (Array.isArray(state) && typeof state[1] === 'function') closeMenu = state[1]
      }

      const onClick = () => openConfirm(closeMenu, sessionId, propTitle, 'backup-then-delete')

      // 该项自身的可见性：both 或 backup-then-delete
      if (SETTINGS.mode === 'delete-only') return null

      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: S.item,
          onClick,
          onMouseEnter: (e) => {
            e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.background = 'transparent'
          },
        },
        menuIcon(),
        React.createElement('span', null, '备份删除'),
      )
    }

    /** 「彻底删除」项：both 与 delete-only 模式显示 */
    function DeleteOnlyMenuItem(props) {
      const sessionId = (props && props.sessionId) || ''
      const propTitle =
        (props && (props.displayTitle || props.title || (props.session && (props.session.title || props.session.name)))) || ''
      const useMenuOpenState = props && props.useMenuOpenState

      let closeMenu
      if (typeof useMenuOpenState === 'function') {
        const state = useMenuOpenState()
        if (Array.isArray(state) && typeof state[1] === 'function') closeMenu = state[1]
      }

      const onClick = () => openConfirm(closeMenu, sessionId, propTitle, 'delete-only')

      // 该项自身的可见性：both 或 delete-only
      if (SETTINGS.mode === 'backup-then-delete') return null

      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: S.item,
          onClick,
          onMouseEnter: (e) => {
            e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.background = 'transparent'
          },
        },
        menuIcon(),
        React.createElement('span', null, '彻底删除'),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：模式切换 + 备份目录
    // ---------------------------------------------------------------------

    /** 把路径拆成可点击的层级：D:\work\DSH-归档会话 → [D:\, D:\work, D:\work\DSH-归档会话] */
    function splitPath(p) {
      const s = String(p || '')
      if (!s) return []
      const parts = s.split(/[\\/]+/).filter(Boolean)
      const out = []
      let cur = ''
      for (const part of parts) {
        cur = cur ? cur.replace(/[\\/]+$/, '') + '\\' + part : part + (part.endsWith(':') ? '\\' : '')
        out.push({ label: part, full: cur })
      }
      return out
    }

    /**
     * 备份目录选择器：
     *   - 地址栏本身可编辑，回车/失焦即保存（保存前先校验路径是否有效）
     *   - 「默认」按钮：清空并恢复默认（工作区下的 DSH-归档会话）
     *   - 「浏览…」直接弹 Windows 系统文件夹对话框
     *   - 宿主不支持原生对话框（非 Windows / 找不到 pwsh）时回退到页面内浏览
     */
    function FolderPicker(props) {
      const [open, setOpen] = React.useState(false)
      const [cwd, setCwd] = React.useState('')
      const [dirs, setDirs] = React.useState([])
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      // 显示值由组件自己持有：选完立刻显示，不等父组件保存往返
      const [value, setValue] = React.useState((props && props.savedRoot) || '')
      // 保存失败（路径无效）的提示
      const [saveErr, setSaveErr] = React.useState('')
      // 屏蔽 onBlur 保存：点「浏览」时输入框会失焦
      const suppressBlurRef = React.useRef(false)
      // 跟踪外部传入的已保存值，只在它真的变化时同步（避免覆盖用户正在输入的内容）
      const lastExternalRef = React.useRef((props && props.savedRoot) || '')

      // 当前生效路径（用于「浏览」对话框的初始目录）
      const current = (props && typeof props.current === 'string' && props.current) || EFFECTIVE_ROOT || SETTINGS.backupRoot || ''

      /** 校验路径并保存；无效则提示并回滚显示，不写入设置 */
      function commit(raw) {
        const v = String(raw || '').trim()
        if (v === lastExternalRef.current) return
        fetch('/dsh-session-archive-delete/check-path', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: v }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d || !d.ok) {
              setSaveErr((d && d.error) || '路径无效')
              setValue(lastExternalRef.current)
              return
            }
            setSaveErr('')
            lastExternalRef.current = v
            setValue(v)
            props.onPick(v, d.resolved)
          })
          .catch((e) => {
            setSaveErr('校验路径失败：' + String((e && e.message) || e))
            setValue(lastExternalRef.current)
          })
      }

      React.useEffect(() => {
        const next = (props && props.savedRoot) || ''
        if (next !== lastExternalRef.current) {
          lastExternalRef.current = next
          setValue(next)
        }
      })

      React.useEffect(() => {
        if (!open) return
        load(current)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open])

      /** 先试系统对话框；只有宿主明确报告「不支持」时才返回 false 让调用方回退 */
      function pickNative() {
        setPicking(true)
        // 关键：选中的路径先用 ref 钉住。
        // 点「浏览」会让输入框失焦，若此时父组件还没保存，onBlur 会用空 draft 把路径冲掉。
        suppressBlurRef.current = true
        return fetch('/dsh-session-archive-delete/pick-folder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initial: current }),
        })
          .then((r) => r.json())
          .then((d) => {
            setPicking(false)
            log('pick-folder 返回：', d)
            // 只要宿主能弹窗（supported !== false），就不再回退到页面内浏览
            if (d && d.ok === false && d.supported === false) {
              suppressBlurRef.current = false
              return false
            }
            if (d && d.ok && d.path) {
              const picked = d.path
              // 先本地显示，再交给父组件持久化；onBlur 期间已被 suppress 掉
              lastExternalRef.current = picked
              setValue(picked)
              setSaveErr('')
              log('选中路径 →', picked)
              props.onPick(picked, picked)
              return true
            }
            suppressBlurRef.current = false
            if (d && d.ok && !d.path) {
              // 用户取消：保持原路径，不弹第二个窗口
              return true
            }
            // 有错误但宿主支持原生对话框：提示错误，同样不回退
            if (d && d.error) {
              log('pick-folder 失败：', d.error)
              return true
            }
            return false
          })
          .catch((e) => {
            setPicking(false)
            log('pick-folder 请求异常：', e)
            return false
          })
      }

      function onBrowse() {
        if (props.disabled || picking) return
        // 点浏览的瞬间输入框会失焦，先屏蔽一次 onBlur，避免用旧草稿覆盖路径
        suppressBlurRef.current = true
        pickNative().then((handled) => {
          if (!handled) {
            // 宿主明确不支持原生对话框 → 回退到页面内浏览
            suppressBlurRef.current = false
            setOpen(true)
          }
        })
      }

      function load(dirPath) {
        setLoading(true)
        setErr('')
        fetch('/dsh-session-archive-delete/browse?dir=' + encodeURIComponent(dirPath))
          .then((r) => r.json())
          .then((d) => {
            setLoading(false)
            if (!d || !d.ok) {
              setErr((d && d.error) || '无法读取目录')
              return
            }
            setCwd(d.dir)
            setDirs(Array.isArray(d.dirs) ? d.dirs : [])
          })
          .catch((e) => {
            setLoading(false)
            setErr(String((e && e.message) || e))
          })
      }

      const crumbs = splitPath(cwd)
      const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].full : ''

      const overlay = open
        ? React.createElement(
            'div',
            {
              style: S.wrap,
              onClick: () => setOpen(false),
              onKeyDown: (e) => {
                if (e.key === 'Escape') setOpen(false)
              },
            },
            React.createElement(
              'div',
              { style: { ...S.dialog, width: 'min(560px, calc(100vw - 32px))' }, onClick: (e) => e.stopPropagation() },
              React.createElement('div', { style: S.title }, '选择备份文件夹'),
              // 面包屑
              React.createElement(
                'div',
                { style: { ...S.meta, display: 'flex', flexWrap: 'wrap', gap: '2px', alignItems: 'center' } },
                crumbs.map((c, i) =>
                  React.createElement(
                    'span',
                    { key: c.full },
                    React.createElement(
                      'a',
                      {
                        role: 'button',
                        tabIndex: 0,
                        style: { color: 'var(--dsw-alias-brand-primary, #3b82f6)', cursor: 'pointer', textDecoration: 'none' },
                        onClick: () => load(c.full),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') load(c.full)
                        },
                      },
                      c.label,
                    ),
                    i < crumbs.length - 1 ? React.createElement('span', null, ' › ') : null,
                  ),
                ),
              ),
              // 列表
              React.createElement(
                'div',
                {
                  style: {
                    maxHeight: '320px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
                    borderRadius: '8px', marginTop: '8px', minHeight: '120px',
                  },
                },
                loading
                  ? React.createElement('div', { style: { ...S.meta, padding: '12px' } }, '读取中…')
                  : err
                    ? React.createElement('div', { style: { ...S.warn, padding: '12px' } }, err)
                    : dirs.length === 0
                      ? React.createElement('div', { style: { ...S.meta, padding: '12px' } }, '（这个文件夹里没有子文件夹）')
                      : dirs.map((d) =>
                          React.createElement(
                            'button',
                            {
                              key: d.path,
                              type: 'button',
                              style: { ...S.item, color: 'inherit', padding: '6px 10px' },
                              onClick: () => load(d.path),
                              onMouseEnter: (e) => {
                                e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
                              },
                              onMouseLeave: (e) => {
                                e.currentTarget.style.background = 'none'
                              },
                            },
                            React.createElement('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, '📁 ' + d.name),
                            d.hasChildren ? React.createElement('span', { style: S.pickerHint }, '›') : null,
                          ),
                        ),
              ),
              React.createElement(
                'div',
                { style: { ...S.meta, marginTop: '10px', fontSize: '12px' } },
                '选中文件夹：' + (cwd || '—'),
              ),
              React.createElement(
                'div',
                { style: S.footer },
                parent
                  ? React.createElement('button', { type: 'button', style: S.cancel, onClick: () => load(parent) }, '↑ 上一级')
                  : null,
                React.createElement('button', { type: 'button', style: S.cancel, onClick: () => setOpen(false) }, '取消'),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.cancel, borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-brand-primary, #3b82f6)' },
                    disabled: !cwd || loading,
                    onClick: () => {
                      setOpen(false)
                      props.onPick(cwd)
                    },
                  },
                  '选择这个文件夹',
                ),
              ),
            ),
          )
        : null

      return React.createElement(
        'div',
        null,
        // 地址栏：可直接编辑；右侧「默认」和「浏览…」两个按钮
        React.createElement(
          'div',
          { style: { ...S.picker, opacity: props.disabled || picking ? 0.6 : 1, padding: '4px 4px 4px 10px' } },
          React.createElement('span', { style: { flex: 'none' } }, '📁'),
          React.createElement('input', {
            type: 'text',
            value: value,
            placeholder: DEFAULT_HINT,
            spellCheck: false,
            style: { ...S.input, flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '4px 0' },
            onChange: (e) => {
              setValue(e.target.value)
              if (saveErr) setSaveErr('')
            },
            onBlur: () => {
              // 点了「浏览」导致的失焦：不要保存，否则会用旧值冲掉刚选中的路径
              if (suppressBlurRef.current) {
                suppressBlurRef.current = false
                return
              }
              commit(value)
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setValue(lastExternalRef.current)
                setSaveErr('')
                suppressBlurRef.current = true
                e.currentTarget.blur()
              }
            },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              title: '恢复默认位置（工作区下的 DSH-归档会话）',
              style: {
                ...S.cancel,
                flex: 'none',
                padding: '4px 10px',
                marginLeft: '6px',
                fontSize: '12px',
              },
              disabled: props.disabled || picking,
              onClick: () => {
                suppressBlurRef.current = true
                setValue('')
                setSaveErr('')
                commit('')
              },
            },
            '默认',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              title: '用系统文件夹对话框选择',
              style: {
                ...S.cancel,
                flex: 'none',
                padding: '4px 10px',
                marginLeft: '6px',
                fontSize: '12px',
              },
              disabled: props.disabled || picking,
              onClick: onBrowse,
            },
            picking ? '等待选择…' : '浏览…',
          ),
        ),
        saveErr
          ? React.createElement(
              'div',
              { style: { marginTop: '4px', color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: '12px' } },
              saveErr,
            )
          : null,
        overlay,
      )
    }

    function SettingsSection() {
      const [mode, setMode] = React.useState(SETTINGS.mode)
      const [dateStyle, setDateStyle] = React.useState(SETTINGS.dateStyle || 'default')
      const [root, setRoot] = React.useState(SETTINGS.backupRoot)
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState('')

      React.useEffect(() => {
        loadSettings().then((s) => {
          setMode(s.mode)
          setDateStyle(s.dateStyle || 'default')
          setRoot(s.backupRoot || '')
        })
      }, [])

      const persist = (patch) => {
        setSaving(true)
        setMsg('')
        return saveSettings(patch).then((d) => {
          setSaving(false)
          setMsg(d && d.ok ? '已保存' : '保存失败：' + ((d && d.error) || '未知错误'))
          return d
        })
      }

      // EFFECTIVE_ROOT 是模块级普通变量，保存后不会自己触发重渲染——
      // 必须改用组件状态，确认框与选择器读到的才是新路径
      const [effective, setEffective] = React.useState(EFFECTIVE_ROOT)
      React.useEffect(() => {
        loadSettings().then(() => setEffective(EFFECTIVE_ROOT))
      }, [])

      return React.createElement(
        'div',
        { style: { padding: '4px 2px', fontSize: '13px', lineHeight: '22px' } },
        React.createElement('h3', { style: { fontSize: '14px', margin: '0 0 8px' } }, SETTINGS_LABEL),
        React.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-secondary, #8a8a8e)' } },
          '在侧栏会话「…」菜单最下方增加删除选项；默认同时显示「备份删除」与「彻底删除」。',
        ),
        React.createElement(
          'div',
          { style: { marginTop: '12px' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '删除模式'),
          React.createElement(
            'select',
            {
              value: mode,
              disabled: saving,
              style: S.input,
              onChange: (e) => {
                const v = e.target.value
                setMode(v)
                persist({ mode: v })
              },
            },
            React.createElement('option', { value: 'both' }, '「备份删除」+「彻底删除」同时显示'),
            React.createElement('option', { value: 'backup-then-delete' }, '「备份删除」'),
            React.createElement('option', { value: 'delete-only' }, '「彻底删除」'),
          ),
        ),
        React.createElement(
          'div',
          { style: { marginTop: '12px' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '备份文件夹命名'),
          React.createElement(
            'select',
            {
              value: dateStyle,
              disabled: saving,
              style: S.input,
              onChange: (e) => {
                const v = e.target.value
                setDateStyle(v)
                persist({ dateStyle: v })
              },
            },
            React.createElement('option', { value: 'default' }, '默认：日期+主题（20261020_标题）'),
            React.createElement('option', { value: 'id-title' }, 'ID前八位+主题（a1b2c3d4-标题）'),
            React.createElement('option', { value: 'title' }, '纯主题（标题）'),
            React.createElement('option', { value: 'id-title-date' }, '前八位+主题+日期（a1b2c3d4-标题_20261020）'),
          ),
          React.createElement(
            'div',
            { style: { marginTop: '4px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: '12px' } },
            '重名自动加 -2/-3；标题过长自动截断。',
          ),
        ),
        React.createElement(
          'div',
          { style: { marginTop: '12px' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '备份目录'),
          React.createElement(FolderPicker, {
            disabled: saving,
            current: effective,
            savedRoot: root,
            onPick: (p, resolved) => {
              setRoot(p)
              // 立即更新「当前实际备份到」，清空时也用宿主算出的默认路径
              if (resolved) setEffective(resolved)
              persist({ backupRoot: p }).then(() => setEffective(EFFECTIVE_ROOT))
            },
          }),
          React.createElement(
            'div',
            { style: { marginTop: '6px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: '12px' } },
            '当前实际备份到：' + (effective || '（读取中）'),
          ),
          React.createElement(
            'div',
            { style: { marginTop: '2px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: '12px' } },
            '每次删除前会把该会话完整复制到这里并校验；不能设在 ~/.dsh 里面。',
          ),
        ),
        msg
          ? React.createElement(
              'div',
              {
                style: {
                  marginTop: '8px',
                  color:
                    msg.indexOf('失败') >= 0
                      ? 'var(--dsw-alias-state-error-primary, #e5484d)'
                      : 'var(--dsw-alias-label-secondary, #8a8a8e)',
                },
              },
              msg,
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // 设置左栏导航图标：把本插件那一行的齿轮换成垃圾桶
    //
    // DSH 外壳按 settings.section 的 id 选图标，未知 id 一律回退成齿轮，
    // 且没有公开的 icon 字段。所以等设置对话框挂载后，按 label 文字
    // 精确找到本插件的导航按钮，打上标记，再由 CSS 用截图替换成垃圾桶图标。
    // 只命中文字完全一致的那一个按钮，不影响其他插件。
    // ---------------------------------------------------------------------
    const NAV_MARKER = 'data-session-archive-delete-nav'
    const NAV_ICON_SEL = '[data-session-archive-delete-nav-icon]'

    // 16×16 垃圾桶，线条风格（与其他导航图标一致，避免实心块显得"失真"）
    const TRASH_SVG_INNER =
      '<path d="M2.75 4.5h10.5"/>' +
      '<path d="M6.1 4.5V3.4c0-.5.4-.9.9-.9h1.9c.5 0 .9.4.9.9v1.1"/>' +
      '<path d="M4.1 4.5l.55 8.05c.03.5.45.9.95.9h4.7c.5 0 .92-.4.95-.9l.55-8.05"/>' +
      '<path d="M6.7 7.1v4.1"/>' +
      '<path d="M9.3 7.1v4.1"/>'

    function makeTrashSvg() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute(NAV_ICON_SEL.replace(/^\[|\]$/g, ''), '1')
      svg.style.cssText = 'width:16px;height:16px;flex:none;display:block;'
      svg.innerHTML = TRASH_SVG_INNER
      return svg
    }

    /**
     * 把本插件在设置左栏那一行的图标换成垃圾桶。
     *
     * DSH 外壳按 settings.section 的 id 选图标，未知 id 一律给齿轮，也没有公开的 icon 字段。
     * 这里在设置对话框挂载后，按 label 文字精确找到本插件那一行，
     * 直接 **替换** 它内部的原生 <svg>（不用 CSS，避免误伤新插入的图标）。
     */
    function installNavIcon(labelText) {
      if (typeof document === 'undefined') return () => {}
      let disposed = false
      let scheduled = false

      const apply = () => {
        scheduled = false
        if (disposed) return
        let buttons = []
        try {
          buttons = document.querySelectorAll('[role="dialog"] nav button')
        } catch {
          return
        }
        const want = String(labelText || '').trim()
        if (!want) return

        // 诊断：记录每轮扫描到的按钮文字，便于判断选择器是否命中
        if (buttons.length > 0) {
          const texts = []
          for (const b of buttons) texts.push(String(b.textContent || '').trim())
          if (!apply._logged || apply._logged !== buttons.length + '|' + texts.join(',')) {
            apply._logged = buttons.length + '|' + texts.join(',')
            log('设置导航按钮（' + buttons.length + '）：' + texts.join(' / '))
          }
        }

        for (const b of buttons) {
          const match = b.textContent && b.textContent.trim() === want
          if (!match) {
            b.removeAttribute(NAV_MARKER)
            continue
          }
          b.setAttribute(NAV_MARKER, '')
          // 已经换过就跳过，避免反复替换造成闪烁
          if (b.querySelector(NAV_ICON_SEL)) continue
          const nativeSvg = b.querySelector('svg')
          const trash = makeTrashSvg()
          if (nativeSvg) {
            nativeSvg.replaceWith(trash)
            log('已替换导航图标（原生 svg 存在）')
          } else {
            b.insertBefore(trash, b.firstChild)
            log('已插入导航图标（原生 svg 不存在，插入到最前）')
          }
        }
      }

      // MutationObserver 会因为我们的改动再次触发，用 microtask 合并，避免抖动
      const sync = () => {
        if (scheduled || disposed) return
        scheduled = true
        Promise.resolve().then(apply)
      }

      apply()
      let observer = null
      try {
        observer = new MutationObserver(sync)
        observer.observe(document.body, { childList: true, subtree: true })
      } catch {}

      return () => {
        disposed = true
        if (observer) observer.disconnect()
        document.querySelectorAll('[' + NAV_MARKER + ']').forEach((el) => el.removeAttribute(NAV_MARKER))
      }
    }

    // ---------------------------------------------------------------------
    /** 从 sessions 服务里拿到 list 快照（取标题用） */
    function adoptSessions(svc) {
      try {
        const list = svc && svc.list
        if (list && typeof list.getSnapshot === 'function' && typeof list.subscribe === 'function') {
          sessionsList = list
        }
      } catch {}
    }

    // apply
    // ---------------------------------------------------------------------
    function apply(ctx) {
      log('client half applying')
      try {
        const svc = ctx.get ? ctx.get('sessions') : null
        window.__DSH_SESSION_ARCHIVE_DELETE_SESSIONS__ = svc
        adoptSessions(svc)
        if (!svc && typeof ctx.inject === 'function') {
          ctx.inject(['sessions'], (sub) => {
            window.__DSH_SESSION_ARCHIVE_DELETE_SESSIONS__ = sub.sessions
            adoptSessions(sub.sessions)
          })
        }
      } catch {}

      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register({ name: OVERLAY_SLOT, id: 'session-archive-delete-dialog', order: 200 }, ConfirmDialog)
      })

      ctx.slots.inject(MENU_SLOT, function* () {
        yield ctx.slots.register({ name: MENU_SLOT, id: 'session-archive-delete-menu-backup', order: 900 }, BackupDeleteMenuItem)
        yield ctx.slots.register({ name: MENU_SLOT, id: 'session-archive-delete-menu-delete', order: 910 }, DeleteOnlyMenuItem)
      })

      ctx.slots.inject(SETTINGS_SLOT, function* () {
        yield ctx.slots.register(
          { name: SETTINGS_SLOT, id: 'session-archive-delete-settings', order: 90, label: () => SETTINGS_LABEL },
          SettingsSection,
        )
      })

      // 把设置左栏里本插件那一行的齿轮换成垃圾桶（只认文字匹配的那一个按钮）
      try {
        ctx.effect(() => installNavIcon(SETTINGS_LABEL), NS + ': settings nav icon')
      } catch {
        installNavIcon(SETTINGS_LABEL)
      }

      void loadSettings()
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = NS
    return module.exports
  },
})
