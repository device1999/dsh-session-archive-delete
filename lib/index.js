/**
 * dsh-session-archive-delete · 宿主半
 *
 * 职责：
 *   1. 暴露 HTTP 接口给客户端：
 *        GET  /dsh-session-archive-delete/config        读取设置
 *        POST /dsh-session-archive-delete/settings      写入设置
 *        POST /dsh-session-archive-delete/session       对单个会话执行「备份删除」或「直接删除」
 *        GET  /dsh-session-archive-delete/browse        列出目录（页面内兜底浏览）
 *        POST /dsh-session-archive-delete/pick-folder   弹系统文件夹对话框，返回选中路径
 *   2. 客户端渲染失败时，把 /dsh-session-archive-delete/client.js 作为普通 <script> 兜底注入
 *
 * 主路径是标准 dsh.client 声明；webserver 注入只作兜底。
 *
 * 安全约束：
 *   - 会话目录必须解析在 ~/.dsh/sessions 之下，且目录名与会话 id 一致（delete.js 里再校验一次）
 *   - 备份根目录不能落在 ~/.dsh 里，否则 DSH 会把它当成数据
 *   - 备份校验不通过就中止，原会话保留
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshHome, isInside } from './paths.js'
import { readSettings, writeSettings, normalize } from './store.js'
import { backupSession } from './backup.js'
import { deleteSession, isValidSessionId } from './delete.js'
import { collectSubtree } from './subtree.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CLIENT_FILE = path.join(ROOT, 'assets', 'client.js')
const PKG_FILE = path.join(ROOT, 'package.json')

const NS = '/dsh-session-archive-delete'
const CLIENT_PATH = NS + '/client.js'
const CONFIG_PATH = NS + '/config'
const SETTINGS_PATH = NS + '/settings'
const SESSION_PATH = NS + '/session'
const BROWSE_PATH = NS + '/browse'
const PICK_PATH = NS + '/pick-folder'
const CHECK_PATH = NS + '/check-path'

const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// 日志只打到宿主控制台，不落盘。
function log(...args) {
  try {
    console.log('[dsh-session-archive-delete]', ...args)
  } catch {}
}

function json(res, obj, code) {
  const body = JSON.stringify(obj)
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

/** 会话 id 的两种写法：裸 uuid 与 session- 前缀 */
function idVariants(id) {
  const leaf = String(id).replace(/^session-/, '')
  return [...new Set([String(id), leaf, 'session-' + leaf])]
}

/**
 * 找到会话目录与缓存文件。
 * 目录扫描方式与 ps1 一致：遍历 sessions/<工作区>/<id>，不自己去推导工作区目录名的编码。
 */
function locateSession(id) {
  const home = dshHome()
  const sessionsRoot = path.join(home, 'sessions')
  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
  const variants = idVariants(id)

  let sessionDir = null
  let workspace = null
  let entries = []
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const v of variants) {
      const candidate = path.join(sessionsRoot, e.name, v)
      try {
        if (fs.statSync(candidate).isDirectory()) {
          sessionDir = candidate
          workspace = e.name
          break
        }
      } catch {}
    }
    if (sessionDir) break
  }

  let cacheFile = null
  for (const v of variants) {
    const candidate = path.join(cacheRoot, v + '.json')
    if (fs.existsSync(candidate)) {
      cacheFile = candidate
      break
    }
  }

  return {
    sessionDir,
    workspace: workspace || '_unknown',
    cacheFile,
    sessionsRoot,
    snapshots: {
      workspaceJson: path.join(home, 'storages', 'workspace.json'),
      projcacheJson: path.join(home, 'storages', 'session_projcache.json'),
    },
  }
}

/**
 * 默认备份根 = 工作区根目录下的「DSH-归档会话」。
 *
 * 注意：不能用 process.cwd()！DSH 宿主进程的工作目录通常落在 ~/.dsh/profiles 下，
 * 会命中「备份不能放在 ~/.dsh 里」的安全校验。
 *
 * 优先级：
 *   1. 用户设置 backupRoot
 *   2. 环境变量 DSH_ARCHIVE_ROOT
 *   3. 插件 config.workspaceRoot
 *   4. 从当前会话的工作区目录推断（用户的真实项目目录）
 *   5. 最后回退到用户主目录下的 DSH-归档会话
 */
const ARCHIVE_FOLDER = 'DSH-归档会话'

/** 从会话列表里挑一个工作区目录作为默认存放位置 */
async function detectWorkspaceRoot(ctx) {
  try {
    const sq = ctx && ctx.get ? ctx.get('sessionQuery') : null
    if (!sq || typeof sq.listSessions !== 'function') return ''
    const records = await sq.listSessions()
    const counts = new Map()
    for (const r of records || []) {
      const cwd = r && r.header && typeof r.header.cwd === 'string' ? r.header.cwd.trim() : ''
      if (!cwd) continue
      // 工作区目录不能落在 ~/.dsh 里
      const home = path.resolve(dshHome())
      const resolved = path.resolve(cwd)
      if (resolved === home || isInside(home, resolved)) continue
      counts.set(cwd, (counts.get(cwd) || 0) + 1)
    }
    // 取会话最多的那个目录
    let best = ''
    let bestN = 0
    for (const [cwd, n] of counts) {
      if (n > bestN) {
        best = cwd
        bestN = n
      }
    }
    return best
  } catch {
    return ''
  }
}

function resolveBackupRoot(settings, workspaceRoot) {
  const raw = settings && settings.backupRoot ? String(settings.backupRoot).trim() : ''
  if (raw) return path.resolve(raw)
  const envRoot = process.env.DSH_ARCHIVE_ROOT
  if (envRoot && envRoot.trim()) return path.resolve(envRoot.trim())
  const ws = workspaceRoot && String(workspaceRoot).trim() ? String(workspaceRoot).trim() : ''
  if (ws) return path.join(path.resolve(ws), ARCHIVE_FOLDER)
  // 兜底：主目录下（既不属于 ~/.dsh，也不写死任何盘符）
  return path.join(os.homedir(), ARCHIVE_FOLDER)
}

function checkBackupRoot(backupRoot) {
  const home = dshHome()
  const root = path.resolve(backupRoot)
  if (root === path.resolve(home) || isInside(home, root)) {
    return '备份目录不能放在 ~/.dsh 里面，否则 DSH 会重新看到它'
  }
  return null
}

/**
 * 校验用户填写的备份目录。
 *
 * 规则：
 *   - 空字符串 = 使用默认（始终合法）
 *   - 必须在 ~/.dsh 之外
 *   - 已存在的路径必须是目录
 *   - 不存在时，最近的已存在祖先必须是目录，且可写（这样才能自动建目录）
 *
 * @returns {{ok:boolean, input:string, resolved:string, isDefault:boolean, exists:boolean, error?:string}}
 */
function validateBackupPath(input, workspaceRoot) {
  const raw = typeof input === 'string' ? input.trim() : ''
  const isDefault = raw === ''
  const fallback = resolveBackupRoot({ backupRoot: '' }, workspaceRoot)

  if (isDefault) {
    return { ok: true, input: '', resolved: fallback, isDefault: true, exists: fs.existsSync(fallback) }
  }

  let resolved
  try {
    resolved = path.resolve(raw)
  } catch {
    return { ok: false, input: raw, resolved: raw, isDefault: false, exists: false, error: '路径格式无效' }
  }

  // 必须是非空盘符路径
  if (!path.isAbsolute(resolved)) {
    return { ok: false, input: raw, resolved, isDefault: false, exists: false, error: '请填写完整路径，例如 E:\\备份\\DSH' }
  }

  const homeProblem = checkBackupRoot(resolved)
  if (homeProblem) {
    return { ok: false, input: raw, resolved, isDefault: false, exists: false, error: homeProblem }
  }

  const exists = fs.existsSync(resolved)
  if (exists) {
    let st
    try {
      st = fs.statSync(resolved)
    } catch (e) {
      return { ok: false, input: raw, resolved, isDefault: false, exists: true, error: '无法读取该路径：' + String((e && e.message) || e) }
    }
    if (!st.isDirectory()) {
      return { ok: false, input: raw, resolved, isDefault: false, exists: true, error: '这个路径是一个文件，不是文件夹' }
    }
    // 探测可写：在目标目录里建一个临时文件再删掉
    try {
      const probe = path.join(resolved, '.dsh-write-probe-' + Date.now())
      fs.writeFileSync(probe, '')
      fs.rmSync(probe, { force: true })
    } catch {
      return { ok: false, input: raw, resolved, isDefault: false, exists: true, error: '该文件夹没有写入权限' }
    }
    return { ok: true, input: raw, resolved, isDefault: false, exists: true }
  }

  // 不存在：找最近的已存在祖先，要求它可写（届时会自动逐级创建）
  let probe = resolved
  for (let i = 0; i < 32 && probe; i++) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
    if (!fs.existsSync(probe)) continue
    try {
      const st = fs.statSync(probe)
      if (!st.isDirectory()) {
        return { ok: false, input: raw, resolved, isDefault: false, exists: false, error: '上层路径不是文件夹：' + probe }
      }
      const t = path.join(probe, '.dsh-write-probe-' + Date.now())
      fs.writeFileSync(t, '')
      fs.rmSync(t, { force: true })
    } catch {
      return { ok: false, input: raw, resolved, isDefault: false, exists: false, error: '没有权限在 ' + probe + ' 下创建文件夹' }
    }
    return { ok: true, input: raw, resolved, isDefault: false, exists: false }
  }

  return { ok: false, input: raw, resolved, isDefault: false, exists: false, error: '找不到可用的上层目录，请检查盘符是否存在' }
}

// ---- 标题：与 delete-archived-sessions.ps1 同一套来源 ----
// record.rows.title.val → record.rows.titleInput.val.first.text → 会话首条用户输入 → 「未命名」
function titleFromProjCache(cacheFile) {
  const out = { title: '', first: '' }
  if (!cacheFile || !fs.existsSync(cacheFile)) return out
  try {
    const doc = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    const rows = doc && doc.record && doc.record.rows
    if (!rows || typeof rows !== 'object') return out
    if (rows.title && typeof rows.title.val === 'string') out.title = rows.title.val
    const ti = rows.titleInput
    if (ti && ti.val && ti.val.first && typeof ti.val.first.text === 'string') out.first = ti.val.first.text
  } catch {}
  return out
}

/** 从会话目录里的明文 .jsonl 取首条用户输入（主文件是 zstd，读不了就返回空） */
function firstUserText(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return ''
  try {
    for (const e of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const lines = fs.readFileSync(path.join(sessionDir, e.name), 'utf8').split(/\r?\n/).slice(0, 100)
      for (const line of lines) {
        if (!line.includes('"role"') || !line.includes('"user"')) continue
        try {
          const o = JSON.parse(line)
          const t = typeof o.message === 'string' ? o.message : typeof o.text === 'string' ? o.text : ''
          if (t.trim()) return t.trim()
        } catch {}
      }
    }
  } catch {}
  return ''
}

/** 最终标题：缓存标题 → 首条输入 → 客户端传来 → 「未命名」 */
function resolveTitle(cacheFile, sessionDir, clientTitle) {
  const c = titleFromProjCache(cacheFile)
  if (c.title && c.title.trim()) return c.title.trim()
  if (c.first && c.first.trim()) return c.first.trim()
  const fu = firstUserText(sessionDir)
  if (fu) return fu
  if (clientTitle && String(clientTitle).trim()) return String(clientTitle).trim()
  return '未命名会话'
}

// ---- 系统文件夹对话框 ----
// 宿主是 Node 进程，可以 spawn pwsh 调 Windows 自带的 WinForms FolderBrowserDialog。
// 非 Windows、找不到 pwsh、或脚本出错时返回 supported=false，由前端回退到页面内浏览。

const PICK_TIMEOUT_MS = 30 * 60 * 1000 // 30 分钟：用户可能开着对话框走开

/** 找一个可用的 PowerShell 7 可执行文件（不写死任何本机路径） */
function findPwsh() {
  const envPs = process.env.DSH_PWSH || process.env.DSH_POWERSHELL
  if (envPs && fs.existsSync(envPs)) return envPs

  // 先从 PATH 找（标准安装会自己加进去）
  const exeName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const pathParts = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of pathParts) {
    try {
      const c = path.join(dir, exeName)
      if (fs.existsSync(c)) return c
    } catch {}
  }

  // 再试常见安装位置（按平台约定，不含个人路径）
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', '7', 'pwsh.exe'),
        ]
      : ['/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh', '/usr/bin/pwsh']

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/**
 * 弹系统文件夹对话框，返回选中路径。
 * @param {string} initialDir 对话框初始位置
 * @returns {Promise<{ok:boolean, path?:string|null, canceled?:boolean, supported?:boolean, error?:string}>}
 */
function pickFolderNative(initialDir) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, supported: false, error: '当前系统没有可调用的原生文件夹对话框' })
  }
  const ps = findPwsh()
  if (!ps) {
    return Promise.resolve({ ok: false, supported: false, error: '找不到 pwsh 7' })
  }

  const start = initialDir && fs.existsSync(initialDir) ? initialDir : os.homedir()
  // 用 -EncodedCommand 传脚本：UTF-16LE + base64，中文初始目录不会被命令行二次解析。
  // 输出也必须防编码问题：PowerShell 往管道写中文会按系统代码页（GBK）编码，
  // Node 按 UTF-8 解码就成了乱码，路径校验必然失败。
  // 所以让脚本把结果转成 UTF-8 的 base64 再输出，纯 ASCII，任何代码页下都安全。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择 DSH 归档会话备份文件夹'",
    '$d.ShowNewFolderButton = $true',
    '$d.SelectedPath = ' + "'" + start.replace(/'/g, "''") + "'",
    '$r = $d.ShowDialog()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $b = [Text.Encoding]::UTF8.GetBytes($d.SelectedPath)',
    "  [Console]::Out.Write('B64:' + [Convert]::ToBase64String($b))",
    '} else {',
    "  [Console]::Out.Write('CANCEL')",
    '}',
  ].join('\r\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child
    try {
      child = spawn(ps, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ ok: false, supported: false, error: '无法启动 PowerShell：' + String((e && e.message) || e) })
      return
    }

    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, error: '文件夹对话框超时（30 分钟）' })
    }, PICK_TIMEOUT_MS)

    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, supported: false, error: 'PowerShell 启动失败：' + String((e && e.message) || e) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const raw = (out || '').trim()
      if (code !== 0 && !raw) {
        return resolve({ ok: false, error: (err || '').trim().slice(0, 300) || 'PowerShell 退出码 ' + code })
      }
      if (!raw || raw === 'CANCEL') return resolve({ ok: true, path: null, canceled: true })

      // 正常返回是 'B64:<base64(UTF8 路径)>'，纯 ASCII，不受代码页影响；
      // 兼容旧格式（纯路径），万一环境退回老行为也不至于整条失败。
      let picked
      if (raw.startsWith('B64:')) {
        try {
          picked = Buffer.from(raw.slice(4), 'base64').toString('utf8')
        } catch {
          return resolve({ ok: false, error: '无法解析 PowerShell 返回的路径' })
        }
      } else {
        picked = raw
      }
      picked = picked.replace(/[\r\n]+$/, '')

      if (!fs.existsSync(picked)) return resolve({ ok: false, error: '选中的路径不存在：' + picked })
      resolve({ ok: true, path: picked })
    })
  })
}

export const name = '@device1999/dsh-session-archive-delete'

export function apply(root, config) {
  const disposers = []
  // 默认备份位置的工作区根：config.workspaceRoot 优先，否则启动后从会话列表推断
  let workspaceRoot = config && typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : ''
  log('v' + PKG_VERSION + ' 已加载，模式：' + readSettings().mode)

  // 延迟推断：sessionQuery 可能比本插件晚就绪
  const detectLater = () => {
    const sq = root.get ? root.get('sessionQuery') : null
    if (!sq) return
    detectWorkspaceRoot(root)
      .then((ws) => {
        if (ws && !workspaceRoot) {
          workspaceRoot = ws
          log('默认备份位置推断为：' + path.join(ws, ARCHIVE_FOLDER))
        }
      })
      .catch(() => {})
  }
  if (!workspaceRoot) {
    try {
      if (typeof root.inject === 'function') root.inject(['sessionQuery'], () => detectLater())
      else detectLater()
    } catch {}
  }

  // 2026-10-20 修复：默认停用 <script> 兜底注入。
  // assets/client.js 以 `window.__ModuleLoader__.load({...})` 形式编写，只能由
  // dsh.client 声明经 client-modules 加载；作为裸 <script> 注入时 __ModuleLoader__
  // 尚未就绪，会抛 "Cannot read properties of undefined (reading 'load')"，并把同一
  // factory 注册两次（duplicate factory registration），最终导致 web boot 失败。
  // 排查主路径问题时可用 DSH_ARCHIVE_DELETE_FALLBACK_INJECT=1 临时恢复兜底。
  if (process.env.DSH_ARCHIVE_DELETE_FALLBACK_INJECT === '1') {
    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          if (table.some((r) => r && r.kind === 'script-src' && r.src === CLIENT_PATH)) return
          table.push({ kind: 'script-src', placement: 'head', src: CLIENT_PATH, 'data-dsh-session-archive-delete-fallback': '1' })
        } catch {}
      })
    )
  }

  root.inject(['webServer'], (ctx) => {
    const reg = (route) =>
      disposers.push(
        ctx.webServer.register({
          ...route,
          handler: (req, res) => {
            Promise.resolve()
              .then(() => route.handler(req, res))
              .catch((err) => {
                try {
                  json(res, { ok: false, error: String((err && err.message) || err).slice(0, 500) }, 500)
                } catch {}
              })
          },
        })
      )

    reg({
      kind: 'exact',
      path: CLIENT_PATH,
      handler: (req, res) => {
        let body = ''
        try {
          body = fs.readFileSync(CLIENT_FILE, 'utf8')
        } catch {}
        if (!body) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('client script missing')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      },
    })

    reg({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) =>
        json(res, {
          ok: true,
          version: PKG_VERSION,
          settings: readSettings(),
          // 实际生效的备份根（设置里留空时是默认值），供设置页如实显示
          effectiveBackupRoot: resolveBackupRoot(readSettings(), workspaceRoot),
        }),
    })

    // 目录浏览：给设置页的「文件夹选择」用
    // 只列目录不列文件，隐藏 ~/.dsh（那里不能当备份根），并标出是否有子目录
    reg({
      kind: 'exact',
      path: BROWSE_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, { ok: false, error: 'method not allowed' }, 405)
        const url = new URL(req.url, 'http://x')
        let dir = url.searchParams.get('dir') || ''
        if (!dir) dir = resolveBackupRoot(readSettings(), workspaceRoot)
        dir = path.resolve(dir)

        // 不存在就退到最近的已存在祖先，避免一次点空白
        let probe = dir
        while (probe && !fs.existsSync(probe)) {
          const up = path.dirname(probe)
          if (up === probe) break
          probe = up
        }
        if (!probe || !fs.existsSync(probe)) return json(res, { ok: false, error: '目录不存在' }, 404)
        dir = probe

        const home = path.resolve(dshHome())
        const out = []
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue
            if (e.name.startsWith('.')) continue
            const full = path.join(dir, e.name)
            // 隐藏 DSH 家目录本身及其内部，防止误选
            if (path.resolve(full) === home || isInside(home, full)) continue
            let hasChildren = false
            try {
              hasChildren = fs.readdirSync(full, { withFileTypes: true }).some((c) => c.isDirectory())
            } catch {}
            out.push({ name: e.name, path: full, hasChildren })
          }
        } catch (err) {
          return json(res, { ok: false, error: '无法读取目录：' + String((err && err.message) || err) }, 500)
        }
        out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        return json(res, { ok: true, dir, parent: path.dirname(dir), dirs: out })
      },
    })

    reg({
      kind: 'exact',
      path: PICK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, { ok: false, error: 'method not allowed' }, 405)
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {}
        const initial = typeof body.initial === 'string' && body.initial ? body.initial : resolveBackupRoot(readSettings(), workspaceRoot)
        let r = await pickFolderNative(initial)
        // 成功与「用户取消」都必须带上 supported:true，否则前端会误判为不支持而回退到页面内浏览
        if (r.ok) r = { ...r, supported: true }
        if (r.ok && r.path) {
          const problem = checkBackupRoot(r.path)
          if (problem) return json(res, { ok: false, supported: true, error: problem }, 400)
        }
        log('pick-folder', r.ok ? (r.path || 'canceled') : 'FAIL ' + r.error + (r.supported === false ? ' (unsupported)' : ''))
        return json(res, r)
      },
    })

    reg({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, { ok: false, error: 'method not allowed' }, 405)
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          return json(res, { ok: false, error: 'bad json body' }, 400)
        }
        const next = normalize(body && body.settings ? body.settings : body)
        // 保存前做完整校验：路径有效性、是否是目录、是否可写、是否在 ~/.dsh 内
        const check = validateBackupPath(next.backupRoot, workspaceRoot)
        if (!check.ok) return json(res, { ok: false, error: check.error, check }, 400)
        const saved = writeSettings(next)
        return json(res, {
          ok: true,
          settings: saved,
          effectiveBackupRoot: check.resolved,
        })
      },
    })

    // 路径校验：前端在失焦/确认时先调这里，无效就当场提示、不保存
    reg({
      kind: 'exact',
      path: CHECK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, { ok: false, error: 'method not allowed' }, 405)
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {}
        const check = validateBackupPath(typeof body.path === 'string' ? body.path : '', workspaceRoot)
        return json(res, check, check.ok ? 200 : 400)
      },
    })

    reg({
      kind: 'exact',
      path: SESSION_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, { ok: false, error: 'method not allowed' }, 405)

        let args = {}
        try {
          const raw = await readBody(req)
          args = raw ? JSON.parse(raw) : {}
        } catch {
          return json(res, { ok: false, error: 'bad json body' }, 400)
        }

        const sessionId = String(args.sessionId || '').trim()
        if (!isValidSessionId(sessionId)) {
          return json(res, { ok: false, error: 'invalid session id' }, 400)
        }

        const settings = readSettings()
        // both 模式下菜单会明确传来具体行为，这里只兜底非法值
        const mode =
          args.mode === 'delete-only' || args.mode === 'backup-then-delete' ? args.mode : settings.mode === 'both' ? 'backup-then-delete' : settings.mode

        const loc = locateSession(sessionId)
        if (!loc.sessionDir && !loc.cacheFile) {
          return json(res, { ok: false, error: '找不到该会话（可能已被删除）' }, 404)
        }

        // ---- 收集子代理会话（主会话的兄弟目录，靠 header.parentSession 关联）----
        let subtree = []
        try {
          subtree = await collectSubtree({ ctx, sessionId, sessionsRoot: loc.sessionsRoot })
        } catch (e) {
          log('collectSubtree FAIL', String((e && e.message) || e))
          subtree = [{ id: sessionId }]
        }
        // 第一个恒为主会话；其余是子孙，解析出各自的目录/工作区/缓存
        const children = []
        for (const node of subtree.slice(1)) {
          if (!isValidSessionId(node.id)) continue
          const l = locateSession(node.id)
          if (!l.sessionDir) continue
          children.push({ id: node.id, dir: l.sessionDir, workspace: l.workspace, cacheFile: l.cacheFile })
        }
        if (children.length > 0) log('子代理会话', children.length, '个：', children.map((c) => c.id).join(','))

        // ---- 删除模式：不备份 ----
        if (mode === 'delete-only') {
          if (!loc.sessionDir) {
            return json(res, { ok: false, error: '会话目录不存在，无法删除' }, 404)
          }
          const r = await deleteSession({
            ctx,
            sessionId,
            sessionDir: loc.sessionDir,
            sessionsRoot: loc.sessionsRoot,
            cacheFile: loc.cacheFile,
          })
          // 主会话删除成功后，连带删除子代理会话（逐个独立处理，失败不影响主结果）
          const childResults = []
          if (r.ok) {
            for (const c of children) {
              const cr = await deleteSession({
                ctx,
                sessionId: c.id,
                sessionDir: c.dir,
                sessionsRoot: loc.sessionsRoot,
                cacheFile: c.cacheFile,
              })
              childResults.push({ id: c.id, ok: cr.ok, error: cr.error })
            }
          }
          log('delete-only', sessionId, r.ok ? 'OK' : 'FAIL ' + r.error, '子代理', childResults.length)
          return json(
            res,
            { ok: r.ok, mode, result: r, subagents: childResults, error: r.error },
            r.ok ? 200 : 500,
          )
        }

        // ---- 备份删除 ----
        const backupRoot = resolveBackupRoot(settings, workspaceRoot)
        const rootProblem = checkBackupRoot(backupRoot)
        if (rootProblem) return json(res, { ok: false, error: rootProblem }, 400)

        // 标题以宿主读到的为准：客户端 props 里没有 title 字段
        const title = resolveTitle(loc.cacheFile, loc.sessionDir, args.title)
        const b = backupSession({
          backupRoot,
          sessionId,
          sessionDir: loc.sessionDir || '',
          cacheFile: loc.cacheFile,
          workspace: loc.workspace,
          title,
          dateStyle: settings.dateStyle,
          snapshots: loc.snapshots,
          extraSessions: children,
        })
        if (!b.ok) {
          log('backup FAIL', sessionId, b.error)
          return json(res, { ok: false, step: 'backup', error: '备份失败，已中止删除：' + b.error }, 500)
        }
        log('backup OK', sessionId, '→', b.name, '子代理', (b.subagents || []).length)

        const d = await deleteSession({
          ctx,
          sessionId,
          sessionDir: loc.sessionDir,
          sessionsRoot: loc.sessionsRoot,
          cacheFile: loc.cacheFile,
        })
        // 主会话删除成功后，连带删除子代理会话
        const childResults = []
        if (d.ok) {
          for (const c of children) {
            const cr = await deleteSession({
              ctx,
              sessionId: c.id,
              sessionDir: c.dir,
              sessionsRoot: loc.sessionsRoot,
              cacheFile: c.cacheFile,
            })
            childResults.push({ id: c.id, ok: cr.ok, error: cr.error })
          }
        }
        log('delete', sessionId, d.ok ? 'OK' : 'FAIL ' + d.error, '子代理已删', childResults.filter((x) => x.ok).length)

        return json(
          res,
          {
            ok: d.ok,
            mode,
            title,
            backup: { dir: b.dir, name: b.name },
            result: d,
            subagents: childResults,
            error: d.error,
          },
          d.ok ? 200 : 500,
        )
      },
    })
  })

  root.effect(() => () => {
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {}
    }
  })
}
