/**
 * dsh-session-archive-delete · 子代理会话收集
 *
 * 子代理会话是主会话的「兄弟目录」：
 *   ~/.dsh/sessions/<工作区>/session-<主会话id>/
 *   ~/.dsh/sessions/<工作区>/session-<子代理id>/   ← 目录名里看不出父子关系
 *
 * 关系记录在会话 header 的 parentSession 字段里。删主会话时如果不处理它们：
 *   - 磁盘上留孤儿目录（占空间）
 *   - 归档账本仍引用它们，侧栏可能出现空壳条目
 *   - 对话框 @ 提及仍可能列出这些死掉的子会话
 *
 * 所以删除前先按 parentSession 广度优先收集整个子树（含跨工作区的子会话），
 * 由调用方一起备份、一起删除。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 读取会话日志里第一个含 header 的行，拿到 header 对象 */
function readHeaderFromJsonl(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const text = buf.subarray(0, n).toString('utf8')
    // zstd 压缩文件按 utf8 解出来是乱码，直接放弃
    if (text.indexOf('\uFFFD') >= 0) return null
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.indexOf('header') < 0) continue
      try {
        const o = JSON.parse(line)
        if (o && o.header && typeof o.header === 'object') return o.header
        if (o && o.type === 'session/header' && o.data && typeof o.data === 'object') return o.data
      } catch {}
    }
  } catch {}
  return null
}

/**
 * 读出某个会话目录的 header（不依赖宿主服务，纯读盘）。
 * 注意：真实 DSH 的会话文件是 session.v4.jsonl.zstd（zstd 压缩），
 * 读不出 header 属正常情况——此时完全依赖宿主的 sessionQuery 服务。
 */
function readHeaderFromDir(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return null
  try {
    for (const e of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      if (!/\.(jsonl|json)$/i.test(e.name)) continue
      const h = readHeaderFromJsonl(path.join(sessionDir, e.name))
      if (h) return h
    }
  } catch {}
  return null
}

/**
 * 收集主会话及其所有子孙会话（广度优先）。
 *
 * 数据来源优先级：宿主 sessionQuery.listSessions() → 扫描磁盘读 header。
 *
 * @param {object} p
 * @param {object} p.ctx         插件上下文
 * @param {string} p.sessionId   主会话 id
 * @param {string} p.sessionsRoot sessions 根目录
 * @returns {Promise<Array<{id:string, dir:string, workspace:string}>>}
 *          第一个元素恒为主会话自身
 */
export async function collectSubtree({ ctx, sessionId, sessionsRoot }) {
  const out = [{ id: sessionId, dir: null, workspace: null }]
  const seen = new Set([sessionId, sessionId.replace(/^session-/, ''), 'session-' + sessionId.replace(/^session-/, '')])

  // ---- 建立 parent -> children 索引 ----
  const childrenOf = new Map()
  const addChild = (parent, child, dir, workspace) => {
    if (!parent || !child) return
    const list = childrenOf.get(parent) || []
    if (!list.some((x) => x.id === child)) list.push({ id: child, dir, workspace })
    childrenOf.set(parent, list)
  }

  let fromHost = false
  try {
    const sq = ctx && ctx.get ? ctx.get('sessionQuery') : null
    if (sq && typeof sq.listSessions === 'function') {
      const records = await sq.listSessions()
      for (const r of records || []) {
        const h = r && r.header
        if (!h || typeof h.id !== 'string') continue
        if (typeof h.parentSession !== 'string' || !h.parentSession) continue
        addChild(h.parentSession, h.id, null, null)
      }
      fromHost = true
    }
  } catch {}

  // ---- 宿主服务不可用时，扫盘补全索引 ----
  if (!fromHost) {
    let wsDirs = []
    try {
      wsDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {}
    for (const ws of wsDirs) {
      const wsPath = path.join(sessionsRoot, ws.name)
      let sessDirs = []
      try {
        sessDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter((e) => e.isDirectory())
      } catch {}
      for (const sd of sessDirs) {
        const dir = path.join(wsPath, sd.name)
        const h = readHeaderFromDir(dir)
        if (!h) continue
        if (typeof h.parentSession !== 'string' || !h.parentSession) continue
        addChild(h.parentSession, h.id, dir, ws.name)
      }
    }
  }

  // ---- 广度优先展开 ----
  const queue = [sessionId]
  let guard = 0
  while (queue.length > 0 && guard++ < 5000) {
    const parent = queue.shift()
    const kids = childrenOf.get(parent) || []
    for (const k of kids) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      seen.add('session-' + k.id.replace(/^session-/, ''))
      seen.add(k.id.replace(/^session-/, ''))
      out.push({ id: k.id, dir: k.dir, workspace: k.workspace })
      queue.push(k.id)
    }
  }

  return out
}
