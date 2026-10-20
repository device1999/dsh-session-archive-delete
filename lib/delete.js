/**
 * dsh-session-archive-delete · 删除
 *
 * 删除顺序参照 dsh-session-menu 的 removeSession，尽量做到「不留半删除会话」：
 *   1. 运行中 → 取消当前轮次并等待结束（最长 3 秒），不阻塞
 *   2. 先 detach 运行时，避免 dispose 阶段把日志目录写回来
 *   3. 删除磁盘上的会话目录（删前确认目录名与会话 id 一致）
 *   4. 删除后复查 3 次，防止句柄把目录重建
 *   5. 最后才清理归档账本（unarchiveSession / unpinSession）
 *
 * 注意：预算备份由调用方在真正删除前完成，本模块只负责「删」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.js'

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidSessionId(id) {
  return SESSION_ID_RE.test(String(id || ''))
}

/**
 * 静默停止运行中的 agent。
 * @returns {boolean} 是否真的取消了一个正在运行的 agent
 */
async function stopIfRunning(ctx, sessionId) {
  const agents = ctx.get ? ctx.get('agents') : ctx.agents
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  try {
    if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
  } catch {}
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), new Promise((r) => setTimeout(r, 3000))])
    } catch {}
  }
  return true
}

/** 从运行时摘除会话，防止 dispose 阶段回写目录 */
function detachLive(ctx, sessionId) {
  const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions
  if (!sessions) return false
  try {
    const live = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (!live) return false
    if (typeof sessions.liveEntryFor === 'function' && typeof sessions.detachEntered === 'function') {
      const entry = sessions.liveEntryFor(live)
      if (entry !== undefined) {
        sessions.detachEntered(entry)
        return true
      }
    }
  } catch {}
  return false
}

/** 清掉归档 / 置顶账本里的记录（方法不存在时静默跳过） */
async function forgetLedger(ctx, sessionId) {
  const reg = ctx.get ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
  if (!reg) return false
  let touched = false
  for (const m of ['unarchiveSession', 'unpinSession']) {
    try {
      if (typeof reg[m] === 'function') {
        await reg[m](sessionId)
        touched = true
      }
    } catch {}
  }
  return touched
}

/**
 * 直接从 workspace.json 里摘掉会话引用（B 方案：先写账本，再删文件）。
 *
 * 为什么必须直接改文件：宿主的内存状态在删除后仍可能 flush 一次，
 * 把 sessionIds / archivedSessionIds 又写回来。先落盘摘引用，
 * 删文件后即使发生 flush，也只会带着「已摘除」的状态写回。
 *
 * 只动这三处，其他字段一字不改：
 *   global.archivedSessionIds
 *   global.pinnedSessionIds
 *   tables.workspaces.*.sessionIds
 *
 * @returns {{ok:boolean, removed:number, error?:string}}
 */
function stripWorkspaceJson(sessionId) {
  const home = dshHome()
  const file = path.join(home, 'storages', 'workspace.json')
  if (!fs.existsSync(file)) return { ok: false, removed: 0, error: 'workspace.json 不存在' }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const doc = JSON.parse(raw)
    const leaf = sessionId.replace(/^session-/, '')
    const variants = new Set([sessionId, leaf, 'session-' + leaf])
    let removed = 0
    const keep = (arr) => {
      if (!Array.isArray(arr)) return arr
      const out = arr.filter((x) => !variants.has(String(x)))
      removed += arr.length - out.length
      return out
    }
    if (doc.global) {
      if (Array.isArray(doc.global.archivedSessionIds)) doc.global.archivedSessionIds = keep(doc.global.archivedSessionIds)
      if (Array.isArray(doc.global.pinnedSessionIds)) doc.global.pinnedSessionIds = keep(doc.global.pinnedSessionIds)
    }
    const workspaces = doc.tables && doc.tables.workspaces
    if (workspaces && typeof workspaces === 'object') {
      for (const key of Object.keys(workspaces)) {
        const ws = workspaces[key]
        if (ws && Array.isArray(ws.sessionIds)) ws.sessionIds = keep(ws.sessionIds)
      }
    }
    if (removed > 0) {
      const tmp = file + '.ad-tmp'
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    }
    return { ok: true, removed }
  } catch (e) {
    return { ok: false, removed: 0, error: String((e && e.message) || e) }
  }
}

/**
 * 同步清理投影缓存索引（storages/session_projcache.json）。
 * 只删 tables.sessions 下本会话那几条，其他结构不动。
 */
function stripProjCacheIndex(sessionId) {
  const home = dshHome()
  const file = path.join(home, 'storages', 'session_projcache.json')
  if (!fs.existsSync(file)) return { ok: true, removed: 0 }
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const leaf = sessionId.replace(/^session-/, '')
    const variants = new Set([sessionId, leaf, 'session-' + leaf])
    let removed = 0
    const sessions = doc && doc.tables && doc.tables.sessions
    if (sessions && typeof sessions === 'object') {
      for (const k of Object.keys(sessions)) {
        if (variants.has(k)) {
          delete sessions[k]
          removed++
        }
      }
    }
    if (removed > 0) {
      const tmp = file + '.ad-tmp'
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    }
    return { ok: true, removed }
  } catch (e) {
    return { ok: false, removed: 0, error: String((e && e.message) || e) }
  }
}

/**
 * 删除一个会话。
 *
 * 执行顺序（B 方案）：
 *   0. 先摘掉 workspace.json 里的引用并落盘  ← 防止删除后被内存 flush 写回
 *   1. 运行中 → 取消当前轮次并等待结束（最长 3 秒）
 *   2. detach 运行时，避免 dispose 阶段把日志目录写回
 *   3. 删磁盘会话目录（删前校验目录名与会话 id 一致）
 *   4. 复查 3 次，防止句柄把目录重建
 *   5. 删投影缓存文件
 *   6. 再摘一次引用（兜底：上面几步耗时期间可能又被写回）
 *
 * @param {object} ctx       插件上下文（提供 get）
 * @param {string} sessionId 完整会话 id
 * @param {string} sessionDir 会话目录绝对路径（删除前会做名字校验）
 * @param {string} sessionsRoot sessions 根目录（边界校验）
 * @param {string|null} cacheFile 投影缓存文件
 * @returns {Promise<{ok:boolean, removed?:boolean, stopped?:boolean, detached?:boolean, ledger?:boolean, unlinked?:number, error?:string}>}
 */
export async function deleteSession({ ctx, sessionId, sessionDir, sessionsRoot, cacheFile }) {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, error: 'invalid session id: ' + sessionId }
  }

  // 硬性边界：目录必须在 sessions 根下，且目录名就是会话 id
  const resolvedDir = path.resolve(sessionDir)
  const resolvedRoot = path.resolve(sessionsRoot || path.dirname(path.dirname(resolvedDir)))
  if (!resolvedDir.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, error: '路径越界：' + resolvedDir }
  }
  if (path.basename(resolvedDir) !== sessionId) {
    return { ok: false, error: '目录名与会话 id 不一致，拒绝删除：' + path.basename(resolvedDir) }
  }

  // 0) 先摘账本引用并落盘
  const pre = stripWorkspaceJson(sessionId)
  stripProjCacheIndex(sessionId)

  const stopped = await stopIfRunning(ctx, sessionId)
  const detached = detachLive(ctx, sessionId)

  let removed = false
  try {
    if (fs.existsSync(resolvedDir)) {
      fs.rmSync(resolvedDir, { recursive: true, force: true })
      removed = true
    }
  } catch (err) {
    return { ok: false, stopped, detached, error: '删除失败：' + String((err && err.message) || err) }
  }

  // 复查：句柄可能把目录重建
  for (let i = 0; i < 3; i++) {
    if (!fs.existsSync(resolvedDir)) break
    await new Promise((r) => setTimeout(r, 150))
    try {
      fs.rmSync(resolvedDir, { recursive: true, force: true })
    } catch {}
  }
  if (fs.existsSync(resolvedDir)) {
    return { ok: false, stopped, detached, error: '目录删除后又被重建：' + resolvedDir }
  }

  // 缓存文件
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      fs.rmSync(cacheFile, { force: true })
    } catch {}
  }

  const ledger = await forgetLedger(ctx, sessionId)

  // 6) 兜底：上面耗时期间内存可能又 flush 写回，再摘一次
  await new Promise((r) => setTimeout(r, 200))
  const post = stripWorkspaceJson(sessionId)
  stripProjCacheIndex(sessionId)
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      fs.rmSync(cacheFile, { force: true })
    } catch {}
  }

  return {
    ok: true,
    removed,
    stopped,
    detached,
    ledger,
    unlinked: Math.max(pre.removed || 0, post.removed || 0),
  }
}
